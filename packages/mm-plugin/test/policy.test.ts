/**
 * The buyer's guarantees: nothing is signed unless the quote, and then the
 * 402, ask for exactly what the buyer accepted — the quoted provider, the
 * quoted USDC amount, on Monad, under --max.
 */

import { describe, expect, it } from "vitest";
import { BrokerClient } from "../src/lib/broker.js";
import { executorSigner } from "../src/lib/executor.js";
import { payForQuote } from "../src/lib/pay.js";
import { vetQuote } from "../src/lib/vet.js";
import {
  ATTACKER_ADDRESS,
  BROKER_URL,
  PAYER,
  PROVIDER_ADDRESS,
  fakeBroker,
  fakeMetaMask,
  paymentRequiredFor,
  quote,
  type BrokerScript,
} from "./helpers.js";

describe("vetQuote", () => {
  it("accepts an honest quote", () => {
    const vetted = vetQuote(quote(), { maxPriceUsdMicros: 50_000, payer: PAYER.address });
    expect(vetted).toMatchObject({ network: "eip155:10143", chainId: 10143 });
  });

  it("refuses a price over --max", () => {
    expect(() => vetQuote(quote(), { maxPriceUsdMicros: 5_000 })).toThrow(/above your --max of \$0\.0050/);
  });

  it("refuses an amount that is not the quoted price", () => {
    expect(() => vetQuote(quote({ usdcAmount: "10001" }), { maxPriceUsdMicros: 50_000 })).toThrow(/freezes 10001 USDC units/);
  });

  it("refuses accepts rows that pay someone other than the quoted provider", () => {
    const q = quote();
    const tampered = quote({ accepts: [{ ...q.accepts[0]!, payTo: ATTACKER_ADDRESS }] });
    expect(() => vetQuote(tampered, { maxPriceUsdMicros: 50_000 })).toThrow(/do not match its own provider and price/);
  });

  it("refuses accepts rows with a different amount", () => {
    const q = quote();
    const tampered = quote({ accepts: [{ ...q.accepts[0]!, amount: "20000" }] });
    expect(() => vetQuote(tampered, { maxPriceUsdMicros: 50_000 })).toThrow(expect.objectContaining({ code: "XORV_QUOTE_REFUSED" }));
  });

  it("refuses networks the plugin does not target, and a --chain-id mismatch", () => {
    expect(() => vetQuote(quote({ network: "eip155:8453" }), { maxPriceUsdMicros: 50_000 })).toThrow(
      expect.objectContaining({ code: "XORV_UNSUPPORTED_NETWORK" }),
    );
    expect(() => vetQuote(quote(), { maxPriceUsdMicros: 50_000, chainId: 143 })).toThrow(/--chain-id is 143/);
  });

  it("refuses paying yourself", () => {
    expect(() => vetQuote(quote(), { maxPriceUsdMicros: 50_000, payer: PROVIDER_ADDRESS.toLowerCase() })).toThrow(/cannot pay yourself/);
  });

  it("refuses an expired quote", () => {
    expect(() => vetQuote(quote({ expiresAt: 1 }), { maxPriceUsdMicros: 50_000 })).toThrow(/expired/);
  });
});

describe("payForQuote: the 402 must match the vetted quote", () => {
  async function attempt(paymentRequired: BrokerScript["paymentRequired"]) {
    const broker = fakeBroker({ paymentRequired });
    const mm = fakeMetaMask();
    let signerError: unknown = null;
    const signer = executorSigner({
      executor: mm.executor,
      address: PAYER.address,
      chainId: 10143,
      onError: (e) => {
        signerError ??= e;
      },
    });
    const client = new BrokerClient({ baseUrl: BROKER_URL, fetch: broker.fetch });
    const vetted = vetQuote(quote(), { maxPriceUsdMicros: 50_000, payer: PAYER.address });
    const promise = payForQuote({ broker: client, vetted, signer, maxPriceUsdMicros: 50_000, signerError: () => signerError });
    return { promise, mm, broker };
  }

  it("refuses a 402 whose payTo was swapped after the quote — MetaMask is never asked", async () => {
    const { promise, mm, broker } = await attempt((q) => {
      const pr = paymentRequiredFor(q);
      return { ...pr, accepts: pr.accepts.map((a) => ({ ...a, payTo: ATTACKER_ADDRESS })) };
    });
    await expect(promise).rejects.toMatchObject({ code: "XORV_PAYMENT_REFUSED", message: expect.stringMatching(/does not match the quote/) });
    expect(mm.requests).toHaveLength(0);
    expect(broker.payments).toHaveLength(0);
  });

  it("refuses a 402 whose amount was bumped after the quote — MetaMask is never asked", async () => {
    const { promise, mm, broker } = await attempt((q) => {
      const pr = paymentRequiredFor(q);
      return { ...pr, accepts: pr.accepts.map((a) => ({ ...a, amount: "10001" })) };
    });
    await expect(promise).rejects.toMatchObject({ code: "XORV_PAYMENT_REFUSED" });
    expect(mm.requests).toHaveLength(0);
    expect(broker.payments).toHaveLength(0);
  });

  it("refuses a 402 over the --max spend cap even if the quote was cheaper", async () => {
    const broker = fakeBroker({
      paymentRequired: (q) => {
        const pr = paymentRequiredFor(q);
        return { ...pr, accepts: pr.accepts.map((a) => ({ ...a, amount: "90000" })) };
      },
    });
    const mm = fakeMetaMask();
    const signer = executorSigner({ executor: mm.executor, address: PAYER.address, chainId: 10143 });
    const client = new BrokerClient({ baseUrl: BROKER_URL, fetch: broker.fetch });
    const vetted = vetQuote(quote(), { maxPriceUsdMicros: 50_000 });
    await expect(
      payForQuote({ broker: client, vetted, signer, maxPriceUsdMicros: 50_000, signerError: () => null }),
    ).rejects.toMatchObject({ code: "XORV_PAYMENT_REFUSED" });
    expect(mm.requests).toHaveLength(0);
  });

  it("refuses a 402 on another asset (not Monad USDC)", async () => {
    const { promise, mm } = await attempt((q) => {
      const pr = paymentRequiredFor(q);
      return { ...pr, accepts: pr.accepts.map((a) => ({ ...a, asset: "0x0000000000000000000000000000000000000001" })) };
    });
    await expect(promise).rejects.toMatchObject({ code: "XORV_PAYMENT_REFUSED" });
    expect(mm.requests).toHaveLength(0);
  });

  it("pays an honest 402 at the broker URL the user chose, not the quote's payUrl", async () => {
    const { promise, mm, broker } = await attempt(undefined);
    const paid = await promise;
    expect(paid.response.jobId).toBe("job_TestJob0001");
    expect(paid.settlement.txHash).toMatch(/^0x(ab){32}$/);
    expect(paid.settlement.explorerUrl).toBe(`https://testnet.monadscan.com/tx/${paid.settlement.txHash}`);
    expect(mm.requests).toHaveLength(1);
    expect(broker.payments).toHaveLength(1);
    const paidRequests = broker.seen.filter((s) => s.method === "POST" && s.path.startsWith("/api/jobs/"));
    expect(paidRequests).toHaveLength(2); // the unpaid probe, then the retry with PAYMENT-SIGNATURE
    expect(paidRequests[1]!.headers.get("PAYMENT-SIGNATURE")).toBeTruthy();
  });

  it("surfaces a facilitator rejection with its x402 reason and a faucet hint", async () => {
    const broker = fakeBroker({ rejectPayment: "invalid_exact_evm_insufficient_balance" });
    const mm = fakeMetaMask();
    const signer = executorSigner({ executor: mm.executor, address: PAYER.address, chainId: 10143 });
    const client = new BrokerClient({ baseUrl: BROKER_URL, fetch: broker.fetch });
    const vetted = vetQuote(quote(), { maxPriceUsdMicros: 50_000 });
    await expect(
      payForQuote({ broker: client, vetted, signer, maxPriceUsdMicros: 50_000, signerError: () => null }),
    ).rejects.toMatchObject({ code: "XORV_INSUFFICIENT_USDC", hint: expect.stringContaining("faucet.circle.com") });
  });

  it("keeps MetaMask's own refusal code instead of x402's generic wrapper", async () => {
    const broker = fakeBroker();
    const mm = fakeMetaMask({ result: { status: "DENIED", failureDescription: "user rejected" } });
    let signerError: unknown = null;
    const signer = executorSigner({
      executor: mm.executor,
      address: PAYER.address,
      chainId: 10143,
      onError: (e) => {
        signerError ??= e;
      },
    });
    const client = new BrokerClient({ baseUrl: BROKER_URL, fetch: broker.fetch });
    const vetted = vetQuote(quote(), { maxPriceUsdMicros: 50_000 });
    await expect(
      payForQuote({ broker: client, vetted, signer, maxPriceUsdMicros: 50_000, signerError: () => signerError }),
    ).rejects.toMatchObject({ code: "XORV_SIGNATURE_DENIED", message: expect.stringContaining("user rejected") });
    expect(broker.payments).toHaveLength(0);
  });
});
