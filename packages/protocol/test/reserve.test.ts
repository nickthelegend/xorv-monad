import { describe, expect, it } from "vitest";
import { MONAD_RESERVE_WEI, keepsReserve, reserveStanding } from "../src/reserve.js";

const MON = 10n ** 18n;

describe("Monad's 10 MON reserve", () => {
  it("says whether a gas-paying account is above it, and by how much it is short", () => {
    expect(MONAD_RESERVE_WEI).toBe(10n * MON);
    expect(reserveStanding(25n * MON)).toMatchObject({ aboveReserve: true, shortfallWei: "0" });
    expect(reserveStanding(4n * MON)).toMatchObject({ aboveReserve: false, shortfallWei: (6n * MON).toString() });
  });

  it("lets gas dip into the reserve but not a value spend, except the emptying transaction", () => {
    const gas = { gasLimit: 100_000n, maxFeePerGas: 102_000_000_000n };
    // A settlement: no value, only gas, from an account under the reserve. Allowed (the fee may dip in).
    expect(keepsReserve({ balanceWei: 5n * MON, valueWei: 0n, ...gas }).ok).toBe(true);
    // Sending 8 MON out of 15 leaves 7 < 10: Monad reverts it at execution.
    expect(keepsReserve({ balanceWei: 15n * MON, valueWei: 8n * MON, ...gas })).toMatchObject({ ok: false });
    // ...unless it is the account's emptying transaction.
    expect(keepsReserve({ balanceWei: 15n * MON, valueWei: 8n * MON, ...gas, emptyingAllowed: true }).ok).toBe(true);
    // Below the reserve to begin with, the floor is the balance itself: any value spend reverts.
    expect(keepsReserve({ balanceWei: 5n * MON, valueWei: 1n * MON, ...gas }).ok).toBe(false);
    // Monad charges the whole gas limit: value plus limit × fee must fit.
    expect(keepsReserve({ balanceWei: MON / 1000n, valueWei: 0n, gasLimit: 30_000_000n, maxFeePerGas: 102_000_000_000n })).toMatchObject({ ok: false });
  });
});
