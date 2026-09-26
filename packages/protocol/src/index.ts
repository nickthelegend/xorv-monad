/**
 * @xorv/protocol — everything the CLI, the broker and the web apps must agree
 * on: the domain model, money math, Monad chain config, the XorvLedger and
 * ERC-8004 conventions, the x402 wiring and the sponsor-model LLM presets.
 *
 * This is the Node entry. It re-exports the browser-safe surface
 * (`@xorv/protocol/web`) and adds the server-only pieces: the in-process x402
 * facilitator, the LLM client, and the `node:crypto` helpers below.
 */

export * from "./web.js";
export * from "./x402.js";
export * from "./llm.js";

import { createHash, randomBytes } from "node:crypto";

/**
 * sha-256 hex of a string.
 *
 * On-chain hashes are keccak256 (`textHash` in ledger.ts), which is what an
 * EVM contract can recompute; this remains for off-chain fingerprints where
 * sha-256 is the conventional choice.
 */
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
