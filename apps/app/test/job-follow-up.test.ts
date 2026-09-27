import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@/lib/api";
import { awaitingOnChain, followUpJob } from "@/lib/job-follow-up";

/*
 * The job page used to schedule its one post-"done" refetch inside the SSE
 * effect, whose cleanup cancelled it the moment "done" made the job terminal
 * (and a job already finished at server render never streamed at all). So the
 * XorvLedger receipt link and the verifier's feedback link never appeared
 * without a manual reload.
 */

const PAYMENT = { payer: "0x1", payTo: "0x2", amount: "10000", network: "eip155:10143", txHash: "0xpay", explorerUrl: "" };

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    status: "completed",
    private: false,
    payment: PAYMENT,
    receiptTxHash: null,
    verification: null,
    ...overrides,
  } as unknown as Job;
}

const VERIFIED = { by: "kimi", model: "k3", score: 90, pass: true, rationale: "", feedbackTxHash: "0xfeed" };

describe("awaitingOnChain", () => {
  it("waits for the receipt of a finished paid job, and for the verifier's feedback when one runs", () => {
    expect(awaitingOnChain(job({ status: "running" as Job["status"] }), true)).toBe(false);
    expect(awaitingOnChain(job(), false)).toBe(true);
    expect(awaitingOnChain(job({ receiptTxHash: "0xrcpt" }), false)).toBe(false);
    expect(awaitingOnChain(job({ receiptTxHash: "0xrcpt" }), true)).toBe(true);
    expect(awaitingOnChain(job({ receiptTxHash: "0xrcpt", verification: { ...VERIFIED, feedbackTxHash: null } }), true)).toBe(true);
    expect(awaitingOnChain(job({ receiptTxHash: "0xrcpt", verification: VERIFIED }), true)).toBe(false);
    const failedFeedback = { ...VERIFIED, feedbackTxHash: null, feedbackError: "reverted" };
    expect(awaitingOnChain(job({ receiptTxHash: "0xrcpt", verification: failedFeedback as Job["verification"] }), true)).toBe(false);
    // The verifier skips private jobs and doesn't score failures; an unpaid job gets no receipt.
    expect(awaitingOnChain(job({ receiptTxHash: "0xrcpt", private: true }), true)).toBe(false);
    expect(awaitingOnChain(job({ receiptTxHash: "0xrcpt", status: "failed" }), true)).toBe(false);
    expect(awaitingOnChain(job({ payment: null }), false)).toBe(false);
  });
});

describe("followUpJob", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls a finished job until the receipt and the feedback are in, then stops", async () => {
    const answers = [job(), job({ receiptTxHash: "0xrcpt" }), job({ receiptTxHash: "0xrcpt", verification: VERIFIED })];
    const load = vi.fn(async () => answers[Math.min(load.mock.calls.length - 1, answers.length - 1)]!);
    const seen: Job[] = [];
    followUpJob({ jobId: "job_1", load, onJob: (j) => seen.push(j), needsMore: (j) => awaitingOnChain(j, true), intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(load).toHaveBeenCalledTimes(3);
    expect(seen.at(-1)?.receiptTxHash).toBe("0xrcpt");
    expect(seen.at(-1)?.verification?.feedbackTxHash).toBe("0xfeed");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxPolls, keeps going through a failed fetch, and cancels cleanly", async () => {
    const load = vi.fn(async () => {
      if (load.mock.calls.length === 1) throw new Error("broker blip");
      return job();
    });
    followUpJob({ jobId: "job_1", load, onJob: () => {}, needsMore: () => true, intervalMs: 1_000, maxPolls: 3 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(3);

    const other = vi.fn(async () => job());
    const cancel = followUpJob({ jobId: "job_1", load: other, onJob: () => {}, needsMore: () => true, intervalMs: 1_000 });
    cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(other).not.toHaveBeenCalled();
  });

  it("the job page runs it from its own effect, not from the stream the 'done' event closes", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../components/job-view.tsx"), "utf8");
    expect(source).toMatch(/useEffect\(\(\) => \{\s*if \(!awaiting\) return;\s*return followUpJob\(/);
    expect(source).not.toMatch(/refetch = setTimeout/);
  });
});
