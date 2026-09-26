/**
 * Small formatting helpers shared by the commands' human-readable output.
 * The machine-readable result (`--json`) never goes through these: it carries
 * raw integer strings and full addresses.
 */

import { formatUsdc, shortHex } from "@xorv/protocol";

/** USDC smallest units → "0.0100 USDC". */
export function usdcLabel(units: string | bigint): string {
  return `${formatUsdc(units).replace(/^\$/, "")} USDC`;
}

/** "0x1234…abcd" */
export function short(hex: string | null | undefined): string {
  return hex ? shortHex(hex, 6, 4) : "—";
}

/** A 0–100 rating as stars, e.g. 80 → "★★★★☆". */
export function stars(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "unrated";
  const n = Math.max(0, Math.min(5, Math.round(value / 20)));
  return `${"★".repeat(n)}${"☆".repeat(5 - n)}`;
}

/** Truncate a single-line preview of a long text. */
export function preview(text: string | null | undefined, max = 120): string {
  if (!text) return "";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
