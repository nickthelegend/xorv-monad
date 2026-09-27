/**
 * What a finished job is still waiting for, and the poll that fetches it.
 *
 * A job reaching a terminal state is not the end of its page: the broker
 * writes the XorvLedger receipt in batches a few seconds after the job ends
 * (`receiptTxHash`), and the result verifier's ERC-8004 feedback lands after
 * that (`verification.feedbackTxHash`). The live SSE stream closes at "done",
 * so the page has to come back for them. That follow-up lives here, outside
 * the stream's effect: tied to the stream it was cancelled by the very state
 * change ("done" makes the job terminal) that should have started it, and a
 * job already finished at server render never streamed at all.
 */

import type { Job } from "@/lib/api";

const TERMINAL = new Set<Job["status"]>(["completed", "failed", "expired"]);

/**
 * Is this finished job still missing something the broker writes later?
 * `verifierOn`: the broker runs a result verifier (from `/api/network`).
 */
export function awaitingOnChain(job: Job, verifierOn: boolean): boolean {
  if (!TERMINAL.has(job.status)) return false;
  // Receipts are written for paid jobs only.
  if (job.payment && !job.receiptTxHash) return true;
  // The verifier scores completed public jobs; its feedback tx (or its failure) comes last.
  if (verifierOn && job.status === "completed" && !job.private) {
    const verification = job.verification as (Job["verification"] & { feedbackError?: string | null }) | null | undefined;
    if (!verification) return true;
    if (!verification.feedbackTxHash && !verification.feedbackError) return true;
  }
  return false;
}

export interface FollowUpOptions {
  jobId: string;
  load: (jobId: string) => Promise<Job>;
  onJob: (job: Job) => void;
  /** Keep polling while this says the job is still missing something. */
  needsMore: (job: Job) => boolean;
  intervalMs?: number;
  /** Give up after this many polls (the verifier may never publish for some jobs). */
  maxPolls?: number;
}

/**
 * Poll a finished job until `needsMore` is satisfied or `maxPolls` runs out.
 * Returns a cancel function (for an effect's cleanup).
 */
export function followUpJob(opts: FollowUpOptions): () => void {
  const intervalMs = opts.intervalMs ?? 4_000;
  const maxPolls = opts.maxPolls ?? 20;
  let polls = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (): void => {
    if (cancelled || polls >= maxPolls) return;
    timer = setTimeout(() => void poll(), intervalMs);
  };
  const poll = async (): Promise<void> => {
    polls += 1;
    try {
      const job = await opts.load(opts.jobId);
      if (cancelled) return;
      opts.onJob(job);
      if (!opts.needsMore(job)) return;
    } catch {
      if (cancelled) return;
      // A failed fetch is not an answer; try again on the next tick.
    }
    schedule();
  };

  schedule();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
