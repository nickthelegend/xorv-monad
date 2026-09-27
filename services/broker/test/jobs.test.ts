/**
 * Quotes and the job state machine.
 *
 * The critical invariant is that a quote is a *price commitment*: the same
 * provider at the same amounts, for both the 402 and the payment that answers
 * it, and usable exactly once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobStore, MAX_OPEN_QUOTES, type Quote } from "../src/jobs.js";

const PAYEE = "0x1111111111111111111111111111111111111111";

function quoteInput(over: Partial<Omit<Quote, "id" | "createdAt" | "expiresAt">> = {}) {
  return {
    request: { prompt: "hello", maxPriceUsdMicros: 50_000 },
    providerId: "prv_1",
    providerLabel: "node-a",
    providerAddress: PAYEE,
    providerAgentId: null,
    capabilityId: "echo",
    capabilityName: "Echo (test)",
    capabilityAdapter: "echo" as const,
    priceUsdMicros: 1_000,
    usdcAmount: "1000",
    ...over,
  };
}

describe("quotes", () => {
  let store: JobStore;
  beforeEach(() => {
    store = new JobStore();
  });

  it("freezes the amounts at quote time so both 402 answers agree", () => {
    const quote = store.createQuote(quoteInput());
    const a = store.getQuote(quote.id)!;
    const b = store.getQuote(quote.id)!;
    expect(a.usdcAmount).toBe("1000");
    expect(b.usdcAmount).toBe(a.usdcAmount);
    expect(b.providerAddress).toBe(a.providerAddress);
  });

  it("expires after its TTL and stops resolving", () => {
    vi.useFakeTimers();
    const quote = store.createQuote(quoteInput());
    expect(store.getQuote(quote.id)).toBeDefined();
    vi.advanceTimersByTime(301_000);
    expect(store.getQuote(quote.id)).toBeUndefined();
    vi.useRealTimers();
  });

  it("records the job it bought, so a replayed payment can be refused", () => {
    const quote = store.createQuote(quoteInput());
    const job = store.createJob(quote);
    expect(store.getQuote(quote.id)!.jobId).toBe(job.id);
  });

  it("stays resolvable past its TTL while a payment for it is settling", () => {
    // Money that moved must always find its quote, even if the TTL ran out
    // between the buyer signing and the settlement landing.
    vi.useFakeTimers();
    const quote = store.createQuote(quoteInput());
    quote.paying = true;
    vi.advanceTimersByTime(301_000);
    expect(store.getQuote(quote.id)).toBeDefined();
    quote.paying = false;
    expect(store.getQuote(quote.id)).toBeUndefined();
    vi.useRealTimers();
  });

  it("returns undefined for an unknown quote", () => {
    expect(store.getQuote("qte_nope")).toBeUndefined();
  });

  it("prunes expired quotes nobody looks up again, but not one mid-settlement", () => {
    // Removal used to be lazy, in getQuote only: a quote that was never paid
    // or asked for again stayed in memory for good, request body and all.
    vi.useFakeTimers();
    const stale = store.createQuote(quoteInput());
    const settling = store.createQuote(quoteInput());
    settling.paying = true;
    vi.advanceTimersByTime(301_000);
    const fresh = store.createQuote(quoteInput());
    expect(store.quoteCount).toBe(3);
    expect(store.pruneQuotes()).toBe(1);
    expect(store.quoteCount).toBe(2);
    expect(store.getQuote(stale.id)).toBeUndefined();
    expect(store.getQuote(settling.id)).toBeDefined();
    expect(store.getQuote(fresh.id)).toBeDefined();
    vi.useRealTimers();
  });

  it("stops taking quotes at the cap, and makes room once old ones expire", () => {
    vi.useFakeTimers();
    for (let i = 0; i < MAX_OPEN_QUOTES; i += 1) store.createQuote(quoteInput());
    expect(store.hasQuoteRoom()).toBe(false);
    vi.advanceTimersByTime(301_000);
    expect(store.hasQuoteRoom()).toBe(true);
    expect(store.quoteCount).toBe(0);
    vi.useRealTimers();
  });
});

describe("job lifecycle", () => {
  let store: JobStore;
  beforeEach(() => {
    store = new JobStore();
  });

  it("starts paid and carries the quote's provider and price", () => {
    const job = store.createJob(store.createQuote(quoteInput()));
    expect(job.status).toBe("paid");
    expect(job.providerAddress).toBe(PAYEE);
    expect(job.quoteId).toBeTruthy();
    expect(job.quotedProviderId).toBe("prv_1");
    expect(job.priceUsdMicros).toBe(1_000);
    expect(job.events).toEqual([]);
  });

  it("moves paid → assigned → running → completed", () => {
    const job = store.createJob(store.createQuote(quoteInput()));
    store.setStatus(job.id, "assigned");
    expect(store.get(job.id)!.assignedAt).toBeGreaterThan(0);

    store.addEvent(job.id, { at: Date.now(), kind: "status", text: "started" });
    expect(store.get(job.id)!.status).toBe("running");
    expect(store.get(job.id)!.startedAt).toBeGreaterThan(0);

    store.complete(job.id, "the answer", "abc123");
    const done = store.get(job.id)!;
    expect(done.status).toBe("completed");
    expect(done.result).toBe("the answer");
    expect(done.resultHash).toBe("abc123");
    expect(done.completedAt).toBeGreaterThan(0);
  });

  it("caps the retained event tail so a chatty agent can't grow the heap", () => {
    const job = store.createJob(store.createQuote(quoteInput()));
    for (let i = 0; i < 500; i += 1) {
      store.addEvent(job.id, { at: Date.now(), kind: "tool_call", text: `call ${i}` });
    }
    const events = store.get(job.id)!.events;
    expect(events).toHaveLength(400);
    // The tail that's kept is the most recent one, which is what anyone reads.
    expect(events.at(-1)!.text).toBe("call 499");
  });

  it("records a failure with its reason", () => {
    const job = store.createJob(store.createQuote(quoteInput()));
    store.fail(job.id, "provider exploded");
    expect(store.get(job.id)!.status).toBe("failed");
    expect(store.get(job.id)!.error).toBe("provider exploded");
  });

  it("carries the settlement it was bought with from the moment it exists", () => {
    const payment = {
      asset: "usdc" as const,
      assetAddress: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      amount: "1000",
      network: "eip155:10143",
      txHash: `0x${"ab".repeat(32)}`,
      payer: "0x2222222222222222222222222222222222222222",
      payTo: PAYEE,
      settledAt: Date.now(),
      explorerUrl: "https://testnet.monadscan.com/tx/0xab",
    };
    const job = store.createJob(store.createQuote(quoteInput()), { payment, cancelTokenHash: "h" });
    expect(store.get(job.id)!.payment).toEqual(payment);
    expect(store.get(job.id)!.cancelTokenHash).toBe("h");
  });

  it("will not resurrect a terminal job", () => {
    // A cancel marks the job failed; a result (or error) that arrives after
    // must not flip it back — that is how a cancelled job used to come back.
    const job = store.createJob(store.createQuote(quoteInput()));
    store.fail(job.id, "cancelled by the buyer");
    expect(store.complete(job.id, "late answer", "h")).toBeUndefined();
    expect(store.fail(job.id, "late error")).toBeUndefined();
    const after = store.get(job.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toBe("cancelled by the buyer");
    expect(after.result).toBeUndefined();
  });

  it("is a no-op on unknown job ids rather than throwing", () => {
    expect(store.setStatus("job_nope", "running")).toBeUndefined();
    expect(store.addEvent("job_nope", { at: 1, kind: "status", text: "x" })).toBeUndefined();
    expect(store.complete("job_nope", "r", "h")).toBeUndefined();
    expect(store.fail("job_nope", "e")).toBeUndefined();
  });
});

describe("overdue sweeping", () => {
  it("flags only in-flight jobs that outran the ceiling", () => {
    vi.useFakeTimers();
    const store = new JobStore();

    const running = store.createJob(store.createQuote(quoteInput()));
    store.setStatus(running.id, "assigned");

    const finished = store.createJob(store.createQuote(quoteInput()));
    store.complete(finished.id, "done", "h");

    vi.advanceTimersByTime(11 * 60_000);

    const overdue = store.overdue();
    expect(overdue.map((j) => j.id)).toEqual([running.id]);
    vi.useRealTimers();
  });
});

describe("reassignment", () => {
  it("restarts the clock and remembers every provider that had the job", () => {
    vi.useFakeTimers();
    const store = new JobStore();
    const job = store.createJob(store.createQuote(quoteInput()));
    store.setStatus(job.id, "assigned");
    store.addEvent(job.id, { at: Date.now(), kind: "status", text: "started" });

    vi.advanceTimersByTime(9 * 60_000);
    store.reassign(job.id, { providerId: "prv_2", providerLabel: "node-b", capabilityId: "echo", capabilityAdapter: "echo" });
    const moved = store.get(job.id)!;
    expect(moved.providerId).toBe("prv_2");
    expect(moved.status).toBe("assigned");
    expect(moved.startedAt).toBeNull();
    expect(store.runtimeMs(moved)).toBe(0);
    expect(moved.attemptedProviders).toEqual(["prv_1", "prv_2"]);
    // The payee does not move with the work.
    expect(moved.quotedProviderId).toBe("prv_1");
    expect(moved.providerAddress).toBe(PAYEE);

    // The new provider gets the full timeout, not what was left of the old one.
    vi.advanceTimersByTime(2 * 60_000);
    expect(store.overdue()).toHaveLength(0);
    vi.useRealTimers();
  });

  it("refuses to reassign a job that is already over", () => {
    const store = new JobStore();
    const job = store.createJob(store.createQuote(quoteInput()));
    store.complete(job.id, "done", "h");
    expect(
      store.reassign(job.id, { providerId: "prv_2", providerLabel: "b", capabilityId: "echo", capabilityAdapter: "echo" }),
    ).toBeUndefined();
  });
});

describe("subscriptions", () => {
  it("notifies global and per-job listeners, and unsubscribes cleanly", () => {
    const store = new JobStore();
    const job = store.createJob(store.createQuote(quoteInput()));

    const global = vi.fn();
    const perJob = vi.fn();
    const offGlobal = store.subscribe(global);
    const offJob = store.subscribeToJob(job.id, perJob);

    store.addEvent(job.id, { at: Date.now(), kind: "message", text: "hi" });
    expect(global).toHaveBeenCalled();
    expect(perJob).toHaveBeenCalled();

    offGlobal();
    offJob();
    global.mockClear();
    perJob.mockClear();

    store.complete(job.id, "r", "h");
    expect(global).not.toHaveBeenCalled();
    expect(perJob).not.toHaveBeenCalled();
  });

  it("keeps emitting to everyone else when one subscriber throws", () => {
    const store = new JobStore();
    const job = store.createJob(store.createQuote(quoteInput()));
    const healthy = vi.fn();
    store.subscribe(() => {
      throw new Error("this subscriber is broken");
    });
    store.subscribe(healthy);
    expect(() => store.complete(job.id, "r", "h")).not.toThrow();
    expect(healthy).toHaveBeenCalled();
  });
});

describe("listing", () => {
  it("returns newest first and honours the limit and provider filter", () => {
    const store = new JobStore();
    const a = store.createJob(store.createQuote(quoteInput({ providerId: "prv_a" })));
    const b = store.createJob(store.createQuote(quoteInput({ providerId: "prv_b" })));

    const all = store.list({ limit: 10 });
    expect(all[0]!.id).toBe(b.id);
    expect(all).toHaveLength(2);

    expect(store.list({ providerId: "prv_a" }).map((j) => j.id)).toEqual([a.id]);
    expect(store.list({ limit: 1 })).toHaveLength(1);
  });
});
