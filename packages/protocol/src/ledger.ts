/**
 * XorvLedger — Xorv's on-chain audit trail on Monad.
 *
 * Three facts a marketplace has to be honest about go on-chain as events: who
 * joined (`ProviderRegistered`), who was actually alive (`ProviderHeartbeat`),
 * and what each job paid and produced (`JobRecorded`). A fourth closes the
 * loop into ERC-8004: a buyer's rating (`JobRated`), which the contract relays
 * to the Reputation Registry — one rating per paid job, authorised by the
 * payer's own EIP-712 signature. The broker keeps operational state in memory
 * for speed, but the ledger holds the record, so "this provider really was
 * online when it took your job" and "this job really paid this much" are
 * checkable by anyone with an RPC endpoint, not just by us.
 *
 * Writes are the broker's business and stay best-effort: a job poster must
 * never wait on the audit log to get their answer, and a failed ledger write
 * must never fail the thing being audited. This module is the shared,
 * side-effect-free half — the ABI, the id/hash conventions everyone must agree
 * on, the typed data a buyer signs, and a bounded reader for the feeds.
 *
 * Receipts carry hashes, never content: `requestHash = keccak256(prompt)`,
 * `resultHash = keccak256(result)`. Anyone holding the text can prove it
 * matches; nobody reading the chain learns it.
 */

import {
  getAbiItem,
  isHex,
  keccak256,
  maxUint256,
  stringToBytes,
  zeroHash,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { chainIdOf, networkConfig } from "./chains.js";
import { normalizeAddress, publicClientFor } from "./evm.js";
import type {
  Capability,
  LedgerEvent,
  LedgerEventDataMap,
  LedgerEventKind,
} from "./types.js";

/**
 * The XorvLedger ABI, transcribed from the contract interface (SPEC §4).
 * The indexer and every writer depend on these exact signatures.
 */
export const XORV_LEDGER_ABI = [
  {
    type: "constructor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "identity_", type: "address" },
      { name: "reputation_", type: "address" },
      { name: "broker_", type: "address" },
      { name: "owner_", type: "address" },
    ],
  },
  {
    type: "function",
    name: "NO_AGENT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "RATING_TYPEHASH",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "identity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "reputation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "broker",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "jobs",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "bytes32" }],
    outputs: [
      { name: "buyer", type: "address" },
      { name: "agentId", type: "uint64" },
      { name: "rated", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "setBroker",
    stateMutability: "nonpayable",
    inputs: [{ name: "broker_", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "transferOwnership",
    stateMutability: "nonpayable",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "registerProvider",
    stateMutability: "nonpayable",
    inputs: [
      { name: "providerId", type: "bytes32" },
      { name: "payTo", type: "address" },
      { name: "agentId", type: "uint256" },
      { name: "label", type: "string" },
      { name: "capabilities", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "heartbeat",
    stateMutability: "nonpayable",
    inputs: [
      { name: "providerId", type: "bytes32" },
      { name: "activeJobs", type: "uint32" },
      { name: "capacity", type: "uint32" },
      { name: "uptimeSeconds", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "recordJobs",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "receipts",
        type: "tuple[]",
        internalType: "struct XorvLedger.JobReceipt[]",
        components: [
          { name: "jobId", type: "bytes32" },
          { name: "agentId", type: "uint256" },
          { name: "buyer", type: "address" },
          { name: "payTo", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "paymentTx", type: "bytes32" },
          { name: "requestHash", type: "bytes32" },
          { name: "resultHash", type: "bytes32" },
          { name: "durationMs", type: "uint32" },
          { name: "ok", type: "bool" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "rateJob",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "r",
        type: "tuple",
        internalType: "struct XorvLedger.Rating",
        components: [
          { name: "jobId", type: "bytes32" },
          { name: "value", type: "int128" },
          { name: "tag2", type: "string" },
          { name: "endpoint", type: "string" },
          { name: "feedbackURI", type: "string" },
          { name: "feedbackHash", type: "bytes32" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "buyerSig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "ratingDigest",
    stateMutability: "view",
    inputs: [
      {
        name: "r",
        type: "tuple",
        internalType: "struct XorvLedger.Rating",
        components: [
          { name: "jobId", type: "bytes32" },
          { name: "value", type: "int128" },
          { name: "tag2", type: "string" },
          { name: "endpoint", type: "string" },
          { name: "feedbackURI", type: "string" },
          { name: "feedbackHash", type: "bytes32" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "event",
    name: "ProviderRegistered",
    anonymous: false,
    inputs: [
      { name: "providerId", type: "bytes32", indexed: true },
      { name: "payTo", type: "address", indexed: true },
      { name: "agentId", type: "uint256", indexed: true },
      { name: "label", type: "string", indexed: false },
      { name: "capabilities", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ProviderHeartbeat",
    anonymous: false,
    inputs: [
      { name: "providerId", type: "bytes32", indexed: true },
      { name: "activeJobs", type: "uint32", indexed: false },
      { name: "capacity", type: "uint32", indexed: false },
      { name: "uptimeSeconds", type: "uint32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "JobRecorded",
    anonymous: false,
    inputs: [
      { name: "jobId", type: "bytes32", indexed: true },
      { name: "agentId", type: "uint256", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "payTo", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "paymentTx", type: "bytes32", indexed: false },
      { name: "requestHash", type: "bytes32", indexed: false },
      { name: "resultHash", type: "bytes32", indexed: false },
      { name: "durationMs", type: "uint32", indexed: false },
      { name: "ok", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "JobRated",
    anonymous: false,
    inputs: [
      { name: "jobId", type: "bytes32", indexed: true },
      { name: "agentId", type: "uint256", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "value", type: "int128", indexed: false },
      { name: "feedbackHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BrokerSet",
    anonymous: false,
    inputs: [{ name: "broker", type: "address", indexed: true }],
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    anonymous: false,
    inputs: [
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
  },
  { type: "error", name: "NotOwner", inputs: [] },
  { type: "error", name: "NotBroker", inputs: [] },
  { type: "error", name: "DuplicateJob", inputs: [{ name: "jobId", type: "bytes32" }] },
  { type: "error", name: "UnknownJob", inputs: [{ name: "jobId", type: "bytes32" }] },
  { type: "error", name: "AlreadyRated", inputs: [{ name: "jobId", type: "bytes32" }] },
  { type: "error", name: "NoAgent", inputs: [{ name: "jobId", type: "bytes32" }] },
  {
    type: "error",
    name: "PayToNotAgentWallet",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "payTo", type: "address" },
      { name: "agentWallet", type: "address" },
    ],
  },
  { type: "error", name: "BadValue", inputs: [] },
  { type: "error", name: "Expired", inputs: [] },
  { type: "error", name: "BadSignature", inputs: [] },
  { type: "error", name: "AgentIdTooLarge", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "SelfDealing", inputs: [{ name: "jobId", type: "bytes32" }] },
] as const;

/** `XorvLedger.NO_AGENT` — the agentId a provider without an ERC-8004 identity is recorded under. */
export const NO_AGENT: bigint = maxUint256;

/** The ERC-8004 `tag1` every relayed rating carries (the spec's 0–100 "starred" convention). */
export const RATING_TAG1 = "starred";

/** Provider labels are truncated to this many UTF-8 bytes on-chain — log bytes cost gas. */
export const LEDGER_LABEL_MAX_BYTES = 64;

/** The public Monad RPC's `eth_getLogs` range cap, in blocks (inclusive range). */
export const MAX_LOG_BLOCK_RANGE = 100;

/**
 * How far back `readLedgerEvents` scans by default: 20k blocks ≈ 100 minutes
 * of Monad at 300 ms, in 200 requests. Longer history belongs to the indexer.
 */
export const DEFAULT_LEDGER_SCAN_BLOCKS = 20_000;

/** Hard ceiling on a single scan, so no caller can turn a feed read into an RPC flood. */
const MAX_LEDGER_SCAN_BLOCKS = 200_000;

/** Which contract event backs each feed. */
export const LEDGER_EVENT_NAMES = {
  registrations: "ProviderRegistered",
  heartbeats: "ProviderHeartbeat",
  receipts: "JobRecorded",
  ratings: "JobRated",
} as const satisfies Record<LedgerEventKind, string>;

/** keccak256 of a string's UTF-8 bytes. */
export function textHash(text: string | null | undefined): Hex {
  return keccak256(stringToBytes(text ?? ""));
}

/** The on-chain id of a broker job: `keccak256(utf8(brokerJobId))`. */
export function jobIdHash(brokerJobId: string): Hex {
  return textHash(brokerJobId);
}

/** The on-chain id of a broker provider: `keccak256(utf8(brokerProviderId))`. */
export function providerIdHash(brokerProviderId: string): Hex {
  return textHash(brokerProviderId);
}

/**
 * A tx hash as `bytes32`, or the zero hash when there is none.
 *
 * A job whose settlement never landed is still recorded (marked by a zero
 * `paymentTx`), so the absence of payment is itself on the record.
 */
export function bytes32OrZero(hash: string | null | undefined): Hex {
  return hash && isHex(hash) && hash.length === 66 ? (hash.toLowerCase() as Hex) : zeroHash;
}

/** A provider's agent id as the contract wants it: the decimal id, or `NO_AGENT`. */
export function agentIdArg(agentId: string | number | bigint | null | undefined): bigint {
  if (agentId === null || agentId === undefined || agentId === "") return NO_AGENT;
  const value = BigInt(agentId);
  if (value < 0n) throw new Error(`agent id must be non-negative, got ${String(agentId)}`);
  return value;
}

/** Inverse of `agentIdArg`: the decimal string, or null for `NO_AGENT`. */
export function agentIdFromArg(value: bigint | string | number): string | null {
  const id = BigInt(value);
  return id === NO_AGENT ? null : id.toString();
}

/**
 * Truncate a label to `maxBytes` of UTF-8 without splitting a character.
 *
 * Byte-based rather than character-based because the cost (and the
 * contract's view of length) is bytes: 64 emoji would be 256 bytes.
 */
export function ledgerLabel(label: string, maxBytes = LEDGER_LABEL_MAX_BYTES): string {
  const encoder = new TextEncoder();
  if (encoder.encode(label).length <= maxBytes) return label;
  let out = "";
  let used = 0;
  for (const char of label) {
    const size = encoder.encode(char).length;
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

/**
 * The compact capability list registered on-chain: `adapter:priceUsdMicros`
 * pairs, comma-separated, e.g. `"claude-code:10000,qwen:5000"`.
 *
 * A string rather than a struct array because it is read by humans on an
 * explorer and by the indexer, and is never computed on in Solidity.
 */
export function capabilityString(
  caps: ReadonlyArray<Pick<Capability, "adapter" | "priceUsdMicros">>,
): string {
  return caps
    .map((cap) => `${cap.adapter.replace(/[:,\s]/g, "")}:${Math.max(0, Math.round(cap.priceUsdMicros))}`)
    .join(",");
}

/** Parse `capabilityString` output back into pairs; malformed entries are skipped. */
export function parseCapabilityString(value: string): Array<{ adapter: string; priceUsdMicros: number }> {
  const out: Array<{ adapter: string; priceUsdMicros: number }> = [];
  for (const entry of value.split(",")) {
    const [adapter, price] = entry.trim().split(":");
    const priceUsdMicros = Number(price);
    if (adapter && Number.isInteger(priceUsdMicros) && priceUsdMicros >= 0) {
      out.push({ adapter, priceUsdMicros });
    }
  }
  return out;
}

/** Arguments for `registerProvider`, with every ID rule applied in one place. */
export function registerProviderArgs(input: {
  providerId: string;
  address: string;
  agentId: string | null | undefined;
  label: string;
  capabilities: ReadonlyArray<Pick<Capability, "adapter" | "priceUsdMicros">>;
}): readonly [Hex, Address, bigint, string, string] {
  return [
    providerIdHash(input.providerId),
    normalizeAddress(input.address),
    agentIdArg(input.agentId),
    ledgerLabel(input.label),
    capabilityString(input.capabilities),
  ];
}

/** The `JobReceipt` struct `recordJobs` takes. */
export interface JobReceiptStruct {
  jobId: Hex;
  agentId: bigint;
  buyer: Address;
  payTo: Address;
  amount: bigint;
  paymentTx: Hex;
  requestHash: Hex;
  resultHash: Hex;
  durationMs: number;
  ok: boolean;
}

/**
 * The zero address, used as `buyer` for a job whose payment never settled —
 * the receipt still goes out (marked by a zero `paymentTx` too), so an unpaid
 * job is visible on the record rather than simply missing from it.
 */
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/**
 * Build one receipt from broker-side facts, hashing the prompt and result so
 * neither ever reaches the chain.
 */
export function jobReceipt(input: {
  jobId: string;
  agentId: string | null | undefined;
  buyer: string | null | undefined;
  payTo: string;
  amount: string | bigint;
  paymentTx: string | null | undefined;
  prompt: string;
  result: string | null | undefined;
  durationMs: number;
  ok: boolean;
}): JobReceiptStruct {
  return {
    jobId: jobIdHash(input.jobId),
    agentId: agentIdArg(input.agentId),
    buyer: input.buyer ? normalizeAddress(input.buyer) : ZERO_ADDRESS,
    payTo: normalizeAddress(input.payTo),
    amount: BigInt(input.amount),
    paymentTx: bytes32OrZero(input.paymentTx),
    requestHash: textHash(input.prompt),
    resultHash: textHash(input.result ?? ""),
    // uint32 on-chain: ~49 days, far past JOB_TIMEOUT_MS; clamp rather than revert.
    durationMs: Math.min(Math.max(0, Math.round(input.durationMs)), 0xffff_ffff),
    ok: input.ok,
  };
}

// ---------------------------------------------------------------------------
// Ratings: the EIP-712 message a buyer signs (gaslessly) for the broker to relay
// ---------------------------------------------------------------------------

/** EIP-712 types for `XorvLedger.Rating`, field order exactly as `RATING_TYPEHASH`. */
export const RATING_TYPES = {
  Rating: [
    { name: "jobId", type: "bytes32" },
    { name: "value", type: "int128" },
    { name: "tag2", type: "string" },
    { name: "endpoint", type: "string" },
    { name: "feedbackURI", type: "string" },
    { name: "feedbackHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** The `Rating` struct as viem encodes it — also the `r` argument to `rateJob`. */
export interface RatingMessage {
  jobId: Hex;
  value: bigint;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: Hex;
  deadline: bigint;
}

/**
 * A rating as it arrives over JSON: numbers or decimal strings where the
 * struct wants bigints, so a browser can pass the broker's response straight in.
 */
export interface RatingInput {
  /** `jobIdHash(brokerJobId)` — the bytes32, not the broker's string id. */
  jobId: string;
  /** 0–100. */
  value: number | bigint | string;
  /** The adapter, by convention (e.g. "claude-code"); keep it under 32 bytes. */
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
  /** Unix seconds after which a relayed signature is refused. */
  deadline: number | bigint | string;
}

/** Validate and convert a `RatingInput` into the struct viem signs and sends. */
export function ratingMessage(rating: RatingInput): RatingMessage {
  if (!isHex(rating.jobId) || rating.jobId.length !== 66) {
    throw new Error(`rating.jobId must be a bytes32 (pass jobIdHash(brokerJobId)), got "${rating.jobId}"`);
  }
  if (!isHex(rating.feedbackHash) || rating.feedbackHash.length !== 66) {
    throw new Error(`rating.feedbackHash must be a bytes32, got "${rating.feedbackHash}"`);
  }
  const value = BigInt(rating.value);
  if (value < 0n || value > 100n) {
    throw new Error(`rating value must be an integer from 0 to 100, got ${String(rating.value)}`);
  }
  return {
    jobId: rating.jobId as Hex,
    value,
    tag2: rating.tag2,
    endpoint: rating.endpoint,
    feedbackURI: rating.feedbackURI,
    feedbackHash: rating.feedbackHash as Hex,
    deadline: BigInt(rating.deadline),
  };
}

/**
 * The full EIP-712 payload for a buyer's rating: pass it to viem's
 * `signTypedData` (or a wallet's `eth_signTypedData_v4` via `toJsonSafe`).
 *
 * Domain `{ name: "XorvLedger", version: "1", chainId, verifyingContract }`
 * binds the signature to one ledger on one chain, so it cannot be replayed
 * against a redeploy or the other network.
 */
export function ratingTypedData(opts: { network: string; ledger: string; rating: RatingInput }) {
  return {
    domain: {
      name: "XorvLedger",
      version: "1",
      chainId: networkConfig(opts.network).chainId,
      verifyingContract: normalizeAddress(opts.ledger),
    },
    types: RATING_TYPES,
    primaryType: "Rating" as const,
    message: ratingMessage(opts.rating),
  };
}

// ---------------------------------------------------------------------------
// Reading the feeds
// ---------------------------------------------------------------------------

export interface ReadLedgerEventsOptions<K extends LedgerEventKind> {
  kind: K;
  /** Newest-first cap on events returned; default 50, max 500. */
  limit?: number;
  /** Never scan below this block — the ledger's deploy block (`XORV_LEDGER_FROM_BLOCK`). */
  fromBlock?: bigint | number | string | null;
  /** Scan budget back from the latest block; default 20k, hard max 200k. */
  maxBlocks?: number;
  /** Windows fetched in parallel; default 4 (the public RPCs allow 25–50 rps). */
  concurrency?: number;
  /** Bring your own client (tests pass one over a mocked transport). */
  client?: PublicClient;
}

/** The ABI item behind a feed. */
export function ledgerEventAbi(kind: LedgerEventKind): AbiEvent {
  return getAbiItem({ abi: XORV_LEDGER_ABI, name: LEDGER_EVENT_NAMES[kind] }) as AbiEvent;
}

/**
 * Read one XorvLedger feed, newest first.
 *
 * The public Monad RPCs refuse `eth_getLogs` over more than 100 blocks — about
 * 30 seconds of chain — so "the last 50 receipts" is answered by walking
 * backwards from the latest block in ≤100-block windows until enough events
 * are found or the scan budget runs out. The budget is what keeps a quiet
 * ledger from turning one page load into thousands of requests; anything
 * deeper than it is the Envio indexer's job.
 *
 * Throws on RPC errors (a feed that silently comes back empty looks exactly
 * like a ledger nobody writes to). A single log that cannot be decoded is
 * skipped instead, so one foreign or malformed entry can't break the feed.
 */
export async function readLedgerEvents<K extends LedgerEventKind>(
  network: string,
  ledger: string,
  opts: ReadLedgerEventsOptions<K>,
): Promise<Array<LedgerEvent<K>>> {
  const limit = clampInt(opts.limit ?? 50, 1, 500);
  const budget = BigInt(clampInt(opts.maxBlocks ?? DEFAULT_LEDGER_SCAN_BLOCKS, 1, MAX_LEDGER_SCAN_BLOCKS));
  const concurrency = clampInt(opts.concurrency ?? 4, 1, 16);
  const address = normalizeAddress(ledger);
  const client = opts.client ?? publicClientFor(network);
  const event = ledgerEventAbi(opts.kind);

  const latest = await client.getBlockNumber();
  const byBudget = latest - budget + 1n;
  const deployFloor = opts.fromBlock === null || opts.fromBlock === undefined ? 0n : BigInt(opts.fromBlock);
  const floor = maxBig(maxBig(byBudget, 0n), deployFloor);
  if (floor > latest) return [];

  const windows: Array<[bigint, bigint]> = [];
  for (let to = latest; to >= floor; ) {
    const from = maxBig(floor, to - BigInt(MAX_LOG_BLOCK_RANGE) + 1n);
    windows.push([from, to]);
    to = from - 1n;
  }

  const found: Array<LedgerEvent<K>> = [];
  for (let i = 0; i < windows.length && found.length < limit; i += concurrency) {
    const batch = windows.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(([fromBlock, toBlock]) => client.getLogs({ address, event, fromBlock, toBlock })),
    );
    // Batches are newest-window-first; within a window, newest log first.
    for (const logs of results) {
      const ordered = [...logs].sort(compareLogsDesc);
      for (const log of ordered) {
        if (found.length >= limit) break;
        if (log.removed || log.blockNumber === null || log.transactionHash === null) continue;
        let data: LedgerEventDataMap[K] | null;
        try {
          data = shapeLedgerEvent(opts.kind, (log as { args?: unknown }).args);
        } catch {
          data = null;
        }
        if (!data) continue;
        found.push({
          kind: opts.kind,
          id: `${log.blockNumber}:${log.logIndex ?? 0}`,
          blockNumber: Number(log.blockNumber),
          txHash: log.transactionHash,
          at: 0,
          data,
        });
      }
    }
  }

  const times = await blockTimes(client, chainIdOf(network), found.map((e) => BigInt(e.blockNumber)));
  for (const event of found) event.at = times.get(BigInt(event.blockNumber)) ?? 0;
  return found;
}

function compareLogsDesc(
  a: { blockNumber: bigint | null; logIndex: number | null },
  b: { blockNumber: bigint | null; logIndex: number | null },
): number {
  const block = (b.blockNumber ?? 0n) - (a.blockNumber ?? 0n);
  if (block !== 0n) return block > 0n ? 1 : -1;
  return (b.logIndex ?? 0) - (a.logIndex ?? 0);
}

/**
 * Block timestamps never change once a block is final, so they are cached
 * process-wide: a feed refreshed every few seconds re-reads the same recent
 * blocks, and only the new ones should cost a request. Bounded, oldest-out.
 */
const blockTimeCache = new Map<string, number>();
const BLOCK_TIME_CACHE_MAX = 10_000;

async function blockTimes(
  client: PublicClient,
  chainId: number,
  blocks: bigint[],
): Promise<Map<bigint, number>> {
  const out = new Map<bigint, number>();
  const missing: bigint[] = [];
  for (const block of new Set(blocks)) {
    const cached = blockTimeCache.get(`${chainId}:${block}`);
    if (cached !== undefined) out.set(block, cached);
    else missing.push(block);
  }
  for (let i = 0; i < missing.length; i += 10) {
    const slice = missing.slice(i, i + 10);
    const fetched = await Promise.all(slice.map((blockNumber) => client.getBlock({ blockNumber })));
    fetched.forEach((block, index) => {
      const number = slice[index]!;
      const ms = Number(block.timestamp) * 1000;
      out.set(number, ms);
      blockTimeCache.set(`${chainId}:${number}`, ms);
      if (blockTimeCache.size > BLOCK_TIME_CACHE_MAX) {
        const oldest = blockTimeCache.keys().next().value;
        if (oldest !== undefined) blockTimeCache.delete(oldest);
      }
    });
  }
  return out;
}

type Args = Record<string, unknown>;

function hexArg(args: Args, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && isHex(value) ? value : null;
}

function bigArg(args: Args, key: string): bigint | null {
  const value = args[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  return null;
}

function numArg(args: Args, key: string): number | null {
  const value = bigArg(args, key);
  return value === null ? null : Number(value);
}

/**
 * Turn a decoded log's args into the JSON-safe feed shape, or null when a
 * required field is missing (a log decoded non-strictly from foreign data).
 */
export function shapeLedgerEvent<K extends LedgerEventKind>(
  kind: K,
  rawArgs: unknown,
): LedgerEventDataMap[K] | null {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return null;
  const args = rawArgs as Args;
  switch (kind) {
    case "registrations": {
      const providerId = hexArg(args, "providerId");
      const payTo = hexArg(args, "payTo");
      const agentId = bigArg(args, "agentId");
      if (!providerId || !payTo || agentId === null) return null;
      return {
        providerId,
        payTo: normalizeAddress(payTo),
        agentId: agentIdFromArg(agentId),
        label: typeof args.label === "string" ? args.label : "",
        capabilities: typeof args.capabilities === "string" ? args.capabilities : "",
      } satisfies LedgerEventDataMap["registrations"] as LedgerEventDataMap[K];
    }
    case "heartbeats": {
      const providerId = hexArg(args, "providerId");
      const activeJobs = numArg(args, "activeJobs");
      const capacity = numArg(args, "capacity");
      const uptimeSeconds = numArg(args, "uptimeSeconds");
      if (!providerId || activeJobs === null || capacity === null || uptimeSeconds === null) return null;
      return { providerId, activeJobs, capacity, uptimeSeconds } satisfies LedgerEventDataMap["heartbeats"] as LedgerEventDataMap[K];
    }
    case "receipts": {
      const jobId = hexArg(args, "jobId");
      const agentId = bigArg(args, "agentId");
      const buyer = hexArg(args, "buyer");
      const payTo = hexArg(args, "payTo");
      const amount = bigArg(args, "amount");
      const paymentTx = hexArg(args, "paymentTx");
      const requestHash = hexArg(args, "requestHash");
      const resultHash = hexArg(args, "resultHash");
      const durationMs = numArg(args, "durationMs");
      if (
        !jobId || agentId === null || !buyer || !payTo || amount === null || !paymentTx ||
        !requestHash || !resultHash || durationMs === null || typeof args.ok !== "boolean"
      ) {
        return null;
      }
      return {
        jobId,
        agentId: agentIdFromArg(agentId),
        buyer: normalizeAddress(buyer),
        payTo: normalizeAddress(payTo),
        amount: amount.toString(),
        paymentTx: paymentTx === zeroHash ? null : paymentTx,
        requestHash,
        resultHash,
        durationMs,
        ok: args.ok,
      } satisfies LedgerEventDataMap["receipts"] as LedgerEventDataMap[K];
    }
    case "ratings": {
      const jobId = hexArg(args, "jobId");
      const agentId = bigArg(args, "agentId");
      const buyer = hexArg(args, "buyer");
      const value = numArg(args, "value");
      const feedbackHash = hexArg(args, "feedbackHash");
      if (!jobId || agentId === null || !buyer || value === null || !feedbackHash) return null;
      return {
        jobId,
        agentId: agentId.toString(),
        buyer: normalizeAddress(buyer),
        value,
        feedbackHash,
      } satisfies LedgerEventDataMap["ratings"] as LedgerEventDataMap[K];
    }
    default:
      return null;
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
