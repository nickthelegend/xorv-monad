import { describe, expect, it } from "vitest";
import type { Job } from "@/lib/api";
import { jobOutcome, offsetLabel, paymentTimeline } from "@/lib/payment-timeline";

const T0 = 1_760_000_000_000;
const ESCROW = "0x9a6f27d9bfdd9abd20600d8e7ea3fff6ceeab377";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    status: "completed",
    private: false,
    providerLabel: "atlas",
    providerAddress: "0xd5cdc9020acd286fe06c587694b38f4795df238c",
    priceLabel: "$0.0010",
    assignedAt: T0 + 50,
    startedAt: T0 + 100,
    completedAt: T0 + 760,
    error: null,
    resultHash: "0x382fc6b11214f927586375c3665f81d74773082ebfd9157e7531ee6929e03af9",
    receiptTxHash: "0xrcpt",
    payment: {
      asset: "usdc",
      assetAddress: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      amount: "1000",
      network: "eip155:10143",
      txHash: "0xfund",
      payer: "0x9735aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5c96",
      payTo: "0xd5cdc9020acd286fe06c587694b38f4795df238c",
      settledAt: T0,
      explorerUrl: "",
      scheme: "escrow",
      escrow: {
        address: ESCROW,
        jobId: "0xjob",
        deadline: Math.floor(T0 / 1000) + 1800,
        state: "released",
        provider: "0xd5cdc9020acd286fe06c587694b38f4795df238c",
        releaseTx: "0xrelease",
        settledAt: T0 + 1210,
        explorerUrl: "",
      },
    },
    ...overrides,
  } as unknown as Job;
}

function withEscrow(j: Job, escrow: Partial<NonNullable<NonNullable<Job["payment"]>["escrow"]>>): Job {
  return { ...j, payment: { ...j.payment!, escrow: { ...j.payment!.escrow!, ...escrow } } } as Job;
}

describe("paymentTimeline", () => {
  it("tells a released escrow job as paid → running → delivered → released → receipted, each with its proof", () => {
    const steps = paymentTimeline(job());
    expect(steps.map((s) => s.key)).toEqual(["paid", "running", "delivered", "settled", "receipt"]);
    expect(steps.every((s) => s.state === "done")).toBe(true);
    expect(steps[0]).toMatchObject({ title: "Paid into XorvEscrow", tx: "0xfund", at: T0 });
    expect(steps[0]!.detail).toContain("paid no gas");
    expect(steps[3]).toMatchObject({ title: "Released to atlas", tx: "0xrelease", at: T0 + 1210 });
    expect(steps[4]).toMatchObject({ tx: "0xrcpt" });
  });

  it("shows a cancelled job as refunded in full, not as a failure the buyer paid for", () => {
    const cancelled = withEscrow(job({ status: "failed", error: "cancelled by the buyer", resultHash: null }), {
      state: "refunded",
      releaseTx: undefined,
      refundTx: "0xrefund",
    });
    const steps = paymentTimeline(cancelled);
    expect(steps[2]).toMatchObject({ title: "Cancelled by the buyer", state: "failed" });
    expect(steps[3]).toMatchObject({ title: "Refunded to the buyer", tx: "0xrefund", state: "done" });
    expect(steps[3]!.detail).toContain("full $0.0010");
    expect(jobOutcome(cancelled)).toBe("refunded");
  });

  it("names who settled it when it wasn't this broker (a CRE keeper's refund after the deadline)", () => {
    const steps = paymentTimeline(
      withEscrow(job({ status: "failed", error: "timed out" }), { state: "refunded", refundTx: "0xr", settledBy: "0x1111111111111111111111111111111111111111" }),
    );
    expect(steps[2]).toMatchObject({ title: "Not delivered", detail: "timed out" });
    expect(steps[3]!.detail).toContain("not this broker");
  });

  it("is live while the money is held: running is active, settlement and receipt are still to come", () => {
    const running = withEscrow(job({ status: "running", completedAt: null, receiptTxHash: null }), { state: "funded", releaseTx: undefined, settledAt: undefined });
    const states = Object.fromEntries(paymentTimeline(running).map((s) => [s.key, s.state]));
    expect(states).toEqual({ paid: "done", running: "active", delivered: "pending", settled: "pending", receipt: "pending" });
    expect(paymentTimeline(running)[3]!.detail).toContain("Chainlink CRE keeper");
  });

  it("shows a settlement in flight, with the retry reason, once the job is over", () => {
    const steps = paymentTimeline(withEscrow(job(), { state: "funded", releaseTx: undefined, lastError: "nonce too low" }));
    expect(steps[3]).toMatchObject({ title: "Releasing to the provider", state: "active", detail: "Retrying: nonce too low" });
  });

  it("records a reassignment with its on-chain re-point", () => {
    const steps = paymentTimeline(withEscrow(job(), { reassignTxs: ["0xmove"] }));
    expect(steps[1]).toMatchObject({ tx: "0xmove" });
    expect(steps[1]!.detail).toContain("re-pointed on-chain");
  });

  it("tells a direct payment without an escrow step", () => {
    const direct = job({ payment: { ...job().payment!, scheme: "exact", escrow: undefined } as Job["payment"] });
    const steps = paymentTimeline(direct);
    expect(steps.map((s) => s.key)).toEqual(["paid", "running", "delivered", "receipt"]);
    expect(steps[0]!.title).toBe("Paid to atlas");
    expect(jobOutcome(direct)).toBe("completed");
  });
});

describe("offsetLabel", () => {
  it("formats time since the payment", () => {
    expect(offsetLabel(T0 + 1210, T0)).toBe("+1.2 s");
    expect(offsetLabel(T0 + 45_000, T0)).toBe("+45 s");
    expect(offsetLabel(T0 + 600_000, T0)).toBe("+10 min");
    expect(offsetLabel(null, T0)).toBeNull();
  });
});
