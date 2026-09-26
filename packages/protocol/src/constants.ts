/**
 * Protocol-level constants shared by the CLI, the broker and both frontends.
 *
 * Anything here is protocol surface: change a value and every participant has
 * to agree on the change, so they live in one place rather than being retyped
 * per package. Chain-specific values (RPCs, addresses, block time) live in
 * `chains.ts`; this file is the chain-agnostic half.
 */

/** The x402 protocol version Xorv speaks. */
export const X402_VERSION = 2;

/** The only payment scheme Xorv uses; `exact` means "pay exactly this amount". */
export const XORV_SCHEME = "exact";

/**
 * How often a provider node reports in.
 *
 * Chosen against the offline threshold below: three missed beats before a
 * provider drops out of matching, which tolerates one slow network round-trip
 * without parking a job on a node that has actually gone away.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** A provider with no heartbeat inside this window stops being matchable. */
export const HEARTBEAT_OFFLINE_MS = 45_000;

/** Providers idle this long are dropped from the registry entirely. */
export const PROVIDER_REAP_MS = 10 * 60_000;

/**
 * How long a quoted price is honoured.
 *
 * A 402 quote pins a specific provider and a specific price. Too short and a
 * human approving a wallet prompt times out mid-payment; too long and the
 * network holds capacity for someone who wandered off. Five minutes is also the
 * x402 `maxTimeoutSeconds` we advertise, which on EVM becomes the EIP-3009
 * authorization's `validBefore = now + 300`: client, server and token contract
 * all agree on the same window.
 */
export const QUOTE_TTL_SECONDS = 300;

/** Ceiling on how long a single job may run on a provider before it's failed. */
export const JOB_TIMEOUT_MS = 10 * 60_000;
