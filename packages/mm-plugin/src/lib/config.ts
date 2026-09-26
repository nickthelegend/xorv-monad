/**
 * Where the broker is, which chains the plugin will sign for, and the parsing
 * of the few numbers a buyer types (a dollar ceiling, a star rating, a
 * timeout). Pure functions — the commands feed them raw flag values.
 */

import { MONAD_MAINNET, MONAD_TESTNET, networkConfig, parseUsd, type MonadNetwork } from "@xorv/protocol";
import { XorvPluginError } from "./errors.js";

/** `mm xorv …` talks to this broker unless `--broker` or `XORV_BROKER_URL` says otherwise. */
export const DEFAULT_BROKER_URL = "http://localhost:8402";
export const BROKER_URL_ENV = "XORV_BROKER_URL";

/**
 * The chains this plugin will ever sign for: Monad testnet and mainnet.
 *
 * Mirrors `package.json#mm.commands[].targetChains`, which is what MetaMask
 * shows on the install consent screen. Keeping the runtime check next to the
 * declared list means a broker on some other chain gets a clear refusal here,
 * not a signature for a chain the user never consented to.
 */
export const TARGET_CHAIN_IDS = [10143, 143] as const;
const NETWORK_BY_CHAIN_ID: Readonly<Record<number, MonadNetwork>> = {
  10143: MONAD_TESTNET,
  143: MONAD_MAINNET,
};

/** The default spend ceiling per job, in dollars — the same default as `xorv run` in the Xorv CLI. */
export const DEFAULT_MAX_USD = "0.05";

/** How long `mm xorv run` waits for a paid job to finish before handing back the job id. */
export const DEFAULT_TIMEOUT_SECONDS = 600;

type Env = Record<string, string | undefined>;

/**
 * `--broker`, then `XORV_BROKER_URL`, then localhost.
 *
 * Only http(s) URLs are accepted, and the trailing slash is dropped so paths
 * join cleanly. The pay URL is always built from this base, never taken from a
 * broker response, so a payment goes to the server the user pointed at.
 */
export function resolveBrokerUrl(flag?: string | null, env: Env = process.env): string {
  const raw = flag?.trim() || env[BROKER_URL_ENV]?.trim() || DEFAULT_BROKER_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new XorvPluginError(
      "XORV_INVALID_INPUT",
      `broker URL "${raw}" is not a valid URL`,
      `Pass --broker https://broker.example.com or set ${BROKER_URL_ENV}.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new XorvPluginError(
      "XORV_INVALID_INPUT",
      `broker URL "${raw}" must use http or https`,
      `Pass --broker https://broker.example.com or set ${BROKER_URL_ENV}.`,
    );
  }
  return url.toString().replace(/\/+$/, "");
}

/** The CAIP-2 network for one of the plugin's target chain ids, or null for any other chain. */
export function networkForChainId(chainId: number): MonadNetwork | null {
  return NETWORK_BY_CHAIN_ID[chainId] ?? null;
}

/**
 * The chain id a CAIP-2 network string names, if it is one the plugin targets.
 * Anything else — another EVM chain, a leftover `hedera:testnet` — is null.
 */
export function targetChainIdOf(network: string | null | undefined): number | null {
  if (!network) return null;
  const match = /^eip155:(\d+)$/.exec(network.trim());
  if (!match) return null;
  const chainId = Number(match[1]);
  return networkForChainId(chainId) ? chainId : null;
}

/** Parse an optional `--chain-id`, which pins the chain the buyer expects the broker to quote on. */
export function parseChainId(raw: string | null | undefined): number | null {
  const text = raw?.trim();
  if (!text) return null;
  const chainId = Number(text);
  if (!Number.isInteger(chainId) || !networkForChainId(chainId)) {
    throw new XorvPluginError(
      "XORV_INVALID_INPUT",
      `--chain-id ${text} is not a Monad chain`,
      `Use --chain-id ${TARGET_CHAIN_IDS[0]} (Monad testnet) or --chain-id ${TARGET_CHAIN_IDS[1]} (Monad mainnet).`,
    );
  }
  return chainId;
}

/**
 * `--max` in dollars ("0.05", "$0.10") → micro-USD.
 *
 * This one number is both the ceiling sent to the broker and the x402
 * client's per-payment spend cap, so it has to be a positive amount.
 */
export function parseMaxUsd(raw: string | null | undefined): number {
  const text = raw?.trim() || DEFAULT_MAX_USD;
  let micros: number;
  try {
    micros = parseUsd(text);
  } catch {
    micros = Number.NaN;
  }
  if (!Number.isFinite(micros) || micros <= 0) {
    throw new XorvPluginError(
      "XORV_INVALID_INPUT",
      `--max "${text}" is not a positive dollar amount`,
      "Pass the most you will pay for this job in dollars, e.g. --max 0.05.",
    );
  }
  return micros;
}

/**
 * `--stars 1..5` → the 0–100 value ERC-8004 feedback carries (20 per star),
 * the same scale the Xorv web app uses.
 */
export function parseStars(raw: string | number | null | undefined): { stars: number; value: number } {
  const text = String(raw ?? "").trim();
  const stars = Number(text);
  if (!/^\d+$/.test(text) || stars < 1 || stars > 5) {
    throw new XorvPluginError(
      "XORV_INVALID_INPUT",
      `--stars "${text}" must be a whole number from 1 to 5`,
      "Rate the job with --stars 1 (poor) to --stars 5 (excellent).",
    );
  }
  return { stars, value: stars * 20 };
}

/** `--timeout` in seconds, bounded to something a terminal session can reasonably wait. */
export function parseTimeoutSeconds(raw: string | null | undefined): number {
  const text = raw?.trim();
  if (!text) return DEFAULT_TIMEOUT_SECONDS;
  const seconds = Number(text);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
    throw new XorvPluginError(
      "XORV_INVALID_INPUT",
      `--timeout "${text}" must be a whole number of seconds from 5 to 3600`,
      `Omit it for the default of ${DEFAULT_TIMEOUT_SECONDS} seconds.`,
    );
  }
  return seconds;
}

/** Short human label for a target network, e.g. "Monad Testnet". */
export function networkName(network: string): string {
  try {
    return networkConfig(network).name;
  } catch {
    return network;
  }
}
