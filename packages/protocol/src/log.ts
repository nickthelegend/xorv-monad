/**
 * XorvLog — the public audit trail.
 *
 * Three append-only streams carry the facts a marketplace has to be honest
 * about: who joined, who was actually alive, and what each job paid. The broker
 * holds operational state in memory for speed, but the chain holds the record,
 * so "this provider really was online when it took your job" and "this job
 * really paid this much" are checkable by anyone with an RPC endpoint, not just
 * by us.
 *
 * On Hedera this was three Consensus Service topics. An EVM chain has no HCS,
 * so the same guarantee is rebuilt from EVM event logs — ordered, append-only,
 * attributed to their sender, and readable by anyone without credentials. The
 * envelope shape is unchanged, deliberately: the audit format is protocol, and
 * a consumer written against the Hedera version still parses these.
 *
 * Publishing is best-effort and never blocks the request path. A job poster
 * should not wait on the audit log to get their answer. Failures are surfaced,
 * not swallowed silently.
 */

import {
  getAddress,
  keccak256,
  parseEventLogs,
  toHex,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { LOG_KIND, LOG_SCHEMA_VERSION, logAddress, rpcUrl } from "./constants.js";
import { readClient } from "./chain.js";
import type { LogEnvelope, LogMessageKind } from "./types.js";
import { XORV_LOG_ABI } from "./xorv-log.abi.js";

export { XORV_LOG_ABI };

/** Wrap a payload in the versioned envelope every Xorv log entry uses. */
export function envelope<T>(kind: LogMessageKind, data: T): LogEnvelope<T> {
  return { v: LOG_SCHEMA_VERSION, kind, at: Date.now(), data };
}

/** Map an envelope kind onto the contract's numeric discriminator. */
export function kindNumber(kind: LogMessageKind): number {
  if (kind === "provider.registered") return LOG_KIND.registration;
  if (kind === "provider.heartbeat") return LOG_KIND.heartbeat;
  return LOG_KIND.receipt;
}

/** And back again, for readers. */
export function kindName(n: number): LogMessageKind | null {
  if (n === LOG_KIND.registration) return "provider.registered";
  if (n === LOG_KIND.heartbeat) return "provider.heartbeat";
  if (n === LOG_KIND.receipt) return "job.receipt";
  return null;
}

/**
 * The indexed `subject` of an entry: a node id or a job id.
 *
 * Hashed rather than stored as a string because an indexed event parameter of
 * dynamic type is hashed by the EVM anyway. Doing it explicitly means the
 * caller can reconstruct the same topic to filter by, which a reader could not
 * do if it were left implicit.
 */
export function subjectOf(id: string): `0x${string}` {
  return keccak256(toHex(id));
}

export interface AppendResult {
  transactionHash: string;
  blockNumber: string;
  /** Network-wide monotonic sequence number, the analogue of an HCS one. */
  sequenceNumber?: string;
}

/**
 * Publish one entry.
 *
 * The payload cap is enforced by the contract at 1024 bytes, the same limit HCS
 * imposed. Checking it here too turns a wasted on-chain revert — which still
 * costs gas — into a local throw.
 */
export async function appendEntry(
  clients: { wallet: WalletClient; public: PublicClient },
  address: string,
  kind: LogMessageKind,
  subject: string,
  payload: unknown,
): Promise<AppendResult> {
  const body = JSON.stringify(payload);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > 1024) {
    throw new Error(`log entry is ${bytes}B, over the contract's 1024B limit`);
  }

  const account = clients.wallet.account;
  if (!account) throw new Error("wallet client has no account");

  const hash = await clients.wallet.writeContract({
    address: getAddress(address),
    abi: XORV_LOG_ABI,
    functionName: "append",
    args: [kindNumber(kind), subjectOf(subject), body],
    account,
    chain: clients.wallet.chain,
  });
  const receipt = await clients.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`log append reverted (${hash})`);
  }
  return {
    transactionHash: hash,
    blockNumber: receipt.blockNumber.toString(),
  };
}

/**
 * Fire-and-forget publish.
 *
 * Returns the result on success and `null` on failure, after handing the error
 * to `onError`. Call sites use this on the request path where the audit write
 * must not be able to fail the thing being audited.
 */
export async function appendEntrySafe(
  clients: { wallet: WalletClient; public: PublicClient },
  address: string | undefined | null,
  kind: LogMessageKind,
  subject: string,
  payload: unknown,
  onError?: (err: Error) => void,
): Promise<AppendResult | null> {
  if (!address) return null;
  try {
    return await appendEntry(clients, address, kind, subject, payload);
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error(String(err)));
    return null;
  }
}

export interface LogEntry {
  kind: LogMessageKind | null;
  subject: `0x${string}`;
  author: string;
  sequence: number;
  payload: unknown;
  blockNumber: number;
  transactionHash: string;
}

/**
 * Default number of blocks one `eth_getLogs` call may span.
 *
 * Public RPCs cap `eth_getLogs` differently — by block range, by result count,
 * or both — and an unbounded `fromBlock: 0` is commonly rejected outright.
 * That last one matters: the obvious implementation ("scan from the deployment
 * block") does not merely run slowly, it errors, and the natural place to
 * catch that error is a try/catch that renders the audit trail as empty. An
 * empty audit log looks like a working feature with nothing in it yet, so the
 * failure is invisible exactly where it is least affordable. So reads are
 * always chunked.
 *
 * 10,000 blocks is a range the public Arbitrum endpoints and most hosted
 * providers accept. Arbitrum produces a block roughly every 0.25s, so it is
 * only ~40 minutes of chain time — hence the higher window ceiling below, and
 * `XORV_LOG_WINDOW_BLOCKS` to widen (or narrow) it for a given RPC.
 */
const LOG_WINDOW_BLOCKS = 10_000n;

/**
 * The `eth_getLogs` window in blocks: `XORV_LOG_WINDOW_BLOCKS`, or the default.
 *
 * Read per call so a test, or an operator switching RPC, can change it without
 * re-importing the module.
 */
export function logWindowBlocks(): bigint {
  const raw = process.env.XORV_LOG_WINDOW_BLOCKS?.trim();
  if (raw && /^\d+$/.test(raw) && BigInt(raw) > 0n) return BigInt(raw);
  return LOG_WINDOW_BLOCKS;
}

/**
 * Ceiling on windows walked per backwards read, so a cold chain can't hang a
 * request. 120 × 10,000 blocks is about 3.5 days of Arbitrum at 0.25s blocks;
 * `XORV_LOG_MAX_WINDOWS` overrides it.
 */
function maxWindows(): number {
  const raw = Number(process.env.XORV_LOG_MAX_WINDOWS);
  return Number.isInteger(raw) && raw > 0 ? raw : 120;
}

/** Where the deployed contract starts, so a scan knows when to stop walking. */
export function logFromBlock(): bigint {
  const raw = process.env.XORV_LOG_FROM_BLOCK?.trim();
  const parsed = raw ? BigInt(raw) : 0n;
  return parsed > 0n ? parsed : 0n;
}

/**
 * Read the audit trail back.
 *
 * This is how the web app renders the public record without credentials —
 * anyone can verify the same feed from the same public endpoint.
 *
 * Walks backwards from the head in windows rather than issuing one wide query,
 * for the reason above, and stops as soon as it has `limit` entries. Recent
 * entries are the common case, so the usual cost is a single RPC call.
 */
export async function readLog(
  network: string,
  opts: {
    kind?: LogMessageKind;
    subject?: string;
    limit?: number;
    address?: string;
  } = {},
): Promise<LogEntry[]> {
  const address = opts.address ?? logAddress();
  if (!address) return [];

  const limit = Math.min(opts.limit ?? 50, 200);
  const client = readClient(network);
  const floor = logFromBlock();

  const args: Record<string, unknown> = {};
  if (opts.kind) args.kind = kindNumber(opts.kind);
  if (opts.subject) args.subject = subjectOf(opts.subject);

  const collected: LogEntry[] = [];
  let toBlock = await client.getBlockNumber();

  const span = logWindowBlocks();
  const windows = maxWindows();
  for (let window = 0; window < windows && collected.length < limit; window++) {
    const fromBlock = toBlock > floor + span ? toBlock - span + 1n : floor;

    const events = await client.getContractEvents({
      address: getAddress(address) as Address,
      abi: XORV_LOG_ABI,
      eventName: "Entry",
      args,
      fromBlock,
      toBlock,
    });

    // Newest first, matching what a feed wants to render.
    for (const entry of decodeEntryEvents(events).reverse()) {
      collected.push(entry);
      if (collected.length >= limit) break;
    }

    if (fromBlock <= floor) break;
    toBlock = fromBlock - 1n;
  }

  return collected;
}

/** The decoded shape of an `Entry` event as viem returns it. */
interface EntryEvent {
  args: unknown;
  blockNumber: bigint | null;
  transactionHash: string | null;
}

/**
 * Turn raw `Entry` events into log entries, oldest first.
 *
 * Shared by every reader, so a receipt looks identical whether it came from a
 * backwards scan, a forward index or a known transaction hash.
 */
export function decodeEntryEvents(events: readonly EntryEvent[]): LogEntry[] {
  return events.map((e) => {
    const a = e.args as {
      kind?: number;
      subject?: `0x${string}`;
      author?: string;
      seq?: bigint;
      payload?: string;
    };
    let payload: unknown = null;
    try {
      payload = a.payload ? JSON.parse(a.payload) : null;
    } catch {
      // An entry someone else wrote in a shape we don't recognise. Surfaced
      // as null rather than thrown, so one foreign entry can't break the feed.
      payload = null;
    }
    return {
      kind: kindName(Number(a.kind ?? 0)),
      subject: a.subject ?? "0x",
      author: a.author ?? "",
      sequence: Number(a.seq ?? 0n),
      payload,
      blockNumber: Number(e.blockNumber ?? 0n),
      transactionHash: e.transactionHash ?? "",
    };
  });
}

/**
 * Every entry in one block window, oldest first.
 *
 * The primitive a forward index is built from: one `eth_getLogs` call, never
 * wider than the RPC allows. Throws on RPC errors (including rate limits) so
 * the caller can back off rather than record a gap as "empty".
 */
export async function readLogRange(
  network: string,
  opts: { address: string; fromBlock: bigint; toBlock: bigint },
): Promise<LogEntry[]> {
  const span = logWindowBlocks();
  if (opts.toBlock - opts.fromBlock + 1n > span) {
    throw new Error(`window of ${opts.toBlock - opts.fromBlock + 1n} blocks exceeds ${span}`);
  }
  const events = await readClient(network).getContractEvents({
    address: getAddress(opts.address) as Address,
    abi: XORV_LOG_ABI,
    eventName: "Entry",
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
  });
  return decodeEntryEvents(events);
}

/**
 * The entries a set of known transactions emitted.
 *
 * One `eth_getTransactionReceipt` per hash, no block scanning — so entries the
 * broker itself published are readable immediately, however far back they are.
 * A transaction that emitted nothing from `address` contributes nothing.
 */
export async function readLogFromTransactions(
  network: string,
  address: string,
  transactionHashes: readonly string[],
): Promise<LogEntry[]> {
  const client = readClient(network);
  const target = getAddress(address).toLowerCase();
  const out: LogEntry[] = [];
  for (const hash of transactionHashes) {
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
    } catch (err) {
      // Some RPCs (pruned or light nodes) do not serve historical transaction
      // lookups: an old receipt comes back as "not found" even though the
      // block and its logs exist. That hash is skipped — a block-range reader can still
      // recover the entry — while every other error (rate limits included)
      // propagates so the caller can back off.
      if ((err as { name?: string })?.name === "TransactionReceiptNotFoundError") continue;
      throw err;
    }
    const ours = receipt.logs.filter((l) => l.address.toLowerCase() === target);
    const decoded = parseEventLogs({ abi: XORV_LOG_ABI, eventName: "Entry", logs: ours });
    out.push(...decodeEntryEvents(decoded));
  }
  return out;
}

export { LOG_WINDOW_BLOCKS };

/** Total entries ever published, straight from the contract. */
export async function logCount(network: string, address?: string): Promise<number> {
  const target = address ?? logAddress();
  if (!target) return 0;
  const client = readClient(network);
  const count = await client.readContract({
    address: getAddress(target),
    abi: XORV_LOG_ABI,
    functionName: "count",
  });
  return Number(count);
}

/** Whether the audit trail is configured and the contract is actually there. */
export async function logDeployed(network: string, address?: string): Promise<boolean> {
  const target = address ?? logAddress();
  if (!target) return false;
  const client = readClient(network);
  const code = await client.getCode({ address: getAddress(target) });
  return Boolean(code && code !== "0x");
}

/** Which RPC a reader would use — surfaced by `xorv doctor`. */
export function logRpc(network: string): string {
  return rpcUrl(network);
}
