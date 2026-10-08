/**
 * The broker's public wire shapes.
 *
 * What leaves the process is decided here and nowhere else, so an internal
 * field (a bearer token, a cancel-token hash, the list of providers a job
 * bounced through) can't leak by being added to a record that some route
 * happens to serialize. The shapes are the protocol's `PublicJob` /
 * `PublicProvider`, which the apps, CLI and MCP server import.
 */

import {
  explorerAddress,
  explorerAgent,
  explorerTx,
  formatUsd,
  formatUsdc,
  providerIdHash,
  usdcAddress,
  usdMicrosToUsdcUnits,
  usdcUnitsToUsdMicros,
  type LedgerEvent,
  type PublicJob,
  type PublicProvider,
} from "@xorv/protocol";
import type { StoredJob } from "./jobs.js";
import type { RoutingRecord, ScreeningRecord } from "./ai/types.js";
import { publicRelatedCheck, type PublicRelatedCheck, type PublicTrustSignal } from "./trust/index.js";
import type { ProviderRecord } from "./registry.js";
import { toBigIntString, toNumber, type IndexerLeaderboardRow } from "./indexer.js";

/** Strip the bearer token before a provider record goes anywhere, even back to its own node. */
export function stripSecrets<T extends { token?: string }>(record: T): Omit<T, "token"> {
  const { token: _token, ...rest } = record;
  return rest;
}

/**
 * A job as the world sees it.
 *
 * A private job (`request.encryptTo`) is listed, priced, paid and receipted
 * like any other, but its words are not public: the prompt and title are
 * redacted (the buyer's own copy lives in their passkey-encrypted history
 * vault), the result is the sealed envelope only the buyer's passkey opens,
 * and `private: true` lets every surface say so rather than render a blank.
 * The broker still holds the prompt internally, because routing, screening
 * and a free reassignment all need it.
 */
export function publicJob(
  job: StoredJob,
  opts: { events?: boolean } = {},
): PublicJob & { trustCheck: PublicRelatedCheck | null } {
  const sealed = Boolean(job.request.encryptTo);
  return {
    id: job.id,
    private: sealed,
    title: sealed ? null : (job.request.title ?? null),
    prompt: sealed ? "" : job.request.prompt,
    adapter: job.request.adapter ?? null,
    status: job.status,
    createdAt: job.createdAt,
    assignedAt: job.assignedAt ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    providerId: job.providerId ?? null,
    providerLabel: job.providerLabel ?? null,
    providerAddress: job.providerAddress ?? null,
    providerAgentId: job.providerAgentId ?? null,
    priceUsdMicros: job.priceUsdMicros ?? null,
    priceLabel: job.priceUsdMicros ? formatUsd(job.priceUsdMicros) : null,
    payment: job.payment ?? null,
    result: job.result ?? null,
    resultHash: job.resultHash ?? null,
    error: job.error ?? null,
    receiptTxHash: job.receiptTxHash ?? null,
    routing: sealed ? sealedRouting(job.routing) : (job.routing ?? null),
    screening: sealed ? sealedScreening(job.screening) : (job.screening ?? null),
    verification: job.verification ?? null,
    rating: job.rating
      ? { value: job.rating.value, txHash: job.rating.txHash, feedbackURI: job.rating.feedbackURI }
      : null,
    agent: job.request.agent ?? null,
    eventCount: job.events.length,
    events: opts.events ? job.events : undefined,
    // The Nansen related-wallet check run before relaying the rating, if one ran.
    trustCheck: job.trustCheck ? publicRelatedCheck(job.trustCheck) : null,
  };
}

/** What a private job's AI records say in place of the model's own words. */
export const PRIVATE_AI_REASON = "withheld for a private job";

/**
 * A private job's routing record, minus what the router wrote about the job.
 * Asked for "one plain sentence … saying why this adapter suits this job",
 * the model paraphrases the prompt, so its reason (and its difficulty read)
 * would leak what the redacted prompt hides. A timeout or error fallback
 * keeps its reason: that sentence is the broker's own template. An invalid
 * one does not, since it can quote the model's pick.
 */
function sealedRouting(routing: StoredJob["routing"]): RoutingRecord | null {
  if (!routing) return null;
  const templated = routing.fallback === "timeout" || routing.fallback === "error";
  return { ...routing, reason: templated ? routing.reason : PRIVATE_AI_REASON, difficulty: null };
}

/**
 * A private job's screening record, minus the screener's free-text reason.
 * The verdict and category are fixed vocabularies and stay; an unscreened
 * record keeps its reason, which is the broker's fail-open/closed template.
 */
function sealedScreening(screening: StoredJob["screening"]): ScreeningRecord | null {
  if (!screening) return null;
  return { ...screening, reason: screening.unavailable ? screening.reason : PRIVATE_AI_REASON };
}

/**
 * A provider as the world sees it, with its payout wallet's Nansen trust
 * signal (public view: no smart-money data, no related-wallet addresses,
 * attribution attached) when the broker has one.
 */
export function publicProvider(
  network: string,
  p: ProviderRecord,
  connected: boolean,
  trust: PublicTrustSignal | null = null,
): PublicProvider & { trust: PublicTrustSignal | null } {
  return {
    id: p.id,
    label: p.label,
    address: p.address,
    addressUrl: explorerAddress(network, p.address),
    agentId: p.agentId,
    agentUrl: p.agentId ? explorerAgent(network, p.agentId) : null,
    endpoint: p.endpoint,
    status: p.status,
    connected,
    activeJobs: p.activeJobs,
    capabilities: p.capabilities,
    lastHeartbeatAt: p.lastHeartbeatAt,
    registeredAt: p.registeredAt,
    uptimeSeconds: p.uptimeSeconds,
    version: p.version,
    region: p.region ?? null,
    stats: p.stats,
    registryTxHash: p.registryTxHash ?? null,
    trust,
  };
}

/**
 * A ledger receipt in the shape `/api/receipts` has always served.
 *
 * The landing page's ledger section (and the app's network page) predate the
 * Monad port and read `sequence` plus `payload.data.{jobId, payer,
 * providerAccountId, amount, asset, transactionId}`. Those keys are kept, now
 * carrying EVM values, next to the new ones (`buyer`, `payTo`, `paymentTx`,
 * `explorerUrl`, `paymentUrl`), so an old consumer keeps rendering while a new
 * one reads the new names. `payload.data.jobId` is the on-chain `bytes32`;
 * `brokerJobId` is the broker's own id when this broker knows the job.
 */
export function legacyReceipt(
  network: string,
  event: LedgerEvent<"receipts">,
  brokerJobId: string | null,
) {
  const data = event.data;
  const paymentUrl = data.paymentTx ? explorerTx(network, data.paymentTx) : null;
  return {
    id: event.id,
    sequence: event.id,
    blockNumber: event.blockNumber,
    txHash: event.txHash,
    explorerUrl: explorerTx(network, event.txHash),
    at: event.at,
    consensusAt: new Date(event.at).toISOString(),
    brokerJobId,
    payload: {
      v: 2,
      kind: "job.receipt",
      at: event.at,
      data: {
        ...data,
        brokerJobId,
        payer: data.buyer,
        providerAddress: data.payTo,
        providerAccountId: data.payTo,
        asset: usdcAddress(network),
        transactionId: data.paymentTx,
        paymentUrl,
      },
    },
  };
}

/** One leaderboard row, from either the indexer or the in-memory registry. */
export interface LeaderboardEntry {
  rank: number;
  /** The broker's provider id, when this broker knows the provider. */
  providerId: string | null;
  /** keccak256 of the provider id — the key on-chain and in the indexer. */
  providerIdHash: string;
  label: string;
  address: string;
  addressUrl: string;
  agentId: string | null;
  agentUrl: string | null;
  /** Whether the provider is heartbeating to this broker right now. */
  live: boolean;
  jobsTotal: number;
  jobsOk: number;
  jobsFailed: number;
  /** jobsOk / jobsTotal, or null before the first job. */
  successRate: number | null;
  earnedUsdcUnits: string;
  earnedUsdMicros: number;
  earnedLabel: string;
  avgDurationMs: number;
  ratingsCount: number;
  avgRating: number | null;
  /** ERC-8004 reputation, when the indexer has it. */
  reputation: { feedbackCount: number; feedbackAvg: number | null; verifiedScore: number | null } | null;
  /** The payout wallet's Nansen trust signal (public view), when the broker has one. */
  trust?: PublicTrustSignal | null;
}

export function leaderboardFromIndexer(
  network: string,
  rows: IndexerLeaderboardRow[],
  known: ProviderRecord[],
): LeaderboardEntry[] {
  const byHash = new Map(known.map((p) => [providerIdHash(p.id).toLowerCase(), p]));
  return rows.map((row, index) => {
    const provider = byHash.get(row.id.toLowerCase());
    const earned = toBigIntString(row.earnedUsdc);
    const ratingsCount = toNumber(row.ratingsCount);
    const address = provider?.address ?? row.payTo;
    const agentId = row.agent_id ?? provider?.agentId ?? null;
    return {
      rank: index + 1,
      providerId: provider?.id ?? null,
      providerIdHash: row.id,
      label: row.label || provider?.label || "",
      address,
      addressUrl: explorerAddress(network, address),
      agentId,
      agentUrl: agentId ? explorerAgent(network, agentId) : null,
      live: provider ? provider.status !== "offline" : false,
      jobsTotal: toNumber(row.jobsTotal),
      jobsOk: toNumber(row.jobsOk),
      jobsFailed: toNumber(row.jobsFailed),
      successRate: row.jobsTotal ? toNumber(row.jobsOk) / toNumber(row.jobsTotal) : null,
      earnedUsdcUnits: earned,
      earnedUsdMicros: usdcUnitsToUsdMicros(earned),
      earnedLabel: formatUsdc(earned),
      avgDurationMs: toNumber(row.avgDurationMs),
      ratingsCount,
      avgRating: ratingsCount > 0 ? toNumber(row.avgRating) : null,
      reputation: row.agent
        ? {
            feedbackCount: toNumber(row.agent.feedbackCount),
            feedbackAvg: row.agent.feedbackCount ? toNumber(row.agent.feedbackAvg) : null,
            verifiedScore: row.agent.verifiedScore === null ? null : toNumber(row.agent.verifiedScore),
          }
        : null,
    };
  });
}

/**
 * The leaderboard from what this broker has seen: lifetime stats per provider
 * plus buyer ratings from its own job store. Narrower than the indexer's view
 * (one broker, providers it currently knows), but always available.
 */
export function leaderboardFromMemory(
  network: string,
  providers: ProviderRecord[],
  jobs: StoredJob[],
  limit: number,
): LeaderboardEntry[] {
  const ratings = new Map<string, { n: number; sum: number }>();
  for (const job of jobs) {
    const target = job.quotedProviderId ?? job.providerId;
    if (!job.rating || !target) continue;
    const entry = ratings.get(target) ?? { n: 0, sum: 0 };
    entry.n += 1;
    entry.sum += job.rating.value;
    ratings.set(target, entry);
  }
  return providers
    .map((p) => {
      const { jobsCompleted, jobsFailed, earnedUsdcMicros, avgDurationMs } = p.stats;
      const total = jobsCompleted + jobsFailed;
      const rated = ratings.get(p.id);
      const earnedUnits = usdMicrosToUsdcUnits(earnedUsdcMicros);
      return {
        rank: 0,
        providerId: p.id,
        providerIdHash: providerIdHash(p.id),
        label: p.label,
        address: p.address,
        addressUrl: explorerAddress(network, p.address),
        agentId: p.agentId,
        agentUrl: p.agentId ? explorerAgent(network, p.agentId) : null,
        live: p.status !== "offline",
        jobsTotal: total,
        jobsOk: jobsCompleted,
        jobsFailed,
        successRate: total > 0 ? jobsCompleted / total : null,
        earnedUsdcUnits: earnedUnits,
        earnedUsdMicros: earnedUsdcMicros,
        earnedLabel: formatUsd(earnedUsdcMicros),
        avgDurationMs,
        ratingsCount: rated?.n ?? 0,
        avgRating: rated ? rated.sum / rated.n : null,
        reputation: null,
      } satisfies LeaderboardEntry;
    })
    .sort((a, b) => b.earnedUsdMicros - a.earnedUsdMicros || b.jobsOk - a.jobsOk || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}
