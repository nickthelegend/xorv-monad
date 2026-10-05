/**
 * The `accepts` array is the contract between buyer and network: get an amount
 * or an asset wrong here and a correctly-signed payment is rejected, or worse,
 * the wrong amount moves.
 */

import { describe, expect, it } from "vitest";
import {
  assetSymbol,
  choosePaymentAsset,
  onlyAssetPolicy,
  paymentOptionsFor,
} from "../src/x402.js";
import { ARBITRUM_SEPOLIA_CAIP2, ROBINHOOD_TESTNET_CAIP2 } from "../src/constants.js";
import { sha256, newId, formatDuration, formatAgo } from "../src/index.js";
import { envelope } from "../src/log.js";

const PROVIDER = "0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B";
const USDG = "0xFFC95faa3d63Cde504a05B567C600B78C0b41892";
const USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

type Priced = { asset: string; amount: string; extra?: Record<string, unknown> };

describe("paymentOptionsFor", () => {
  it("offers one option per configured stablecoin, USDG first", () => {
    const options = paymentOptionsFor({
      network: ARBITRUM_SEPOLIA_CAIP2,
      priceUsdMicros: 10_000,
      payTo: PROVIDER,
    });
    expect(options.map((o) => (o.price as Priced).asset)).toEqual([USDG, USDC]);
  });

  it("offers only USDG where USDG is all there is", () => {
    const options = paymentOptionsFor({
      network: ROBINHOOD_TESTNET_CAIP2,
      priceUsdMicros: 10_000,
      payTo: PROVIDER,
    });
    expect(options).toHaveLength(1);
  });

  it("quotes the same 6-decimal amount on every row", () => {
    // $0.01 is 10000 units of either stablecoin.
    const options = paymentOptionsFor({
      network: ARBITRUM_SEPOLIA_CAIP2,
      priceUsdMicros: 10_000,
      payTo: PROVIDER,
    });
    for (const option of options) expect((option.price as Priced).amount).toBe("10000");
  });

  it("carries each token's own EIP-712 domain", () => {
    // Not decorative: an EIP-3009 signature is made against
    // (name, version, chainId, verifyingContract), and x402 does not fill the
    // domain in for tokens outside its own registry. USDG has no version() to
    // read, so the table is the only source.
    const [usdg, usdc] = paymentOptionsFor({
      network: ARBITRUM_SEPOLIA_CAIP2,
      priceUsdMicros: 1_000,
      payTo: PROVIDER,
    });
    expect((usdg!.price as Priced).extra).toEqual({ name: "Global Dollar", version: "1" });
    expect((usdc!.price as Priced).extra).toEqual({ name: "USD Coin", version: "2" });
  });

  it("pays the provider, never the broker", () => {
    const options = paymentOptionsFor({
      network: ARBITRUM_SEPOLIA_CAIP2,
      priceUsdMicros: 1_000,
      payTo: PROVIDER,
    });
    for (const option of options) expect(option.payTo).toBe(PROVIDER);
  });

  it("uses the exact scheme and the requested network on every row", () => {
    const options = paymentOptionsFor({
      network: ARBITRUM_SEPOLIA_CAIP2,
      priceUsdMicros: 1_000,
      payTo: PROVIDER,
    });
    for (const option of options) {
      expect(option.scheme).toBe("exact");
      expect(option.network).toBe(ARBITRUM_SEPOLIA_CAIP2);
      expect(option.maxTimeoutSeconds).toBeGreaterThan(0);
    }
  });
});

describe("assetSymbol", () => {
  it("names configured tokens and nothing else", () => {
    expect(assetSymbol(ARBITRUM_SEPOLIA_CAIP2, USDG)).toBe("USDG");
    expect(assetSymbol(ARBITRUM_SEPOLIA_CAIP2, USDC.toLowerCase())).toBe("USDC");
    expect(assetSymbol(ARBITRUM_SEPOLIA_CAIP2, PROVIDER)).toBe("stablecoin");
  });
});

describe("choosePaymentAsset", () => {
  const accepts = [
    { asset: USDG, amount: "1000", symbol: "USDG" },
    { asset: USDC, amount: "1000", symbol: "USDC" },
  ];

  it("takes the first option when balances are unknown", () => {
    expect(choosePaymentAsset(accepts)!.symbol).toBe("USDG");
  });

  it("skips a stablecoin the buyer can't afford", () => {
    const chosen = choosePaymentAsset(accepts, {
      balances: { [USDG.toLowerCase()]: "999", [USDC.toLowerCase()]: "5000" },
    });
    expect(chosen!.symbol).toBe("USDC");
  });

  it("falls back to the first option when nothing is affordable", () => {
    const chosen = choosePaymentAsset(accepts, {
      balances: { [USDG.toLowerCase()]: "0", [USDC.toLowerCase()]: "0" },
    });
    expect(chosen!.symbol).toBe("USDG");
  });

  it("honours an explicit choice by symbol or address, and refuses one not offered", () => {
    expect(choosePaymentAsset(accepts, { preferred: "usdc" })!.asset).toBe(USDC);
    expect(choosePaymentAsset(accepts, { preferred: USDC.toLowerCase() })!.symbol).toBe("USDC");
    expect(choosePaymentAsset(accepts, { preferred: "DAI" })).toBeNull();
  });
});

describe("onlyAssetPolicy", () => {
  it("narrows requirements to the chosen asset", () => {
    const reqs = [{ asset: USDG }, { asset: USDC }];
    expect(onlyAssetPolicy(USDC.toLowerCase())(2, reqs)).toEqual([{ asset: USDC }]);
  });

  it("never empties the list, which would fail a payable request", () => {
    const reqs = [{ asset: USDG }];
    expect(onlyAssetPolicy(USDC)(2, reqs)).toEqual(reqs);
  });
});

describe("helpers", () => {
  it("hashes results deterministically, so receipts are comparable", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
    expect(sha256("hello")).not.toBe(sha256("hello "));
    expect(sha256("hello")).toHaveLength(64);
  });

  it("mints prefixed, URL-safe, non-colliding ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId("job")));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^job_[A-Za-z0-9_-]+$/);
  });

  it("formats durations across the ms/s/m boundaries", () => {
    expect(formatDuration(820)).toBe("820ms");
    expect(formatDuration(4_200)).toBe("4.2s");
    expect(formatDuration(72_000)).toBe("1m 12s");
  });

  it("formats relative times", () => {
    const now = Date.now();
    expect(formatAgo(now, now)).toBe("just now");
    expect(formatAgo(now - 12_000, now)).toBe("12s ago");
    expect(formatAgo(now - 4 * 60_000, now)).toBe("4m ago");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
});

describe("audit envelope size", () => {
  it("stays under the contract's 1024-byte cap for a real receipt", () => {
    // The cap is enforced on chain, so exceeding it is a revert that still
    // costs gas. An EVM address is longer than a Hedera account id and a tx
    // hash is longer than a transaction id, so the margin is genuinely smaller
    // here than it was — worth an assertion rather than an assumption.
    const wrapped = envelope("job.receipt", {
      jobId: "job_2eHjgDqDuMyv",
      providerId: "prv_1LanKLZA8vhK",
      providerAddress: "0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B",
      payer: "0x03294Ce27e218d1611B2ebc0b0ffdDb95F129F36",
      asset: USDG,
      amount: "10000",
      transactionHash: `0x${"a".repeat(64)}`,
      resultHash: "0".repeat(64),
      durationMs: 8_400,
      ok: true,
    });
    expect(Buffer.byteLength(JSON.stringify(wrapped), "utf8")).toBeLessThan(1024);
  });
});
