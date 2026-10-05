/**
 * Quotes and the job state machine.
 *
 * The critical invariant is that a quote is a *price commitment*: the same
 * provider at the same amounts, for both the 402 and the payment that answers
 * it, and usable exactly once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { JobStore, type Quote } from "../src/jobs.js";

function quoteInput(over: Partial<Omit<Quote, "id" | "createdAt" | "expiresAt">> = {}) {
  return {
    request: { prompt: "hello", maxPriceUsdMicros: 50_000 },
    providerId: "prv_1",
    providerLabel: "node-a",
    providerAddress: "0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B",
    capabilityId: "echo",
    capabilityName: "Echo (test)",
    priceUsdMicros: 1_000,
    amountUnits: "1000",
    options: [
      { symbol: "AUSD", asset: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC", eip712: { name: "Agora Dollar", version: "1" } },
      { symbol: "USDC", asset: "0x534b2f3A21130d7a60830c2Df862319e593943A3", eip712: { name: "USDC", version: "2" } },
    ],
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
    expect(a.amountUnits).toBe("1000");
    expect(b.amountUnits).toBe(a.amountUnits);
    expect(b.providerAddress).toBe(a.providerAddress);
    // The payment options are frozen for the same reason as the amount: x402
    // asks for requirements twice, and anything that differs between the two
    // calls rejects a correctly-signed payment.
    expect(b.options).toEqual(a.options);
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

  it("still knows a paid quote after it expires, so a late retry is refused rather than re-quoted", () => {
    // A retry after the TTL used to be told "request a new one" — an invitation
    // to pay a second time for the job the buyer had already bought.
    vi.useFakeTimers();
    const quote = store.createQuote(quoteInput());
    const job = store.createJob(quote);
    vi.advanceTimersByTime(301_000);
    expect(store.getQuote(quote.id)).toBeUndefined();
    expect(store.paidJobIdForQuote(quote.id)).toBe(job.id);
    expect(store.paidJobIdForQuote("qte_nope")).toBeUndefined();
    vi.useRealTimers();
  });

  it("does not treat an unpaid quote as paid", () => {
    const quote = store.createQuote(quoteInput());
    expect(store.paidJobIdForQuote(quote.id)).toBeUndefined();
  });

  it("carries each stablecoin's EIP-712 domain the buyer has to sign against, AUSD first", () => {
    // x402's EVM scheme fills this in only for tokens in its built-in
    // registry, and AUSD is not one of them, so the quote must.
    const quote = store.createQuote(quoteInput());
    const options = store.getQuote(quote.id)!.options;
    expect(options.map((o) => o.symbol)).toEqual(["AUSD", "USDC"]);
    expect(options[0]!.eip712).toEqual({ name: "Agora Dollar", version: "1" });
  });

  it("returns undefined for an unknown quote", () => {
    expect(store.getQuote("qte_nope")).toBeUndefined();
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
    expect(job.providerAddress).toBe("0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B");
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
