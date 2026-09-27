/**
 * The router's tools: what Qwen can read before it picks a provider.
 *
 * Five reads of live state and one terminal call, in the OpenAI function
 * calling shape DashScope's compatible mode accepts:
 *
 *   list_candidates         the live, matchable providers under the buyer's ceiling
 *   erc8004_reputation      an agent's reputation on the ERC-8004 Reputation Registry
 *                           (buyer ratings relayed by XorvLedger, Kimi verifier scores)
 *                           and whether the Identity Registry's agent wallet is the payee
 *   recent_receipts         the provider's XorvLedger JobRecorded / JobRated history
 *   indexer_provider_stats  the provider's aggregates from the Envio indexer
 *   nansen_trust            the public view of the payout wallet's Nansen trust signal
 *   select_provider         the answer
 *
 * Each read goes through `RouterData` (router-data.ts wires the real sources:
 * Monad RPC, the ledger reader, the indexer, the trust cache) under its own
 * timeout, and comes back two ways: a small JSON object for the model, and a
 * `RoutingStep` for the trace — a one-line summary in the broker's own words,
 * the validated arguments, and explorer links. The model never gets to write
 * into the trace: an id it made up is recorded as "(not a candidate)", and a
 * source that failed says so without quoting the error.
 *
 * Every tool only answers about the candidates in front of it. That keeps
 * the model on task (no reading arbitrary agents with the broker's RPC) and
 * makes a hallucinated id a cheap, visible miss instead of a wrong answer.
 */

import {
  explorerAddress,
  explorerAgent,
  explorerTx,
  formatUsd,
  formatUsdc,
  shortHex,
  type ChatTool,
  type JobRequest,
} from "@xorv/protocol";
import type { PublicTrustSignal } from "../trust/index.js";
import { clip } from "./client.js";
import type { RouteCandidate, RouterToolName, RoutingStep, TraceLink } from "./types.js";

// ---------------------------------------------------------------------------
// What the data sources return
// ---------------------------------------------------------------------------

export interface Erc8004Read {
  agentId: string;
  identityRegistry: string;
  reputationRegistry: string;
  /** XorvLedger, the client every buyer rating is relayed from; null when none is configured. */
  ledger: string | null;
  /** The verifier EOA whose "xorv-verified" scores count; null when the verifier writes nothing on-chain. */
  verifier: string | null;
  /** getSummary over [ledger]; null when there is no ledger to ask or the read failed. */
  buyerRatings: { count: number; average: number | null } | null;
  /** getSummary over [verifier]; null when there is no verifier or the read failed. */
  verifierScores: { count: number; average: number | null } | null;
  /** getAgentWallet; null when unset (the registry clears it on every transfer). */
  agentWallet: string | null;
  walletMatchesPayout: boolean;
  /** Which of the three reads failed, if any ("buyer ratings", "verifier scores", "agent wallet"). */
  failed: string[];
}

export interface ReceiptsRead {
  source: "indexer" | "rpc" | "none";
  ledger: string | null;
  /** How many of the ledger's latest receipts were searched. */
  scanned: number;
  receipts: number;
  ok: number;
  failed: number;
  /** USDC base units over paid, delivered receipts. */
  earnedUnits: string;
  lastAt: number | null;
  ratings: number;
  avgRating: number | null;
  /** Newest first, at most three. */
  latest: Array<{ txHash: string; ok: boolean; at: number }>;
  /** The indexer was configured but failed, and the RPC answered. */
  indexerDown?: boolean;
}

export type IndexerStatsRead =
  | { configured: false }
  | { configured: true; found: false }
  | {
      configured: true;
      found: true;
      jobsTotal: number;
      jobsOk: number;
      jobsFailed: number;
      successRate: number;
      /** USDC base units. */
      earnedUnits: string;
      avgDurationMs: number;
      ratingsCount: number;
      avgRating: number;
      lastJobAt: number | null;
      agent: {
        feedbackCount: number;
        buyerRatingCount: number;
        buyerRatingAvg: number;
        verifiedCount: number;
        verifiedScore: number;
      } | null;
    };

export interface TrustRead {
  /** Whether this broker builds Nansen signals at all. */
  enabled: boolean;
  signal: PublicTrustSignal | null;
}

/** The provider a read is about. */
export interface CandidateRef {
  providerId: string;
  address: string;
  agentId: string | null;
}

/**
 * Where the router's reads come from. Every member is optional: a broker
 * without an indexer, a ledger or Nansen still routes, and the tool tells the
 * model (and the trace tells the buyer) that the source isn't there.
 */
export interface RouterData {
  network: string;
  erc8004?(agentId: string, payTo: string): Promise<Erc8004Read>;
  receipts?(candidate: CandidateRef): Promise<ReceiptsRead>;
  indexerStats?(providerId: string): Promise<IndexerStatsRead>;
  trust?(address: string): TrustRead;
}

// ---------------------------------------------------------------------------
// Tool definitions (what the model is offered)
// ---------------------------------------------------------------------------

const providerIdParam = {
  type: "object",
  properties: { providerId: { type: "string", description: "A providerId from list_candidates." } },
  required: ["providerId"],
  additionalProperties: false,
};

export const SELECT_PROVIDER_TOOL: ChatTool = {
  type: "function",
  function: {
    name: "select_provider",
    description:
      "Your final answer: the provider that should run this job. Call it exactly once, when you have decided. " +
      "The providerId must come from list_candidates.",
    parameters: {
      type: "object",
      properties: {
        providerId: { type: "string", description: "The chosen providerId from list_candidates." },
        adapter: {
          type: "string",
          description: "Which of that provider's adapters to use, when it lists more than one. Optional.",
        },
        reason: {
          type: "string",
          description: "One plain sentence for the buyer: why this provider suits this job, citing the evidence you read.",
        },
        difficulty: { type: "string", enum: ["easy", "medium", "hard"], description: "Your read of the task." },
      },
      required: ["providerId", "reason"],
      additionalProperties: false,
    },
  },
};

export const ROUTER_TOOLS_SPEC: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "list_candidates",
      description:
        "Every live provider that could take this job now, under the buyer's price ceiling, cheapest first: " +
        "providerId, label, adapter, model, price, ERC-8004 agentId, liveness, and the broker's own success and rating stats. Start here.",
      parameters: {
        type: "object",
        properties: { adapter: { type: "string", description: "Only list this adapter. Optional." } },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "erc8004_reputation",
      description:
        "Read an agent's reputation on Monad from the ERC-8004 Reputation Registry: the average and count of buyer ratings " +
        "(relayed by XorvLedger, one per paid job) and of Kimi verifier scores, plus whether the Identity Registry's " +
        "agent wallet is the provider's payout address.",
      parameters: {
        type: "object",
        properties: { agentId: { type: "string", description: "A candidate's ERC-8004 agentId from list_candidates." } },
        required: ["agentId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recent_receipts",
      description:
        "The provider's recent job receipts on XorvLedger (JobRecorded: delivered or failed, paid amount) and the buyer " +
        "ratings attached to them (JobRated).",
      parameters: providerIdParam,
    },
  },
  {
    type: "function",
    function: {
      name: "indexer_provider_stats",
      description:
        "The provider's lifetime aggregates from the Envio indexer of XorvLedger and ERC-8004: jobs, success rate, " +
        "average buyer rating, verifier score, USDC earned.",
      parameters: providerIdParam,
    },
  },
  {
    type: "function",
    function: {
      name: "nansen_trust",
      description:
        "The Nansen trust score (0-100) of the provider's payout wallet: wallet age, activity, related wallets and risk flags.",
      parameters: providerIdParam,
    },
  },
  SELECT_PROVIDER_TOOL,
];

// ---------------------------------------------------------------------------
// Running a tool
// ---------------------------------------------------------------------------

/** How many candidate rows list_candidates returns: past this the model is reading a phone book. */
export const LIST_CANDIDATES_MAX_ROWS = 12;

export interface ToolContext {
  network: string;
  request: JobRequest;
  /** The live candidates under the ceiling, in matcher order. */
  candidates: RouteCandidate[];
  data: RouterData | null;
  timeoutMs: number;
  /** The loop's overall budget. */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface ToolOutcome {
  /** What the model reads back (serialized into the tool message). */
  result: Record<string, unknown>;
  step: RoutingStep;
}

/** Recorded in place of an argument the model made up. */
export const NOT_A_CANDIDATE = "(not a candidate)";

type ReadTool = Exclude<RouterToolName, "select_provider">;

class ToolTimeout extends Error {}

function isReadTool(name: string): name is ReadTool {
  return (
    name === "list_candidates" ||
    name === "erc8004_reputation" ||
    name === "recent_receipts" ||
    name === "indexer_provider_stats" ||
    name === "nansen_trust"
  );
}

/** Parse a tool call's argument text into an object; anything else is an empty object. */
export function parseToolArgs(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function idArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

const pct = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
const round = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A promise that gives up after `ms` or when the loop's budget ends. */
function bounded<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeout()), Math.max(1, ms));
    timer.unref?.();
    const onAbort = () => reject(new ToolTimeout());
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Run one read tool. Never throws: an unknown tool, a made-up id, a missing
 * source, a timeout or a failing source all come back as an `error` the model
 * can read and a step that says what happened.
 */
export async function runReadTool(name: string, argText: string, ctx: ToolContext): Promise<ToolOutcome> {
  const started = Date.now();
  const args = parseToolArgs(argText);
  if (!isReadTool(name)) {
    return {
      result: { error: `unknown tool "${clip(name, 40)}"` },
      step: { tool: "list_candidates", args: {}, summary: "asked for a tool that doesn't exist", ms: 0, ok: false, source: "none" },
    };
  }
  try {
    const outcome = await bounded(readTool(name, args, ctx), ctx.timeoutMs, ctx.signal);
    return { ...outcome, step: { ...outcome.step, ms: Date.now() - started } };
  } catch (err) {
    const timedOut = err instanceof ToolTimeout;
    ctx.log?.(`[broker] router tool ${name} ${timedOut ? "timed out" : `failed: ${err instanceof Error ? err.message : String(err)}`}`);
    const what = TOOL_WHAT[name];
    return {
      result: { error: timedOut ? `${what} timed out` : `${what} failed` },
      step: {
        tool: name,
        args: stepArgs(name, args, ctx),
        summary: `couldn't read ${what}: ${timedOut ? `timed out after ${ctx.timeoutMs}ms` : "the source failed"}`,
        ms: Date.now() - started,
        ok: false,
        source: "none",
      },
    };
  }
}

const TOOL_WHAT: Record<ReadTool, string> = {
  list_candidates: "the live candidates",
  erc8004_reputation: "the ERC-8004 reputation",
  recent_receipts: "the XorvLedger receipts",
  indexer_provider_stats: "the Envio indexer stats",
  nansen_trust: "the Nansen trust signal",
};

/** The arguments as the trace records them: validated ids only. */
function stepArgs(name: ReadTool, args: Record<string, unknown>, ctx: ToolContext): Record<string, string | null> {
  if (name === "list_candidates") {
    const adapter = idArg(args.adapter);
    if (!adapter) return {};
    return { adapter: ctx.candidates.some((c) => c.adapter === adapter) ? adapter : NOT_A_CANDIDATE };
  }
  if (name === "erc8004_reputation") {
    const agentId = idArg(args.agentId);
    return { agentId: ctx.candidates.some((c) => c.agentId !== null && c.agentId === agentId) ? agentId : NOT_A_CANDIDATE };
  }
  const providerId = idArg(args.providerId);
  return { providerId: ctx.candidates.some((c) => c.providerId === providerId) ? providerId : NOT_A_CANDIDATE };
}

function unknownCandidate(name: ReadTool, args: Record<string, string | null>, what: string): Omit<ToolOutcome, "step"> & {
  step: RoutingStep;
} {
  return {
    result: { error: `${what} is not one of the candidates; use an id from list_candidates` },
    step: { tool: name, args, summary: `asked about ${what} that isn't a live candidate`, ms: 0, ok: false, source: "none" },
  };
}

async function readTool(name: ReadTool, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const recorded = stepArgs(name, args, ctx);
  switch (name) {
    case "list_candidates":
      return listCandidates(recorded, ctx);
    case "erc8004_reputation": {
      const agentId = recorded.agentId;
      const candidate = ctx.candidates.find((c) => c.agentId !== null && c.agentId === agentId);
      if (!candidate || !agentId) return unknownCandidate(name, recorded, "an agent");
      return erc8004Reputation(candidate, agentId, recorded, ctx);
    }
    default: {
      const candidate = ctx.candidates.find((c) => c.providerId === recorded.providerId);
      if (!candidate) return unknownCandidate(name, recorded, "a provider");
      if (name === "recent_receipts") return recentReceipts(candidate, recorded, ctx);
      if (name === "indexer_provider_stats") return indexerStats(candidate, recorded, ctx);
      return nansenTrust(candidate, recorded, ctx);
    }
  }
}

function listCandidates(recorded: Record<string, string | null>, ctx: ToolContext): ToolOutcome {
  const filter = recorded.adapter && recorded.adapter !== NOT_A_CANDIDATE ? recorded.adapter : null;
  const rows = filter ? ctx.candidates.filter((c) => c.adapter === filter) : ctx.candidates;
  const shown = rows.slice(0, LIST_CANDIDATES_MAX_ROWS);
  const providers = new Set(rows.map((c) => c.providerId));
  const adapters = [...new Set(rows.map((c) => c.adapter))];
  const ceiling = formatUsd(ctx.request.maxPriceUsdMicros);
  return {
    result: {
      ceiling,
      count: rows.length,
      shown: shown.length,
      candidates: shown.map((c) => ({
        providerId: c.providerId,
        label: clip(c.label, 40),
        adapter: c.adapter,
        model: c.model ? clip(c.model, 40) : null,
        price: formatUsd(c.priceUsdMicros),
        agentId: c.agentId,
        liveness: c.liveness,
        heartbeatAgeS: c.heartbeatAgeS,
        jobs: c.jobs,
        successRate: pct(c.successRate),
        avgRating: round(c.avgRating),
        avgVerified: round(c.avgVerified),
      })),
    },
    step: {
      tool: "list_candidates",
      args: recorded,
      summary:
        rows.length === 0
          ? `no live candidate${filter ? ` for ${filter}` : ""} under ${ceiling}`
          : `listed ${plural(rows.length, "live option")} from ${plural(providers.size, "provider")} under ${ceiling}` +
            ` (${adapters.slice(0, 6).join(", ")}${adapters.length > 6 ? ", …" : ""})`,
      ms: 0,
      ok: true,
      source: "registry",
    },
  };
}

async function erc8004Reputation(
  candidate: RouteCandidate,
  agentId: string,
  recorded: Record<string, string | null>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const links: TraceLink[] = [{ label: `agent #${agentId}`, url: explorerAgent(ctx.network, agentId) }];
  if (!ctx.data?.erc8004) {
    return {
      result: { agentId, available: false, note: "this broker cannot read the ERC-8004 registries right now" },
      step: { tool: "erc8004_reputation", args: recorded, summary: `couldn't read agent #${agentId}'s ERC-8004 reputation: no chain reader`, ms: 0, ok: false, source: "none", links },
    };
  }
  const read = await ctx.data.erc8004(agentId, candidate.address);
  const parts: string[] = [];
  if (read.buyerRatings) {
    parts.push(
      read.buyerRatings.count === 0 || read.buyerRatings.average === null
        ? "no buyer ratings yet"
        : `avg ${Math.round(read.buyerRatings.average)} from ${plural(read.buyerRatings.count, "buyer rating")}`,
    );
  } else if (!read.ledger) {
    parts.push("no XorvLedger to read buyer ratings from");
  }
  if (read.verifierScores && read.verifierScores.count > 0 && read.verifierScores.average !== null) {
    parts.push(`Kimi verifier ${Math.round(read.verifierScores.average)} over ${plural(read.verifierScores.count, "score")}`);
  }
  if (!read.failed.includes("agent wallet")) {
    parts.push(
      read.walletMatchesPayout
        ? "agent wallet is the payout address"
        : read.agentWallet
          ? "agent wallet is NOT the payout address"
          : "no agent wallet set",
    );
  }
  if (read.failed.length > 0) parts.push(`couldn't read ${read.failed.join(", ")}`);
  if (read.ledger) links.push({ label: "XorvLedger", url: explorerAddress(ctx.network, read.ledger) });
  return {
    result: {
      agentId,
      identityRegistry: read.identityRegistry,
      reputationRegistry: read.reputationRegistry,
      buyerRatings: read.buyerRatings
        ? { count: read.buyerRatings.count, average: round(read.buyerRatings.average), client: "XorvLedger" }
        : null,
      verifierScores: read.verifierScores
        ? { count: read.verifierScores.count, average: round(read.verifierScores.average), client: "Xorv verifier (Kimi)" }
        : null,
      agentWalletIsPayout: read.failed.includes("agent wallet") ? null : read.walletMatchesPayout,
      ...(read.failed.length ? { unreadable: read.failed } : {}),
    },
    step: {
      tool: "erc8004_reputation",
      args: recorded,
      summary: `read agent #${agentId}'s ERC-8004 reputation on Monad (${parts.join("; ")})`,
      ms: 0,
      ok: read.failed.length < 3,
      source: "chain",
      links,
    },
  };
}

async function recentReceipts(
  candidate: RouteCandidate,
  recorded: Record<string, string | null>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (!ctx.data?.receipts) {
    return {
      result: { available: false, note: "this broker has no XorvLedger reader" },
      step: { tool: "recent_receipts", args: recorded, summary: "no XorvLedger reader on this broker", ms: 0, ok: false, source: "none" },
    };
  }
  const read = await ctx.data.receipts({ providerId: candidate.providerId, address: candidate.address, agentId: candidate.agentId });
  const via = read.source === "indexer" ? " via Envio" : read.source === "rpc" ? " via Monad RPC" : "";
  const links: TraceLink[] = [];
  const newest = read.latest[0];
  if (newest) links.push({ label: "latest receipt", url: explorerTx(ctx.network, newest.txHash) });
  if (read.ledger) links.push({ label: "XorvLedger", url: explorerAddress(ctx.network, read.ledger) });
  let summary: string;
  if (read.source === "none") summary = "no XorvLedger configured on this broker, so no receipts to check";
  else if (read.receipts === 0) summary = `no receipts on XorvLedger yet among the latest ${read.scanned}${via}`;
  else {
    summary =
      `checked ${plural(read.receipts, "receipt")} on XorvLedger${via}: ${read.ok} delivered, ${read.failed} failed` +
      (read.ratings > 0 && read.avgRating !== null ? `; ${plural(read.ratings, "buyer rating")}, avg ${Math.round(read.avgRating)}` : "") +
      (BigInt(read.earnedUnits) > 0n ? `; earned ${formatUsdc(read.earnedUnits)}` : "");
  }
  return {
    result: {
      source: read.source,
      scannedLatest: read.scanned,
      receipts: read.receipts,
      delivered: read.ok,
      failed: read.failed,
      earned: formatUsdc(read.earnedUnits),
      lastReceiptAt: read.lastAt ? new Date(read.lastAt).toISOString() : null,
      ratings: read.ratings,
      avgRating: round(read.avgRating),
    },
    step: {
      tool: "recent_receipts",
      args: recorded,
      summary,
      ms: 0,
      ok: read.source !== "none",
      source: read.source,
      ...(links.length ? { links } : {}),
    },
  };
}

async function indexerStats(
  candidate: RouteCandidate,
  recorded: Record<string, string | null>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const read: IndexerStatsRead = ctx.data?.indexerStats
    ? await ctx.data.indexerStats(candidate.providerId)
    : { configured: false };
  if (!read.configured) {
    return {
      result: { indexed: false, note: "no Envio indexer is configured on this broker (XORV_INDEXER_URL is unset)" },
      step: { tool: "indexer_provider_stats", args: recorded, summary: "no Envio indexer configured on this broker", ms: 0, ok: false, source: "none" },
    };
  }
  if (!read.found) {
    return {
      result: { indexed: false, note: "the Envio indexer has no record of this provider yet" },
      step: { tool: "indexer_provider_stats", args: recorded, summary: "not in the Envio index yet (no registration indexed)", ms: 0, ok: true, source: "indexer" },
    };
  }
  const parts = [`${plural(read.jobsTotal, "job")}`];
  if (read.jobsTotal > 0) parts.push(`${Math.round(read.successRate * 100)}% delivered`);
  if (read.ratingsCount > 0) parts.push(`avg rating ${Math.round(read.avgRating)} (${read.ratingsCount})`);
  if (read.agent && read.agent.verifiedCount > 0) parts.push(`verified ${Math.round(read.agent.verifiedScore)}`);
  if (BigInt(read.earnedUnits) > 0n) parts.push(`earned ${formatUsdc(read.earnedUnits)}`);
  return {
    result: {
      indexed: true,
      jobsTotal: read.jobsTotal,
      jobsDelivered: read.jobsOk,
      jobsFailed: read.jobsFailed,
      successRate: pct(read.successRate),
      avgRating: read.ratingsCount > 0 ? round(read.avgRating) : null,
      ratingsCount: read.ratingsCount,
      verifiedScore: read.agent && read.agent.verifiedCount > 0 ? round(read.agent.verifiedScore) : null,
      verifiedCount: read.agent?.verifiedCount ?? 0,
      earned: formatUsdc(read.earnedUnits),
      avgDurationMs: read.avgDurationMs,
      lastJobAt: read.lastJobAt ? new Date(read.lastJobAt * 1000).toISOString() : null,
    },
    step: {
      tool: "indexer_provider_stats",
      args: recorded,
      summary: `Envio indexer: ${parts.join(", ")}`,
      ms: 0,
      ok: true,
      source: "indexer",
    },
  };
}

function nansenTrust(candidate: RouteCandidate, recorded: Record<string, string | null>, ctx: ToolContext): ToolOutcome {
  const wallet = shortHex(candidate.address);
  const links: TraceLink[] = [{ label: wallet, url: explorerAddress(ctx.network, candidate.address) }];
  const read = ctx.data?.trust?.(candidate.address) ?? { enabled: false, signal: null };
  if (!read.enabled) {
    return {
      result: { available: false, note: "Nansen trust signals are off on this broker" },
      step: { tool: "nansen_trust", args: recorded, summary: "Nansen trust signals are off on this broker", ms: 0, ok: false, source: "none" },
    };
  }
  const signal = read.signal;
  if (!signal) {
    return {
      result: { available: false, note: "no Nansen signal has been built for this wallet yet" },
      step: { tool: "nansen_trust", args: recorded, summary: `no Nansen signal yet for payout wallet ${wallet}`, ms: 0, ok: true, source: "nansen", links },
    };
  }
  // The public view only — never the internal smart-money or related-wallet data.
  return {
    result: {
      score: signal.score,
      band: signal.band,
      walletAgeDays: signal.walletAgeDays,
      txCount: signal.txCount,
      txCountCapped: signal.txCountCapped,
      relatedWalletCount: signal.relatedWalletCount,
      riskFlags: signal.riskFlags.slice(0, 5),
      labels: signal.labels.slice(0, 3).map((l) => clip(l, 40)),
      degraded: signal.degraded,
    },
    step: {
      tool: "nansen_trust",
      args: recorded,
      summary:
        `Nansen trust ${signal.score} (${signal.band}) for payout wallet ${wallet}` +
        (signal.riskFlags.length ? `; flags: ${signal.riskFlags.slice(0, 3).join(", ")}` : ""),
      ms: 0,
      ok: true,
      source: "nansen",
      links,
    },
  };
}
