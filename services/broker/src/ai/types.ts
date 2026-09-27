/**
 * What the AI roles leave behind on quotes and jobs, and how they report
 * themselves.
 *
 * Each record extends the protocol's wire type (`JobScreening`, `JobRouting`,
 * `JobVerification`) with the detail the product shows and an operator debugs
 * with: the screen's category, the router's difficulty call and whether it
 * fell back to the price matcher, the verifier's flags and its ERC-8004
 * bookkeeping, and every role's latency. They go out on the wire as they are
 * — a consumer typed against the protocol shape reads the fields it knows and
 * ignores the rest — so the protocol package doesn't have to change every
 * time a role learns to say a little more.
 */

import type {
  AdapterKind,
  AiRoleInfo,
  JobRouting,
  JobScreening,
  JobVerification,
  LlmPresetKind,
} from "@xorv/protocol";

export type AiRoleName = "screener" | "router" | "verifier";

/**
 * The abuse classes the screen blocks — every one of them aimed at the
 * provider's machine, which is who the screen protects. `none` is an allowed
 * prompt; `unscreened` means the screen could not run (see `unavailable`).
 */
export const SCREEN_CATEGORIES = [
  "none",
  "credential_exfiltration",
  "malware",
  "destructive_command",
  "sandbox_escape",
  "prompt_injection",
  "other_abuse",
] as const;
export type ScreenCategory = (typeof SCREEN_CATEGORIES)[number] | "unscreened";

/** What a quote does when the screen can't give a verdict. */
export type ScreenFailMode = "open" | "closed";

export interface ScreeningRecord extends JobScreening {
  category: ScreenCategory;
  /** Wall time of the screen, in ms. */
  ms: number;
  /**
   * The screen didn't answer (timeout, provider error, malformed output) and
   * the verdict is the configured fail mode rather than the model's call.
   * The reason says so in words, so nobody mistakes it for a real "allow".
   */
  unavailable?: boolean;
  failMode?: ScreenFailMode;
}

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** The router's tools: five reads of live state, and the terminal pick. */
export const ROUTER_TOOLS = [
  "list_candidates",
  "erc8004_reputation",
  "recent_receipts",
  "indexer_provider_stats",
  "nansen_trust",
  "select_provider",
] as const;
export type RouterToolName = (typeof ROUTER_TOOLS)[number];

/** An explorer link a trace step points at (an agent, a transaction, a wallet). */
export interface TraceLink {
  label: string;
  url: string;
}

/**
 * One tool call in the router's trace. Everything here is the broker's own
 * words about public data — the arguments are the validated ids, never the
 * model's raw text, and the summary is a template filled from the tool's
 * result — so the trace can be shown next to a private job without saying
 * anything about its prompt.
 */
export interface RoutingStep {
  tool: RouterToolName;
  /** Validated arguments: a candidate's providerId / agentId, or "(not a candidate)". */
  args: Record<string, string | null>;
  /** What the tool found, in one line the buyer can read. */
  summary: string;
  /** Wall time of the tool call, ms. */
  ms: number;
  /** False when the tool couldn't answer (timeout, source down, unknown id). */
  ok: boolean;
  /** Where the data came from. */
  source?: "registry" | "chain" | "indexer" | "rpc" | "memory" | "nansen" | "none";
  links?: TraceLink[];
}

export interface RoutingRecord extends JobRouting {
  /** The router's read of the task; null when it didn't answer. */
  difficulty: Difficulty | null;
  ms: number;
  /**
   * Set when the router's answer was not used and the deterministic matcher
   * chose instead: `timeout`, `error` (the provider failed) or `invalid`
   * (malformed output, or a pick that isn't a live candidate under the
   * buyer's ceiling). `reason` explains it for the buyer.
   */
  fallback?: "timeout" | "error" | "invalid";
  /** How many live capabilities the router chose between. */
  candidates: number;
  /** The provider the router picked; null when it fell back (the matcher chose). */
  providerId?: string | null;
  providerLabel?: string | null;
  /** The picked provider's ERC-8004 agent, when it has one. */
  agentId?: string | null;
  /** The agent trace: every tool call, in order, with what it found. */
  steps?: RoutingStep[];
  /** Model turns used. */
  turns?: number;
  /** Tool calls made (reads; the terminal select_provider not counted). */
  toolCalls?: number;
  /** Whether the model thought before answering (Qwen `enable_thinking`). */
  thinking?: boolean;
}

export interface VerificationRecord extends JobVerification {
  ms: number;
  flags: string[];
  /** Epoch ms of the verdict — also the feedback file's `createdAt`, so it must never change. */
  at: number;
  /** The provider's ERC-8004 agent the score was written to. */
  agentId?: string | null;
  /** The verifier EOA that submitted `giveFeedback` (the ERC-8004 client address). */
  verifier?: string | null;
  feedbackURI?: string | null;
  /** keccak256 of the served feedback file, committed on-chain. */
  feedbackHash?: string | null;
  /** Why the on-chain write didn't land, when it didn't. The score itself still stands. */
  feedbackError?: string | null;
}

/**
 * One live capability as the router sees it: the provider that offers it,
 * what it costs, and the track record the broker already holds. The router
 * picks a provider (and with it the adapter); the richer evidence — on-chain
 * reputation, receipts, indexer aggregates, Nansen trust — it fetches with
 * its tools.
 */
export interface RouteCandidate {
  providerId: string;
  /** The provider's own label (provider-chosen text: shown, never trusted). */
  label: string;
  /** Payout address (x402 payTo). */
  address: string;
  /** ERC-8004 agent id, verified at registration; null without an identity. */
  agentId: string | null;
  capabilityId: string;
  adapter: AdapterKind;
  displayName: string;
  model: string | null;
  priceUsdMicros: number;
  /** Heartbeat status: "online" has a free slot now, "busy" is at capacity on some adapter. */
  liveness: "online" | "busy";
  /** Seconds since the last heartbeat. */
  heartbeatAgeS: number;
  /** Completed / (completed + failed); null for a provider with no history yet. */
  successRate: number | null;
  jobs: number;
  /** Mean buyer rating (0–100) of this provider's jobs; null when unrated. */
  avgRating: number | null;
  /** Mean Kimi verification score (0–100); null when never verified. */
  avgVerified: number | null;
  /** The provider holds a verified ERC-8004 identity, so its reputation is public and portable. */
  hasAgent: boolean;
}

/** Per-role counters and latency, for /api/network and the boot banner. */
export interface RoleStats {
  calls: number;
  ok: number;
  failed: number;
  timeouts: number;
  /** Latency of the most recent call, ms (successful or not). */
  lastMs: number | null;
  /** Mean latency of successful calls, ms. */
  avgMs: number | null;
  /** The most recent failure, API keys redacted. */
  lastError: string | null;
  lastAt: number | null;
}

/**
 * An enabled role as `/api/network` reports it under `ai`: the protocol's
 * `AiRoleInfo` (`by`, `model`) plus the fields the network page shows. A role
 * that is off stays `null` there — that is the protocol's contract, and what
 * the CLI and the apps test for.
 */
export interface EnabledRoleInfo extends AiRoleInfo {
  enabled: true;
  provider: LlmPresetKind;
  /** What the UI shows, e.g. "Qwen 3.8 Max". */
  label: string;
  timeoutMs: number;
}

/**
 * Every role's state, on or off — `/api/network` reports these under
 * `aiRoles`, because "why is the router off?" is the first thing an operator
 * asks and `null` can't answer it.
 */
export interface AiRoleReport {
  enabled: boolean;
  provider: LlmPresetKind;
  label: string;
  model: string;
  timeoutMs: number;
  /** Why the role is off; null when it is on. */
  reason: string | null;
  stats: RoleStats | null;
  /** Screener only. */
  failMode?: ScreenFailMode;
  /** Screener only: the TokenHub reasoning_effort it asks for ("provider" sends none). */
  reasoning?: "low" | "high" | "provider";
  /** Router only: the agent loop's bounds. */
  agent?: { maxTurns: number; maxToolCalls: number; thinking: boolean; thinkingBudget: number | null };
  /** Verifier only: where its scores go on-chain. */
  feedback?: VerifierFeedbackReport;
}

export interface VerifierFeedbackReport {
  /** Whether scores are written to the ERC-8004 Reputation Registry. */
  onChain: boolean;
  /** The verifier EOA (the ERC-8004 client address), when there is a key. */
  address: string | null;
  reputationRegistry: string;
  tag1: string;
  published: number;
  failed: number;
  lastError: string | null;
  /** Why scores stay off-chain, when they do. */
  reason: string | null;
}
