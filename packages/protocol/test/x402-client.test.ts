/**
 * The `accepts` row is the contract between buyer and network, and the buyer
 * client is the last line of defence before a signature moves money: get an
 * amount, a payee or the EIP-712 domain wrong here and a correctly-signed
 * payment is rejected — or worse, the wrong payment is signed. Payloads are
 * created for real (a local viem account signing offline) and the EIP-3009
 * signature is verified independently.
 */

import { describe, expect, it } from "vitest";
import type { HTTPRequestContext } from "@x402/core/http";
import type { AssetAmount, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { authorizationTypes } from "@x402/evm";
import { getAddress, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MONAD_MAINNET, MONAD_TESTNET } from "../src/chains.js";
import { QUOTE_TTL_SECONDS } from "../src/constants.js";
import {
  buyerX402Client,
  quoteMatchPolicy,
  usdcAssetAmount,
  usdcOnlyPolicy,
  usdcPaymentOption,
} from "../src/x402-client.js";

const USDC_TESTNET = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const USDC_MAINNET = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const PROVIDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const BROKER = "0x00000000219ab540356cBB839Cbe05303d7705Fa";

const ctx = { path: "/api/jobs/qte_1" } as unknown as HTTPRequestContext;

/** What an x402 server turns a PaymentOption into on the wire. */
function requirementFrom(option: ReturnType<typeof usdcPaymentOption>): PaymentRequirements {
  const price = option.price as AssetAmount;
  return {
    scheme: option.scheme,
    network: option.network,
    asset: price.asset,
    amount: price.amount,
    payTo: option.payTo as string,
    maxTimeoutSeconds: option.maxTimeoutSeconds ?? 300,
    extra: price.extra ?? {},
  };
}

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    ...requirementFrom(usdcPaymentOption({ network: MONAD_TESTNET, payTo: PROVIDER, amount: "10000" })),
    ...overrides,
  };
}

function paymentRequired(accepts: PaymentRequirements[]): PaymentRequired {
  return { x402Version: 2, resource: { url: "https://broker.xorv.xyz/api/jobs/qte_1" }, accepts };
}

describe("usdcPaymentOption", () => {
  it("offers exact USDC to the provider with the token's EIP-712 domain", () => {
    const option = usdcPaymentOption({ network: MONAD_TESTNET, payTo: PROVIDER.toLowerCase(), amount: "10000" });
    expect(option).toEqual({
      scheme: "exact",
      network: "eip155:10143",
      payTo: PROVIDER,
      price: { asset: USDC_TESTNET, amount: "10000", extra: { name: "USDC", version: "2" } },
      maxTimeoutSeconds: QUOTE_TTL_SECONDS,
    });
  });

  it("pays the provider, never the broker", () => {
    const option = usdcPaymentOption({ network: MONAD_TESTNET, payTo: PROVIDER, amount: 1_000n });
    expect(option.payTo).toBe(PROVIDER);
    expect(option.payTo).not.toBe(BROKER);
  });

  it("uses mainnet USDC on mainnet and honours a custom timeout", () => {
    const option = usdcPaymentOption({ network: MONAD_MAINNET, payTo: PROVIDER, amount: "1", maxTimeoutSeconds: 60 });
    expect((option.price as AssetAmount).asset).toBe(USDC_MAINNET);
    expect(option.network).toBe("eip155:143");
    expect(option.maxTimeoutSeconds).toBe(60);
  });

  it("resolves payTo and amount per request, checksumming the payee", async () => {
    const option = usdcPaymentOption({
      network: MONAD_TESTNET,
      payTo: async () => PROVIDER.toLowerCase(),
      amount: async () => "25000",
    });
    expect(typeof option.payTo).toBe("function");
    expect(typeof option.price).toBe("function");
    const payTo = await (option.payTo as (c: HTTPRequestContext) => Promise<string>)(ctx);
    const price = await (option.price as (c: HTTPRequestContext) => Promise<AssetAmount>)(ctx);
    expect(payTo).toBe(PROVIDER);
    expect(price).toEqual({ asset: USDC_TESTNET, amount: "25000", extra: { name: "USDC", version: "2" } });
  });

  it("passes an unresolvable payee through untouched so the 402 still renders", async () => {
    const option = usdcPaymentOption({ network: MONAD_TESTNET, payTo: () => "", amount: "1" });
    expect(await (option.payTo as (c: HTTPRequestContext) => Promise<string>)(ctx)).toBe("");
  });

  it("refuses malformed amounts and payees up front", () => {
    expect(() => usdcPaymentOption({ network: MONAD_TESTNET, payTo: PROVIDER, amount: "0.01" })).toThrow(/integer/);
    expect(() => usdcPaymentOption({ network: MONAD_TESTNET, payTo: PROVIDER, amount: "-5" })).toThrow(/integer/);
    expect(() => usdcPaymentOption({ network: MONAD_TESTNET, payTo: "0.0.9848438", amount: "1" })).toThrow(/not an EVM address/);
    expect(() => usdcPaymentOption({ network: "hedera:testnet", payTo: PROVIDER, amount: "1" })).toThrow(/unsupported/);
  });
});

describe("usdcAssetAmount", () => {
  it("always carries name and version — the client refuses to sign without them", () => {
    expect(usdcAssetAmount(MONAD_MAINNET, 7n)).toEqual({
      asset: USDC_MAINNET,
      amount: "7",
      extra: { name: "USDC", version: "2" },
    });
  });
});

describe("buyerX402Client", () => {
  const payer = privateKeyToAccount(generatePrivateKey());

  it("signs a valid EIP-3009 authorization for a matching 402", async () => {
    const client = buyerX402Client({
      signer: payer,
      network: MONAD_TESTNET,
      maxUsdcUnits: "25000000",
      expect: { payTo: PROVIDER, amount: "10000" },
    });
    const req = requirement();
    const payload = await client.createPaymentPayload(paymentRequired([req]));

    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(req);
    const { authorization, signature } = payload.payload as {
      authorization: { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: `0x${string}` };
      signature: `0x${string}`;
    };
    expect(getAddress(authorization.from)).toBe(payer.address);
    expect(getAddress(authorization.to)).toBe(PROVIDER);
    expect(authorization.value).toBe("10000");
    const now = Math.floor(Date.now() / 1000);
    expect(Number(authorization.validBefore)).toBeGreaterThan(now + 290);
    expect(Number(authorization.validBefore)).toBeLessThanOrEqual(now + 301);

    const valid = await verifyTypedData({
      address: payer.address,
      domain: { name: "USDC", version: "2", chainId: 10143, verifyingContract: USDC_TESTNET },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(authorization.from),
        to: getAddress(authorization.to),
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature,
    });
    expect(valid).toBe(true);
  });

  it("pays testnet USDC even though it is not in @x402/evm's default asset table", async () => {
    // Without an allowedAssets entry, x402 ≥ 2.23 rejects every testnet payment.
    const client = buyerX402Client({ signer: payer, network: MONAD_TESTNET, maxUsdcUnits: 1_000_000 });
    await expect(client.createPaymentPayload(paymentRequired([requirement()]))).resolves.toBeTruthy();
  });

  it("enforces the per-payment cap", async () => {
    const client = buyerX402Client({ signer: payer, network: MONAD_TESTNET, maxUsdcUnits: "25000" });
    await expect(client.createPaymentPayload(paymentRequired([requirement({ amount: "25001" })]))).rejects.toThrow(
      /spendControls/,
    );
    await expect(client.createPaymentPayload(paymentRequired([requirement({ amount: "25000" })]))).resolves.toBeTruthy();
  });

  it("lets the cap override the library's $1 default on mainnet, where USDC is a default asset", async () => {
    const client = buyerX402Client({ signer: payer, network: MONAD_MAINNET, maxUsdcUnits: "5000000" });
    const req = requirementFrom(usdcPaymentOption({ network: MONAD_MAINNET, payTo: PROVIDER, amount: "2000000" }));
    await expect(client.createPaymentPayload(paymentRequired([req]))).resolves.toBeTruthy();
  });

  it("refuses a 402 that doesn't match the frozen quote's payee", async () => {
    const client = buyerX402Client({
      signer: payer,
      network: MONAD_TESTNET,
      maxUsdcUnits: "25000000",
      expect: { payTo: PROVIDER, amount: "10000" },
    });
    await expect(client.createPaymentPayload(paymentRequired([requirement({ payTo: BROKER })]))).rejects.toThrow(
      /does not match the quote.*refusing to sign/,
    );
  });

  it("refuses a 402 whose amount drifted from the quote, even under the cap", async () => {
    const client = buyerX402Client({
      signer: payer,
      network: MONAD_TESTNET,
      maxUsdcUnits: "25000000",
      expect: { payTo: PROVIDER.toLowerCase(), amount: 10_000n },
    });
    await expect(client.createPaymentPayload(paymentRequired([requirement({ amount: "10001" })]))).rejects.toThrow(
      /does not match the quote/,
    );
  });

  it("picks the matching row out of several offers", async () => {
    const client = buyerX402Client({
      signer: payer,
      network: MONAD_TESTNET,
      maxUsdcUnits: "25000000",
      expect: { payTo: PROVIDER, amount: "10000" },
    });
    const right = requirement();
    const payload = await client.createPaymentPayload(
      paymentRequired([requirement({ payTo: BROKER }), requirement({ amount: "20000" }), right]),
    );
    expect(payload.accepted).toEqual(right);
  });

  it("refuses assets other than the network's USDC", async () => {
    const client = buyerX402Client({ signer: payer, network: MONAD_TESTNET, maxUsdcUnits: "25000000" });
    await expect(
      client.createPaymentPayload(paymentRequired([requirement({ asset: "0x1111111111111111111111111111111111111111" })])),
    ).rejects.toThrow();
  });

  it("cannot be talked into signing for another network", async () => {
    const client = buyerX402Client({ signer: payer, network: MONAD_TESTNET, maxUsdcUnits: "25000000" });
    const mainnetReq = requirementFrom(usdcPaymentOption({ network: MONAD_MAINNET, payTo: PROVIDER, amount: "10000" }));
    await expect(client.createPaymentPayload(paymentRequired([mainnetReq]))).rejects.toThrow(/No network\/scheme registered/);
  });

  it("refuses a requirement missing the EIP-712 domain", async () => {
    const client = buyerX402Client({ signer: payer, network: MONAD_TESTNET, maxUsdcUnits: "25000000" });
    await expect(client.createPaymentPayload(paymentRequired([requirement({ extra: {} })]))).rejects.toThrow(
      /EIP-712 domain parameters/,
    );
  });

  it("validates its own configuration", () => {
    expect(() => buyerX402Client({ signer: payer, network: MONAD_TESTNET, maxUsdcUnits: 0 })).toThrow(/greater than zero/);
    expect(() => buyerX402Client({ signer: payer, network: MONAD_TESTNET, maxUsdcUnits: "1.5" })).toThrow(/integer/);
    expect(() => buyerX402Client({ signer: payer, network: "hedera:testnet", maxUsdcUnits: 1 })).toThrow(/unsupported/);
    expect(() =>
      buyerX402Client({ signer: payer, network: MONAD_TESTNET, maxUsdcUnits: 1, expect: { payTo: "0.0.1", amount: "1" } }),
    ).toThrow(/not an EVM address/);
  });
});

describe("policies", () => {
  it("usdcOnlyPolicy keeps only exact USDC rows on the network", () => {
    const policy = usdcOnlyPolicy(MONAD_TESTNET);
    const good = requirement();
    const rows = [
      good,
      requirement({ scheme: "upto" }),
      requirement({ asset: "0x1111111111111111111111111111111111111111" }),
      requirement({ network: "eip155:143" }),
    ];
    expect(policy(2, rows)).toEqual([good]);
    expect(policy(2, [requirement({ asset: USDC_TESTNET.toLowerCase() })])).toHaveLength(1);
    expect(() => policy(2, [requirement({ scheme: "upto" })])).toThrow(/no exact-USDC payment/);
  });

  it("quoteMatchPolicy compares addresses case-insensitively and amounts numerically", () => {
    const policy = quoteMatchPolicy({ payTo: PROVIDER, amount: "10000" }, MONAD_TESTNET);
    expect(policy(2, [requirement({ payTo: PROVIDER.toLowerCase() })])).toHaveLength(1);
    expect(policy(2, [requirement({ amount: "010000" })])).toHaveLength(1);
    expect(() => policy(2, [requirement({ amount: "abc" })])).toThrow(/does not match/);
  });

  describe("escrow options", () => {
    const ESCROW = "0x00000000000000000000000000000000000e5c20";
    const escrowRow = (over: { payTo?: string; provider?: string; escrow?: string } = {}) =>
      requirement({
        scheme: "escrow",
        payTo: over.payTo ?? ESCROW,
        extra: { name: "USDC", version: "2", escrow: over.escrow ?? ESCROW, provider: over.provider ?? PROVIDER },
      } as Partial<PaymentRequirements>);

    it("signs escrow only into the contract the quote named, for the quoted provider", () => {
      const policy = quoteMatchPolicy({ payTo: PROVIDER, amount: "10000", escrow: ESCROW }, MONAD_TESTNET);
      const good = escrowRow();
      expect(policy(2, [good, requirement()])).toEqual([good, requirement()]);
      expect(() => policy(2, [escrowRow({ provider: BROKER })])).toThrow(/does not match/);
      expect(() => policy(2, [escrowRow({ payTo: BROKER, escrow: BROKER })])).toThrow(/does not match/);
      // payTo and extra.escrow must agree: a payment to one contract naming another is refused.
      expect(() => policy(2, [escrowRow({ escrow: BROKER })])).toThrow(/does not match/);
    });

    it("refuses escrow a quote didn't announce, and still pays exact", () => {
      const policy = quoteMatchPolicy({ payTo: PROVIDER, amount: "10000" }, MONAD_TESTNET);
      expect(policy(2, [escrowRow(), requirement()])).toEqual([requirement()]);
      expect(() => policy(2, [escrowRow()])).toThrow(/does not match/);
    });

    it("usdcOnlyPolicy keeps escrow USDC rows alongside exact", () => {
      expect(usdcOnlyPolicy(MONAD_TESTNET)(2, [escrowRow(), requirement()])).toHaveLength(2);
    });
  });
});
