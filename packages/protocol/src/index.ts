/**
 * @xorv/protocol — everything the CLI, the broker and the web apps must agree
 * on: the domain model, money math, Hedera plumbing and the x402 wiring.
 */

export * from "./constants.js";
export * from "./types.js";
export * from "./money.js";
export * from "./hedera.js";
export * from "./hcs.js";
export * from "./x402.js";

import { createHash, randomBytes } from "node:crypto";

/** sha-256 hex of a string — used for tamper-evident result hashes in receipts. */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * A short, URL-safe, collision-resistant id.
 *
 * Prefixed by type (`job_`, `prv_`, `qte_`) so an id in a log line says what it
 * is without a lookup.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

/** Wall-clock duration rendered for humans: "820ms", "4.2s", "1m 12s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Relative time for feeds: "just now", "12s ago", "4m ago". */
export function formatAgo(epochMs: number, now = Date.now()): string {
  const delta = Math.max(0, now - epochMs);
  if (delta < 2_000) return "just now";
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}
