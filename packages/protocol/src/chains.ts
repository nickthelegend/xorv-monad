/**
 * Monad network configuration — the one table every participant reads.
 *
 * A marketplace that hardcodes an RPC, an explorer or a token address in six
 * packages ends up with six slightly different ideas of which chain it is on.
 * Everything chain-shaped lives here instead, keyed by CAIP-2 id, which is also
 * the network string x402 puts on the wire (`eip155:10143`), so the value a
 * buyer sees in a 402 is the same key the broker looked its config up with.
 *
 * Testnet is the default. Mainnet is a deliberate choice, never a fallback: an
 * unrecognised network string throws rather than quietly resolving to a real
 * USDC contract.
 *
 * Three overrides are read from the environment **per call** (not at module
 * load, so tests and hot config reloads see changes without re-importing):
 *
 *  - `XORV_RPC_URL`       — a private RPC; the public ones cap `eth_getLogs` at
 *                           100 blocks and rate-limit at 25–50 rps.
 *  - `XORV_EXPLORER_URL`  — e.g. MonadVision instead of Monadscan.
 *  - `XORV_STABLECOIN`    — a different ERC-20 to price in (a test token, a
 *                           different issuer). `XORV_STABLECOIN_NAME` and
 *                           `XORV_STABLECOIN_VERSION` override its EIP-712
 *                           domain, which must match the token exactly or every
 *                           signed payment is rejected.
 *
 * A process talks to one network, so the overrides apply to whichever network
 * is asked for.
 */

import { defineChain, getAddress, isAddress, type Address, type Chain } from "viem";
import { monad, monadTestnet } from "viem/chains";
import { readEnv } from "./env.js";
import { USDC_DECIMALS } from "./money.js";

/** Monad testnet (chain id 10143), as a CAIP-2 network id. The default. */
export const MONAD_TESTNET = "eip155:10143" as const;

/** Monad mainnet (chain id 143), as a CAIP-2 network id. */
export const MONAD_MAINNET = "eip155:143" as const;

/** Where Xorv runs unless told otherwise. */
export const DEFAULT_NETWORK = MONAD_TESTNET;

export type MonadNetwork = typeof MONAD_TESTNET | typeof MONAD_MAINNET;

/** Every network this package has a config for. */
export const SUPPORTED_NETWORKS: readonly MonadNetwork[] = [MONAD_TESTNET, MONAD_MAINNET];

/**
 * Monad's block time since MIP-12 (July 2026). viem's chain definitions still
 * say 400 ms; `viemChain` corrects it so polling intervals are derived from
 * the real figure.
 */
export const MONAD_BLOCK_TIME_MS = 300;

/**
 * The x402 facilitator Monad's own docs point at. It supports the v2 `exact`
 * scheme on both 10143 and 143 with no signup, which makes it the `hosted`
 * shorthand. (x402.org's public facilitator has no Monad support at all.)
 */
export const MONAD_FACILITATOR_URL = "https://x402-facilitator.molandak.org";

export interface UsdcConfig {
  /** Checksummed ERC-20 address. */
  address: Address;
  /** EIP-712 domain name — "USDC" on Monad, *not* "USD Coin". */
  name: string;
  /** EIP-712 domain version. */
  version: string;
  decimals: number;
  symbol: string;
}

/** The canonical ERC-8004 v2.0.0 singletons (vanity `0x8004…` proxies). */
export interface Erc8004Registries {
  identity: Address;
  reputation: Address;
  validation: Address;
}

export interface NetworkConfig {
  caip2: MonadNetwork;
  chainId: number;
  /** Chain name, e.g. "Monad Testnet". */
  name: string;
  /** Short label for CLI and UI chrome. */
  label: "testnet" | "mainnet";
  rpcUrl: string;
  wsUrl: string;
  /** Explorer base URL with no trailing slash. */
  explorerUrl: string;
  usdc: UsdcConfig;
  erc8004: Erc8004Registries;
  /** The hosted x402 facilitator for this network. */
  facilitatorUrl: string;
  /** Where to get gas and test USDC; null where there is no faucet (mainnet). */
  faucets: { mon: string | null; usdc: string | null };
  /** Envio HyperSync endpoint, for the indexer. */
  hypersyncUrl: string;
}

/**
 * The built-in values. Every address here was checked on-chain (code present,
 * `name()`/`version()`/`getVersion()` as expected) on 2026-09-26. Note the
 * testnet was reset in December 2025: older tutorials' testnet USDC
 * (`0xf817…`) no longer has code.
 */
const BASE: Readonly<Record<MonadNetwork, NetworkConfig>> = {
  [MONAD_TESTNET]: {
    caip2: MONAD_TESTNET,
    chainId: 10143,
    name: "Monad Testnet",
    label: "testnet",
    rpcUrl: "https://testnet-rpc.monad.xyz",
    wsUrl: "wss://testnet-rpc.monad.xyz",
    explorerUrl: "https://testnet.monadscan.com",
    usdc: {
      address: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      name: "USDC",
      version: "2",
      decimals: USDC_DECIMALS,
      symbol: "USDC",
    },
    erc8004: {
      identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
    },
    facilitatorUrl: MONAD_FACILITATOR_URL,
    faucets: { mon: "https://faucet.monad.xyz", usdc: "https://faucet.circle.com" },
    hypersyncUrl: "https://monad-testnet.hypersync.xyz",
  },
  [MONAD_MAINNET]: {
    caip2: MONAD_MAINNET,
    chainId: 143,
    name: "Monad",
    label: "mainnet",
    rpcUrl: "https://rpc.monad.xyz",
    wsUrl: "wss://rpc.monad.xyz",
    explorerUrl: "https://monadscan.com",
    usdc: {
      address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      name: "USDC",
      version: "2",
      decimals: USDC_DECIMALS,
      symbol: "USDC",
    },
    erc8004: {
      identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      validation: "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58",
    },
    facilitatorUrl: MONAD_FACILITATOR_URL,
    faucets: { mon: null, usdc: null },
    hypersyncUrl: "https://monad.hypersync.xyz",
  },
};

/** True for the CAIP-2 ids this package has a config for. */
export function isSupportedNetwork(network: unknown): network is MonadNetwork {
  return network === MONAD_TESTNET || network === MONAD_MAINNET;
}

/**
 * The full config for a network, with environment overrides applied.
 *
 * Throws on anything but `eip155:10143` / `eip155:143`. A leftover
 * `hedera:testnet` in someone's `.env` must fail at boot with a message that
 * names the fix, not resolve to *some* chain and fail later as a mystery 402.
 */
export function networkConfig(network: string): NetworkConfig {
  if (!isSupportedNetwork(network)) {
    throw new Error(
      `unsupported network "${network}" — Xorv runs on Monad: use ${MONAD_TESTNET} (testnet) or ${MONAD_MAINNET} (mainnet)`,
    );
  }
  const base = BASE[network];
  const rpcUrl = readEnv("XORV_RPC_URL") ?? base.rpcUrl;
  const explorerUrl = (readEnv("XORV_EXPLORER_URL") ?? base.explorerUrl).replace(/\/+$/, "");
  return {
    ...base,
    rpcUrl,
    explorerUrl,
    usdc: stablecoinFor(base.usdc),
    erc8004: { ...base.erc8004 },
    faucets: { ...base.faucets },
  };
}

/**
 * Apply `XORV_STABLECOIN` (+ optional EIP-712 name/version) over the default.
 *
 * A malformed override throws instead of being ignored. Ignoring it would mean
 * an operator who *thinks* they are pricing in their test token is actually
 * asking buyers for real USDC — the one silent fallback worth refusing.
 */
function stablecoinFor(base: UsdcConfig): UsdcConfig {
  const override = readEnv("XORV_STABLECOIN");
  if (!override) return { ...base };
  if (!isAddress(override, { strict: false })) {
    throw new Error(`XORV_STABLECOIN must be a 0x ERC-20 address, got "${override}"`);
  }
  return {
    ...base,
    address: getAddress(override),
    name: readEnv("XORV_STABLECOIN_NAME") ?? base.name,
    version: readEnv("XORV_STABLECOIN_VERSION") ?? base.version,
  };
}

/**
 * A viem `Chain` for a network, carrying the (possibly overridden) RPC and
 * explorer and the corrected 300 ms block time.
 *
 * Built per call rather than exported as a constant so env overrides apply;
 * the definition is a few small objects, so there is nothing worth caching.
 */
export function viemChain(network: string): Chain {
  const cfg = networkConfig(network);
  const base = cfg.caip2 === MONAD_MAINNET ? monad : monadTestnet;
  return defineChain({
    ...base,
    blockTime: MONAD_BLOCK_TIME_MS,
    rpcUrls: { default: { http: [cfg.rpcUrl], webSocket: [cfg.wsUrl] } },
    blockExplorers: { default: { name: "Explorer", url: cfg.explorerUrl } },
  });
}

/**
 * Human label for a network, for CLI and UI chrome.
 *
 * Unlike `networkConfig` this never throws — it only decorates output — and
 * anything that is not exactly mainnet reads as "testnet", the safe
 * assumption for a label.
 */
export function networkLabel(network: string): "testnet" | "mainnet" {
  return network === MONAD_MAINNET ? "mainnet" : "testnet";
}

/** The stablecoin (USDC unless overridden) a network prices in. */
export function usdcAddress(network: string): Address {
  return networkConfig(network).usdc.address;
}

/**
 * The numeric chain id from a CAIP-2 `eip155:<id>` string.
 *
 * A pure parse: it accepts any EIP-155 chain (useful when checking what a
 * 402 is asking for), and throws on non-EVM namespaces.
 */
export function chainIdOf(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network.trim());
  if (!match) throw new Error(`not an EIP-155 network id: "${network}"`);
  return Number(match[1]);
}

/**
 * Whether an RPC URL is a local chain (a fork or a dev node) rather than a
 * Monad network. Anything timed against one is the local chain's timing,
 * never Monad's, and is labelled that way.
 */
export function isLocalRpc(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}
