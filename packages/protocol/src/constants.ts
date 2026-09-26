/**
 * Network-level constants shared by the CLI, the broker and both frontends.
 *
 * Anything here is protocol surface: change a value and every participant has
 * to agree on the change, so they live in one place rather than being retyped
 * per package.
 */

import {
  HBAR_ASSET_ID,
  HEDERA_MAINNET_CAIP2,
  HEDERA_MAINNET_MIRROR_NODE_URL,
  HEDERA_MAINNET_USDC,
  HEDERA_TESTNET_CAIP2,
  HEDERA_TESTNET_MIRROR_NODE_URL,
  HEDERA_TESTNET_USDC,
  HEDERA_USDC_DECIMALS,
} from "@x402/hedera";

export {
  HBAR_ASSET_ID,
  HEDERA_MAINNET_CAIP2,
  HEDERA_MAINNET_USDC,
  HEDERA_TESTNET_CAIP2,
  HEDERA_TESTNET_USDC,
  HEDERA_USDC_DECIMALS,
};

/** HBAR is denominated in tinybars — 1 ℏ = 10^8 tℏ. */
export const HBAR_DECIMALS = 8;

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
 * human filling in a form times out mid-payment; too long and the network holds
 * capacity for someone who wandered off. Five minutes is the x402
 * `maxTimeoutSeconds` we advertise, so client and server agree on the window.
 */
export const QUOTE_TTL_SECONDS = 300;

/** Ceiling on how long a single job may run on a provider before it's failed. */
export const JOB_TIMEOUT_MS = 10 * 60_000;

/** Wire version for HCS envelopes, so consumers can evolve the shape safely. */
export const HCS_SCHEMA_VERSION = 1;

/** Mirror Node REST base per CAIP-2 network. */
export function mirrorNodeUrl(network: string): string {
  return network === HEDERA_MAINNET_CAIP2
    ? HEDERA_MAINNET_MIRROR_NODE_URL
    : HEDERA_TESTNET_MIRROR_NODE_URL;
}

/**
 * The stablecoin this network prices in.
 *
 * Defaults to Circle's USDC, overridable with `XORV_STABLECOIN`. A marketplace
 * that hardcodes one token id can never be pointed at a different issuer, a
 * different network's USDC, or a test token — and the override is what lets the
 * HTS settlement path be exercised without waiting on a faucet.
 *
 * The value is read per call rather than captured at module load so a test can
 * set it without re-importing the module.
 */
export function usdcTokenId(network: string): string {
  const override = process.env.XORV_STABLECOIN?.trim();
  if (override && /^\d+\.\d+\.\d+$/.test(override)) return override;
  return network === HEDERA_MAINNET_CAIP2 ? HEDERA_MAINNET_USDC : HEDERA_TESTNET_USDC;
}

/** Human label for a network, for CLI and UI chrome. */
export function networkLabel(network: string): string {
  return network === HEDERA_MAINNET_CAIP2 ? "mainnet" : "testnet";
}

/**
 * HashScan link for a Hedera transaction id.
 *
 * The SDK renders ids as `0.0.123@1699.000000000`, and HashScan wants
 * `0.0.123-1699-000000000`, so the separators are rewritten here rather than at
 * each of the half-dozen call sites that surface a receipt link.
 */
export function hashscanTx(network: string, transactionId: string): string {
  const net = networkLabel(network);
  const normalized = transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  return `https://hashscan.io/${net}/transaction/${normalized}`;
}

/** HashScan link for a topic. */
export function hashscanTopic(network: string, topicId: string): string {
  return `https://hashscan.io/${networkLabel(network)}/topic/${topicId}`;
}

/** HashScan link for an account. */
export function hashscanAccount(network: string, accountId: string): string {
  return `https://hashscan.io/${networkLabel(network)}/account/${accountId}`;
}

/** HashScan link for a token. */
export function hashscanToken(network: string, tokenId: string): string {
  return `https://hashscan.io/${networkLabel(network)}/token/${tokenId}`;
}
