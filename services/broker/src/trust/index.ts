/**
 * Nansen trust signals for Xorv — see service.ts for where they are used,
 * nansen.ts for how the broker pays for them (x402, USDC, Monad mainnet) and
 * signal.ts for how answers become a score and a related-party verdict.
 */

import type { PrivateKeyAccount } from "viem";
import { createNansenFixtures } from "./fixtures.js";
import { NansenClient, type NansenMode } from "./nansen.js";
import { NansenTrust } from "./service.js";

export * from "./nansen.js";
export * from "./signal.js";
export * from "./service.js";
export { createNansenFixtures, type FixtureOptions } from "./fixtures.js";

export interface NansenConfig {
  /** `off` (default), `fixture` (deterministic, no network) or `live` (real calls, real payments). */
  mode: NansenMode;
  /** XORV_NANSEN_PAYER_KEY — a Monad MAINNET key holding a few USDC. Pays over x402. */
  payer: PrivateKeyAccount | null;
  /** NANSEN_API_KEY — takes precedence over x402 when set. */
  apiKey: string | null;
  /** Largest single payment, USDC units. */
  perCallCapUnits: bigint;
  /** Most the broker spends on Nansen per UTC day, USDC units. */
  dailyCapUnits: bigint;
  /** Refuse any payee but this one. */
  pinPayTo: string | null;
  /** Fetch the daily Monad smart-money list for the (internal) matching nudge. */
  smartMoney: boolean;
  /** Refuse ratings between related wallets. */
  ratingGuard: boolean;
  /** Rebuild provider signals this often. */
  refreshMs: number;
  /** Fixture mode only: addresses to give one shared first funder (a demo sybil ring). */
  fixtureCluster: string[];
}

export const NANSEN_OFF: NansenConfig = {
  mode: "off",
  payer: null,
  apiKey: null,
  perCallCapUnits: 50_000n,
  dailyCapUnits: 1_000_000n,
  pinPayTo: null,
  smartMoney: true,
  ratingGuard: true,
  refreshMs: 6 * 3_600_000,
  fixtureCluster: [],
};

export function createNansenTrust(
  config: NansenConfig = NANSEN_OFF,
  opts: { fetch?: typeof fetch; now?: () => number; log?: (line: string) => void } = {},
): NansenTrust {
  const client = new NansenClient({
    mode: config.mode,
    apiKey: config.apiKey,
    signer: config.payer,
    perCallCapUnits: config.perCallCapUnits,
    dailyCapUnits: config.dailyCapUnits,
    pinPayTo: config.pinPayTo,
    fixtures: config.mode === "fixture" ? createNansenFixtures({ now: opts.now, cluster: config.fixtureCluster }) : null,
    fetch: opts.fetch,
    now: opts.now,
    log: opts.log,
  });
  return new NansenTrust({
    client,
    smartMoney: config.smartMoney,
    ratingGuard: config.ratingGuard,
    refreshMs: config.refreshMs,
    now: opts.now,
    log: opts.log,
  });
}
