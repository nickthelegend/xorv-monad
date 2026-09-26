/**
 * Persistence.
 *
 * The point of these tests is one sentence: **a restart must not lose money or
 * history.** So they don't just check the SQL round-trips — they build a store,
 * throw it away, build a fresh one over the same file, and assert the world
 * looks the same.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryPersistence, openPersistence, type Persistence } from "../src/store.js";
import { JobStore } from "../src/jobs.js";
import { Registry } from "../src/registry.js";
import type { RegisterRequest } from "@xorv/protocol";

let dir: string;
let file: string;
let open: Persistence[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-db-"));
  file = path.join(dir, "test.db");
  open = [];
});

afterEach(() => {
  for (const p of open) p.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function store(): Persistence {
  const p = openPersistence(file);
  open.push(p);
  return p;
}

function quoteInput(price = 1_000) {
  return {
    request: { prompt: "persisted prompt", maxPriceUsdMicros: 50_000 },
    providerId: "prv_1",
    providerLabel: "node-a",
    providerAccountId: "0.0.1001",
    capabilityId: "echo",
    capabilityName: "Echo (test)",
    priceUsdMicros: price,
    usdcAmount: String(price),
    hbarAmount: "1462167",
  };
}

function registration(over: Partial<RegisterRequest> = {}): RegisterRequest {
  return {
    label: "node-a",
    accountId: "0.0.1001",
    endpoint: "http://localhost:1",
    capabilities: [
      {
        id: "echo",
        adapter: "echo",
        displayName: "Echo",
        model: null,
        priceUsdMicros: 1_000,
        maxConcurrency: 4,
      },
    ],
    version: "0.1.0",
    region: null,
    nodeId: "stable-node-id",
    ...over,
  };
}

describe("openPersistence", () => {
  it("opens a sqlite store and creates the file", () => {
    const p = store();
    expect(p.kind).toBe("sqlite");
    expect(fs.existsSync(file)).toBe(true);
  });

  it("returns the memory store when persistence is switched off", () => {
    expect(openPersistence("off").kind).toBe("memory");
    expect(openPersistence(null).kind).toBe("memory");
  });

  it("degrades to memory rather than refusing to boot on a bad path", () => {
    // A directory where a file should be — the broker must still start.
    const p = openPersistence(dir);
    expect(p.kind).toBe("memory");
  });

  it("says plainly that the memory store does not persist", () => {
    expect(new MemoryPersistence().location).toMatch(/lost on restart/i);
  });
});

describe("jobs survive a restart", () => {
  it("restores completed jobs with their payment and result intact", () => {
    const first = new JobStore(store());
    const job = first.createJob(first.createQuote(quoteInput()));
    first.patch(job.id, {
      payment: {
        asset: "hbar",
        assetId: "0.0.0",
        amount: "1462167",
        network: "hedera:testnet",
        transactionId: "0.0.9842030@1785475549.131327424",
        payer: "0.0.9848440",
        payTo: "0.0.9848438",
        settledAt: Date.now(),
        hashscanUrl: "https://hashscan.io/testnet/transaction/x",
      },
    });
    first.addEvent(job.id, { at: Date.now(), kind: "message", text: "working" });
    first.complete(job.id, "the durable answer", "hash123");

    // A completely fresh process over the same file.
    const second = new JobStore(store());
    const restored = second.get(job.id)!;

    expect(restored).toBeDefined();
    expect(restored.status).toBe("completed");
    expect(restored.result).toBe("the durable answer");
    expect(restored.resultHash).toBe("hash123");
    expect(restored.payment!.transactionId).toBe("0.0.9842030@1785475549.131327424");
    expect(restored.payment!.payTo).toBe("0.0.9848438");
    expect(restored.events.length).toBeGreaterThan(0);
    expect(second.restoredCount).toBe(1);
  });

  it("keeps newest-first ordering across a restart", () => {
    const first = new JobStore(store());
    const a = first.createJob(first.createQuote(quoteInput()));
    const b = first.createJob(first.createQuote(quoteInput()));
    first.complete(a.id, "a", "h");
    first.complete(b.id, "b", "h");

    const second = new JobStore(store());
    const listed = second.list({ limit: 10 });
    expect(listed).toHaveLength(2);
    expect(listed[0]!.id).toBe(b.id);
  });

  it("does NOT restore quotes, because no provider is live yet after a restart", () => {
    const first = new JobStore(store());
    const quote = first.createQuote(quoteInput());
    const second = new JobStore(store());
    // Reviving a quote would let someone pay for a node that isn't there.
    expect(second.getQuote(quote.id)).toBeUndefined();
  });

  it("updates a job in place rather than accumulating rows", () => {
    const first = new JobStore(store());
    const job = first.createJob(first.createQuote(quoteInput()));
    for (let i = 0; i < 20; i += 1) {
      first.addEvent(job.id, { at: Date.now(), kind: "status", text: `step ${i}` });
    }
    first.complete(job.id, "done", "h");

    const second = new JobStore(store());
    expect(second.list({ limit: 100 })).toHaveLength(1);
    expect(second.get(job.id)!.status).toBe("completed");
  });
});

describe("earnings survive a restart", () => {
  it("restores lifetime stats for the same nodeId", () => {
    const p1 = store();
    const first = new Registry(p1);
    const provider = first.register(registration());
    first.jobStarted(provider.id);
    first.jobFinished(provider.id, { ok: true, durationMs: 1_000, usdcMicros: 10_000 });
    first.jobFinished(provider.id, { ok: false, durationMs: 500 });

    // New process, same node comes back.
    const second = new Registry(store());
    expect(second.restoredStatsCount).toBe(1);
    const again = second.register(registration());
    expect(again.stats.jobsCompleted).toBe(1);
    expect(again.stats.jobsFailed).toBe(1);
    expect(again.stats.earnedUsdcMicros).toBe(10_000);
  });

  it("gives a genuinely new node a clean slate", () => {
    const first = new Registry(store());
    const provider = first.register(registration());
    first.jobFinished(provider.id, { ok: true, durationMs: 1, usdcMicros: 5_000 });

    const second = new Registry(store());
    const newcomer = second.register(registration({ nodeId: "a-different-node" }));
    expect(newcomer.stats.jobsCompleted).toBe(0);
    expect(newcomer.stats.earnedUsdcMicros).toBe(0);
  });

  it("keeps HBAR and USDC earnings separate across a restart", () => {
    const first = new Registry(store());
    const provider = first.register(registration());
    first.jobFinished(provider.id, { ok: true, durationMs: 1, usdcMicros: 3_000 });
    first.jobFinished(provider.id, { ok: true, durationMs: 1, tinybars: 1_462_167 });

    const second = new Registry(store());
    const again = second.register(registration());
    expect(again.stats.earnedUsdcMicros).toBe(3_000);
    expect(again.stats.earnedTinybars).toBe(1_462_167);
  });
});

describe("pruning", () => {
  it("drops jobs older than the retention window and keeps recent ones", () => {
    const p = store();
    const jobs = new JobStore(p);
    const recent = jobs.createJob(jobs.createQuote(quoteInput()));
    jobs.complete(recent.id, "keep me", "h");

    // Backdate one job directly through the store.
    const old = jobs.createJob(jobs.createQuote(quoteInput()));
    const backdated = { ...jobs.get(old.id)!, createdAt: Date.now() - 90 * 86_400_000 };
    p.saveJob(backdated);

    const removed = p.prune(30 * 86_400_000);
    expect(removed).toBe(1);

    const after = new JobStore(store());
    expect(after.list({ limit: 100 }).map((j) => j.id)).toEqual([recent.id]);
  });

  it("removes nothing when everything is inside the window", () => {
    const p = store();
    const jobs = new JobStore(p);
    jobs.complete(jobs.createJob(jobs.createQuote(quoteInput())).id, "r", "h");
    expect(p.prune(30 * 86_400_000)).toBe(0);
  });
});

describe("resilience", () => {
  it("skips a corrupt row instead of losing the whole history", () => {
    const p = store();
    const jobs = new JobStore(p);
    const good = jobs.createJob(jobs.createQuote(quoteInput()));
    jobs.complete(good.id, "fine", "h");

    // Simulate a truncated write.
    p.saveJob({ id: "job_corrupt", createdAt: Date.now(), status: "completed" } as never);
    const raw = openPersistence(file);
    open.push(raw);
    // A row whose body isn't valid JSON is dropped, the good one survives.
    expect(raw.loadJobs().some((j) => j.id === good.id)).toBe(true);
  });

  it("is safe to open the same file twice", () => {
    const a = store();
    const b = store();
    const jobs = new JobStore(a);
    const job = jobs.createJob(jobs.createQuote(quoteInput()));
    jobs.complete(job.id, "r", "h");
    expect(b.loadJobs().some((j) => j.id === job.id)).toBe(true);
  });
});
