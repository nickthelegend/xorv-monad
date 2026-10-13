/**
 * Reading the public record back: XorvLedger feeds and the leaderboard.
 *
 * Two sources, in order of preference:
 *
 *  1. the Envio indexer (`XORV_INDEXER_URL`), which has the whole history and
 *     the derived aggregates, and answers in one request;
 *  2. a bounded backward RPC scan (protocol `readLedgerEvents`) — the public
 *     Monad RPC caps `eth_getLogs` at 100 blocks, so this only reaches the
 *     recent past, but it needs nothing but the contract address.
 *
 * Results are cached for a few seconds. The landing page polls, the network
 * page polls, and without a cache every visitor would cost the RPC a couple of
 * hundred `eth_getLogs` calls per refresh.
 */

import { publicClientFor, readLedgerEvents, type LedgerEvent, type LedgerEventKind } from "@xorv/protocol";
import {
  indexerServes,
  readIndexerEvents,
  readIndexerLeaderboard,
  type IndexerLeaderboardRow,
  type IndexerOptions,
} from "./indexer.js";

export interface LedgerFeed {
  source: "indexer" | "rpc" | "none";
  events: LedgerEvent[];
  /** Set when the indexer was configured but failed and the RPC answered instead. */
  indexerError?: string;
}

export interface LedgerReader {
  /** Newest-first events of one kind. Throws only when every source failed. */
  events(kind: LedgerEventKind, limit: number): Promise<LedgerFeed>;
  /** Provider rows from the indexer, or null when there is no indexer to ask. */
  leaderboard(limit: number): Promise<IndexerLeaderboardRow[] | null>;
}

export interface LedgerReaderOptions {
  network: string;
  ledgerAddress: string | null;
  fromBlock: bigint | null;
  indexerUrl: string | null;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injected for tests; defaults to the protocol's bounded RPC scan. */
  readRpc?: (kind: LedgerEventKind, limit: number) => Promise<LedgerEvent[]>;
  cacheMs?: number;
  /** Injected for tests: the incremental scan's chain head and windowed read. */
  tail?: RpcTailSource;
}

export interface RpcTailSource {
  head(): Promise<bigint>;
  scan(kind: LedgerEventKind, limit: number, fromBlock: bigint | null): Promise<LedgerEvent[]>;
}

/** Newest events kept per feed by the incremental scan; every page asks for fewer. */
export const TAIL_KEEP = 200;

/**
 * An RPC feed that scans each block once.
 *
 * A full backward scan costs one `eth_getLogs` per 100 blocks, and the network
 * page asks for several feeds at once. On the public RPC that got rate-limited
 * into a 502 for every visitor. This one backfills once, then on each refresh
 * reads only the blocks since its last scan and merges them in front. If a
 * refresh fails after the first success, the last good feed is served instead
 * of an error.
 */
export function createRpcTail(source: RpcTailSource, deployFloor: bigint | null) {
  const tails = new Map<LedgerEventKind, { events: LedgerEvent[]; scannedTo: bigint | null; inflight: Promise<LedgerEvent[]> | null }>();
  return async function read(kind: LedgerEventKind, limit: number): Promise<LedgerEvent[]> {
    let tail = tails.get(kind);
    if (!tail) {
      tail = { events: [], scannedTo: null, inflight: null };
      tails.set(kind, tail);
    }
    const t = tail;
    if (!t.inflight) {
      t.inflight = (async () => {
        try {
          const head = await source.head();
          const from = t.scannedTo === null ? deployFloor : t.scannedTo + 1n;
          if (from !== null && from > head) return t.events;
          const fresh = await source.scan(kind, TAIL_KEEP, from);
          const seen = new Set(fresh.map((e) => e.id));
          t.events = [...fresh, ...t.events.filter((e) => !seen.has(e.id))]
            .sort((a, b) => b.blockNumber - a.blockNumber || (a.id < b.id ? 1 : -1))
            .slice(0, TAIL_KEEP);
          t.scannedTo = head;
          return t.events;
        } catch (err) {
          if (t.scannedTo === null) throw err;
          return t.events;
        } finally {
          t.inflight = null;
        }
      })();
    }
    return (await t.inflight).slice(0, limit);
  };
}

export const LEDGER_CACHE_MS = 5_000;

export function createLedgerReader(opts: LedgerReaderOptions): LedgerReader {
  const cacheMs = opts.cacheMs ?? LEDGER_CACHE_MS;
  const indexer: IndexerOptions | null = opts.indexerUrl ? { url: opts.indexerUrl, fetch: opts.fetch } : null;
  let headClient: ReturnType<typeof publicClientFor> | undefined;
  const readRpc =
    opts.readRpc ??
    createRpcTail(
      opts.tail ?? {
        head: () => (headClient ??= publicClientFor(opts.network)).getBlockNumber(),
        // Two windows at a time: several feeds backfill at once after a restart, and the public RPC
        // rate-limits anything faster into a 502 for the page that asked.
        scan: (kind, limit, fromBlock) => readLedgerEvents(opts.network, opts.ledgerAddress ?? "", { kind, limit, fromBlock, concurrency: 2 }),
      },
      opts.fromBlock,
    );

  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cacheMs) return hit.value as Promise<T>;
    const value = load();
    cache.set(key, { at: Date.now(), value });
    // A failure is not worth remembering: the next caller should try again.
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    return value;
  }

  return {
    events(kind, limit) {
      return cached(`events:${kind}:${limit}`, async (): Promise<LedgerFeed> => {
        let indexerError: string | undefined;
        if (indexer && indexerServes(kind)) {
          try {
            return { source: "indexer", events: await readIndexerEvents(indexer, kind, limit) };
          } catch (err) {
            indexerError = err instanceof Error ? err.message : String(err);
          }
        }
        if (!opts.ledgerAddress) return { source: "none", events: [], indexerError };
        const events = await readRpc(kind, limit);
        return indexerError ? { source: "rpc", events, indexerError } : { source: "rpc", events };
      });
    },
    leaderboard(limit) {
      if (!indexer) return Promise.resolve(null);
      return cached(`leaderboard:${limit}`, () => readIndexerLeaderboard(indexer, limit));
    },
  };
}
