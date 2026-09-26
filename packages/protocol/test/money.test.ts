/**
 * Money math is where a marketplace quietly loses people's earnings, so these
 * tests are about exactness rather than coverage: every conversion is checked
 * against a hand-computed integer, and the rounding direction is asserted
 * because "close enough" is a bug when it repeats a thousand times a day.
 */

import { describe, expect, it } from "vitest";
import {
  USDC_DECIMALS,
  USD_MICROS,
  formatUsd,
  formatUsdc,
  parseUsd,
  usdMicrosToUsdcUnits,
  usdcUnitsToUsdMicros,
} from "../src/money.js";

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
    expect(formatUsd(1_234_567, { compact: true })).toBe("$1.23");
  });

  it("renders exact zero as $0 rather than $0.0000", () => {
    expect(formatUsd(0)).toBe("$0");
  });
});

describe("USDC conversion", () => {
  it("uses Monad USDC's 6 decimals", () => {
    expect(USDC_DECIMALS).toBe(6);
  });

  it("round-trips micro-USD through USDC's smallest unit without drift", () => {
    for (const micros of [1, 100, 1_000, 10_000, 999_999, 1_000_000, 123_456_789]) {
      expect(usdcUnitsToUsdMicros(usdMicrosToUsdcUnits(micros))).toBe(micros);
    }
  });

  it("returns integer strings with no exponent, because x402 amounts are strings on the wire", () => {
    const units = usdMicrosToUsdcUnits(10_000);
    expect(units).toBe("10000");
    expect(units).toMatch(/^\d+$/);
    // A float → String() would print 1e+21 here; bigint math never does.
    expect(usdMicrosToUsdcUnits(1e21)).toBe("1000000000000000000000");
  });

  it("rounds a fractional micro-USD amount to the nearest unit", () => {
    expect(usdMicrosToUsdcUnits(1_000.4)).toBe("1000");
    expect(usdMicrosToUsdcUnits(1_000.6)).toBe("1001");
  });

  it("refuses negative or non-finite amounts rather than emitting a bogus integer", () => {
    expect(() => usdMicrosToUsdcUnits(-1)).toThrow(/invalid micro-USD/);
    expect(() => usdMicrosToUsdcUnits(Number.NaN)).toThrow(/invalid micro-USD/);
    expect(() => usdMicrosToUsdcUnits(Number.POSITIVE_INFINITY)).toThrow(/invalid micro-USD/);
  });

  it("accepts the bigint balances viem returns", () => {
    expect(usdcUnitsToUsdMicros(25_000n)).toBe(25_000);
    expect(formatUsdc(25_000n)).toBe("$0.0250");
  });

  it("formats USDC units back to a dollar string", () => {
    expect(formatUsdc("10000")).toBe("$0.0100");
    expect(formatUsdc(2_500_000)).toBe("$2.50");
  });
});
