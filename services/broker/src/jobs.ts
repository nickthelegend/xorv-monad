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
import {
  JOB_TIMEOUT_MS,
  QUOTE_TTL_SECONDS,
  type Job,
  type JobEvent,
  type JobRequest,
  type JobStatus,
  newId,
} from "@xorv/protocol";

export interface Quote {
  id: string;
  request: JobRequest;
  providerId: string;
  providerLabel: string;
  providerAccountId: string;
  capabilityId: string;
  capabilityName: string;
  priceUsdMicros: number;
  /**
   * The exact on-chain amounts this quote commits to, frozen at quote time.
   *
   * These must not be recomputed per request. x402 asks the server for payment
   * requirements twice — once to answer 402, once to check the payment that
   * comes back — and the HBAR figure derives from a live exchange rate. Recompute
   * it and a rate refresh between those two calls changes the amount, the
   * payload no longer matches the requirements, and a correctly-signed payment
   * is rejected. A quote is a price commitment; this is where it's kept.
   */
  usdcAmount: string;
  hbarAmount: string | null;
  createdAt: number;
  expiresAt: number;
  /** Set once the quote has been paid, so a replayed payment can't buy twice. */
  jobId?: string;
}

type Listener = (job: Job, event: JobEvent | null) => void;

export class JobStore {
  private quotes = new Map<string, Quote>();
  private jobs = new Map<string, Job>();
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
      this.jobs.set(job.id, job);
      this.sequence.set(job.id, this.nextSequence++);
    }
  }

  /** How many jobs came back from disk — reported at boot. */
  get restoredCount(): number {
    return this.jobs.size;
  }

  private persist(job: Job): void {
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

  getQuote(id: string): Quote | undefined {
    const quote = this.quotes.get(id);
    if (!quote) return undefined;
    if (Date.now() > quote.expiresAt) {
      this.quotes.delete(id);
      return undefined;
    }
    return quote;
  }

  // -- jobs -----------------------------------------------------------------

  createJob(quote: Quote): Job {
    const job: Job = {
      id: newId("job"),
      request: quote.request,
      status: "paid",
      createdAt: Date.now(),
      providerId: quote.providerId,
      providerLabel: quote.providerLabel,
      providerAccountId: quote.providerAccountId,
      capabilityId: quote.capabilityId,
      priceUsdMicros: quote.priceUsdMicros,
      events: [],
    };
    this.jobs.set(job.id, job);
    this.sequence.set(job.id, this.nextSequence++);
    quote.jobId = job.id;
    this.emit(job, null);
    return job;
  }

  get(id: string): Job | undefined {
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
  list(opts: { limit?: number; providerId?: string } = {}): Job[] {
    let all = [...this.jobs.values()].sort((a, b) => {
      const bySeq = (this.sequence.get(b.id) ?? 0) - (this.sequence.get(a.id) ?? 0);
      return b.createdAt - a.createdAt || bySeq;
    });
    if (opts.providerId) all = all.filter((j) => j.providerId === opts.providerId);
    return all.slice(0, opts.limit ?? 50);
  }

  setStatus(id: string, status: JobStatus): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.status = status;
    if (status === "assigned") job.assignedAt = Date.now();
    if (status === "running" && !job.startedAt) job.startedAt = Date.now();
    this.emit(job, null);
    return job;
  }

  patch(id: string, patch: Partial<Job>): Job | undefined {
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
   */
  addEvent(id: string, event: JobEvent): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.events.push(event);
    if (job.events.length > 400) job.events.splice(0, job.events.length - 400);
    if (job.status === "assigned") {
      job.status = "running";
      job.startedAt ??= Date.now();
    }
    this.emit(job, event);
    return job;
  }

  complete(id: string, result: string, resultHash: string): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.status = "completed";
    job.result = result;
    job.resultHash = resultHash;
    job.completedAt = Date.now();
    this.emit(job, null);
    return job;
  }

  fail(id: string, error: string): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.status = "failed";
    job.error = error;
    job.completedAt = Date.now();
    this.emit(job, null);
    return job;
  }

  /** How long a job has been running, for the timeout sweeper. */
  runtimeMs(job: Job): number {
    const started = job.startedAt ?? job.assignedAt ?? job.createdAt;
    return Date.now() - started;
  }

  /** Jobs that have outlived the ceiling and should be failed. */
  overdue(): Job[] {
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

  private emit(job: Job, event: JobEvent | null): void {
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
