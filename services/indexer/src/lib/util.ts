/**
 * Pure helpers shared by the handlers. Nothing here touches the Envio context, so the
 * unit tests exercise them directly.
 */

import { NO_AGENT, ZERO_ADDRESS, ZERO_BYTES32 } from "./constants.js";

/** Entity types from codegen are readonly; handlers build a mutable copy, then set it once. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const SECONDS_PER_DAY = 86_400;

/** UTC calendar day of a block timestamp (seconds): id "yyyy-mm-dd" plus its 00:00 epoch. */
export function dayOf(timestamp: number): { id: string; start: number } {
  const start = Math.floor(timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  return { id: new Date(start * 1000).toISOString().slice(0, 10), start };
}

/** sum / count, or 0 when there is nothing to divide (never NaN in the API). */
export function ratio(sum: number, count: number): number {
  return count > 0 ? sum / count : 0;
}

/**
 * The integer mean of a bigint total, as a JS number. Used for avgDurationMs, where the
 * total is a BigInt column but the average comfortably fits a 32-bit Int.
 */
export function meanInt(total: bigint, count: number): number {
  return count > 0 ? Number(total / BigInt(count)) : 0;
}

/**
 * hex values come back lowercase from HyperSync, but the simulate harness and any RPC
 * fallback pass through whatever they are given, so ids are normalised at the edge.
 */
export function lower(hex: string): string {
  return hex.toLowerCase();
}

export function isZeroBytes32(hex: string): boolean {
  return lower(hex) === ZERO_BYTES32;
}

export function isZeroAddress(hex: string): boolean {
  return lower(hex) === ZERO_ADDRESS;
}

/** ERC-8004 agentId as the Agent entity id, or undefined for XorvLedger.NO_AGENT. */
export function agentIdOrNone(agentId: bigint): string | undefined {
  return agentId === NO_AGENT ? undefined : agentId.toString();
}

/**
 * How a receipt finds its provider. JobRecorded carries agentId and payTo but not the
 * providerId, so the join key is the agent when there is one (the ledger already proved
 * payTo == agentWallet), else the payee address.
 */
export function attributionKey(agentId: string | undefined, payTo: string): string {
  return agentId !== undefined ? `agent:${agentId}` : `payto:${lower(payTo)}`;
}

/** Feedback entity id. feedbackIndex is 1-based per (agentId, client) in the registry. */
export function feedbackId(agentId: bigint | string, client: string, feedbackIndex: bigint): string {
  return `${agentId.toString()}-${lower(client)}-${feedbackIndex.toString()}`;
}

/**
 * ERC-8004 values are int128 with 0..18 decimals ("uptime" 9977/2 = 99.77). Everything the
 * API averages is normalised first, so a 2-decimal score and a 0-decimal score compare.
 */
export function normalizeFeedbackValue(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}

export interface Capability {
  adapter: string;
  priceUsdMicros: bigint;
}

/**
 * Parse the ledger's compact capability string, "claude-code:10000,qwen:5000"
 * (adapter:priceUsdMicros, see SPEC §4). Anyone reading chain data can only trust what is
 * well formed, so entries without a name or a non-negative integer price are dropped
 * instead of showing up as free offers. A repeated adapter keeps its last price.
 */
export function parseCapabilities(raw: string): Capability[] {
  const byAdapter = new Map<string, bigint>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const colon = entry.lastIndexOf(":");
    if (colon <= 0) continue;
    const adapter = entry.slice(0, colon).trim();
    const price = entry.slice(colon + 1).trim();
    if (!adapter || !/^\d+$/.test(price)) continue;
    byAdapter.delete(adapter); // re-insert so iteration order follows the last mention
    byAdapter.set(adapter, BigInt(price));
  }
  return [...byAdapter].map(([adapter, priceUsdMicros]) => ({ adapter, priceUsdMicros }));
}

/**
 * A comma/space separated list of addresses from an ENVIO_* variable, lowercased. Blank,
 * malformed and zero entries are dropped: config.yaml defaults the ledger address to the
 * zero address, and trusting 0x0 as a feedback client would be meaningless at best.
 */
export function parseAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const part of raw.split(/[\s,]+/)) {
    const hex = lower(part.trim());
    if (/^0x[0-9a-f]{40}$/.test(hex) && !isZeroAddress(hex)) out.add(hex);
  }
  return [...out];
}

/**
 * IdentityRegistry stores agentWallet as abi.encodePacked(address): exactly 20 bytes, or
 * empty once cleared. Anything else is not a wallet we can pay, so it reads as unset.
 */
export function walletFromMetadata(value: string): string | undefined {
  const hex = lower(value);
  if (!/^0x[0-9a-f]{40}$/.test(hex)) return undefined;
  return isZeroAddress(hex) ? undefined : hex;
}
