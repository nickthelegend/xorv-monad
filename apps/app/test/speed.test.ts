import { describe, expect, it } from "vitest";
import { ETHEREUM_SLOT_MS, formatGas, formatMon, formatMs, vsEthereumSlot } from "@/lib/speed";

describe("the Monad speed receipt's formatting", () => {
  it("shows milliseconds under a second and seconds above", () => {
    expect(formatMs(612.4)).toBe("612 ms");
    expect(formatMs(999)).toBe("999 ms");
    expect(formatMs(1240)).toBe("1.24 s");
  });

  it("shows gas paid in MON, short, without inventing precision", () => {
    expect(formatMon("4210650000000000")).toBe("0.00421 MON");
    expect(formatMon(10n ** 18n)).toBe("1 MON");
    expect(formatMon("0")).toBe("0 MON");
    expect(formatMon("999")).toBe("<0.000001 MON");
  });

  it("groups gas digits", () => {
    expect(formatGas("84213")).toBe("84,213");
  });

  it("compares with one Ethereum slot only when the gap is real", () => {
    expect(ETHEREUM_SLOT_MS).toBe(12_000);
    expect(vsEthereumSlot(600)).toBe(20);
    expect(vsEthereumSlot(7_000)).toBeNull();
    expect(vsEthereumSlot(null)).toBeNull();
    expect(vsEthereumSlot(0)).toBeNull();
  });
});
