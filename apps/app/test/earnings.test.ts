import { describe, expect, it } from "vitest";
import type { Job } from "@/lib/api";
import { dayKey, providerEarnings } from "@/lib/earnings";

const NOW = Date.parse("2026-10-07T15:00:00Z");
const DAY = 86_400_000;
const ME = "0xd5cdc9020acd286fe06c587694b38f4795df238c";
const OTHER = "0x52493575e349133a5ca6e73a1abe6119bd0b0157";

let n = 0;
function job(opts: {
  payee?: string;
  units?: string;
  at?: number;
  escrow?: "funded" | "released" | "refunded" | null;
  private?: boolean;
  paid?: boolean;
}): Job {
  const at = opts.at ?? NOW;
  const payee = opts.payee ?? ME;
  const id = `job_${++n}`;
  const escrow =
    opts.escrow === null || opts.escrow === undefined
      ? undefined
      : {
          address: "0xe5c0000000000000000000000000000000000e5c",
          jobId: "0x01",
          deadline: 0,
          state: opts.escrow,
          provider: payee,
          releaseTx: opts.escrow === "released" ? `0xrel${n}` : undefined,
          refundTx: opts.escrow === "refunded" ? `0xref${n}` : undefined,
          settledAt: opts.escrow === "funded" ? undefined : at + 1000,
          explorerUrl: "",
        };
  return {
    id,
    title: null,
    prompt: `prompt ${n}`,
    private: opts.private ?? false,
    createdAt: at,
    completedAt: at + 700,
    payment:
      opts.paid === false
        ? null
        : { amount: opts.units ?? "1000", payTo: payee, payer: "0xb", txHash: `0xfund${n}`, settledAt: at, escrow, scheme: escrow ? "escrow" : "exact" },
  } as unknown as Job;
}

describe("providerEarnings", () => {
  it("counts released and direct payments as earned, and keeps held and refunded apart", () => {
    const jobs = [
      job({ escrow: "released", units: "1000" }),
      job({ escrow: null, units: "2500" }),
      job({ escrow: "funded", units: "4000" }),
      job({ escrow: "refunded", units: "8000" }),
    ];
    const e = providerEarnings(jobs, ME.toUpperCase().replace("0X", "0x"), { now: NOW });
    expect(e).toMatchObject({ earned: 3500n, held: 4000n, refunded: 8000n });
    expect(e.payouts.map((p) => p.state).sort()).toEqual(["held", "paid", "refunded", "released"]);
  });

  it("links each payout to the transaction that moved it", () => {
    const [released, direct, refunded] = [job({ escrow: "released" }), job({ escrow: null }), job({ escrow: "refunded" })];
    const byId = Object.fromEntries(providerEarnings([released, direct, refunded], ME, { now: NOW }).payouts.map((p) => [p.jobId, p.tx]));
    expect(byId[released.id]).toMatch(/^0xrel/);
    expect(byId[direct.id]).toMatch(/^0xfund/);
    expect(byId[refunded.id]).toMatch(/^0xref/);
  });

  it("only counts money paid to this provider's address, and skips unpaid jobs", () => {
    const e = providerEarnings([job({ payee: OTHER, escrow: "released" }), job({ paid: false }), job({ escrow: "released" })], ME, { now: NOW });
    expect(e.payouts).toHaveLength(1);
    expect(e.earned).toBe(1000n);
  });

  it("puts earnings on the UTC day they landed, zero-filling the rest, oldest first", () => {
    const e = providerEarnings(
      [job({ escrow: "released", at: NOW, units: "1000" }), job({ escrow: null, at: NOW - 2 * DAY, units: "3000" }), job({ escrow: "refunded", at: NOW - DAY })],
      ME,
      { now: NOW, days: 3 },
    );
    expect(e.byDay).toEqual([
      { day: dayKey(NOW - 2 * DAY), units: 3000n },
      { day: dayKey(NOW - DAY), units: 0n },
      { day: "2026-10-07", units: 1000n },
    ]);
  });

  it("lists payouts newest first and never shows a private job's prompt", () => {
    const e = providerEarnings([job({ at: NOW - DAY, escrow: "released" }), job({ at: NOW, escrow: "released", private: true })], ME, { now: NOW });
    expect(e.payouts[0]!.title).toBe("Private job");
    expect(e.payouts[1]!.title).toMatch(/^prompt /);
  });
});
