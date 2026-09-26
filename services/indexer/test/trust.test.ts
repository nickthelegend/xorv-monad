/**
 * lib/trust.ts on its own. The simulated indexer only routes XorvLedger events from the
 * configured address, which the env already trusts, so the on-chain side (a Ledger row
 * for an address config.yaml indexes but the env does not name, e.g. a second ledger
 * after a redeploy) is checked here against a stub context.
 */

import { describe, expect, it } from "vitest";
import type { Context } from "../src/lib/entities.js";
import { isLedgerClient, isVerifierClient } from "../src/lib/trust.js";
import { CONFIGURED_VERIFIER, LEDGER, addr } from "./harness.js";

const SECOND_LEDGER = addr(0x1ed2);
const ACTIVE_BROKER = addr(0xb0);
const RETIRED_BROKER = addr(0xb1);

const context = {
  Ledger: { get: async (id: string) => (id === SECOND_LEDGER ? { id } : undefined) },
  Broker: {
    get: async (id: string) =>
      id === ACTIVE_BROKER ? { id, active: true } : id === RETIRED_BROKER ? { id, active: false } : undefined,
  },
} as unknown as Context;

describe("trusted feedback clients", () => {
  it("a ledger is the configured address or any address with a Ledger row", async () => {
    expect(await isLedgerClient(context, LEDGER)).toBe(true);
    expect(await isLedgerClient(context, SECOND_LEDGER)).toBe(true);
    expect(await isLedgerClient(context, ACTIVE_BROKER)).toBe(false);
    expect(await isLedgerClient(context, `0x${"0".repeat(40)}`)).toBe(false);
  });

  it("a verifier is a configured address or the active broker, never a retired one", async () => {
    expect(await isVerifierClient(context, CONFIGURED_VERIFIER)).toBe(true);
    expect(await isVerifierClient(context, ACTIVE_BROKER)).toBe(true);
    expect(await isVerifierClient(context, RETIRED_BROKER)).toBe(false);
    expect(await isVerifierClient(context, LEDGER)).toBe(false);
  });
});
