/**
 * The derived numbers. Each fold is a pure function over a mutable copy so the same
 * arithmetic serves the live JobRecorded path and the provider back-fill, and the tests
 * can check it without an indexer.
 *
 * Money rules (mirrored in schema.graphql):
 *   paid     = paymentTx != 0x0. Unpaid receipts are jobs, never volume.
 *   earned   = paid AND ok: what a provider got for delivered work.
 *   settled  = paid: what reached payTo on-chain, failures included (x402 settles
 *              before the job runs, so a failed job was still paid for).
 */

import type { DailyStats, Job, NetworkStats, Provider } from "envio";
import { loadProviderDay, type Context, type DailyStatsCache } from "./entities.js";
import { meanInt, ratio, type Mutable } from "./util.js";

export type JobFacts = Pick<Job, "ok" | "paid" | "amount" | "durationMs" | "blockTimestamp">;

export function creditJobToProvider(p: Mutable<Provider>, job: JobFacts): void {
  p.jobsTotal += 1;
  if (job.ok) {
    p.jobsOk += 1;
    // Duration only means "time to deliver" for successful jobs; a failure's duration is
    // time-to-failure and would make a flaky provider look fast.
    p.totalDurationMs += BigInt(job.durationMs);
    p.avgDurationMs = meanInt(p.totalDurationMs, p.jobsOk);
  } else {
    p.jobsFailed += 1;
  }
  if (job.paid) {
    p.settledUsdc += job.amount;
    if (job.ok) p.earnedUsdc += job.amount;
  }
  p.successRate = ratio(p.jobsOk, p.jobsTotal);
  p.lastJobAt = Math.max(p.lastJobAt ?? 0, job.blockTimestamp);
}

export function creditRatingToProvider(p: Mutable<Provider>, value: number): void {
  p.ratingsCount += 1;
  p.ratingSum += value;
  p.avgRating = ratio(p.ratingSum, p.ratingsCount);
}

export function creditJobToNetwork(stats: Mutable<NetworkStats>, job: JobFacts): void {
  stats.jobs += 1;
  if (job.ok) stats.okJobs += 1;
  else stats.failedJobs += 1;
  if (job.paid) {
    stats.paidJobs += 1;
    stats.volumeUsdc += job.amount;
    if (job.ok) stats.earnedUsdc += job.amount;
  }
  stats.successRate = ratio(stats.okJobs, stats.jobs);
}

export function creditJobToDay(day: Mutable<DailyStats>, job: JobFacts): void {
  day.jobs += 1;
  if (job.ok) day.okJobs += 1;
  else day.failedJobs += 1;
  if (job.paid) {
    day.volumeUsdc += job.amount;
    if (job.ok) day.earnedUsdc += job.amount;
  }
}

/** Ratings are 0..100 ints, so network/day averages are plain means. */
export function creditRating(
  row: { ratings: number; ratingSum: number; avgRating: number },
  value: number,
): void {
  row.ratings += 1;
  row.ratingSum += value;
  row.avgRating = ratio(row.ratingSum, row.ratings);
}

/**
 * Fold a job into its provider's day. The first job of a provider on a day creates the
 * ProviderDay row, and that creation is what counts the provider as active that day, so
 * DailyStats.activeProviders stays an exact distinct count without scanning.
 *
 * `rating` is passed only by the back-fill, for jobs that were rated before their
 * provider was known; the live JobRated path adds ratings itself.
 */
export async function creditJobToProviderDay(
  context: Context,
  providerId: string,
  job: JobFacts & { rating?: number | undefined },
  days: DailyStatsCache,
): Promise<void> {
  const { row, isNew } = await loadProviderDay(context, providerId, job.blockTimestamp);
  row.jobs += 1;
  if (job.ok) row.okJobs += 1;
  if (job.paid && job.ok) row.earnedUsdc += job.amount;
  if (job.rating !== undefined) {
    row.ratings += 1;
    row.ratingSum += job.rating;
  }
  if (isNew) (await days.get(job.blockTimestamp)).activeProviders += 1;
  context.ProviderDay.set(row);
}
