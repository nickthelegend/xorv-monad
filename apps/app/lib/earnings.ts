/**
 * A provider's earnings, from the broker's job records.
 *
 * Every number here is a sum of paid jobs, and every paid job carries the
 * transaction that moved its money, so the dashboard can link each payout to
 * the chain. A job counts for this provider when its money goes (or went) to
 * this provider's payout address: the escrow's current payee for escrowed
 * jobs, which moves on reassignment, or the payee of a direct payment.
 *
 * Pure: tested without a browser.
 */
import type { Job } from "@/lib/api";

export type PayoutState = "paid" | "released" | "held" | "refunded";

export interface Payout {
  jobId: string;
  title: string;
  /** When the money reached the provider, or when it was paid in, for held and refunded jobs. */
  at: number;
  /** USDC units (6 decimals). */
  units: bigint;
  state: PayoutState;
  /** The transaction that proves it: the release, the refund, or the direct payment. */
  tx: string | null;
}

export interface Earnings {
  /** Reached the provider: direct payments plus escrow releases. */
  earned: bigint;
  /** Paid into the escrow for this provider, not released yet. */
  held: bigint;
  /** Paid into the escrow for this provider and refunded to the buyer instead. */
  refunded: bigint;
  /** Newest first. */
  payouts: Payout[];
  /** Earned per UTC day, oldest first, `days` long, ending today; zero days included. */
  byDay: { day: string; units: bigint }[];
}

const DAY_MS = 86_400_000;

function payee(job: Job): string | null {
  const payment = job.payment;
  if (!payment) return null;
  return (payment.escrow?.provider ?? payment.payTo ?? null)?.toLowerCase() ?? null;
}

function payoutOf(job: Job): Payout | null {
  const payment = job.payment;
  if (!payment) return null;
  const held = payment.escrow;
  const title = job.private ? "Private job" : job.title || job.prompt.slice(0, 80) || job.id;
  const units = BigInt(payment.amount);
  if (!held) return { jobId: job.id, title, at: payment.settledAt, units, state: "paid", tx: payment.txHash };
  if (held.state === "released") {
    return { jobId: job.id, title, at: held.settledAt ?? job.completedAt ?? payment.settledAt, units, state: "released", tx: held.releaseTx ?? null };
  }
  if (held.state === "refunded") {
    return { jobId: job.id, title, at: held.settledAt ?? job.completedAt ?? payment.settledAt, units, state: "refunded", tx: held.refundTx ?? null };
  }
  return { jobId: job.id, title, at: payment.settledAt, units, state: "held", tx: payment.txHash };
}

/** UTC calendar day, "2026-10-07". */
export function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function providerEarnings(jobs: readonly Job[], address: string, opts: { now: number; days?: number }): Earnings {
  const me = address.toLowerCase();
  const payouts = jobs
    .filter((job) => payee(job) === me)
    .map(payoutOf)
    .filter((p): p is Payout => p !== null)
    .sort((a, b) => b.at - a.at);

  const sum = (states: PayoutState[]) => payouts.filter((p) => states.includes(p.state)).reduce((n, p) => n + p.units, 0n);

  const days = opts.days ?? 14;
  const today = Date.parse(`${dayKey(opts.now)}T00:00:00Z`);
  const byDay = Array.from({ length: days }, (_, i) => ({ day: dayKey(today - (days - 1 - i) * DAY_MS), units: 0n }));
  const index = new Map(byDay.map((d, i) => [d.day, i]));
  for (const p of payouts) {
    if (p.state !== "paid" && p.state !== "released") continue;
    const i = index.get(dayKey(p.at));
    if (i !== undefined) byDay[i]!.units += p.units;
  }

  return { earned: sum(["paid", "released"]), held: sum(["held"]), refunded: sum(["refunded"]), payouts, byDay };
}
