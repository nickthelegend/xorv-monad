/**
 * The buyer path, up to and including the signature.
 *
 * On EVM a signed EIP-3009 authorization is directly spendable, so the checks
 * that happen *before* signing are the ones that protect a buyer's money: the
 * price ceiling, the frozen quote (payee, amount, network, token), and the
 * refusal to pay yourself. These run with a real viem account signing offline
 * against a scripted 402 — no network, no broker, no chain.
 */

import { describe, expect, it } from "vitest";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import type { QuoteResponse } from "@xorv/protocol";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  RunRefusal,
  buyerNetwork,
  payingFetch,
  resolveBuyerAccount,
  runJsonResult,
  vetQuote,
} from "../src/commands/run.js";

const BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BUYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const PROVIDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const BROKER = "0x00000000219ab540356cBB839Cbe05303d7705Fa";
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const NETWORK = "eip155:10143";
const SETTLE_TX = `0x${"ab".repeat(32)}`;

function quote(over: Partial<QuoteResponse> = {}, provider: Partial<QuoteResponse["provider"]> = {}): QuoteResponse {
  return {
    quoteId: "qte_1",
    payUrl: "http://broker.test/api/jobs/qte_1",
    network: NETWORK,
    priceUsdMicros: 40_000,
    priceLabel: "$0.0400",
    usdcAmount: "40000",
    expiresAt: Date.now() + 300_000,
    provider: {
      id: "prv_1",
      label: "someone's qwen",
      address: PROVIDER,
      addressUrl: `https://testnet.monadvision.com/address/${PROVIDER}`,
      agentId: "42",
      capability: "Qwen 3.8 Max",
      adapter: "qwen",
      model: "qwen3.8-max",
      stats: { jobsCompleted: 3, jobsFailed: 0, earnedUsdcMicros: 120_000, avgDurationMs: 900 },
      ...provider,
    },
    accepts: [],
    ...over,
  };
}

const ctx = { network: NETWORK, maxPriceUsdMicros: 50_000, payer: BUYER };

function refusal(fn: () => void): RunRefusal {
  try {
    fn();
  } catch (err) {
    if (err instanceof RunRefusal) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("vetQuote", () => {
  it("accepts a quote that matches the ceiling, the network and its own price", () => {
    expect(() => vetQuote(quote(), ctx)).not.toThrow();
  });

  it("refuses a quote above --max even if the broker ignored the ceiling", () => {
    const r = refusal(() => vetQuote(quote({ priceUsdMicros: 60_000, priceLabel: "$0.0600", usdcAmount: "60000" }), ctx));
    expect(r.stage).toBe("quote");
    expect(r.message).toMatch(/\$0\.0600.*--max of \$0\.0500/);
  });

  it("refuses a quote whose frozen USDC amount disagrees with its label", () => {
    // $0.04 on the label, $40 frozen for the 402: exactly the swap to catch.
    const r = refusal(() => vetQuote(quote({ usdcAmount: "40000000" }), ctx));
    expect(r.message).toMatch(/freezes 40000000 USDC units \(expected 40000\)/);
  });

  it("refuses a quote from a broker on another network", () => {
    const r = refusal(() => vetQuote(quote({ network: "eip155:143" }), ctx));
    expect(r.message).toMatch(/eip155:143.*eip155:10143/);
    expect(r.hints.join(" ")).toContain("XORV_NETWORK=eip155:143");
  });

  it("refuses to pay yourself, whatever the address casing", () => {
    const r = refusal(() => vetQuote(quote({}, { address: BUYER.toLowerCase() }), ctx));
    expect(r.stage).toBe("payment");
    expect(r.message).toMatch(/cannot pay yourself/);
    expect(r.hints.join(" ")).toContain("XORV_PAYER_KEY");
  });

  it("refuses an open-ended quote with no USDC amount", () => {
    expect(() => vetQuote(quote({ usdcAmount: "" }), ctx)).toThrow(/no USDC amount/);
  });
});

describe("who pays, on which chain", () => {
  it("prefers XORV_PAYER_KEY, then XORV_PRIVATE_KEY, then the node config", () => {
    const config = { privateKey: OTHER_KEY };
    expect(resolveBuyerAccount(config, { XORV_PAYER_KEY: BUYER_KEY, XORV_PRIVATE_KEY: OTHER_KEY }).address).toBe(BUYER);
    expect(resolveBuyerAccount(config, { XORV_PRIVATE_KEY: BUYER_KEY }).address).toBe(BUYER);
    expect(resolveBuyerAccount(config, {}).address).toBe(OTHER);
  });

  it("tells an address-only node why it cannot buy", () => {
    const r = refusal(() => resolveBuyerAccount({ privateKey: "" }, {}));
    expect(r.stage).toBe("setup");
    expect(r.message).toMatch(/address-only/);
    expect(r.hints.join(" ")).toMatch(/XORV_PAYER_KEY.*no MON needed/);
  });

  it("names the source of an unusable key", () => {
    const r = refusal(() => resolveBuyerAccount(null, { XORV_PAYER_KEY: "not-a-key" }));
    expect(r.message).toMatch(/XORV_PAYER_KEY is unusable|key in XORV_PAYER_KEY is unusable/);
  });

  it("defaults to Monad testnet, honours XORV_NETWORK, and refuses a Hedera network", () => {
    expect(buyerNetwork(null, {})).toBe("eip155:10143");
    expect(buyerNetwork({ network: "eip155:10143" }, { XORV_NETWORK: "eip155:143" })).toBe("eip155:143");
    expect(() => buyerNetwork({ network: "hedera:testnet" }, {})).toThrow(/Monad/);
  });
});

/** A requirement exactly as the broker's 402 would carry it for the quote. */
function requirement(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: USDC,
    amount: "40000",
    payTo: PROVIDER,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
    ...over,
  };
}

/** A broker's paid route: 402 until a PAYMENT-SIGNATURE arrives, then 200 + settlement. */
function brokerStub(accepts: PaymentRequirements[]) {
  const seen: Array<{ url: string; payment: string | null }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // @x402/fetch hands over a Request object, not (url, init).
    const request = input instanceof Request ? input : new Request(input, init);
    const payment = request.headers.get("PAYMENT-SIGNATURE");
    seen.push({ url: request.url, payment });
    if (!payment) {
      const required = { x402Version: 2, error: "payment required", resource: { url: request.url }, accepts };
      return new Response(JSON.stringify({}), {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required as never) },
      });
    }
    const settle = { success: true, transaction: SETTLE_TX, network: NETWORK, payer: BUYER };
    return new Response(JSON.stringify({ jobId: "job_1" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle as never) },
    });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

describe("payingFetch", () => {
  const account = privateKeyToAccount(BUYER_KEY);

  it("pays exactly the quoted amount to the quoted provider and reads the settlement back", async () => {
    const broker = brokerStub([requirement()]);
    const { fetch, httpClient } = payingFetch({ account, network: NETWORK, maxPriceUsdMicros: 50_000, quote: quote(), fetch: broker.fetch });

    const res = await fetch("http://broker.test/api/jobs/qte_1", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);

    const signed = broker.seen.find((s) => s.payment)!;
    const payload = decodePaymentSignatureHeader(signed.payment!) as unknown as {
      payload: { authorization: { from: string; to: string; value: string } };
    };
    expect(getAddress(payload.payload.authorization.from)).toBe(BUYER);
    expect(getAddress(payload.payload.authorization.to)).toBe(PROVIDER);
    expect(payload.payload.authorization.value).toBe("40000");

    const settlement = httpClient.getPaymentSettleResponse((name) => res.headers.get(name));
    expect(settlement.transaction).toBe(SETTLE_TX);
  });

  it("picks the quoted option out of several on offer", async () => {
    const broker = brokerStub([requirement({ payTo: BROKER }), requirement()]);
    const { fetch } = payingFetch({ account, network: NETWORK, maxPriceUsdMicros: 50_000, quote: quote(), fetch: broker.fetch });
    await fetch("http://broker.test/api/jobs/qte_1", { method: "POST", body: "{}" });
    const payload = decodePaymentSignatureHeader(broker.seen.find((s) => s.payment)!.payment!) as unknown as {
      payload: { authorization: { to: string } };
    };
    expect(getAddress(payload.payload.authorization.to)).toBe(PROVIDER);
  });

  it("refuses to sign when the 402's payee differs from the quote", async () => {
    const broker = brokerStub([requirement({ payTo: BROKER })]);
    const { fetch } = payingFetch({ account, network: NETWORK, maxPriceUsdMicros: 50_000, quote: quote(), fetch: broker.fetch });
    await expect(fetch("http://broker.test/api/jobs/qte_1", { method: "POST", body: "{}" })).rejects.toThrow(
      /does not match the quote/,
    );
    expect(broker.seen.every((s) => s.payment === null)).toBe(true);
  });

  it("refuses to sign when the 402's amount drifted from the quote", async () => {
    const broker = brokerStub([requirement({ amount: "45000" })]);
    const { fetch } = payingFetch({ account, network: NETWORK, maxPriceUsdMicros: 50_000, quote: quote(), fetch: broker.fetch });
    await expect(fetch("http://broker.test/api/jobs/qte_1", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(broker.seen.every((s) => s.payment === null)).toBe(true);
  });

  it("caps every payment at --max, even for a 402 that matches a (bad) quote", async () => {
    const pricey = quote({ priceUsdMicros: 90_000, usdcAmount: "90000" });
    const broker = brokerStub([requirement({ amount: "90000" })]);
    const { fetch } = payingFetch({ account, network: NETWORK, maxPriceUsdMicros: 50_000, quote: pricey, fetch: broker.fetch });
    await expect(fetch("http://broker.test/api/jobs/qte_1", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(broker.seen.every((s) => s.payment === null)).toBe(true);
  });
});

describe("the --json contract", () => {
  it("links the settlement, the ledger receipt and the agent on the explorer", () => {
    const out = runJsonResult({
      jobId: "job_1",
      network: NETWORK,
      payer: BUYER,
      quote: quote(),
      settleTx: SETTLE_TX,
      job: { status: "completed", result: "4", error: null, resultHash: `0x${"cd".repeat(32)}`, receiptTxHash: `0x${"ef".repeat(32)}` },
      durationMs: 1200,
    });
    expect(out).toMatchObject({
      jobId: "job_1",
      network: NETWORK,
      payer: BUYER,
      settlementTransaction: SETTLE_TX,
      explorer: `https://testnet.monadvision.com/tx/${SETTLE_TX}`,
      receiptTransaction: `0x${"ef".repeat(32)}`,
      receiptExplorer: `https://testnet.monadvision.com/tx/0x${"ef".repeat(32)}`,
      agentExplorer: "https://testnet.monadvision.com/nft/0x8004A818BFB912233c491871b3d84c89A494BD9e/42",
      status: "completed",
      result: "4",
    });
    expect(Object.keys(out)).not.toContain("hashscan");
  });

  it("falls back to the job's own payment record when the header carried no settlement", () => {
    const out = runJsonResult({
      jobId: "job_1",
      network: NETWORK,
      payer: BUYER,
      quote: quote({}, { agentId: null }),
      settleTx: null,
      job: {
        status: "failed",
        error: "provider went away",
        payment: {
          asset: "usdc",
          assetAddress: USDC,
          amount: "40000",
          network: NETWORK,
          txHash: SETTLE_TX,
          payer: BUYER,
          payTo: PROVIDER,
          settledAt: 1,
          explorerUrl: "",
        },
      },
      durationMs: 5,
    });
    expect(out.explorer).toBe(`https://testnet.monadvision.com/tx/${SETTLE_TX}`);
    expect(out.agentExplorer).toBeNull();
    expect(out.receiptExplorer).toBeNull();
    expect(out.status).toBe("failed");
  });
});
