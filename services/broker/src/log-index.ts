/**
 * A forward index of the XorvLog audit trail, persisted in SQLite.
 *
 * The public page of receipts could read the chain on every request: walk
 * backwards from the head in bounded `eth_getLogs` windows. Two things are
 * wrong with that, both observed live on an earlier chain rather than supposed:
 *
 *  - **It cannot reach old receipts.** A bounded number of windows covers a
 *    bounded stretch of chain, and at Arbitrum's ~0.25s blocks even 120
 *    10,000-block windows is only a few days. Anything older is invisible,
 *    and the page says "no receipts yet" about a log that has them.
 *  - **It rate-limits itself.** Public RPCs allow only a few `eth_getLogs` a
 *    second sustained. A landing page and a job board both polling the
 *    endpoint turn into a stream of "rate limit exceeded" and a 502 for
 *    everyone.
 *
 * So the broker keeps its own index instead, and pages are served from it:
 *
 *  1. **Seed** from transactions the broker already knows it published — one
 *     receipt lookup each, no scanning, so real entries appear immediately.
 *  2. **Scan forward** from the deployment block, one window at a time, paced
 *     under the RPC's limit and backing off when it pushes back. The cursor is
 *     persisted, so a restart resumes rather than starting over.
 *  3. **Follow the head** once caught up, and keep seeding newly published
 *     receipts so they show up even while a long backfill is still running.
 *
 * Everything that touches the network is injectable; the tests drive the real
 * scheduling, cursor and dedupe logic against scripted responses.
 */

import {
  logWindowBlocks,
  readClient,
  readLogFromTransactions,
  readLogRange,
  type LogEntry,
  type LogMessageKind,
} from "@xorv/protocol";

export interface LogIndexStore {
  loadLogEntries(address: string): LogEntry[];
  saveLogEntries(address: string, entries: LogEntry[]): void;
  loadLogCursor(address: string): bigint | null;
  saveLogCursor(address: string, block: bigint): void;
}

export interface LogIndexOptions {
  network: string;
  /** The XorvLog contract. */
  address: string;
  /** Block the contract was deployed at; `0n` means "unknown — follow the head". */
  fromBlock: bigint;
  store: LogIndexStore;
  /** Transaction hashes the broker knows emitted entries (receipts it published). */
  knownTransactions?: () => string[];
  readRange?: (fromBlock: bigint, toBlock: bigint) => Promise<LogEntry[]>;
  readTransactions?: (hashes: string[]) => Promise<LogEntry[]>;
  head?: () => Promise<bigint>;
  /**
   * True while something more important is using the RPC — a settlement, an
   * audit write. The index skips its turn rather than compete: a public
   * endpoint has one small rate budget, and a backfill paced to use all of it
   * once starved a heartbeat and a registration into "rate limit exceeded".
   */
  yieldTo?: () => boolean;
  /**
   * Blocks per `eth_getLogs` window. Defaults to `logWindowBlocks()` —
   * `XORV_LOG_WINDOW_BLOCKS`, or 10,000.
   */
  windowBlocks?: bigint;
  /** Pause between windows while backfilling. Sized for a public RPC. */
  paceMs?: number;
  /** Pause between head checks once caught up. */
  pollMs?: number;
  /** First backoff after an RPC error; doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  onEvent?: (message: string) => void;
}

export interface LogIndexSync {
  fromBlock: string;
  scannedTo: string;
  head: string | null;
  caughtUp: boolean;
  entries: number;
  lastError: string | null;
}

export type TickOutcome = "scanned" | "caught-up" | "backoff" | "yielded";

export class LogIndex {
  private readonly byKey = new Map<string, LogEntry>();
  private readonly seenTransactions = new Set<string>();
  private cursor: bigint | null;
  private headBlock: bigint | null = null;
  private lastError: string | null = null;
  private backoff: number;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;

  private readonly readRange: (from: bigint, to: bigint) => Promise<LogEntry[]>;
  private readonly readTransactions: (hashes: string[]) => Promise<LogEntry[]>;
  private readonly head: () => Promise<bigint>;
  private readonly paceMs: number;
  private readonly windowBlocks: bigint;
  private readonly pollMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(private readonly options: LogIndexOptions) {
    const { network, address } = options;
    this.readRange = options.readRange ?? ((fromBlock, toBlock) => readLogRange(network, { address, fromBlock, toBlock }));
    this.readTransactions = options.readTransactions ?? ((hashes) => readLogFromTransactions(network, address, hashes));
    this.head = options.head ?? (() => readClient(network).getBlockNumber());
    // Arbitrum makes ~4 blocks a second, so a backfill has to move faster
    // than the old 2.5s pace to ever catch up: 10,000 blocks a second is still
    // one request a second, well inside public-RPC limits.
    this.paceMs = options.paceMs ?? 1_000;
    this.windowBlocks = options.windowBlocks ?? logWindowBlocks();
    this.pollMs = options.pollMs ?? 15_000;
    this.baseBackoffMs = options.backoffMs ?? 5_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.backoff = this.baseBackoffMs;

    for (const entry of options.store.loadLogEntries(address)) {
      this.byKey.set(keyOf(entry), entry);
      this.seenTransactions.add(entry.transactionHash.toLowerCase());
    }
    const saved = options.store.loadLogCursor(address);
    this.cursor = saved ?? (options.fromBlock > 0n ? options.fromBlock - 1n : null);
  }

  /** Add the entries emitted by known transactions. Returns how many were new. */
  async seed(hashes: readonly string[]): Promise<number> {
    const fresh = [...new Set(hashes.filter(Boolean).map((h) => h.toLowerCase()))].filter(
      (h) => !this.seenTransactions.has(h),
    );
    if (fresh.length === 0) return 0;
    const found = await this.readTransactions(fresh);
    for (const h of fresh) this.seenTransactions.add(h);
    return this.add(found);
  }

  /**
   * One step of the loop: seed anything newly published, then scan the next
   * window or check the head. Exposed so tests can drive it deterministically.
   */
  async tick(): Promise<TickOutcome> {
    if (this.options.yieldTo?.()) return "yielded";

    // Seeding is a shortcut, never a precondition: if it fails (a rate limit,
    // an RPC without historical lookups) the forward scan must still advance.
    // Before this, one unfindable hash stalled the whole index indefinitely.
    if (this.options.knownTransactions) {
      try {
        await this.seed(this.options.knownTransactions());
      } catch (err) {
        this.options.onEvent?.(`seeding skipped this round: ${describe(err).slice(0, 120)}`);
      }
    }

    try {
      const head = await this.head();
      this.headBlock = head;
      if (this.cursor === null) {
        // No deployment block configured: index from here on; anything older
        // is only visible through seeded transactions.
        this.cursor = head;
        this.options.store.saveLogCursor(this.options.address, head);
        this.options.onEvent?.(`no XORV_LOG_FROM_BLOCK — indexing from block ${head}`);
      }
      if (this.cursor >= head) {
        this.lastError = null;
        this.backoff = this.baseBackoffMs;
        return "caught-up";
      }

      const from = this.cursor + 1n;
      const to = head - from + 1n > this.windowBlocks ? from + this.windowBlocks - 1n : head;
      const found = await this.readRange(from, to);
      this.add(found);
      this.cursor = to;
      this.options.store.saveLogCursor(this.options.address, to);
      this.lastError = null;
      this.backoff = this.baseBackoffMs;
      return "scanned";
    } catch (err) {
      this.lastError = describe(err);
      return "backoff";
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wake?.();
  }

  /** Newest first. */
  entries(opts: { kind?: LogMessageKind; limit?: number } = {}): LogEntry[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return [...this.byKey.values()]
      .filter((e) => !opts.kind || e.kind === opts.kind)
      .sort((a, b) => b.blockNumber - a.blockNumber || b.sequence - a.sequence)
      .slice(0, limit);
  }

  counts(): { registry: number; heartbeat: number; receipts: number } {
    const all = [...this.byKey.values()];
    return {
      registry: all.filter((e) => e.kind === "provider.registered").length,
      heartbeat: all.filter((e) => e.kind === "provider.heartbeat").length,
      receipts: all.filter((e) => e.kind === "job.receipt").length,
    };
  }

  sync(): LogIndexSync {
    return {
      fromBlock: this.options.fromBlock.toString(),
      scannedTo: (this.cursor ?? 0n).toString(),
      head: this.headBlock === null ? null : this.headBlock.toString(),
      caughtUp: this.cursor !== null && this.headBlock !== null && this.cursor >= this.headBlock,
      entries: this.byKey.size,
      lastError: this.lastError,
    };
  }

  private add(found: readonly LogEntry[]): number {
    const fresh: LogEntry[] = [];
    for (const entry of found) {
      const key = keyOf(entry);
      if (this.byKey.has(key)) continue;
      this.byKey.set(key, entry);
      this.seenTransactions.add(entry.transactionHash.toLowerCase());
      fresh.push(entry);
    }
    if (fresh.length > 0) this.options.store.saveLogEntries(this.options.address, fresh);
    return fresh.length;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const outcome = await this.tick();
      const wait =
        outcome === "scanned" || outcome === "yielded"
          ? this.paceMs
          : outcome === "caught-up"
            ? this.pollMs
            : this.backoff;
      if (outcome === "backoff") {
        this.options.onEvent?.(`rpc refused (${this.lastError?.slice(0, 80)}) — retrying in ${Math.round(wait / 1000)}s`);
        this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
      }
      if (!this.running) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, wait);
        this.timer.unref?.();
      });
    }
  }
}

/** viem puts the RPC's own reason in `details`; prefer it over the generic message. */
function describe(err: unknown): string {
  if (err instanceof Error) return (err as Error & { details?: string }).details ?? err.message;
  return String(err);
}

function keyOf(entry: LogEntry): string {
  return `${entry.transactionHash.toLowerCase()}:${entry.sequence}`;
}
