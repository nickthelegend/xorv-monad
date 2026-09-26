/**
 * The Xorv domain model.
 *
 * These shapes cross process boundaries — CLI ⇄ broker ⇄ browser — so they are
 * plain JSON-safe data with no class instances and no bigints. Money is carried
 * as integer strings in the asset's smallest unit for the same reason: a job
 * priced at $0.001 must survive a round trip through JSON without a float
 * quietly rounding someone's earnings.
 */

/** Which local agent CLI a provider hands a job to. */
export type AdapterKind =
  | "claude-code"
  | "codex"
  | "grok"
  | "opencode"
  | "openai-compatible"
  | "echo";

/** Every adapter Xorv knows how to drive, in the order the wizard offers them. */
export const ADAPTER_KINDS: AdapterKind[] = [
  "claude-code",
  "codex",
  "grok",
  "opencode",
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
  /** Hedera account that receives USDC/HBAR for this provider's jobs. */
  accountId: string;
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
  /** Consensus timestamp of the HCS registry message, when it was published. */
  registryConsensusAt?: string | null;
}

export interface ProviderStats {
  jobsCompleted: number;
  jobsFailed: number;
  /** Lifetime earnings in micro-USDC (6dp), summed across settled jobs. */
  earnedUsdcMicros: number;
  /** Lifetime earnings in tinybars, for jobs paid in HBAR. */
  earnedTinybars: number;
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

/** Which asset a job was paid in. */
export type PayAsset = "usdc" | "hbar";

/** What the poster asked for. */
export interface JobRequest {
  prompt: string;
  /** Preferred adapter; when null the broker matches on price alone. */
  adapter?: AdapterKind | null;
  /** Ceiling the poster will pay, in micro-USD. */
  maxPriceUsdMicros: number;
  /** Optional label so posters can find their job again. */
  title?: string | null;
  /** Hard deadline in epoch ms; the broker won't assign past it. */
  deadlineAt?: number | null;
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
  /** Hedera token id, or "0.0.0" for native HBAR. */
  assetId: string;
  /** Amount in the asset's smallest unit, as an integer string. */
  amount: string;
  network: string;
  /** Hedera transaction id of the settled transfer. */
  transactionId: string;
  /** Account debited. */
  payer: string;
  /** Account credited — the provider. */
  payTo: string;
  settledAt: number;
  /** Direct HashScan link, precomputed so every surface shows the same one. */
  hashscanUrl: string;
}

export interface Job {
  id: string;
  request: JobRequest;
  status: JobStatus;
  createdAt: number;
  /** Provider the quote was pinned to; set as soon as the job is quoted. */
  providerId?: string | null;
  providerLabel?: string | null;
  providerAccountId?: string | null;
  capabilityId?: string | null;
  /** Agreed price in micro-USD, fixed at quote time. */
  priceUsdMicros?: number | null;
  payment?: PaymentRecord | null;
  assignedAt?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
  /** The answer, when the job succeeded. */
  result?: string | null;
  /** sha-256 of `result`, mirrored into the HCS receipt so it's tamper-evident. */
  resultHash?: string | null;
  error?: string | null;
  events: JobEvent[];
  /** Consensus timestamp of the HCS receipt, once published. */
  receiptConsensusAt?: string | null;
}

// ---------------------------------------------------------------------------
// Wire messages: CLI → broker
// ---------------------------------------------------------------------------

export interface RegisterRequest {
  label: string;
  accountId: string;
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
  /** HCS registry message, when publishing succeeded. */
  registry?: { topicId: string; transactionId: string; hashscanUrl: string } | null;
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

/** What a node receives when work is handed to it. */
export interface DispatchedJob {
  jobId: string;
  capabilityId: string;
  prompt: string;
  /** Wall-clock ceiling for this job. */
  timeoutMs: number;
  /** Price the provider will be paid, in micro-USD, for display in the node UI. */
  priceUsdMicros: number;
}

// ---------------------------------------------------------------------------
// HCS envelopes
// ---------------------------------------------------------------------------

export type HcsMessageKind = "provider.registered" | "provider.heartbeat" | "job.receipt";

export interface HcsEnvelope<T> {
  v: number;
  kind: HcsMessageKind;
  at: number;
  data: T;
}

export interface HcsProviderRegistered {
  providerId: string;
  label: string;
  accountId: string;
  capabilities: Array<{ id: string; adapter: string; priceUsdMicros: number }>;
  version: string;
}

export interface HcsHeartbeat {
  providerId: string;
  activeJobs: number;
  capacity: number;
  uptimeSeconds: number;
}

export interface HcsJobReceipt {
  jobId: string;
  providerId: string;
  providerAccountId: string;
  payer: string;
  asset: string;
  amount: string;
  transactionId: string;
  /** sha-256 of the result text, so the payload is auditable without publishing it. */
  resultHash: string;
  durationMs: number;
  ok: boolean;
}
