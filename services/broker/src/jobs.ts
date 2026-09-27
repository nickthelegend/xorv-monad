/**
 * Quotes and jobs.
 *
 * A quote is the pin between "what does this cost?" and "here is the money".
 * It has to exist as its own object because x402 asks the server for payment
 * requirements twice — once to answer 402, once to check the payment that comes
 * back — and both answers must name the same provider at the same price. If the
 * matcher ran twice, a poster could be quoted one node and pay another.
 */

import { MemoryPersistence, type Persistence } from "./store.js";
import type { RoutingRecord, ScreeningRecord, VerificationRecord } from "./ai/types.js";
import type { RelatedCheck } from "./trust/service.js";
import {
  JOB_TIMEOUT_MS,
  QUOTE_TTL_SECONDS,
  type AdapterKind,
  type Job,
  type JobEvent,
  type JobRating,
  type JobRequest,
  type JobStatus,
  type PaymentRecord,
  newId,
} from "@xorv/protocol";

export interface Quote {
  id: string;
  request: JobRequest;
  providerId: string;
  providerLabel: string;
  /** The provider's checksummed payout address — the x402 `payTo`. */
  providerAddress: string;
  /** The provider's verified ERC-8004 agent id at quote time, if any. */
  providerAgentId: string | null;
  capabilityId: string;
  capabilityName: string;
  /** The adapter behind the quoted capability — what will actually run the job. */
  capabilityAdapter: AdapterKind;
  priceUsdMicros: number;
  /**
   * The exact USDC amount (smallest units) this quote commits to, frozen at
   * quote time along with the payee.
   *
   * These must not be recomputed per request. x402 asks the server for payment
   * requirements twice — once to answer 402, once to check the payment that
   * comes back — and the buyer signs an EIP-3009 authorization for exactly
   * this amount to exactly this address. If the provider re-registered at a new
   * price or payout address between those two calls, recomputing would change
   * the requirements, the signed payload would no longer match, and a
   * correctly-signed payment would be rejected. A quote is a price
   * commitment; this is where it's kept.
   */
  usdcAmount: string;
  /** What the AI router (Qwen) decided, when it ran — carried onto the job. */
  routing?: RoutingRecord | null;
  /** The prompt screen's (Hunyuan) verdict — carried onto the job. */
  screening?: ScreeningRecord | null;
  createdAt: number;
  expiresAt: number;
  /** Set once the quote has been paid, so a replayed payment can't buy twice. */
  jobId?: string;
  /**
   * True while a payment for this quote is being settled. A second paid
   * request for the same quote is refused until the first one resolves —
   * otherwise two different signed authorizations (a double-click) would both
   * settle, and the buyer would pay twice for one job. It also keeps the quote
   * from expiring mid-settlement: money that moved must always find its quote.
   */
  paying?: boolean;
}

/** A buyer's rating as stored: the public fields plus what rebuilds its feedback file. */
export interface StoredRating extends JobRating {
  /** Unix seconds; part of the signed message and the feedback file's `createdAt`. */
  deadline: number;
  feedbackHash: string;
}

/**
 * A job as the broker keeps it: the protocol's `Job` plus bookkeeping that
 * never leaves the broker (see `publicJob` in app.ts).
 */
export interface StoredJob extends Job {
  /**
   * The provider the quote was pinned to — the one the buyer actually paid.
   * `providerId` moves on reassignment; this does not, which is how earnings
   * reach the address that received the money rather than whoever ran the
   * job last.
   */
  quotedProviderId?: string | null;
  /** The adapter of the capability currently running the job (the rating's ERC-8004 tag2). */
  capabilityAdapter?: AdapterKind | null;
  /** Every provider this job has been handed to, so reassignment never loops back. */
  attemptedProviders?: string[];
  /** sha-256 of the buyer's cancel token; only the payer can cancel. */
  cancelTokenHash?: string | null;
  rating?: StoredRating | null;
  routing?: RoutingRecord | null;
  screening?: ScreeningRecord | null;
  /** The verifier's (Kimi) score, with the bookkeeping that rebuilds its ERC-8004 feedback file. */
  verification?: VerificationRecord | null;
  /** The Nansen related-wallet check run before relaying the buyer's rating (src/trust/). */
  trustCheck?: RelatedCheck | null;
  /**
   * XorvLedger holds this job's receipt. Normally `receiptTxHash` says so;
   * this also covers a receipt found already recorded (a retry reverted as
   * `DuplicateJob`) whose original transaction could not be looked up.
   */
  receiptRecorded?: boolean;
}

/** True once the job's receipt is known to be on XorvLedger. */
export function receiptLanded(job: StoredJob): boolean {
  return Boolean(job.receiptTxHash) || job.receiptRecorded === true;
}

type Listener = (job: StoredJob, event: JobEvent | null) => void;

/** Completed, failed and expired jobs are final. */
export function isTerminal(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "expired";
}

export class JobStore {
  private quotes = new Map<string, Quote>();
  private jobs = new Map<string, StoredJob>();
  /** Monotonic insertion order, for deterministic sorting within a millisecond. */
  private sequence = new Map<string, number>();
  private nextSequence = 0;
  private readonly persistence: Persistence;

  /**
   * Rehydrates from the durable store on construction.
   *
   * Quotes are deliberately *not* restored: a quote is a short-lived promise
   * about a provider that is live right now, and after a restart no provider is
   * live yet. Reviving one would let someone pay for a node that isn't there.
   */
  constructor(persistence: Persistence = new MemoryPersistence()) {
    this.persistence = persistence;
    for (const job of persistence.loadJobs().reverse()) {
      this.jobs.set(job.id, job as StoredJob);
      this.sequence.set(job.id, this.nextSequence++);
    }
  }

  /** How many jobs came back from disk — reported at boot. */
  get restoredCount(): number {
    return this.jobs.size;
  }

  private persist(job: StoredJob): void {
    try {
      this.persistence.saveJob(job);
    } catch (err) {
      // The job already ran and was already paid for; a disk problem must not
      // turn that into a failed request.
      console.error("[broker] failed to persist job:", err instanceof Error ? err.message : err);
    }
  }
  private listeners = new Set<Listener>();
  /** Per-job subscribers, for the live stream a poster watches. */
  private jobListeners = new Map<string, Set<Listener>>();

  // -- quotes ---------------------------------------------------------------

  createQuote(input: Omit<Quote, "id" | "createdAt" | "expiresAt">): Quote {
    const now = Date.now();
    const quote: Quote = {
      ...input,
      id: newId("qte"),
      createdAt: now,
      expiresAt: now + QUOTE_TTL_SECONDS * 1000,
    };
    this.quotes.set(quote.id, quote);
    return quote;
  }

  /** A live quote; expired ones stop resolving — unless a payment for it is mid-settlement. */
  getQuote(id: string): Quote | undefined {
    const quote = this.quotes.get(id);
    if (!quote) return undefined;
    if (Date.now() > quote.expiresAt && !quote.paying) {
      this.quotes.delete(id);
      return undefined;
    }
    return quote;
  }

  // -- jobs -----------------------------------------------------------------

  /**
   * Turn a paid quote into a job.
   *
   * `payment` is the settlement record: with up-front settlement it already
   * exists when the job is created, so a job is never visible — or
   * dispatched — without the proof that it was paid for.
   */
  createJob(
    quote: Quote,
    opts: { payment?: PaymentRecord | null; cancelTokenHash?: string | null } = {},
  ): StoredJob {
    const job: StoredJob = {
      id: newId("job"),
      request: quote.request,
      status: "paid",
      createdAt: Date.now(),
      quoteId: quote.id,
      providerId: quote.providerId,
      providerLabel: quote.providerLabel,
      providerAddress: quote.providerAddress,
      providerAgentId: quote.providerAgentId,
      quotedProviderId: quote.providerId,
      attemptedProviders: [quote.providerId],
      capabilityId: quote.capabilityId,
      capabilityAdapter: quote.capabilityAdapter,
      priceUsdMicros: quote.priceUsdMicros,
      payment: opts.payment ?? null,
      cancelTokenHash: opts.cancelTokenHash ?? null,
      routing: quote.routing ?? null,
      screening: quote.screening ?? null,
      events: [],
    };
    this.jobs.set(job.id, job);
    this.sequence.set(job.id, this.nextSequence++);
    quote.jobId = job.id;
    quote.paying = false;
    this.emit(job, null);
    return job;
  }

  get(id: string): StoredJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * Newest first, optionally filtered by provider.
   *
   * Ordered by an insertion sequence rather than by `createdAt` alone. Two jobs
   * posted in the same millisecond are common under load and in tests, and a
   * timestamp tie leaves the sort to fall back on Map insertion order — which
   * is *oldest* first, the exact opposite of what the feed should show.
   */
  list(opts: { limit?: number; providerId?: string } = {}): StoredJob[] {
    let all = [...this.jobs.values()].sort((a, b) => {
      const bySeq = (this.sequence.get(b.id) ?? 0) - (this.sequence.get(a.id) ?? 0);
      return b.createdAt - a.createdAt || bySeq;
    });
    if (opts.providerId) all = all.filter((j) => j.providerId === opts.providerId);
    return all.slice(0, opts.limit ?? 50);
  }

  setStatus(id: string, status: JobStatus): StoredJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.status = status;
    if (status === "assigned") job.assignedAt = Date.now();
    if (status === "running" && !job.startedAt) job.startedAt = Date.now();
    this.emit(job, null);
    return job;
  }

  patch(id: string, patch: Partial<StoredJob>): StoredJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    Object.assign(job, patch);
    this.emit(job, null);
    return job;
  }

  /**
   * Append a streamed step.
   *
   * The tail is capped: a chatty agent can emit thousands of tool calls in one
   * job, and the broker holds every job in memory. Keeping the most recent 400
   * bounds that without losing the part anyone reads.
   *
   * A private job keeps status lines only. The node already sends nothing
   * else for one; this is the broker refusing to store reasoning or streamed
   * text for a private job even if an older node sends it. The event still
   * counts as a sign of life.
   */
  addEvent(id: string, event: JobEvent): StoredJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const kept = !job.request.encryptTo
      ? event
      : event.kind === "status"
        ? { ...event, text: String(event.text ?? "").slice(0, 200) }
        : null;
    if (kept) {
      job.events.push(kept);
      if (job.events.length > 400) job.events.splice(0, job.events.length - 400);
    }
    if (job.status === "assigned") {
      job.status = "running";
      job.startedAt ??= Date.now();
    }
    this.emit(job, kept);
    return job;
  }

  /**
   * Hand a job to a different provider, as a fresh assignment.
   *
   * The clock restarts: the new provider gets the full timeout, and the sweep
   * does not count the previous provider's time against it — which is how an
   * overdue job used to bounce between two providers every sweep.
   */
  reassign(
    id: string,
    to: { providerId: string; providerLabel: string; capabilityId: string; capabilityAdapter: AdapterKind },
  ): StoredJob | undefined {
    const job = this.jobs.get(id);
    if (!job || isTerminal(job.status)) return undefined;
    job.providerId = to.providerId;
    job.providerLabel = to.providerLabel;
    job.capabilityId = to.capabilityId;
    job.capabilityAdapter = to.capabilityAdapter;
    job.status = "assigned";
    job.assignedAt = Date.now();
    job.startedAt = null;
    job.attemptedProviders = [...new Set([...(job.attemptedProviders ?? []), to.providerId])];
    this.emit(job, null);
    return job;
  }

  /**
   * Mark a job completed. A no-op once the job is terminal: a result that
   * arrives after a cancel, a timeout or a failure must not resurrect it.
   */
  complete(id: string, result: string, resultHash: string): StoredJob | undefined {
    const job = this.jobs.get(id);
    if (!job || isTerminal(job.status)) return undefined;
    job.status = "completed";
    job.result = result;
    job.resultHash = resultHash;
    job.completedAt = Date.now();
    this.emit(job, null);
    return job;
  }

  /** Mark a job failed; a no-op once it is terminal, for the same reason as `complete`. */
  fail(id: string, error: string): StoredJob | undefined {
    const job = this.jobs.get(id);
    if (!job || isTerminal(job.status)) return undefined;
    job.status = "failed";
    job.error = error;
    job.completedAt = Date.now();
    this.emit(job, null);
    return job;
  }

  /** How long a job has been running on its current provider, for the timeout sweeper. */
  runtimeMs(job: Job): number {
    const started = job.startedAt ?? job.assignedAt ?? job.createdAt;
    return Date.now() - started;
  }

  /** Jobs that have outlived the ceiling and should be failed. */
  overdue(): StoredJob[] {
    return [...this.jobs.values()].filter(
      (job) =>
        (job.status === "assigned" || job.status === "running") &&
        this.runtimeMs(job) > JOB_TIMEOUT_MS,
    );
  }

  // -- live updates ---------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeToJob(jobId: string, listener: Listener): () => void {
    let set = this.jobListeners.get(jobId);
    if (!set) {
      set = new Set();
      this.jobListeners.set(jobId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.jobListeners.delete(jobId);
    };
  }

  private emit(job: StoredJob, event: JobEvent | null): void {
    // One write-through point rather than a save() sprinkled at every call
    // site: every mutation already funnels through emit, so persistence can't
    // be forgotten when a new transition is added.
    this.persist(job);

    for (const listener of this.listeners) {
      // One broken subscriber (a browser that navigated away mid-write) must
      // not take down the emit loop for everyone else.
      try {
        listener(job, event);
      } catch {
        /* ignore */
      }
    }
    for (const listener of this.jobListeners.get(job.id) ?? []) {
      try {
        listener(job, event);
      } catch {
        /* ignore */
      }
    }
  }
}
