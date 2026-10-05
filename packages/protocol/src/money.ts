/**
 * Money math.
 *
 * Xorv quotes everything in **micro-USD** (millionths of a dollar) as a plain
 * integer, because the prices involved — $0.001 a job — are exactly where
 * floating point starts lying. A `number` holds micro-USD losslessly well past
 * any price this network will ever see, and JSON carries it without ceremony.
 *
 * Every stablecoin Xorv settles in (USDG, USDC) has 6 decimals, so micro-USD
 * and a token's smallest unit are the same integer. That is a happy
 * coincidence, not a law, so the conversion still goes through a named
 * function — if this ever runs against a token with different precision, there
 * is one place to fix.
 *
 * ## What is no longer here
 *
 * On Hedera this file also carried an exchange-rate client, a rate cache, and
 * tinybar conversions, because a job could be priced in HBAR *or* USDC and the
 * two needed a live rate to relate. Xorv now prices only in dollar
 * stablecoins, treated 1:1 with the dollar, so there is no rate to fetch, no
 * cache to keep warm, and no window in which a stale quote misprices someone's
 * work. Gas is ETH, but only the operator's facilitator ever pays it, so no
 * price in the product is denominated in it.
 */

import { GAS_TOKEN_DECIMALS, STABLECOIN_DECIMALS } from "./constants.js";

/** One US dollar, in micro-USD. */
export const USD_MICROS = 1_000_000;

/** Parse a human price like "$0.01", "0.01" or 0.01 into micro-USD. */
export function parseUsd(input: string | number): number {
  const raw = typeof input === "number" ? input : Number(String(input).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(raw) || raw < 0) {
    throw new Error(`invalid price: ${String(input)}`);
  }
  return Math.round(raw * USD_MICROS);
}

/**
 * Render micro-USD for humans.
 *
 * Sub-cent prices are the normal case here, so the default keeps four decimal
 * places — "$0.0010" rather than a "$0.00" that reads as free.
 */
export function formatUsd(micros: number, opts: { compact?: boolean } = {}): string {
  const dollars = micros / USD_MICROS;
  if (opts.compact && dollars >= 1) return `$${dollars.toFixed(2)}`;
  if (dollars === 0) return "$0";
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(4)}`;
}

/** micro-USD → stablecoin smallest units, as the integer string x402 wants. */
export function usdMicrosToUnits(micros: number): string {
  const scale = 10 ** (STABLECOIN_DECIMALS - 6);
  return String(Math.round(micros * scale));
}

/** Stablecoin smallest units → micro-USD. */
export function unitsToUsdMicros(units: string | number): number {
  const scale = 10 ** (STABLECOIN_DECIMALS - 6);
  return Math.round(Number(units) / scale);
}

/** Render stablecoin smallest units as a dollar string. */
export function formatUnits(units: string | number): string {
  return formatUsd(unitsToUsdMicros(units));
}

/**
 * Render a wei amount as ETH, for the operator's gas balance.
 *
 * Six decimal places, because an Arbitrum transaction costs a few millionths
 * of an ETH and "0.00 ETH" says nothing. Integer math down to the display
 * precision, so an 18-decimal balance never passes through a float whole.
 */
export function formatEth(wei: string | number | bigint): string {
  const value = BigInt(wei);
  const scale = 10n ** BigInt(GAS_TOKEN_DECIMALS - 6);
  const micro = value / scale;
  if (micro === 0n) return value === 0n ? "0 ETH" : "<0.000001 ETH";
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac} ETH`;
}
