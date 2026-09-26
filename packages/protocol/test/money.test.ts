/**
 * Money math is where a marketplace quietly loses people's earnings, so these
 * tests are about exactness rather than coverage: every conversion is checked
 * against a hand-computed integer, and the rounding direction is asserted
 * because "close enough" is a bug when it repeats a thousand times a day.
 */

import { describe, expect, it } from "vitest";
import {
  HbarRateCache,
  USD_MICROS,
  formatHbar,
  formatUsd,
  formatUsdc,
  parseUsd,
  tinybarsToUsdMicros,
  usdMicrosToTinybars,
  usdMicrosToUsdcUnits,
  usdcUnitsToUsdMicros,
  type HbarRate,
} from "../src/money.js";

const RATE: HbarRate = { centsPerHbar: 6.839166666666666, expiresAt: 0, fetchedAt: Date.now() };

describe("parseUsd", () => {
  it("parses plain numbers, strings and currency-formatted input identically", () => {
    expect(parseUsd(0.01)).toBe(10_000);
    expect(parseUsd("0.01")).toBe(10_000);
    expect(parseUsd("$0.01")).toBe(10_000);
    expect(parseUsd(" $1,000.00 ")).toBe(1_000 * USD_MICROS);
  });

  it("keeps sub-cent precision that a float would lose", () => {
    // 0.001 * 1e6 is 1000.0000000000001 in IEEE-754; the result must be integral.
    expect(parseUsd("0.001")).toBe(1_000);
    expect(Number.isInteger(parseUsd("0.001"))).toBe(true);
    expect(parseUsd("0.0001")).toBe(100);
  });

  it("rejects anything that isn't a non-negative number", () => {
    expect(() => parseUsd("abc")).toThrow(/invalid price/);
    expect(() => parseUsd(-1)).toThrow(/invalid price/);
    expect(() => parseUsd(Number.NaN)).toThrow(/invalid price/);
    expect(() => parseUsd(Number.POSITIVE_INFINITY)).toThrow(/invalid price/);
  });
});

describe("formatUsd", () => {
  it("shows four decimals for sub-dollar amounts so sub-cent prices don't read as free", () => {
    expect(formatUsd(1_000)).toBe("$0.0010");
    expect(formatUsd(10_000)).toBe("$0.0100");
    expect(formatUsd(100)).toBe("$0.0001");
  });

  it("shows two decimals at a dollar and above", () => {
    expect(formatUsd(1 * USD_MICROS)).toBe("$1.00");
    expect(formatUsd(1_234_567)).toBe("$1.23");
  });

  it("renders exact zero as $0 rather than $0.0000", () => {
    expect(formatUsd(0)).toBe("$0");
  });
});

describe("USDC conversion", () => {
  it("round-trips micro-USD through USDC's smallest unit without drift", () => {
    for (const micros of [1, 100, 1_000, 10_000, 999_999, 1_000_000, 123_456_789]) {
      expect(usdcUnitsToUsdMicros(usdMicrosToUsdcUnits(micros))).toBe(micros);
    }
  });

  it("returns integer strings, because x402 amounts are strings on the wire", () => {
    const units = usdMicrosToUsdcUnits(10_000);
    expect(units).toBe("10000");
    expect(units).toMatch(/^\d+$/);
  });

  it("formats USDC units back to a dollar string", () => {
    expect(formatUsdc("10000")).toBe("$0.0100");
  });
});

describe("HBAR conversion", () => {
  it("converts micro-USD to tinybars at the given rate", () => {
    // $0.001 = 0.1 cents; at 6.839166… cents/ℏ that's 0.014621… ℏ = 1_462_1xx tℏ.
    const tinybars = Number(usdMicrosToTinybars(1_000, RATE));
    expect(tinybars).toBeGreaterThan(1_462_000);
    expect(tinybars).toBeLessThan(1_463_000);
  });

  it("always rounds UP, so the provider never silently eats the remainder", () => {
    // A rate chosen to land mid-tinybar; rounding down would under-pay.
    const awkward: HbarRate = { centsPerHbar: 7.3, expiresAt: 0, fetchedAt: 0 };
    const exact = (1_000 / 10_000 / 7.3) * 1e8;
    const got = Number(usdMicrosToTinybars(1_000, awkward));
    expect(got).toBe(Math.ceil(exact));
    expect(got).toBeGreaterThanOrEqual(exact);
  });

  it("returns an integer string with no exponent, even for large amounts", () => {
    const big = usdMicrosToTinybars(10_000 * USD_MICROS, RATE);
    expect(big).toMatch(/^\d+$/);
    expect(big).not.toContain("e");
  });

  it("round-trips back to approximately the original dollar amount", () => {
    const micros = 10_000;
    const back = tinybarsToUsdMicros(usdMicrosToTinybars(micros, RATE), RATE);
    // Round-up on the way out means back >= original, within one tinybar's worth.
    expect(back).toBeGreaterThanOrEqual(micros);
    expect(back - micros).toBeLessThan(10);
  });
});

describe("formatHbar", () => {
  it("renders tinybars as a trimmed ℏ figure", () => {
    expect(formatHbar("100000000")).toBe("1 ℏ");
    expect(formatHbar("1462167")).toContain("0.0146");
  });
});

describe("HbarRateCache", () => {
  it("collapses concurrent misses onto a single fetch", async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      // A small delay so all three callers arrive while the first is in flight.
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        json: async () => ({
          current_rate: { cent_equivalent: 821, hbar_equivalent: 120, expiration_time: 0 },
        }),
      } as Response;
    }) as typeof fetch;

    try {
      const cache = new HbarRateCache("hedera:testnet");
      const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()]);
      expect(calls).toBe(1);
      expect(a.centsPerHbar).toBeCloseTo(821 / 120);
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("serves a cached rate inside the max age and refetches after it", async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          current_rate: { cent_equivalent: 700, hbar_equivalent: 100, expiration_time: 0 },
        }),
      } as Response;
    }) as typeof fetch;

    try {
      const cache = new HbarRateCache("hedera:testnet", 30);
      await cache.get();
      await cache.get();
      expect(calls).toBe(1);
      await new Promise((r) => setTimeout(r, 45));
      await cache.get();
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("propagates a failed fetch rather than serving a made-up rate", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch;
    try {
      await expect(new HbarRateCache("hedera:testnet").get()).rejects.toThrow(/503/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
