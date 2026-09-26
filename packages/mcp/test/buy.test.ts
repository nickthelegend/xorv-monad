/**
 * The buying path, end to end against a local mock broker: the quote policy
 * (what is refused before signing), the x402 payment itself (a real EIP-3009
 * signature the mock verifies), and how the session budget accounts for each
 * outcome.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { QuoteResponse } from "@xorv/protocol";
import { SessionBudget } from "../src/budget.js";
import { brokerClient } from "../src/broker.js";
import { BuyError, buyJob, effectiveCeiling, vetQuote, type BuyDeps } from "../src/buy.js";
import { createPayerSigner, resolveSignerConfig } from "../src/signer.js";
import { BUYER_ADDRESS, BUYER_KEY } from "./helpers/fixtures.js";
import { NETWORK, PROVIDER, RECEIPT_TX, SETTLE_TX, startMockBroker, type MockBroker, type MockBrokerOptions } from "./helpers/mock-broker.js";

const OTHER = "0x00000000000000000000000000000000000000c3";

function quote(overrides: Partial<QuoteResponse> = {}): QuoteResponse {
  return {
    quoteId: "qte_1",
    payUrl: "http://broker.test/api/jobs/qte_1",
    network: NETWORK,
    priceUsdMicros: 10_000,
    priceLabel: "$0.0100",
    usdcAmount: "10000",
    expiresAt: Date.now() + 300_000,
    provider: {
      id: "prv_1",
      label: "node",
      address: PROVIDER,
      addressUrl: "",
      agentId: "7",
      capability: "Echo",
      adapter: "echo",
      model: null,
      stats: { jobsCompleted: 0, jobsFailed: 0, earnedUsdcMicros: 0, avgDurationMs: 0 },
    },
    accepts: [],
    ...overrides,
  };
}

describe("vetQuote", () => {
  const ctx = { network: NETWORK, ceilingUsdMicros: 50_000, payer: BUYER_ADDRESS };

  it("accepts a quote that matches on every count", () => {
    expect(() => vetQuote(quote(), ctx)).not.toThrow();
  });

  it("refuses a quote on another network", () => {
    expect(() => vetQuote(quote({ network: "eip155:143" }), ctx)).toThrow(/quotes on eip155:143 but this server pays on eip155:10143/);
  });

  it("refuses a quote over the ceiling, even if the broker ignored it", () => {
    expect(() => vetQuote(quote({ priceUsdMicros: 60_000, priceLabel: "$0.0600", usdcAmount: "60000" }), ctx)).toThrow(
      /Refusing to pay \$0\.0600, which is over the \$0\.0500 limit/,
    );
  });

  it("refuses a quote whose frozen USDC amount is not its price", () => {
    expect(() => vetQuote(quote({ usdcAmount: "10001" }), ctx)).toThrow(/freezes 10001 USDC units \(expected 10000\)/);
    expect(() => vetQuote(quote({ usdcAmount: "" }), ctx)).toThrow(/no USDC amount/);
  });

  it("refuses to pay its own address", () => {
    expect(() => vetQuote(quote(), { ...ctx, payer: PROVIDER.toLowerCase() })).toThrow(/own payer address/);
  });

  it("is a BuyError at the quote stage", () => {
    try {
      vetQuote(quote({ network: "eip155:143" }), ctx);
    } catch (err) {
      expect(err).toBeInstanceOf(BuyError);
      expect((err as BuyError).stage).toBe("quote");
    }
  });
});

describe("effectiveCeiling", () => {
  it("is the smallest of the request, the per-job cap and the budget left", () => {
    expect(effectiveCeiling({ maxPriceUsdMicros: 50_000, budgetRemainingUsdMicros: Infinity })).toBe(50_000);
    expect(effectiveCeiling({ requestedUsd: 0.02, maxPriceUsdMicros: 50_000, budgetRemainingUsdMicros: Infinity })).toBe(20_000);
    expect(effectiveCeiling({ requestedUsd: 5, maxPriceUsdMicros: 50_000, budgetRemainingUsdMicros: Infinity })).toBe(50_000);
    expect(effectiveCeiling({ maxPriceUsdMicros: 50_000, budgetRemainingUsdMicros: 7_000 })).toBe(7_000);
  });
});

describe("buyJob against a mock broker", () => {
  let broker: MockBroker | null = null;
  afterEach(async () => {
    await broker?.close();
    broker = null;
  });

  async function setup(opts: MockBrokerOptions = {}, budgetMicros: number | null = 500_000, env: Record<string, string> = { XORV_PRIVATE_KEY: BUYER_KEY }) {
    broker = await startMockBroker(opts);
    const budget = new SessionBudget(budgetMicros);
    const deps: BuyDeps = {
      broker: brokerClient(broker.url),
      signer: createPayerSigner(resolveSignerConfig(env)),
      budget,
      network: NETWORK,
      maxPriceUsdMicros: 50_000,
      pollIntervalMs: 20,
      receiptWaitMs: 100,
    };
    return { broker, budget, deps };
  }

  it("pays exactly the quote with a valid EIP-3009 signature and returns the result", async () => {
    const { broker, budget, deps } = await setup();
    const result = await buyJob(deps, { prompt: "what is 2+2?" });

    expect(broker.quotes[0]).toMatchObject({ prompt: "what is 2+2?", adapter: null, maxPriceUsdMicros: 50_000 });
    expect(broker.payments).toHaveLength(1);
    const payment = broker.payments[0]!;
    expect(payment.valid).toBe(true);
    expect(payment.from).toBe(BUYER_ADDRESS);
    expect(payment.to.toLowerCase()).toBe(PROVIDER.toLowerCase());
    expect(payment.value).toBe("10000");
    // validBefore = now + the quote TTL, not open-ended.
    expect(Number(payment.validBefore) - Date.now() / 1000).toBeLessThanOrEqual(301);

    // Paid at the configured broker, not the quote's self-reported payUrl.
    expect(broker.hits.filter((h) => h === "POST /api/jobs/qte_1")).toHaveLength(2);

    expect(result.settlementTx).toBe(SETTLE_TX);
    expect(result.job.result).toBe("4");
    expect(result.job.receiptTxHash).toBe(RECEIPT_TX);
    expect(budget.spentUsdMicros).toBe(10_000);
    expect(budget.heldUsdMicros).toBe(0);
  });

  it("refuses to sign when the 402 names a different payee than the quote", async () => {
    const { broker, budget, deps } = await setup({ requirements: { payTo: OTHER } });
    await expect(buyJob(deps, { prompt: "x" })).rejects.toThrow(/does not match the quote.*refusing to sign/s);
    expect(broker.payments).toHaveLength(0);
    expect(budget.spentUsdMicros).toBe(0);
    expect(budget.heldUsdMicros).toBe(0);
  });

  it("refuses to sign when the 402 asks for more than the quote froze", async () => {
    const { broker, budget, deps } = await setup({ requirements: { amount: "20000" } });
    await expect(buyJob(deps, { prompt: "x" })).rejects.toThrow(/does not match the quote/);
    expect(broker.payments).toHaveLength(0);
    expect(budget.remainingUsdMicros()).toBe(500_000);
  });

  it("refuses to sign for another chain's USDC", async () => {
    const { broker, deps } = await setup({ requirements: { network: "eip155:143" } });
    await expect(buyJob(deps, { prompt: "x" })).rejects.toThrow(BuyError);
    expect(broker.payments).toHaveLength(0);
  });

  it("releases the budget when the settlement is rejected with a 402", async () => {
    const { broker, budget, deps } = await setup({ settleStatus: 402 });
    await expect(buyJob(deps, { prompt: "x" })).rejects.toThrow(/Payment failed \(402\)/);
    expect(broker.payments).toHaveLength(1);
    expect(budget.spentUsdMicros).toBe(0);
    expect(budget.heldUsdMicros).toBe(0);
  });

  it("counts the money as spent when a signed payment ends in an unexplained error", async () => {
    const { budget, deps } = await setup({ settleStatus: 500 });
    await expect(buyJob(deps, { prompt: "x" })).rejects.toThrow(/Payment failed \(500\)/);
    expect(budget.spentUsdMicros).toBe(10_000);
  });

  it("stops at the session budget", async () => {
    const { broker, budget, deps } = await setup({}, 15_000);
    await buyJob(deps, { prompt: "one" });
    // Only $0.005 left: the quote is requested under that and nothing matches.
    await expect(buyJob(deps, { prompt: "two" })).rejects.toThrow(/only \$0\.0050 of the session budget is left/);
    expect(broker.quotes[1]).toMatchObject({ maxPriceUsdMicros: 5_000 });
    expect(broker.payments).toHaveLength(1);
    expect(budget.spentUsdMicros).toBe(10_000);
  });

  it("lets only one of two concurrent jobs through when the budget fits one", async () => {
    const { broker, budget, deps } = await setup({}, 15_000);
    const results = await Promise.allSettled([buyJob(deps, { prompt: "a" }), buyJob(deps, { prompt: "b" })]);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as BuyError).stage).toBe("budget");
    expect(broker.payments).toHaveLength(1);
    expect(budget.spentUsdMicros).toBe(10_000);
  });

  it("refuses up front, before quoting, when there is no payer", async () => {
    const { broker, deps } = await setup({}, 500_000, {});
    await expect(buyJob(deps, { prompt: "x" })).rejects.toThrow(/no payer configured/i);
    expect(broker.hits).toEqual([]);
  });

  it("reports a quote refusal without paying", async () => {
    const { broker, deps } = await setup({ quote: { usdcAmount: "999999" } });
    await expect(buyJob(deps, { prompt: "x" })).rejects.toThrow(/freezes 999999 USDC units/);
    expect(broker.hits).toEqual(["POST /api/quotes"]);
  });
});
