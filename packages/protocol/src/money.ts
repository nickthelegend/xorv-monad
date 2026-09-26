/**
 * Money math.
 *
 * Xorv quotes everything in **micro-USD** (millionths of a dollar) as a plain
 * integer, because the prices involved — $0.001 a job — are exactly where
 * floating point starts lying. A `number` holds micro-USD losslessly well past
 * any price this network will ever see, and JSON carries it without ceremony.
 *
 * USDC on Hedera also has 6 decimals, so micro-USD and USDC's smallest unit are
 * the same integer. That is a happy coincidence, not a law, so the conversion
 * still goes through a named function — if this ever runs against a token with
 * different precision, there's one place to fix.
 */

import { HBAR_DECIMALS, HEDERA_USDC_DECIMALS, mirrorNodeUrl } from "./constants.js";

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

/** micro-USD → USDC smallest units, as the integer string x402 wants. */
export function usdMicrosToUsdcUnits(micros: number): string {
  const scale = 10 ** (HEDERA_USDC_DECIMALS - 6);
  return String(Math.round(micros * scale));
}

/** USDC smallest units → micro-USD. */
export function usdcUnitsToUsdMicros(units: string | number): number {
  const scale = 10 ** (HEDERA_USDC_DECIMALS - 6);
  return Math.round(Number(units) / scale);
}

/** Render USDC smallest units as a dollar string. */
export function formatUsdc(units: string | number): string {
  return formatUsd(usdcUnitsToUsdMicros(units));
}

/** Render tinybars as an ℏ string. */
export function formatHbar(tinybars: string | number): string {
  const hbar = Number(tinybars) / 10 ** HBAR_DECIMALS;
  return `${hbar.toFixed(hbar >= 1 ? 4 : 8).replace(/0+$/, "").replace(/\.$/, "")} ℏ`;
}

/**
 * The network's own HBAR/USD rate, straight from the Mirror Node.
 *
 * Hedera publishes the exchange rate it charges fees at, so the HBAR price of a
 * job comes from the ledger rather than from a third-party oracle we'd have to
 * trust and keep alive. The shape is `cent_equivalent / hbar_equivalent` cents
 * per HBAR.
 */
export interface HbarRate {
  /** US cents per 1 HBAR. */
  centsPerHbar: number;
  /** Epoch seconds this rate expires; Hedera rotates it hourly. */
  expiresAt: number;
  fetchedAt: number;
}

interface MirrorExchangeRate {
  current_rate: { cent_equivalent: number; hbar_equivalent: number; expiration_time: number };
}

/** Fetch the current HBAR/USD rate for a network. Throws on a bad response. */
export async function fetchHbarRate(network: string): Promise<HbarRate> {
  const url = `${mirrorNodeUrl(network)}/api/v1/network/exchangerate`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`mirror node exchangerate → ${res.status}`);
  const body = (await res.json()) as MirrorExchangeRate;
  const { cent_equivalent, hbar_equivalent, expiration_time } = body.current_rate;
  if (!cent_equivalent || !hbar_equivalent) throw new Error("mirror node returned an empty rate");
  return {
    centsPerHbar: cent_equivalent / hbar_equivalent,
    expiresAt: expiration_time,
    fetchedAt: Date.now(),
  };
}

/**
 * micro-USD → tinybars at a given rate, rounded up.
 *
 * Rounding up rather than to-nearest is deliberate: the provider quoted a price
 * in dollars, and a half-tinybar rounded down is the provider silently eating
 * the difference on every single job.
 */
export function usdMicrosToTinybars(micros: number, rate: HbarRate): string {
  const cents = micros / 10_000; // 1 cent = 10_000 micro-USD
  const hbar = cents / rate.centsPerHbar;
  return String(BigInt(Math.ceil(hbar * 10 ** HBAR_DECIMALS)));
}

/** tinybars → micro-USD at a given rate. */
export function tinybarsToUsdMicros(tinybars: string | number, rate: HbarRate): number {
  const hbar = Number(tinybars) / 10 ** HBAR_DECIMALS;
  return Math.round(hbar * rate.centsPerHbar * 10_000);
}

/**
 * A rate cache that survives a burst of quotes without hammering the Mirror
 * Node, and refuses to serve a rate old enough to misprice a job.
 */
export class HbarRateCache {
  private cached: HbarRate | null = null;
  private inflight: Promise<HbarRate> | null = null;

  constructor(
    private readonly network: string,
    private readonly maxAgeMs = 60_000,
  ) {}

  async get(): Promise<HbarRate> {
    const fresh = this.cached && Date.now() - this.cached.fetchedAt < this.maxAgeMs;
    if (fresh && this.cached) return this.cached;
    // Collapse concurrent misses onto one request; a burst of quotes at startup
    // would otherwise open a dozen sockets for the same number.
    this.inflight ??= fetchHbarRate(this.network)
      .then((rate) => {
        this.cached = rate;
        return rate;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}
