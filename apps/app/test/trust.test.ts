import { describe, expect, it } from "vitest";
import {
  endpointName,
  funderText,
  paidLine,
  readNansenStatus,
  readTrust,
  readTrustCheck,
  refusalHeadline,
  riskFlagText,
  sourceNote,
  trustLabel,
  walletAge,
  warningFlags,
} from "@/lib/trust";
import { RatingError, isRelatedWalletRefusal, submitRating } from "@/lib/rating";

const WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const FUNDER = "0x28c6c06298d514db089934071355e5743bf21d60";

/** A provider's `trust`, exactly as the broker's publicTrustView serializes it. */
const brokerTrust = {
  address: WALLET,
  score: 85,
  band: "high",
  firstSeen: "2025-05-04T12:58:54.000Z",
  walletAgeDays: 510,
  txCount: 96,
  txCountCapped: false,
  firstFunder: {
    address: FUNDER,
    label: "Binance 14",
    chain: "ethereum",
    txHash: `0x${"f".repeat(64)}`,
    at: "2025-05-04T12:58:54",
    url: `https://monadscan.com/address/${FUNDER}`,
  },
  relatedWalletCount: 1,
  labels: ["funded by Binance 14"],
  riskFlags: [],
  paidTx: [
    { txHash: `0x${"1".repeat(64)}`, url: `https://monadscan.com/tx/0x${"1".repeat(64)}`, endpoint: "/api/v1/profiler/address/first-funder", amountUsdc: "0.01", at: 1 },
    { txHash: `0x${"2".repeat(64)}`, url: `https://monadscan.com/tx/0x${"2".repeat(64)}`, endpoint: "/api/v1/profiler/address/related-wallets", amountUsdc: "0.01", at: 1 },
    { txHash: `0x${"3".repeat(64)}`, url: `https://monadscan.com/tx/0x${"3".repeat(64)}`, endpoint: "/api/v1/profiler/address/transactions", amountUsdc: "0.01", at: 1 },
  ],
  paidUsdc: "0.03",
  source: "nansen",
  mode: "live",
  degraded: false,
  fetchedAt: "2026-09-26T12:00:00.000Z",
  attribution: "Powered by Nansen",
  attributionUrl: "https://nansen.ai",
};

describe("readTrust", () => {
  it("reads the broker's public trust view", () => {
    const trust = readTrust(brokerTrust)!;
    expect(trust).toMatchObject({ score: 85, band: "high", txCount: 96, relatedWalletCount: 1, paidUsdc: "0.03", mode: "live" });
    expect(trust.firstFunder).toMatchObject({ address: FUNDER, label: "Binance 14", chain: "ethereum" });
    expect(trustLabel(trust)).toBe("Trust 85");
    expect(funderText(trust)).toBe("Binance 14 · 0x28c6…1d60");
    expect(paidLine(trust)).toBe("Xorv paid Nansen $0.03 over x402 on Monad");
    expect(sourceNote(trust)).toBeNull();
  });

  it("returns null for a broker without Nansen, and survives junk", () => {
    expect(readTrust(undefined)).toBeNull();
    expect(readTrust(null)).toBeNull();
    expect(readTrust({ score: "high" })).toBeNull();
    const odd = readTrust({ address: WALLET, score: 140, paidTx: [{ txHash: "0x1", url: "javascript:alert(1)" }], paidUsdc: "lots" })!;
    expect(odd.score).toBe(100);
    expect(odd.band).toBe("high");
    expect(odd.paidTx).toEqual([]);
    expect(odd.paidUsdc).toBe("0.00");
    expect(paidLine(odd)).toBeNull();
    expect(odd.attribution).toBe("Powered by Nansen");
    const sneaky = readTrust({ ...brokerTrust, firstFunder: { ...brokerTrust.firstFunder, url: "javascript:alert(1)" } })!;
    expect(sneaky.firstFunder?.url).toBeNull();
  });

  it("claims no payment for fixture data, and says no history rather than a low score", () => {
    const fixture = readTrust({ ...brokerTrust, mode: "fixture", paidTx: [], paidUsdc: "0.00" })!;
    expect(paidLine(fixture)).toBeNull();
    expect(sourceNote(fixture)).toBe("fixture data");
    const blank = readTrust({ ...brokerTrust, score: 50, band: "unknown", firstFunder: null, txCount: 0 })!;
    expect(trustLabel(blank)).toBe("No wallet history");
    expect(funderText(blank)).toBeNull();
  });

  it("separates warnings from the funding-record note", () => {
    const trust = readTrust({
      ...brokerTrust,
      riskFlags: ["no-first-funder-on-record", "counterparty: Tornado Cash: Router"],
    })!;
    expect(warningFlags(trust)).toEqual(["counterparty: Tornado Cash: Router"]);
    expect(riskFlagText("counterparty: Tornado Cash: Router")).toBe("interacted with Tornado Cash: Router");
    expect(riskFlagText("no-first-funder-on-record")).toMatch(/no funding record/);
  });
});

describe("words", () => {
  it("says a wallet's age the way a person would", () => {
    expect(walletAge(null)).toBeNull();
    expect(walletAge(0)).toBe("today");
    expect(walletAge(1)).toBe("1 day");
    expect(walletAge(45)).toBe("45 days");
    expect(walletAge(200)).toBe("6 months");
    expect(walletAge(510)).toBe("1.4 years");
  });

  it("shortens Nansen endpoints", () => {
    expect(endpointName("/api/v1/profiler/address/first-funder")).toBe("first-funder");
    expect(endpointName("/api/v1/smart-money/pnl-leaderboard")).toBe("smart money pnl-leaderboard");
  });
});

describe("readNansenStatus", () => {
  it("reads /api/network's nansen block", () => {
    const status = readNansenStatus({
      nansen: {
        mode: "live",
        auth: "x402",
        network: "eip155:143",
        payer: { address: WALLET, url: `https://monadscan.com/address/${WALLET}` },
        callsToday: 7,
        paidCallsToday: 5,
        spentTodayUsdc: "0.05",
        budgetUsdc: "1.00",
        perCallCapUsdc: "0.05",
        lastPaidTx: brokerTrust.paidTx[0],
        recentPaidTx: brokerTrust.paidTx,
        lastError: null,
        walletsScored: 2,
        ratingGuard: true,
        ratingChecks: 3,
        ratingsRefused: 1,
      },
    })!;
    expect(status).toMatchObject({ mode: "live", auth: "x402", callsToday: 7, spentTodayUsdc: "0.05", ratingsRefused: 1 });
    expect(status.lastPaidTx?.url).toMatch(/^https:\/\/monadscan\.com\/tx\//);
    expect(status.recentPaidTx).toHaveLength(3);
  });

  it("is null on a broker that predates Nansen", () => {
    expect(readNansenStatus({ network: "eip155:10143" })).toBeNull();
    expect(readNansenStatus(null)).toBeNull();
  });
});

describe("the related-wallet refusal", () => {
  const check = {
    checkedAt: 1,
    related: true,
    reasons: [{ kind: "shared-funder", message: "both wallets were first funded by 0xf000…0001" }],
    mode: "live",
    degraded: false,
    attribution: "Powered by Nansen",
  };

  it("reads the job's check and words the headline by reason", () => {
    expect(readTrustCheck(check)).toMatchObject({ related: true, reasons: check.reasons });
    expect(readTrustCheck({ reasons: [] })).toBeNull();
    expect(refusalHeadline(check)).toMatch(/funded by the same wallet/);
    expect(refusalHeadline({ reasons: [{ kind: "same-wallet", message: "" }] })).toMatch(/your own/);
    expect(refusalHeadline({ reasons: [{ kind: "funded-by", message: "" }] })).toMatch(/funded the other/);
    expect(refusalHeadline({ reasons: [{ kind: "related-wallets", message: "" }] })).toMatch(/Nansen links/);
  });

  it("surfaces the broker's 403 as a related-wallet refusal, not a generic failure", async () => {
    const fetch403 = (async () =>
      Response.json(
        { error: "Rating refused: the buyer and provider wallets are related (Nansen) — …", code: "related_wallets", trustCheck: check },
        { status: 403 },
      )) as typeof fetch;
    const failure = await submitRating({
      brokerUrl: "http://broker.test",
      jobId: "job_1",
      value: 100,
      network: "eip155:10143",
      deadline: "9999999999",
      signature: "0x00",
      fetch: fetch403,
    }).catch((err: unknown) => err);
    expect(isRelatedWalletRefusal(failure)).toBe(true);
    expect((failure as RatingError).trustCheck).toEqual(check);
    expect(isRelatedWalletRefusal(new RatingError("nope"))).toBe(false);
  });
});
