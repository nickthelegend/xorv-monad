/**
 * Which Monad network this deployment talks to, resolved once.
 *
 * Everything chain-shaped — RPC, explorer, USDC address and its EIP-712
 * domain, ERC-8004 registries, faucets — comes from `@xorv/protocol`'s one
 * table, so the address the header reads a balance from is the same one the
 * broker's 402 asks the buyer to sign for. This module only decides *which*
 * row of that table the app is on, and builds the viem chain Privy and the
 * injected-wallet path both hand to wallets.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, so they must be read with
 * literal `process.env.NEXT_PUBLIC_…` expressions — a computed lookup would
 * come back `undefined` in the browser.
 */

import { defineChain, type Chain } from "viem";
import { viewerPath } from "@/lib/chain-viewer";
import {
  DEFAULT_NETWORK,
  isLocalRpc,
  isSupportedNetwork,
  networkConfig,
  viemChain,
  type MonadNetwork,
  type NetworkConfig,
} from "@xorv/protocol/web";

/**
 * Resolve the configured network, refusing anything that is not Monad.
 *
 * A leftover `hedera:testnet` in someone's `.env.local` must fail the build
 * with a message that names the fix, not render a page that quietly points at
 * some other chain and then fails every payment as a mystery.
 */
export function resolveNetwork(raw: string | undefined): MonadNetwork {
  const value = raw?.trim();
  if (!value) return DEFAULT_NETWORK;
  if (isSupportedNetwork(value)) return value;
  throw new Error(
    `NEXT_PUBLIC_XORV_NETWORK="${value}" is not a Monad network — use eip155:10143 (testnet) or eip155:143 (mainnet)`,
  );
}

/** The CAIP-2 network id, e.g. `eip155:10143`. */
export const NETWORK: MonadNetwork = resolveNetwork(process.env.NEXT_PUBLIC_XORV_NETWORK);

/** The full chain config for {@link NETWORK}. */
export const CHAIN_CONFIG: NetworkConfig = networkConfig(NETWORK);

export const IS_TESTNET = CHAIN_CONFIG.label === "testnet";

/**
 * Optional browser RPC. The public Monad endpoints rate-limit at 25–50 rps per
 * IP, which a demo booth full of tabs polling balances can hit; a private RPC
 * here keeps the header honest without touching the broker's.
 */
export const PUBLIC_RPC_URL = process.env.NEXT_PUBLIC_XORV_RPC_URL?.trim() || CHAIN_CONFIG.rpcUrl;

/**
 * The viem chain wallets are asked to switch to and sign on: protocol's
 * definition (id, native MON currency, explorer, 300 ms block time) with the
 * browser RPC applied.
 */
export const APP_CHAIN: Chain = defineChain({
  ...viemChain(NETWORK),
  rpcUrls: { default: { http: [PUBLIC_RPC_URL], webSocket: [CHAIN_CONFIG.wsUrl] } },
});

/** "Monad testnet" / "Monad mainnet" — for chrome, never for logic. */
export const NETWORK_LABEL = `Monad ${CHAIN_CONFIG.label}`;

/** Whether this app's contracts and payments run on a local chain; its timings are never Monad's. */
export const IS_LOCAL_CHAIN = isLocalRpc(PUBLIC_RPC_URL);

/**
 * An explorer link, rewritten for where it can actually be seen: on a local
 * fork no public explorer has the fork's transactions, so they open in the
 * app's own viewer (/chain/…), and anything it has no page for (null) shows as
 * text. Links to the real network (the live pipeline) pass `live`.
 */
export function explorerHref(href: string, live = false): string | null {
  if (live || !IS_LOCAL_CHAIN || !href.startsWith(CHAIN_CONFIG.explorerUrl)) return href;
  // On a fork the app's own viewer (/chain/…) reads the fork; anything it has no page for is text.
  return viewerPath(CHAIN_CONFIG.explorerUrl, href);
}

/**
 * Monad's own WebSocket, for the live block pipeline (`monadNewHeads`). Always
 * the real network, even when the app's contracts run on a local fork: the
 * pipeline is Monad's heartbeat, read-only, and labelled as such.
 */
export const MONAD_WS_URL = process.env.NEXT_PUBLIC_XORV_MONAD_WS_URL?.trim() || CHAIN_CONFIG.wsUrl;

/** XorvLedger as deployed on Monad testnet (packages/contracts/deployments/monadTestnet.json). */
export const LIVE_LEDGER: Record<string, `0x${string}`> = {
  "eip155:10143": "0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD",
};
