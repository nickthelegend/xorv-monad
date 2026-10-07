/**
 * The Xorv domain model.
 *
 * These shapes cross process boundaries — CLI ⇄ broker ⇄ browser — so they are
 * plain JSON-safe data with no class instances and no bigints. Money is carried
 * as integer strings in the asset's smallest unit for the same reason: a job
 * priced at $0.001 must survive a round trip through JSON without a float
 * quietly rounding someone's earnings. On-chain `uint256`s (agent ids, token
 * amounts) travel as decimal strings; hashes and addresses as `0x` hex.
 *
 * Addresses are stored checksummed (`normalizeAddress`) and compared
 * case-insensitively (`sameAddress`).
 */

/** Which local agent CLI (or hosted model) a provider hands a job to. */
export type AdapterKind =
  | "claude-code"
  | "codex"
  | "grok"
  | "opencode"
  | "qwen"
  | "kimi"
  | "hunyuan"
  | "qwen-code"
  | "openai-compatible"
  | "echo";

/** Every adapter Xorv knows how to drive, in the order the wizard offers them. */
export const ADAPTER_KINDS: AdapterKind[] = [
  "claude-code",
  "codex",
  "grok",
  "opencode",
  "qwen",
  "kimi",
  "hunyuan",
  "qwen-code",
  "openai-compatible",
  "echo",
];

/**
 * One sellable unit of capacity: "I will run a job on this agent, for this
 * price". A provider advertises one capability per agent CLI they're sharing.
 */
export interface Capability {
  /** Stable id within the provider, e.g. "claude-code". */
  id: string;
  adapter: AdapterKind;
  /** Human label shown in the job board, e.g. "Claude Code (Opus)". */
  displayName: string;
  /** Model passed through to the CLI, when the provider pinned one. */
  model?: string | null;
  /** Price per job in millionths of a US dollar. $0.01 → 10000. */
  priceUsdMicros: number;
  /** How many jobs of this kind may run at once on this node. */
  maxConcurrency: number;
}

export type ProviderStatus = "online" | "busy" | "offline";

/** A live node on the network, as the broker sees it. */
export interface Provider {
  id: string;
  /** Display name chosen by the operator. */
  label: string;
  /** Checksummed EVM address that receives USDC for this provider's jobs (x402 `payTo`). */
  address: string;
  /**
   * The provider's ERC-8004 agent id (decimal string), or null for a node with
   * no on-chain identity yet. When set, the Identity Registry's `agentWallet`
   * for this id must equal `address` — XorvLedger enforces it.
   */
  agentId: string | null;
  /** Publicly reachable base URL of the node (usually a Cloudflare tunnel). */
  endpoint: string;
  capabilities: Capability[];
  status: ProviderStatus;
  /** Jobs in flight right now, across all capabilities. */
  activeJobs: number;
  /** Epoch ms of the last accepted heartbeat. */
  lastHeartbeatAt: number;
  registeredAt: number;
  /** xorv CLI version, for compatibility triage. */
  version: string;
  /** Free-form region hint the operator set, e.g. "eu-west". */
  region?: string | null;
  stats: ProviderStats;
  /** Hash of the XorvLedger `registerProvider` transaction, once it lands. */
  registryTxHash?: string | null;
}

export interface ProviderStats {
  jobsCompleted: number;
  jobsFailed: number;
  /** Lifetime earnings in micro-USDC (6dp), summed across settled jobs. */
  earnedUsdcMicros: number;
  /** Rolling mean job duration in ms; 0 until the first job lands. */
  avgDurationMs: number;
}

export type JobStatus =
  | "quoted"
  | "paid"
  | "assigned"
  | "running"
  | "completed"
  | "failed"
  | "expired";

/**
 * Which asset a job was paid in. USDC only: x402 `exact` on EVM moves ERC-20s
 * via EIP-3009/Permit2, so there is no native-MON payment path to offer.
 */
export type PayAsset = "usdc";

/** What the poster asked for. */
export interface JobRequest {
  prompt: string;
  /** Preferred adapter; when null the broker matches on price alone (or asks the router). */
  adapter?: AdapterKind | null;
  /** Ceiling the poster will pay, in micro-USD. */
  maxPriceUsdMicros: number;
  /** Optional label so posters can find their job again. */
  title?: string | null;
  /** Hard deadline in epoch ms; the broker won't assign past it. */
  deadlineAt?: number | null;
  /**
   * A private job: the buyer's X25519 public key (base64url, 32 bytes), derived
   * from their passkey. When set, the provider seals the result to this key
   * before it leaves the node, so the broker only ever stores and serves
   * ciphertext, and the on-chain resultHash commits to that ciphertext.
   * The prompt itself stays readable, because routing and safety screening
   * need it; anything that needs the plaintext *result* (the AI verifier) is
   * skipped for private jobs.
   */
  encryptTo?: string | null;
}

/** A single streamed step from the provider while the job runs. */
export interface JobEvent {
  at: number;
  kind: "status" | "message" | "tool_call" | "file_edit" | "error" | "reasoning";
  text: string;
}

/** Proof that a job was paid for, with everything needed to audit it. */
export interface PaymentRecord {
  asset: PayAsset;
  /** ERC-20 contract the payment moved (checksummed). */
  assetAddress: string;
  /** Amount in the asset's smallest unit, as an integer string. */
  amount: string;
  /** CAIP-2 network, e.g. "eip155:10143". */
  network: string;
  /** Hash of the settlement (`transferWithAuthorization`) transaction. */
  txHash: string;
  /** Address debited — the buyer. */
  payer: string;
  /** Address credited — the provider, never the broker. */
  payTo: string;
  settledAt: number;
  /** Direct explorer link, precomputed so every surface shows the same one. */
  explorerUrl: string;
  /** "escrow": the money waits in XorvEscrow until the job delivers. Absent on direct payments. */
  scheme?: "exact" | "escrow";
  /** How fast the settlement landed, and what it cost, as the broker measured and read it back. */
  timing?: ChainTiming;
  escrow?: EscrowRecord;
}

/**
 * One transaction's speed and cost on the chain, as the broker saw it: the
 * time from submitting it to holding its confirmed receipt, measured on the
 * broker's clock, and the block, gas and gas payer read from that receipt.
 */
export interface ChainTiming {
  /**
   * Milliseconds from submission to holding the receipt: the transaction has
   * executed in a proposed block (speculatively final on Monad). Null when it
   * wasn't measured.
   */
  confirmMs: number | null;
  /**
   * Milliseconds from submission until the RPC's `finalized` head reached the
   * transaction's block with the same hash (irreversible on Monad, about two
   * slots after proposal). Null when it wasn't observed.
   */
  finalMs?: number | null;
  /** "sync": the receipt came back in the send's own response (eth_sendRawTransactionSync); "async": it was polled. */
  sendMode?: "sync" | "async" | null;
  /** Where it was measured: a Monad network, or a local chain (a fork), whose timings are not Monad's. */
  chain?: "monad" | "local";
  blockNumber: number;
  /** Gas used, as an integer string. */
  gasUsed: string;
  /** gasUsed × effectiveGasPrice, in wei of the native token (MON), as an integer string. */
  gasPaidWei: string;
  /** Who paid that gas (the facilitator or the escrow's attester, never the buyer). */
  gasPayer: string;
}

/**
 * Where an escrowed payment stands. `txHash` on the payment is the funding
 * (buyer → XorvEscrow); `payTo` stays the provider the escrow releases to.
 */
export interface EscrowRecord {
  /** XorvEscrow's address. */
  address: string;
  /** The escrow's job id (bytes32), derived from the quote id. */
  jobId: string;
  /** Unix seconds; after this anyone may refund the buyer. */
  deadline: number;
  state: "funded" | "released" | "refunded";
  /** The provider the escrow currently pays on release (moves on reassignment). */
  provider: string;
  releaseTx?: string;
  refundTx?: string;
  reassignTxs?: string[];
  /** SHA-256 of the result, recorded on chain with the release. */
  resultHash?: string;
  /** When the release or refund was confirmed (ms since epoch). */
  settledAt?: number;
  /** The release's or refund's speed and cost. */
  settleTiming?: ChainTiming;
  /** Who settled it, when it wasn't this broker (a keeper's refund, a buyer's own release). */
  settledBy?: string;
  /** The last settlement attempt's error, while it is still being retried. */
  lastError?: string;
  explorerUrl: string;
}

/** How the AI router (Qwen) chose where a job goes. */
export interface JobRouting {
  /** Which preset made the call, e.g. "qwen". */
  by: string;
  /** Exact model id, e.g. "qwen3.8-max". */
  model: string;
  reason: string;
  /** The adapter it picked, or null when it deferred to the price matcher. */
  adapter: AdapterKind | null;
}

/** The prompt-safety screen (Hunyuan) verdict, taken before a provider sees the prompt. */
export interface JobScreening {
  by: string;
  model: string;
  verdict: "allow" | "block";
  reason: string;
}

/** The result verifier (Kimi) score, which becomes ERC-8004 reputation feedback. */
export interface JobVerification {
  by: string;
  model: string;
  /** 0–100. */
  score: number;
  pass: boolean;
  rationale: string;
  /** The `giveFeedback` transaction, once the verifier's feedback lands on-chain. */
  feedbackTxHash?: string | null;
}

/** The buyer's own rating, relayed through `XorvLedger.rateJob`. */
export interface JobRating {
  /** 0–100. */
  value: number;
  txHash: string;
  feedbackURI: string;
}

export interface Job {
  id: string;
  request: JobRequest;
  status: JobStatus;
  createdAt: number;
  /** The quote this job was bought through — how a settlement finds its job. */
  quoteId?: string | null;
  /** Provider the quote was pinned to; set as soon as the job is quoted. */
  providerId?: string | null;
  providerLabel?: string | null;
  /** The provider's payout address (x402 `payTo`), frozen at quote time. */
  providerAddress?: string | null;
  /** The provider's ERC-8004 agent id at quote time, for the ledger receipt. */
  providerAgentId?: string | null;
  capabilityId?: string | null;
  /** Agreed price in micro-USD, fixed at quote time. */
  priceUsdMicros?: number | null;
  payment?: PaymentRecord | null;
  assignedAt?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
  /** The answer, when the job succeeded. */
  result?: string | null;
  /** keccak256 of `result` (utf-8), recorded in the XorvLedger receipt so it's tamper-evident. */
  resultHash?: string | null;
  error?: string | null;
  events: JobEvent[];
  /** Hash of the XorvLedger `recordJobs` transaction carrying this job's receipt. */
  receiptTxHash?: string | null;
  routing?: JobRouting | null;
  screening?: JobScreening | null;
  verification?: JobVerification | null;
  rating?: JobRating | null;
}

// ---------------------------------------------------------------------------
// Wire messages: CLI → broker
// ---------------------------------------------------------------------------

export interface RegisterRequest {
  label: string;
  /** Payout address (checksummed or lowercase; the broker normalizes it). */
  address: string;
  /** ERC-8004 agent id, when the node has registered one (decimal string). */
  agentId?: string | null;
  endpoint: string;
  capabilities: Capability[];
  version: string;
  region?: string | null;
  /** Node's public key fingerprint; the broker echoes it back in the token. */
  nodeId: string;
}

export interface RegisterResponse {
  provider: Provider;
  /** Bearer token the node presents on heartbeat and job callbacks. */
  token: string;
  /** The XorvLedger registration, when publishing succeeded. */
  registry?: {
    contract: string;
    txHash: string;
    explorerUrl: string;
    agentId?: string | null;
  } | null;
}

export interface HeartbeatRequest {
  activeJobs: number;
  /** Seconds the node has been up, for the fleet view. */
  uptimeSeconds: number;
  /** Per-capability availability, so a busy adapter can be skipped. */
  available: Record<string, boolean>;
}

export interface HeartbeatResponse {
  ok: true;
  status: ProviderStatus;
  /** Jobs the broker wants this node to pick up right now. */
  pending: DispatchedJob[];
  /** Echoed so a node can tell when the broker restarted and re-register. */
  brokerEpoch: number;
}

/** The slice of a job's `PaymentRecord` its provider node is told about. */
export interface DispatchedPayment {
  /** The settlement (`transferWithAuthorization`) transaction. */
  txHash: string;
  /** USDC smallest units, integer string. */
  amount: string;
  /** Who was paid. */
  payTo: string;
}

/** What a node receives when work is handed to it. */
export interface DispatchedJob {
  jobId: string;
  capabilityId: string;
  prompt: string;
  /** Wall-clock ceiling for this job. */
  timeoutMs: number;
  /** The quoted price, in micro-USD, for display in the node UI. */
  priceUsdMicros: number;
  /**
   * The x402 settlement that paid for this job. Paid upfront to the quoted
   * provider, so a node reassigned the job after that provider failed it was
   * not paid: the node credits itself only when `payTo` is its own payout
   * address. Absent when the broker has no settlement record for the job, or
   * predates this field.
   */
  payment?: DispatchedPayment | null;
  /**
   * Set for a private job: the buyer's X25519 inbox key (`JobRequest.encryptTo`).
   * The node seals the result to it (`sealResult`) before reporting, and sends
   * only coarse status events while the job runs — no reasoning, no text.
   */
  encryptTo?: string | null;
}

// ---------------------------------------------------------------------------
// Ledger events (XorvLedger, decoded into JSON-safe shapes)
// ---------------------------------------------------------------------------

/** The four feeds XorvLedger emits, named for what a reader asks for. */
export type LedgerEventKind = "registrations" | "heartbeats" | "receipts" | "ratings";

/** `ProviderRegistered` */
export interface LedgerProviderRegistered {
  /** keccak256 of the broker's provider id. */
  providerId: string;
  payTo: string;
  /** Null when the provider has no ERC-8004 identity (`NO_AGENT` on-chain). */
  agentId: string | null;
  label: string;
  /** Compact `adapter:priceUsdMicros` list, e.g. "claude-code:10000,qwen:5000". */
  capabilities: string;
}

/** `ProviderHeartbeat` */
export interface LedgerHeartbeat {
  providerId: string;
  activeJobs: number;
  capacity: number;
  uptimeSeconds: number;
}

/** `JobRecorded` — the receipt. Carries hashes, never the prompt or result. */
export interface LedgerJobReceipt {
  /** keccak256 of the broker's job id. */
  jobId: string;
  agentId: string | null;
  buyer: string;
  payTo: string;
  /** USDC smallest units, integer string. */
  amount: string;
  /** Settlement tx hash, or null for a job recorded unpaid. */
  paymentTx: string | null;
  /** keccak256 of the prompt. */
  requestHash: string;
  /** keccak256 of the result text ("" for a failed job). */
  resultHash: string;
  durationMs: number;
  ok: boolean;
}

/** `JobRated` — a buyer rating relayed into ERC-8004 reputation. */
export interface LedgerJobRated {
  jobId: string;
  agentId: string;
  buyer: string;
  /** 0–100. */
  value: number;
  feedbackHash: string;
}

export interface LedgerEventDataMap {
  registrations: LedgerProviderRegistered;
  heartbeats: LedgerHeartbeat;
  receipts: LedgerJobReceipt;
  ratings: LedgerJobRated;
}

/** One decoded XorvLedger log, newest-first in a feed. */
export interface LedgerEvent<K extends LedgerEventKind = LedgerEventKind> {
  kind: K;
  /** `<blockNumber>:<logIndex>` — unique and sortable within a chain. */
  id: string;
  blockNumber: number;
  txHash: string;
  /** Block timestamp in epoch ms (Monad timestamps have 1 s resolution). */
  at: number;
  data: LedgerEventDataMap[K];
}

// ---------------------------------------------------------------------------
// Broker public wire shapes (what the HTTP API returns). Exported so the apps,
// the CLI and the MCP server import them instead of keeping drifting copies.
// ---------------------------------------------------------------------------

/** `GET /api/providers` → `{ providers: PublicProvider[] }` */
export interface PublicProvider {
  id: string;
  label: string;
  address: string;
  /** Explorer link for `address`. */
  addressUrl: string;
  agentId: string | null;
  /** Explorer link for the ERC-8004 agent NFT, when there is one. */
  agentUrl: string | null;
  endpoint: string;
  status: ProviderStatus;
  /** Whether the node holds a live WebSocket to the broker. */
  connected: boolean;
  activeJobs: number;
  capabilities: Capability[];
  lastHeartbeatAt: number;
  registeredAt: number;
  uptimeSeconds: number;
  version: string;
  region: string | null;
  stats: ProviderStats;
  registryTxHash: string | null;
}

/** `GET /api/jobs` → `{ jobs: PublicJob[] }`, `GET /api/jobs/:id` → `{ job: PublicJob }` */
export interface PublicJob {
  id: string;
  /**
   * A private job (`JobRequest.encryptTo` was set). Its `result` is a sealed
   * envelope (`parseSealedResult`), its `prompt` and `title` are redacted to
   * "" / null, and its events are coarse status lines only. The buyer's own
   * copy of the prompt lives in their passkey-encrypted history vault.
   */
  private?: boolean;
  title: string | null;
  prompt: string;
  adapter: AdapterKind | null;
  status: JobStatus;
  createdAt: number;
  assignedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  providerId: string | null;
  providerLabel: string | null;
  providerAddress: string | null;
  providerAgentId: string | null;
  priceUsdMicros: number | null;
  priceLabel: string | null;
  payment: PaymentRecord | null;
  result: string | null;
  resultHash: string | null;
  error: string | null;
  receiptTxHash: string | null;
  routing: JobRouting | null;
  screening: JobScreening | null;
  verification: JobVerification | null;
  rating: JobRating | null;
  eventCount: number;
  /** Present only on the single-job route. */
  events?: JobEvent[];
}

/** One `accepts` row as the quote advertises it — exactly what the 402 will ask for. */
export interface QuoteAccept {
  /** "escrow": paid into XorvEscrow, released to `extra.provider` on delivery. */
  scheme: "exact" | "escrow";
  network: string;
  /** ERC-20 address (USDC). */
  asset: string;
  /** Smallest units, integer string — frozen at quote time. */
  amount: string;
  /** The provider's address (exact), or XorvEscrow's (escrow); the broker is never the payee. */
  payTo: string;
  maxTimeoutSeconds: number;
  /** The token's EIP-712 domain, which the buyer signs against; escrow adds its terms. */
  extra: { name: string; version: string; escrow?: string; jobId?: string; deadline?: number; provider?: string };
}

/** `POST /api/quotes` → a frozen, single-use price commitment. */
export interface QuoteResponse {
  quoteId: string;
  /** POST here (with x402 payment) to buy the job. */
  payUrl: string;
  network: string;
  priceUsdMicros: number;
  priceLabel: string;
  /** USDC smallest units the 402 will ask for — compare before signing. */
  usdcAmount: string;
  expiresAt: number;
  provider: {
    id: string;
    label: string;
    address: string;
    addressUrl: string;
    agentId: string | null;
    capability: string;
    adapter: AdapterKind;
    model: string | null;
    stats: ProviderStats;
  };
  accepts: QuoteAccept[];
  /**
   * When the broker escrows payments: the contract, the job id the money is
   * bound to, and the refund deadline. Buyers pass `escrow.address` to the
   * client's quote check, which then signs the escrow option and nothing else.
   */
  escrow?: { address: string; jobId: string; deadline: number; explorerUrl: string } | null;
  routing?: JobRouting | null;
  screening?: JobScreening | null;
}

/** An AI role's configuration as `/api/network` reports it; null when the role is off. */
export interface AiRoleInfo {
  by: string;
  model: string;
}

/** `GET /api/network` */
export interface NetworkInfo {
  network: string;
  chainId: number;
  label: "testnet" | "mainnet";
  explorerUrl: string;
  usdc: { address: string; symbol: string; decimals: number };
  facilitator: {
    mode: "self" | "hosted";
    description: string;
    /** The facilitator EOA that pays settlement gas; null when a hosted one manages it. */
    address: string | null;
  };
  ledger: { address: string; url: string } | null;
  erc8004: { identity: string; reputation: string };
  indexer: { url: string } | null;
  /** Ledger writes published since boot, per feed. */
  published: Record<LedgerEventKind, number>;
  lastPublishError: string | null;
  ai: { router: AiRoleInfo | null; screener: AiRoleInfo | null; verifier: AiRoleInfo | null };
  feeBps: number;
  /** Broker boot epoch; changes on restart. */
  epoch: number;
  stats: {
    providersLive: number;
    providersConnected: number;
    capacity: number;
    jobsTotal: number;
    jobsCompleted: number;
    /** Reached a provider: direct payments plus escrows that released. */
    paidUsdMicros: number;
    /** Funded into XorvEscrow and not yet released or refunded. */
    heldUsdMicros?: number;
    /** Returned to buyers by XorvEscrow. */
    refundedUsdMicros?: number;
    /** Median ms from submitting a payment to its confirmed receipt, over recent jobs; null before any. */
    settleMedianMs?: number | null;
    /** Median ms for an escrow release or refund to confirm; null before any. */
    releaseMedianMs?: number | null;
    /** How many recent settlements the medians are over. */
    timingSamples?: number;
    /** Where those timings were measured: a Monad network, or a local chain whose timings are not Monad's. */
    timingChain?: "monad" | "local";
  };
  heartbeatIntervalMs: number;
  /** XorvEscrow, when jobs are paid into escrow; null pays providers directly. */
  escrow?: {
    address: string;
    url: string;
    /** Seconds from quote until anyone (a keeper) may refund the buyer. */
    deadlineSeconds: number;
    /** Cleanverse CVI: when set, only active A-Pass holders can fund the escrow or be paid by it. */
    identityGate: { address: string; kind: "cleanverse"; apass: string | null; validator: string | null; pool: string | null } | null;
  } | null;
}
