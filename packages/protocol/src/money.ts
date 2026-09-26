/**
 * Money math.
 *
 * Xorv quotes everything in **micro-USD** (millionths of a dollar) as a plain
 * integer, because the prices involved — $0.001 a job — are exactly where
 * floating point starts lying. A `number` holds micro-USD losslessly well past
 * any price this network will ever see, and JSON carries it without ceremony.
 *
 * Circle's USDC on Monad has 6 decimals, so micro-USD and USDC's smallest unit
 * are the same integer. That is a happy coincidence, not a law, so the
 * conversion still goes through a named function — if this ever runs against a
 * token with different precision, there's one place to fix.
 *
 * There is deliberately no native-token (MON) pricing here. x402's `exact`
 * scheme on EVM moves ERC-20s only (EIP-3009 or Permit2), so there is no way to
 * pay a job in MON, and quoting one would need a price oracle for a figure
 * nobody can act on.
 */

/** One US dollar, in micro-USD. */
export const USD_MICROS = 1_000_000;

/**
 * USDC's decimals on Monad (mainnet and testnet alike — confirmed on-chain via
 * `decimals()`). Also the EIP-712 domain is `name: "USDC", version: "2"`; see
 * `NetworkConfig.usdc` for where that lives.
 */
export const USDC_DECIMALS = 6;

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

/**
 * micro-USD → USDC smallest units, as the integer string x402 wants.
 *
 * Done in bigint so the result can never come out in exponent notation, and so
 * the one place a token with more decimals would plug in is already exact.
 */
export function usdMicrosToUsdcUnits(micros: number): string {
  if (!Number.isFinite(micros) || micros < 0) {
    throw new Error(`invalid micro-USD amount: ${String(micros)}`);
  }
  const whole = BigInt(Math.round(micros));
  return (whole * 10n ** BigInt(USDC_DECIMALS - 6)).toString();
}

/**
 * USDC smallest units → micro-USD.
 *
 * Accepts a bigint too, because that is what viem hands back from `balanceOf`.
 */
export function usdcUnitsToUsdMicros(units: string | number | bigint): number {
  const scale = 10 ** (USDC_DECIMALS - 6);
  return Math.round(Number(units) / scale);
}

/** Render USDC smallest units as a dollar string. */
export function formatUsdc(units: string | number | bigint): string {
  return formatUsd(usdcUnitsToUsdMicros(units));
}
