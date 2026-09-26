/**
 * "Can this account be paid in USDC?" has two possible yeses, and getting it
 * wrong is expensive in both directions: report a false no and the operator
 * spends HBAR on an association they didn't need; report a false yes and their
 * payments are rejected at preflight with no explanation.
 *
 * These pin the rule to what `@x402/hedera`'s own preflight checks.
 */

import { afterEach, describe, expect, it } from "vitest";
import { fetchBalances } from "../src/hedera.js";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

function mirrorReturns(body: unknown, ok = true): void {
  globalThis.fetch = (async () =>
    ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response) as typeof fetch;
}

const USDC = "0.0.429274";

describe("fetchBalances", () => {
  it("reads HBAR and USDC balances", async () => {
    mirrorReturns({
      balance: { balance: 538_060_000, tokens: [{ token_id: USDC, balance: 25_000 }] },
      max_automatic_token_associations: 0,
    });
    const balances = await fetchBalances("hedera:testnet", "0.0.1");
    expect(balances.hbarTinybars).toBe("538060000");
    expect(balances.usdcUnits).toBe("25000");
  });

  it("says yes when the token is explicitly associated", async () => {
    mirrorReturns({
      balance: { balance: 0, tokens: [{ token_id: USDC, balance: 0 }] },
      max_automatic_token_associations: 0,
    });
    const balances = await fetchBalances("hedera:testnet", "0.0.1");
    expect(balances.usdcAssociated).toBe(true);
    expect(balances.canReceiveUsdc).toBe(true);
  });

  it("says yes on unlimited automatic association, even with nothing held", async () => {
    // This is every account `pnpm setup:hedera` creates. Reporting no here sent
    // operators to run a pointless, HBAR-costing transaction.
    mirrorReturns({
      balance: { balance: 0, tokens: [] },
      max_automatic_token_associations: -1,
    });
    const balances = await fetchBalances("hedera:testnet", "0.0.1");
    expect(balances.usdcAssociated).toBe(false);
    expect(balances.maxAutoAssociations).toBe(-1);
    expect(balances.canReceiveUsdc).toBe(true);
  });

  it("says yes when automatic slots remain free", async () => {
    mirrorReturns({
      balance: { balance: 0, tokens: [{ token_id: "0.0.999", balance: 1 }] },
      max_automatic_token_associations: 5,
    });
    expect((await fetchBalances("hedera:testnet", "0.0.1")).canReceiveUsdc).toBe(true);
  });

  it("says NO when every automatic slot is used by other tokens", async () => {
    mirrorReturns({
      balance: {
        balance: 0,
        tokens: [
          { token_id: "0.0.111", balance: 1 },
          { token_id: "0.0.222", balance: 1 },
        ],
      },
      max_automatic_token_associations: 2,
    });
    const balances = await fetchBalances("hedera:testnet", "0.0.1");
    expect(balances.canReceiveUsdc).toBe(false);
  });

  it("says NO with no association and no automatic slots", async () => {
    mirrorReturns({ balance: { balance: 0, tokens: [] }, max_automatic_token_associations: 0 });
    expect((await fetchBalances("hedera:testnet", "0.0.1")).canReceiveUsdc).toBe(false);
  });

  it("treats a missing auto-association field as none, not as unlimited", async () => {
    // Failing closed: an older mirror response must not be read as permission.
    mirrorReturns({ balance: { balance: 0, tokens: [] } });
    const balances = await fetchBalances("hedera:testnet", "0.0.1");
    expect(balances.maxAutoAssociations).toBe(0);
    expect(balances.canReceiveUsdc).toBe(false);
  });

  it("throws on a mirror node error rather than reporting a zero balance", async () => {
    mirrorReturns({}, false);
    await expect(fetchBalances("hedera:testnet", "0.0.1")).rejects.toThrow(/mirror node/);
  });
});
