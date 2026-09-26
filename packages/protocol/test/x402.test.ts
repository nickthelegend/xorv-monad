/**
 * The `accepts` array is the contract between buyer and network: get an amount
 * or an asset wrong here and a correctly-signed payment is rejected, or worse,
 * the wrong amount moves.
 */

import { describe, expect, it } from "vitest";
import { assetKind, paymentOptionsFor } from "../src/x402.js";
import { HBAR_ASSET_ID, HEDERA_TESTNET_CAIP2 } from "../src/constants.js";
import type { HbarRate } from "../src/money.js";
import { sha256, newId, formatDuration, formatAgo } from "../src/index.js";
import { envelope } from "../src/hcs.js";

const RATE: HbarRate = { centsPerHbar: 6.8, expiresAt: 0, fetchedAt: Date.now() };

describe("paymentOptionsFor", () => {
  it("offers USDC and HBAR when a live rate is available", () => {
    const options = paymentOptionsFor({
      network: HEDERA_TESTNET_CAIP2,
      priceUsdMicros: 10_000,
      payTo: "0.0.9848438",
      hbarRate: RATE,
    });
    expect(options).toHaveLength(2);
    expect(options.map((o) => (o.price as { asset: string }).asset)).toEqual([
      "0.0.429274",
      HBAR_ASSET_ID,
    ]);
  });

  it("omits HBAR entirely when there is no rate, rather than quoting a wrong price", () => {
    const options = paymentOptionsFor({
      network: HEDERA_TESTNET_CAIP2,
      priceUsdMicros: 10_000,
      payTo: "0.0.9848438",
      hbarRate: null,
    });
    expect(options).toHaveLength(1);
    expect((options[0]!.price as { asset: string }).asset).toBe("0.0.429274");
  });

  it("pays the provider, never the broker", () => {
    const options = paymentOptionsFor({
      network: HEDERA_TESTNET_CAIP2,
      priceUsdMicros: 1_000,
      payTo: "0.0.9848438",
      hbarRate: RATE,
    });
    for (const option of options) expect(option.payTo).toBe("0.0.9848438");
  });

  it("uses the exact scheme and the requested network on every row", () => {
    const options = paymentOptionsFor({
      network: HEDERA_TESTNET_CAIP2,
      priceUsdMicros: 1_000,
      payTo: "0.0.1",
      hbarRate: RATE,
    });
    for (const option of options) {
      expect(option.scheme).toBe("exact");
      expect(option.network).toBe(HEDERA_TESTNET_CAIP2);
      expect(option.maxTimeoutSeconds).toBeGreaterThan(0);
    }
  });
});

describe("assetKind", () => {
  it("recognises native HBAR by its 0.0.0 asset id", () => {
    expect(assetKind(HBAR_ASSET_ID)).toBe("hbar");
  });

  it("treats every other asset id as a token", () => {
    expect(assetKind("0.0.429274")).toBe("usdc");
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

describe("hcs envelope", () => {
  it("stamps a version and kind so consumers can evolve the shape", () => {
    const wrapped = envelope("job.receipt", { jobId: "job_1" });
    expect(wrapped.v).toBe(1);
    expect(wrapped.kind).toBe("job.receipt");
    expect(wrapped.data).toEqual({ jobId: "job_1" });
    expect(typeof wrapped.at).toBe("number");
  });

  it("stays comfortably under the 1024-byte single-transaction limit for a real receipt", () => {
    const wrapped = envelope("job.receipt", {
      jobId: "job_2eHjgDqDuMyv",
      providerId: "prv_1LanKLZA8vhK",
      providerAccountId: "0.0.9848438",
      payer: "0.0.9848440",
      asset: "0.0.429274",
      amount: "10000",
      transactionId: "0.0.9842030@1785475549.131327424",
      resultHash: "0".repeat(64),
      durationMs: 8_400,
      ok: true,
    });
    expect(Buffer.byteLength(JSON.stringify(wrapped), "utf8")).toBeLessThan(1024);
  });
});
