import { describe, expect, it } from "vitest";
import { creditJobToNetwork, creditJobToProvider, creditRating } from "../src/lib/aggregates.js";
import { emptyProviderStats } from "../src/lib/entities.js";
import {
  agentIdOrNone,
  attributionKey,
  dayOf,
  feedbackId,
  meanInt,
  normalizeFeedbackValue,
  parseAddressList,
  parseCapabilities,
  ratio,
  walletFromMetadata,
} from "../src/lib/util.js";
import { NO_AGENT } from "./harness.js";

describe("parseCapabilities", () => {
  it("parses the ledger's adapter:priceUsdMicros list", () => {
    expect(parseCapabilities("claude-code:10000,qwen:5000")).toEqual([
      { adapter: "claude-code", priceUsdMicros: 10000n },
      { adapter: "qwen", priceUsdMicros: 5000n },
    ]);
  });

  it("drops malformed entries instead of advertising them as free", () => {
    expect(parseCapabilities(" codex : 7 ,,nope,:5,grok:-1,kimi:1.5,hunyuan:")).toEqual([
      { adapter: "codex", priceUsdMicros: 7n },
    ]);
    expect(parseCapabilities("")).toEqual([]);
  });

  it("keeps the last price of a repeated adapter", () => {
    expect(parseCapabilities("qwen:1,codex:2,qwen:3")).toEqual([
      { adapter: "codex", priceUsdMicros: 2n },
      { adapter: "qwen", priceUsdMicros: 3n },
    ]);
  });
});

describe("helpers", () => {
  it("buckets timestamps into UTC days", () => {
    const noon = Date.UTC(2026, 9, 1, 12) / 1000;
    expect(dayOf(noon)).toEqual({ id: "2026-10-01", start: Date.UTC(2026, 9, 1) / 1000 });
    expect(dayOf(Date.UTC(2026, 9, 1, 23, 59, 59) / 1000).id).toBe("2026-10-01");
    expect(dayOf(Date.UTC(2026, 9, 2) / 1000).id).toBe("2026-10-02");
  });

  it("never divides by zero", () => {
    expect(ratio(5, 0)).toBe(0);
    expect(ratio(3, 4)).toBe(0.75);
    expect(meanInt(0n, 0)).toBe(0);
    expect(meanInt(7000n, 3)).toBe(2333);
  });

  it("maps NO_AGENT to no agent and builds join keys", () => {
    expect(agentIdOrNone(NO_AGENT)).toBeUndefined();
    expect(agentIdOrNone(0n)).toBe("0");
    expect(attributionKey("12", "0xABC")).toBe("agent:12");
    expect(attributionKey(undefined, "0xABC")).toBe("payto:0xabc");
    expect(feedbackId(3n, "0xAbC", 1n)).toBe("3-0xabc-1");
  });

  it("normalises ERC-8004 values by their decimals", () => {
    expect(normalizeFeedbackValue(9977n, 2)).toBeCloseTo(99.77, 12);
    expect(normalizeFeedbackValue(-32n, 1)).toBeCloseTo(-3.2, 12);
    expect(normalizeFeedbackValue(87n, 0)).toBe(87);
  });

  it("reads trusted-address lists from env values", () => {
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
    expect(
      parseAddressList(` 0x00000000000000000000000000000000000000AA, nope,0x${"0".repeat(40)}  0x00000000000000000000000000000000000000bb,0x00000000000000000000000000000000000000aa`),
    ).toEqual(["0x00000000000000000000000000000000000000aa", "0x00000000000000000000000000000000000000bb"]);
  });

  it("reads agentWallet metadata as a 20-byte address or nothing", () => {
    expect(walletFromMetadata("0x00000000000000000000000000000000000000AA")).toBe(
      "0x00000000000000000000000000000000000000aa",
    );
    expect(walletFromMetadata("0x")).toBeUndefined();
    expect(walletFromMetadata(`0x${"0".repeat(40)}`)).toBeUndefined();
    expect(walletFromMetadata(`0x${"ab".repeat(32)}`)).toBeUndefined();
  });
});

describe("aggregate folds", () => {
  const facts = (ok: boolean, paid: boolean, amount: bigint, durationMs: number) => ({
    ok,
    paid,
    amount,
    durationMs,
    blockTimestamp: 1_000,
  });

  it("success rate, earnings and duration follow the documented money rules", () => {
    const p = { ...emptyProviderStats() } as Parameters<typeof creditJobToProvider>[0];
    creditJobToProvider(p, facts(true, true, 100n, 400));
    creditJobToProvider(p, facts(false, true, 50n, 9_000)); // paid, failed
    creditJobToProvider(p, facts(true, false, 70n, 600)); // unpaid
    expect(p).toMatchObject({
      jobsTotal: 3,
      jobsOk: 2,
      jobsFailed: 1,
      earnedUsdc: 100n,
      settledUsdc: 150n,
      totalDurationMs: 1000n,
      avgDurationMs: 500,
    });
    expect(p.successRate).toBeCloseTo(2 / 3, 12);

    const stats = { jobs: 0, okJobs: 0, failedJobs: 0, paidJobs: 0, volumeUsdc: 0n, earnedUsdc: 0n, successRate: 0 };
    creditJobToNetwork(stats as Parameters<typeof creditJobToNetwork>[0], facts(true, true, 100n, 1));
    creditJobToNetwork(stats as Parameters<typeof creditJobToNetwork>[0], facts(false, false, 5n, 1));
    expect(stats).toMatchObject({ jobs: 2, paidJobs: 1, volumeUsdc: 100n, earnedUsdc: 100n, successRate: 0.5 });

    const r = { ratings: 0, ratingSum: 0, avgRating: 0 };
    creditRating(r, 100);
    creditRating(r, 71);
    expect(r).toEqual({ ratings: 2, ratingSum: 171, avgRating: 85.5 });
  });
});
