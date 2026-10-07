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
import { Registry, type VerifiedRegistration } from "../src/registry.js";

const PAYEE = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const TX = `0x${"ab".repeat(32)}`;

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
    providerAddress: PAYEE,
    providerAgentId: null,
    capabilityId: "echo",
    capabilityName: "Echo (test)",
    capabilityAdapter: "echo" as const,
    priceUsdMicros: price,
    usdcAmount: String(price),
  };
}

function registration(over: Partial<VerifiedRegistration> = {}): VerifiedRegistration {
  return {
    label: "node-a",
    address: PAYEE,
    agentId: null,
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
        asset: "usdc",
        assetAddress: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
        amount: "1000",
        network: "eip155:10143",
        txHash: TX,
        payer: PAYER,
        payTo: PAYEE,
        settledAt: Date.now(),
        explorerUrl: `https://testnet.monadvision.com/tx/${TX}`,
      },
      receiptTxHash: `0x${"cd".repeat(32)}`,
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
    expect(restored.payment!.txHash).toBe(TX);
    expect(restored.payment!.payTo).toBe(PAYEE);
    expect(restored.receiptTxHash).toBe(`0x${"cd".repeat(32)}`);
    expect(restored.quotedProviderId).toBe("prv_1");
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

  it("keeps the payout address with the stats", () => {
    const first = new Registry(store());
    const provider = first.register(registration());
    first.jobFinished(provider.id, { ok: true, durationMs: 1, usdcMicros: 3_000 });
    const restored = store().loadStats().get("stable-node-id")!;
    expect(restored.address).toBe(PAYEE);
    expect(restored.earnedUsdcMicros).toBe(3_000);
  });
});

describe("rows from an older build", () => {
  it("upgrades a Hedera-era job row instead of losing its payment", () => {
    const p = store();
    p.saveJob({
      id: "job_legacy",
      createdAt: Date.now(),
      status: "completed",
      request: { prompt: "old", maxPriceUsdMicros: 1_000 },
      providerAccountId: "0.0.1001",
      receiptConsensusAt: "0.0.9842030@1785475549.1",
      payment: {
        asset: "usdc",
        assetId: "0.0.429274",
        amount: "1000",
        transactionId: "0.0.9842030@1785475549.2",
        hashscanUrl: "https://hashscan.io/testnet/transaction/x",
        payer: "0.0.2",
        payTo: "0.0.1001",
      },
      events: [],
    } as never);

    const job = new JobStore(store()).get("job_legacy")!;
    expect(job.providerAddress).toBe("0.0.1001");
    expect(job.receiptTxHash).toBe("0.0.9842030@1785475549.1");
    expect(job.payment!.txHash).toBe("0.0.9842030@1785475549.2");
    expect(job.payment!.assetAddress).toBe("0.0.429274");
    expect(job.payment!.explorerUrl).toContain("hashscan");
    expect(job as unknown as Record<string, unknown>).not.toHaveProperty("providerAccountId");
  });

  it("drops stats fields that no longer exist", () => {
    const p = store();
    p.saveStats("legacy-node", "old", "0.0.1001", {
      jobsCompleted: 2,
      jobsFailed: 1,
      earnedUsdcMicros: 7,
      earnedTinybars: 99,
      avgDurationMs: 10,
    } as never);
    const row = store().loadStats().get("legacy-node")!;
    expect(row).toMatchObject({ jobsCompleted: 2, earnedUsdcMicros: 7, address: "0.0.1001" });
    expect(row).not.toHaveProperty("earnedTinybars");
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
