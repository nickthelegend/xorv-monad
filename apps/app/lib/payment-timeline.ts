/**
 * Where a job's money is, step by step.
 *
 * An escrowed job's USDC moves twice: buyer → XorvEscrow when the job is paid,
 * then escrow → provider when the work is delivered, or escrow → buyer when it
 * isn't. A direct (`exact`) payment moves once, buyer → provider, before the
 * work starts. Either way the job ends with a receipt on XorvLedger. This
 * module turns a job record into that story as ordered steps, each with the
 * time it happened and the transaction that proves it, so the page can show
 * the lifecycle instead of a table of hashes.
 *
 * Pure: it reads only the job (and `now`, for nothing but deadlines), so it is
 * tested without a browser.
 */
import { formatUsdc, shortHex } from "@xorv/protocol/web";
import type { Job } from "@/lib/api";

export type StepState = "done" | "active" | "pending" | "failed";

export interface TimelineStep {
  key: "paid" | "running" | "delivered" | "settled" | "receipt";
  title: string;
  detail: string | null;
  /** When it happened (ms since epoch), when known. */
  at: number | null;
  tx: string | null;
  state: StepState;
}

const TERMINAL = new Set<Job["status"]>(["completed", "failed", "expired"]);

/** What the job's badge should say: a refunded job is not a failure the buyer paid for. */
export type JobOutcome = Job["status"] | "refunded";

export function jobOutcome(job: Pick<Job, "status" | "payment">): JobOutcome {
  return job.payment?.escrow?.state === "refunded" ? "refunded" : job.status;
}

/** "+0.8 s" after `from`, or null when either end is unknown. */
export function offsetLabel(at: number | null, from: number | null): string | null {
  if (at === null || from === null) return null;
  const ms = Math.max(0, at - from);
  return ms < 10_000 ? `+${(ms / 1000).toFixed(1)} s` : ms < 120_000 ? `+${Math.round(ms / 1000)} s` : `+${Math.round(ms / 60_000)} min`;
}

/** Whether the escrow was settled through XorvRefundKeeper, the Chainlink CRE workflow's receiver. */
export function refundedByKeeper(job: Job, keeper: string | null | undefined): boolean {
  const via = job.payment?.escrow?.settledVia;
  return Boolean(keeper && via && via.toLowerCase() === keeper.toLowerCase());
}

export function paymentTimeline(
  job: Job,
  opts: {
    keeper?: string | null;
    /** The broker holds a delivered job's release for the verifier's verdict. */
    releaseOnVerdict?: boolean;
    /** How a clock time reads. The component passes a hydration-safe one; the default is UTC. */
    formatTime?: (ms: number) => string;
  } = {},
): TimelineStep[] {
  const formatTime = opts.formatTime ?? utcTime;
  const payment = job.payment;
  const held = payment?.escrow ?? null;
  const terminal = TERMINAL.has(job.status);
  const provider = job.providerLabel ?? (job.providerAddress ? shortHex(job.providerAddress) : "the provider");
  const amount = payment ? formatUsdc(payment.amount) : job.priceLabel ?? "";
  const steps: TimelineStep[] = [];

  steps.push({
    key: "paid",
    title: held ? "Paid into XorvEscrow" : payment ? `Paid to ${provider}` : "Waiting for payment",
    detail: payment
      ? held
        ? `${amount} USDC from ${shortHex(payment.payer)}, held by the contract until the job delivers. The buyer paid no gas.`
        : `${amount} USDC straight from ${shortHex(payment.payer)} to the provider. The buyer paid no gas.`
      : null,
    at: payment?.settledAt ?? null,
    tx: payment?.txHash ?? null,
    state: payment ? "done" : "active",
  });

  const reassigned = held?.reassignTxs?.length ?? 0;
  steps.push({
    key: "running",
    title: job.startedAt ? `Running on ${provider}` : "Waiting for a provider",
    detail:
      reassigned > 0
        ? `Reassigned ${reassigned === 1 ? "once" : `${reassigned} times`}; the escrow was re-pointed on-chain before the new provider started.`
        : null,
    at: job.startedAt ?? job.assignedAt ?? null,
    tx: reassigned > 0 ? held!.reassignTxs![reassigned - 1]! : null,
    state: job.startedAt ? (terminal ? "done" : "active") : payment && !terminal ? "active" : terminal ? "done" : "pending",
  });

  if (job.status === "completed") {
    steps.push({
      key: "delivered",
      title: "Delivered",
      detail: job.resultHash ? `Result hash ${shortHex(job.resultHash)}` : null,
      at: job.completedAt,
      tx: null,
      state: "done",
    });
  } else if (terminal) {
    steps.push({
      key: "delivered",
      title: job.error === "cancelled by the buyer" ? "Cancelled by the buyer" : "Not delivered",
      detail: job.error === "cancelled by the buyer" ? null : job.error,
      at: job.completedAt,
      tx: null,
      state: "failed",
    });
  } else {
    steps.push({ key: "delivered", title: "Delivery", detail: null, at: null, tx: null, state: "pending" });
  }

  if (held) {
    const by = held.settledBy ? ` (sent by ${shortHex(held.settledBy)}, not this broker)` : "";
    if (held.state === "released") {
      steps.push({
        key: "settled",
        title: `Released to ${provider}`,
        detail: `XorvEscrow paid ${amount} USDC to the provider, with the result hash on-chain${by}.${opts.releaseOnVerdict && job.verification?.pass && job.verification.feedbackTxHash ? ` Released after the verifier's pass was recorded on chain (ERC-8004 feedback ${shortHex(job.verification.feedbackTxHash)}).` : ""}`,
        at: held.settledAt ?? null,
        tx: held.releaseTx ?? null,
        state: "done",
      });
    } else if (held.state === "refunded" && refundedByKeeper(job, opts.keeper)) {
      steps.push({
        key: "settled",
        title: "Refunded by the Chainlink CRE keeper",
        detail: `The deadline passed with no delivery, so the CRE workflow's report reached XorvRefundKeeper and XorvEscrow returned the full ${amount} USDC. The broker sent nothing.`,
        at: held.settledAt ?? null,
        tx: held.refundTx ?? null,
        state: "done",
      });
    } else if (held.state === "refunded") {
      steps.push({
        key: "settled",
        title: held.refundReason === "failed verification" ? "Refunded: the work failed verification" : "Refunded to the buyer",
        detail:
          held.refundReason === "failed verification"
            ? `The verifier failed the delivered work, so XorvEscrow returned the full ${amount} USDC to the buyer, at the provider's fault.`
            : `XorvEscrow returned the full ${amount} USDC. The provider was paid nothing${by}.`,
        at: held.settledAt ?? null,
        tx: held.refundTx ?? null,
        state: "done",
      });
    } else if (terminal) {
      steps.push({
        key: "settled",
        title: job.status === "completed" ? "Releasing to the provider" : "Refunding the buyer",
        detail: held.lastError
          ? `Retrying: ${held.lastError}`
          : job.status === "completed" && !job.verification && opts.releaseOnVerdict
            ? "Waiting for the verifier's verdict: released on a pass, refunded on a fail."
            : null,
        at: null,
        tx: null,
        state: "active",
      });
    } else {
      steps.push({
        key: "settled",
        title: "To be released on delivery",
        detail: `Or refunded in full if the job fails. After ${formatTime(held.deadline * 1000)} anyone can refund it, the Chainlink CRE keeper included.`,
        at: null,
        tx: null,
        state: "pending",
      });
    }
  }

  steps.push({
    key: "receipt",
    title: "Receipt on XorvLedger",
    detail: job.receiptTxHash
      ? job.status === "completed"
        ? "The payment, the prompt's hash and the result's hash, public on Monad."
        : "The payment and the outcome, public on Monad."
      : null,
    at: null,
    tx: job.receiptTxHash,
    state: job.receiptTxHash ? "done" : terminal ? "active" : "pending",
  });

  return steps;
}

/** A clock time in UTC: the same on the server and in every browser. */
export function utcTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 19)} UTC`;
}
