/**
 * Default rows and load-or-init helpers. Every handler follows the same shape: load the
 * rows it touches into mutable copies, fold the event in, then `set` each row once. Two
 * independent copies of one row set in the same handler would make the second write
 * silently drop the first one's changes, so helpers take and return copies rather than
 * writing on their own.
 */

import type {
  Agent,
  Buyer,
  BuyerDay,
  DailyStats,
  EvmOnEventContext,
  NetworkStats,
  Provider,
  ProviderDay,
} from "envio";
import { GLOBAL_ID } from "./constants.js";
import { dayOf, type Mutable } from "./util.js";

export type Context = EvmOnEventContext;

export function emptyAgent(agentId: bigint): Mutable<Agent> {
  return {
    id: agentId.toString(),
    agentId,
    owner: undefined,
    agentURI: undefined,
    wallet: undefined,
    registeredAt: undefined,
    registeredTx: undefined,
    uriUpdatedAt: undefined,
    transfers: 0,
    isXorvProvider: false,
    provider_id: undefined,
    feedbackCount: 0,
    feedbackRevoked: 0,
    feedbackSum: 0,
    feedbackAvg: 0,
    buyerRatingCount: 0,
    buyerRatingSum: 0,
    buyerRatingAvg: 0,
    verifiedCount: 0,
    verifiedSum: 0,
    verifiedScore: 0,
    lastFeedbackAt: undefined,
    lastLedgerFeedbackId: undefined,
  };
}

/** Agent row as a mutable copy, or a stub when the mint predates the indexer's start block. */
export async function loadAgent(context: Context, agentId: bigint): Promise<Mutable<Agent>> {
  const existing = await context.Agent.get(agentId.toString());
  return existing ? { ...existing } : emptyAgent(agentId);
}

export function emptyProviderStats(): Pick<
  Mutable<Provider>,
  | "heartbeats"
  | "lastHeartbeatAt"
  | "activeJobs"
  | "capacity"
  | "uptimeSeconds"
  | "jobsTotal"
  | "jobsOk"
  | "jobsFailed"
  | "successRate"
  | "earnedUsdc"
  | "settledUsdc"
  | "totalDurationMs"
  | "avgDurationMs"
  | "ratingsCount"
  | "ratingSum"
  | "avgRating"
  | "lastJobAt"
> {
  return {
    heartbeats: 0,
    lastHeartbeatAt: undefined,
    activeJobs: 0,
    capacity: 0,
    uptimeSeconds: 0,
    jobsTotal: 0,
    jobsOk: 0,
    jobsFailed: 0,
    successRate: 0,
    earnedUsdc: 0n,
    settledUsdc: 0n,
    totalDurationMs: 0n,
    avgDurationMs: 0,
    ratingsCount: 0,
    ratingSum: 0,
    avgRating: 0,
    lastJobAt: undefined,
  };
}

export function emptyBuyer(id: string, timestamp: number): Mutable<Buyer> {
  return {
    id,
    jobsTotal: 0,
    jobsOk: 0,
    spentUsdc: 0n,
    ratingsGiven: 0,
    firstJobAt: timestamp,
    lastJobAt: timestamp,
  };
}

export async function loadNetworkStats(context: Context): Promise<Mutable<NetworkStats>> {
  const existing = await context.NetworkStats.get(GLOBAL_ID);
  if (existing) return { ...existing };
  return {
    id: GLOBAL_ID,
    providers: 0,
    agentsTotal: 0,
    agentsLinked: 0,
    buyers: 0,
    jobs: 0,
    okJobs: 0,
    failedJobs: 0,
    paidJobs: 0,
    successRate: 0,
    volumeUsdc: 0n,
    earnedUsdc: 0n,
    ratings: 0,
    ratingSum: 0,
    avgRating: 0,
    heartbeats: 0,
    feedbacks: 0,
    verifiedFeedbacks: 0,
    lastBlock: 0,
    lastUpdated: 0,
  };
}

/** Stamp the singleton with the event that last changed it, then write it. */
export function saveNetworkStats(
  context: Context,
  stats: Mutable<NetworkStats>,
  block: { number: number; timestamp: number },
): void {
  // Events arrive in chain order, but a back-fill can touch stats while replaying older
  // rows, so never move the stamp backwards.
  stats.lastBlock = Math.max(stats.lastBlock, block.number);
  stats.lastUpdated = Math.max(stats.lastUpdated, block.timestamp);
  context.NetworkStats.set(stats);
}

export async function loadDailyStats(context: Context, timestamp: number): Promise<Mutable<DailyStats>> {
  const day = dayOf(timestamp);
  const existing = await context.DailyStats.get(day.id);
  if (existing) return { ...existing };
  return {
    id: day.id,
    dayStart: day.start,
    jobs: 0,
    okJobs: 0,
    failedJobs: 0,
    volumeUsdc: 0n,
    earnedUsdc: 0n,
    uniqueBuyers: 0,
    activeProviders: 0,
    newBuyers: 0,
    newProviders: 0,
    ratings: 0,
    ratingSum: 0,
    avgRating: 0,
    heartbeats: 0,
    feedbacks: 0,
  };
}

/**
 * DailyStats rows for a handler that may touch several days (the provider back-fill).
 * One copy per day, written once by `saveAll`.
 */
export class DailyStatsCache {
  private rows = new Map<string, Mutable<DailyStats>>();

  constructor(private readonly context: Context) {}

  async get(timestamp: number): Promise<Mutable<DailyStats>> {
    const id = dayOf(timestamp).id;
    let row = this.rows.get(id);
    if (!row) {
      row = await loadDailyStats(this.context, timestamp);
      this.rows.set(id, row);
    }
    return row;
  }

  saveAll(): void {
    for (const row of this.rows.values()) this.context.DailyStats.set(row);
  }
}

export async function loadProviderDay(
  context: Context,
  providerId: string,
  timestamp: number,
): Promise<{ row: Mutable<ProviderDay>; isNew: boolean }> {
  const day = dayOf(timestamp);
  const id = `${providerId}-${day.id}`;
  const existing = await context.ProviderDay.get(id);
  if (existing) return { row: { ...existing }, isNew: false };
  return {
    row: {
      id,
      provider_id: providerId,
      day: day.id,
      dayStart: day.start,
      jobs: 0,
      okJobs: 0,
      earnedUsdc: 0n,
      ratings: 0,
      ratingSum: 0,
    },
    isNew: true,
  };
}

export async function loadBuyerDay(
  context: Context,
  buyerId: string,
  timestamp: number,
): Promise<{ row: Mutable<BuyerDay>; isNew: boolean }> {
  const day = dayOf(timestamp);
  const id = `${buyerId}-${day.id}`;
  const existing = await context.BuyerDay.get(id);
  if (existing) return { row: { ...existing }, isNew: false };
  return {
    row: { id, buyer_id: buyerId, day: day.id, jobs: 0, spentUsdc: 0n },
    isNew: true,
  };
}
