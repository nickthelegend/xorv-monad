/**
 * Browsing the job market: filter by outcome and provider, search the text.
 *
 * Outcomes are what a buyer cares about, not the broker's internal states: a
 * job that failed but whose escrow refunded the buyer is "refunded", not
 * "failed", and anything still in flight is "running". A private job's prompt
 * is redacted by the broker, so search never matches it on text.
 *
 * Pure: tested without a browser.
 */
import type { Job } from "@/lib/api";
import { jobOutcome } from "@/lib/payment-timeline";

export const OUTCOMES = ["all", "completed", "refunded", "running", "failed"] as const;
export type OutcomeFilter = (typeof OUTCOMES)[number];

export interface JobQuery {
  outcome: OutcomeFilter;
  /** A provider id, or "all". */
  provider: string;
  text: string;
}

export const ALL: JobQuery = { outcome: "all", provider: "all", text: "" };

/** Which outcome bucket a job falls in. */
export function outcomeOf(job: Job): Exclude<OutcomeFilter, "all"> {
  const outcome = jobOutcome(job);
  if (outcome === "completed" || outcome === "refunded" || outcome === "failed") return outcome;
  if (outcome === "expired") return "failed";
  return "running";
}

export function filterJobs(jobs: readonly Job[], q: JobQuery): Job[] {
  const needle = q.text.trim().toLowerCase();
  return jobs
    .filter((job) => q.outcome === "all" || outcomeOf(job) === q.outcome)
    .filter((job) => q.provider === "all" || job.providerId === q.provider)
    .filter((job) => {
      if (!needle) return true;
      if (job.id.toLowerCase().includes(needle)) return true;
      if (job.private) return false;
      return `${job.title ?? ""}\n${job.prompt}\n${job.providerLabel ?? ""}`.toLowerCase().includes(needle);
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** How many jobs fall in each outcome, for the filter chips. */
export function outcomeCounts(jobs: readonly Job[]): Record<OutcomeFilter, number> {
  const counts: Record<OutcomeFilter, number> = { all: jobs.length, completed: 0, refunded: 0, running: 0, failed: 0 };
  for (const job of jobs) counts[outcomeOf(job)] += 1;
  return counts;
}

/** The providers that appear in these jobs, for the provider filter, most jobs first. */
export function providersIn(jobs: readonly Job[]): { id: string; label: string; count: number }[] {
  const seen = new Map<string, { id: string; label: string; count: number }>();
  for (const job of jobs) {
    if (!job.providerId) continue;
    const row = seen.get(job.providerId) ?? { id: job.providerId, label: job.providerLabel ?? job.providerId, count: 0 };
    row.count += 1;
    seen.set(job.providerId, row);
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
