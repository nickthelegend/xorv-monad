/**
 * Money math is where a marketplace quietly loses people's earnings, so these
 * tests are about exactness rather than coverage: every conversion is checked
 * against a hand-computed integer, and the rounding direction is asserted
 * because "close enough" is a bug when it repeats a thousand times a day.
 */

import { describe, expect, it } from "vitest";
import {
  USD_MICROS,
  formatGas,
  formatUnits,
  formatUsd,
  parseUsd,
  unitsToUsdMicros,
  usdMicrosToUnits,
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
  });

  it("renders exact zero as $0 rather than $0.0000", () => {
    expect(formatUsd(0)).toBe("$0");
  });
});

describe("stablecoin unit conversion", () => {
  it("round-trips micro-USD through a stablecoin's smallest unit without drift", () => {
    for (const micros of [1, 100, 1_000, 10_000, 999_999, 1_000_000, 123_456_789]) {
      expect(unitsToUsdMicros(usdMicrosToUnits(micros))).toBe(micros);
    }
  });

  it("returns integer strings, because x402 amounts are strings on the wire", () => {
    const units = usdMicrosToUnits(10_000);
    expect(units).toBe("10000");
    expect(units).toMatch(/^\d+$/);
  });

  it("formats stablecoin units back to a dollar string", () => {
    expect(formatUnits("10000")).toBe("$0.0100");
  });
});

describe("formatGas", () => {
  it("renders the operator's gas balance at six decimals", () => {
    expect(formatGas(1_250_000_000_000_000_000n)).toBe("1.250000 MON");
    expect(formatGas(4_281_188_000_000n)).toBe("0.000004 MON");
    expect(formatGas("0")).toBe("0 MON");
  });

  it("does not render dust as zero", () => {
    expect(formatGas(999_999_999_999n)).toBe("<0.000001 MON");
  });
});
