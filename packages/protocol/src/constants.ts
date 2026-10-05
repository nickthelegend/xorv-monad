/**
 * Network-level constants shared by the CLI, the broker and both frontends.
 *
 * Anything here is protocol surface: change a value and every participant has
 * to agree on the change, so they live in one place rather than being retyped
 * per package.
 *
 * ## Arbitrum in one paragraph
 *
 * Xorv settles on Arbitrum chains: Arbitrum Sepolia by default, Robinhood
 * Chain Testnet (an Arbitrum Orbit chain) as a second testnet, and Arbitrum One
 * for mainnet. Gas is **ETH** on all three, and only one party ever spends it —
 * the operator's facilitator, which relays signed EIP-3009 authorizations.
 * Buyers sign typed data and providers just receive a transfer, so neither
 * needs to hold any ETH at all.
 *
 * Jobs are priced in a **stablecoin**, and a network can offer more than one.
 * Paxos's USDG is the default wherever it is deployed, with Circle's USDC as
 * the alternative. Both are 6-decimal ERC-20s implementing EIP-3009, so **every
 * amount in this codebase is 6 decimals** whichever one a buyer pays with.
 */

/** CAIP-2 for Arbitrum Sepolia — chain id 421614. The default network. */
export const ARBITRUM_SEPOLIA_CAIP2 = "eip155:421614";

/** CAIP-2 for Robinhood Chain Testnet — chain id 46630. */
export const ROBINHOOD_TESTNET_CAIP2 = "eip155:46630";

/** CAIP-2 for Arbitrum One — chain id 42161. */
export const ARBITRUM_ONE_CAIP2 = "eip155:42161";

/** CAIP-2 for Robinhood Chain mainnet — chain id 4663. */
export const ROBINHOOD_MAINNET_CAIP2 = "eip155:4663";

/**
 * CAIP-2 for a local Nitro dev node — chain id 412346.
 *
 * Not somewhere to take payments: it is the one place the whole system runs
 * end to end with nothing borrowed — the Stylus registry needs real Arbitrum
 * node software, which anvil is not. It has no stablecoin of its own, so it
 * is paired with `XORV_STABLECOIN` pointing at a test token.
 */
export const NITRO_DEVNODE_CAIP2 = "eip155:412346";

/** EVM chain ids, for wallet `switchChain` and RPC checks. */
export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const ARBITRUM_ONE_CHAIN_ID = 42161;
export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
export const NITRO_DEVNODE_CHAIN_ID = 412346;

/** The network every participant assumes when nothing says otherwise. */
export const DEFAULT_NETWORK = ARBITRUM_SEPOLIA_CAIP2;

/**
 * Every stablecoin Xorv prices in has 6 decimals, which is also why micro-USD
 * and a token's smallest unit are the same integer (see money.ts).
 */
export const STABLECOIN_DECIMALS = 6;

/** The gas token on every supported network. Only the facilitator spends it. */
export const GAS_TOKEN_SYMBOL = "ETH";

/** ETH's decimals — used only to render the operator's gas balance. */
export const GAS_TOKEN_DECIMALS = 18;

/**
 * One stablecoin a network can settle in.
 *
 * `eip712` is the token's EIP-712 domain `(name, version)`. It is configured
 * here rather than read from the contract, because it can't always be read:
 * USDG exposes `name()` but has no `version()` (the call reverts) and no
 * EIP-5267 `eip712Domain()`. What every EIP-3009 token *does* expose is
 * `DOMAIN_SEPARATOR()`, so these values are checked by recomputing the
 * separator and comparing (see `verifyStablecoinDomain` in chain.ts).
 *
 * x402's EVM scheme fills the domain in automatically only for tokens in its
 * own registry, so every 402 must carry these two strings as `extra` — get the
 * version wrong and the buyer's signature verifies against nothing.
 */
export interface StablecoinInfo {
  symbol: string;
  address: string;
  decimals: 6;
  eip712: { name: string; version: string };
  /**
   * False when the domain has not been checked against the live contract's
   * `DOMAIN_SEPARATOR()`. Surfaced by `xorv doctor` and the broker's boot log.
   */
  verified: boolean;
}

/** Per-network facts. Anything not listed falls back to Arbitrum Sepolia. */
export interface NetworkInfo {
  caip2: string;
  chainId: number;
  name: string;
  label: string;
  rpcUrl: string;
  explorer: string;
  /** What to call the explorer in UI copy: "Arbiscan", "Robinhood Explorer". */
  explorerName: string;
  /**
   * The stablecoins this network settles in, default first.
   *
   * USDG leads wherever it exists. Order is meaningful: it is the order of the
   * 402's `accepts` array, and x402 clients pay the first option they support.
   */
  stablecoins: StablecoinInfo[];
  testnet: boolean;
}

const USDG_DOMAIN = { name: "Global Dollar", version: "1" } as const;
const USDC_DOMAIN = { name: "USD Coin", version: "2" } as const;

export const NETWORKS: Record<string, NetworkInfo> = {
  [ARBITRUM_SEPOLIA_CAIP2]: {
    caip2: ARBITRUM_SEPOLIA_CAIP2,
    chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
    name: "Arbitrum Sepolia",
    label: "arbitrum-sepolia",
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    explorer: "https://sepolia.arbiscan.io",
    explorerName: "Arbiscan",
    stablecoins: [
      {
        // Paxos Global Dollar. EIP-3009 (transferWithAuthorization and
        // receiveWithAuthorization, v/r/s and bytes-signature variants) is
        // served by facets. DOMAIN_SEPARATOR checked against these values.
        symbol: "USDG",
        address: "0xFFC95faa3d63Cde504a05B567C600B78C0b41892",
        decimals: 6,
        eip712: USDG_DOMAIN,
        verified: true,
      },
      {
        // Circle's FiatTokenV2 deployment.
        symbol: "USDC",
        address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
        decimals: 6,
        eip712: USDC_DOMAIN,
        verified: true,
      },
    ],
    testnet: true,
  },
  [ROBINHOOD_TESTNET_CAIP2]: {
    caip2: ROBINHOOD_TESTNET_CAIP2,
    chainId: ROBINHOOD_TESTNET_CHAIN_ID,
    name: "Robinhood Chain Testnet",
    label: "robinhood-testnet",
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    explorerName: "Robinhood Explorer",
    stablecoins: [
      {
        symbol: "USDG",
        address: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
        decimals: 6,
        eip712: USDG_DOMAIN,
        verified: true,
      },
    ],
    testnet: true,
  },
  [ARBITRUM_ONE_CAIP2]: {
    caip2: ARBITRUM_ONE_CAIP2,
    chainId: ARBITRUM_ONE_CHAIN_ID,
    name: "Arbitrum One",
    label: "arbitrum",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    explorer: "https://arbiscan.io",
    explorerName: "Arbiscan",
    stablecoins: [
      {
        // From Paxos' mainnet address list. DOMAIN_SEPARATOR checked against
        // ("Global Dollar", "1") on 2026-09-30, and receiveWithAuthorization
        // (bytes signature) is served by a facet, as on testnet.
        symbol: "USDG",
        address: "0x004B506865409877C9fA29bfb1ebA929984B9bbC",
        decimals: 6,
        eip712: USDG_DOMAIN,
        verified: true,
      },
      {
        symbol: "USDC",
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        decimals: 6,
        eip712: USDC_DOMAIN,
        verified: true,
      },
    ],
    testnet: false,
  },
  [ROBINHOOD_MAINNET_CAIP2]: {
    caip2: ROBINHOOD_MAINNET_CAIP2,
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    name: "Robinhood Chain",
    label: "robinhood",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    explorerName: "Blockscout",
    stablecoins: [
      {
        // Paxos' mainnet list; domain and the receiveWithAuthorization facet
        // checked on chain 2026-09-30.
        symbol: "USDG",
        address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        decimals: 6,
        eip712: USDG_DOMAIN,
        verified: true,
      },
    ],
    testnet: false,
  },
  [NITRO_DEVNODE_CAIP2]: {
    caip2: NITRO_DEVNODE_CAIP2,
    chainId: NITRO_DEVNODE_CHAIN_ID,
    name: "Nitro dev node",
    label: "nitro-dev",
    rpcUrl: "http://127.0.0.1:8547",
    // No public explorer: set XORV_EXPLORER_URL (the local stack uses the app's /chain viewer).
    explorer: "http://127.0.0.1:8547",
    explorerName: "chain viewer",
    // None of its own: set XORV_STABLECOIN (+ _NAME/_VERSION/_SYMBOL) to a test token.
    stablecoins: [],
    testnet: true,
  },
};

/** Facts for a CAIP-2 network, defaulting to Arbitrum Sepolia for anything unknown. */
export function networkInfo(network: string): NetworkInfo {
  return NETWORKS[network] ?? NETWORKS[DEFAULT_NETWORK]!;
}

/** Public RPC per CAIP-2 network, or `XORV_RPC_URL` when set. */
export function rpcUrl(network: string): string {
  const override = process.env.XORV_RPC_URL?.trim();
  if (override) return override;
  return networkInfo(network).rpcUrl;
}

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

/** Wire version for audit-log envelopes, so consumers can evolve the shape. */
export const LOG_SCHEMA_VERSION = 1;

/**
 * The `kind` discriminator on a `XorvLog` entry.
 *
 * Mirrors the contract's `KIND_` constants exactly. They are indexed on the
 * event, so a reader pulls one stream — say, every receipt — without scanning
 * the rest, which is what the three separate Hedera topics used to give us.
 */
export const LOG_KIND = {
  registration: 1,
  heartbeat: 2,
  receipt: 3,
} as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The stablecoins a network settles in, default first.
 *
 * `XORV_STABLECOIN` picks the default: a symbol (`USDG`, `USDC`) or an address.
 * A known token is moved to the front; the others are still offered, so a
 * buyer holding only the other coin can still pay. An address the table does
 * not know becomes a custom entry at the front, with its EIP-712 domain from
 * `XORV_STABLECOIN_NAME` / `XORV_STABLECOIN_VERSION` (there is no reliable way
 * to read it — see `StablecoinInfo.eip712`) and its symbol from
 * `XORV_STABLECOIN_SYMBOL`. That is what lets the settlement path be exercised
 * against a test token without a faucet.
 *
 * Read per call rather than captured at module load, so a test can set it
 * without re-importing the module.
 */
export function stablecoins(network: string): StablecoinInfo[] {
  const configured = networkInfo(network).stablecoins;
  const override = process.env.XORV_STABLECOIN?.trim();
  if (!override) return [...configured];

  const match = configured.find((s) =>
    ADDRESS_RE.test(override)
      ? s.address.toLowerCase() === override.toLowerCase()
      : s.symbol.toLowerCase() === override.toLowerCase(),
  );
  if (match) return [match, ...configured.filter((s) => s !== match)];

  if (ADDRESS_RE.test(override)) {
    const custom: StablecoinInfo = {
      symbol: process.env.XORV_STABLECOIN_SYMBOL?.trim() || "TOKEN",
      address: override,
      decimals: 6,
      eip712: {
        name: process.env.XORV_STABLECOIN_NAME?.trim() || "USD Coin",
        version: process.env.XORV_STABLECOIN_VERSION?.trim() || "2",
      },
      verified: false,
    };
    return [custom, ...configured];
  }
  // A symbol this network doesn't have (e.g. USDC on Robinhood Chain Testnet):
  // fall back to the table rather than pricing in nothing.
  return [...configured];
}

/** The default stablecoin for a network — the first entry of `stablecoins()`. */
export function primaryStablecoin(network: string): StablecoinInfo {
  const list = stablecoins(network);
  if (list.length === 0) throw new Error(`no stablecoin configured for ${network}`);
  return list[0]!;
}

/** Address of the default stablecoin. */
export function stablecoinAddress(network: string): string {
  return primaryStablecoin(network).address;
}

/** The configured stablecoin at `address`, case-insensitively. */
export function stablecoinByAddress(network: string, address: string): StablecoinInfo | undefined {
  const target = address.trim().toLowerCase();
  return stablecoins(network).find((s) => s.address.toLowerCase() === target);
}

/** The configured stablecoin with `symbol`, case-insensitively. */
export function stablecoinBySymbol(network: string, symbol: string): StablecoinInfo | undefined {
  const target = symbol.trim().toLowerCase();
  return stablecoins(network).find((s) => s.symbol.toLowerCase() === target);
}

/** Symbol for a token address, or "stablecoin" for one the table doesn't know. */
export function stablecoinSymbol(network: string, address: string): string {
  return stablecoinByAddress(network, address)?.symbol ?? "stablecoin";
}

/** The deployed `XorvLog` address, or null when the audit trail is unconfigured. */
export function logAddress(): string | null {
  const raw = process.env.XORV_LOG_ADDRESS?.trim();
  return raw && ADDRESS_RE.test(raw) ? raw : null;
}

/**
 * Deployed Xorv contracts per network. Filled in as deployments happen; an env
 * var always wins, so a fresh deployment can be pointed at without a release.
 */
export interface XorvDeployment {
  escrow?: string;
  registry?: string;
  log?: string;
  /** First block worth scanning for this deployment's events. */
  fromBlock?: number;
}

/** Live deployments, from deployments/<network>.json. Env vars override these. */
export const DEPLOYMENTS: Record<string, XorvDeployment> = {
  // Arbitrum Sepolia, deployed 2026-10-02 by scripts/deploy-testnet.sh.
  "eip155:421614": {
    escrow: "0x383F5153db8Bb18c7c25157Fb3493645A465EeF3",
    registry: "0x38b65014fee7c87d5e13afbc555388f612a7a2a1",
    log: "0x135738387e4bEC5573914F1A2A812728b9b268C8",
    fromBlock: 315016130,
  },
};

function deployed(
  envVar: string,
  network: string | undefined,
  key: "escrow" | "registry",
): string | null {
  const raw = process.env[envVar]?.trim();
  if (raw && ADDRESS_RE.test(raw)) return raw;
  const fromTable = network ? DEPLOYMENTS[network]?.[key] : undefined;
  return fromTable && ADDRESS_RE.test(fromTable) ? fromTable : null;
}

/**
 * The XorvEscrow contract jobs are paid into, or null when escrow is off.
 *
 * Null is a supported configuration, not an error: the broker then offers
 * only the stock `exact` scheme and pays providers directly, as the Hedera and
 * Arc versions did.
 */
export function escrowAddress(network?: string): string | null {
  return deployed("XORV_ESCROW_ADDRESS", network, "escrow");
}

/** The XorvRegistry (Stylus) contract holding provider reputation, or null. */
export function registryAddress(network?: string): string | null {
  return deployed("XORV_REGISTRY_ADDRESS", network, "registry");
}

/**
 * How long after a quote the escrowed payment becomes refundable by anyone.
 *
 * Long enough to cover the job timeout, one reassignment's worth of work and
 * slack for the release transaction; short enough that a buyer whose job was
 * silently dropped gets their money back the same hour. Frozen per quote.
 */
export const ESCROW_DEADLINE_SECONDS = 30 * 60;

/** Human label for a network, for CLI and UI chrome. */
export function networkLabel(network: string): string {
  return networkInfo(network).label;
}

/** EVM chain id for a CAIP-2 network. */
export function chainIdFor(network: string): number {
  const parsed = Number(network.split(":")[1]);
  return Number.isFinite(parsed) ? parsed : ARBITRUM_SEPOLIA_CHAIN_ID;
}

/** Block explorer base URL for a network — Arbiscan, or Robinhood's explorer. */
export function explorerBase(network: string): string {
  // A local node has no public explorer; XORV_EXPLORER_URL points links at one
  // that can read it (the app's own /chain viewer on the local stack).
  const override = process.env.XORV_EXPLORER_URL?.trim().replace(/\/+$/, "");
  return override || networkInfo(network).explorer;
}

/** What to call a network's explorer in copy: "Arbiscan", "Robinhood Explorer". */
export function explorerName(network: string): string {
  return networkInfo(network).explorerName;
}

/** Explorer link for a transaction hash. */
export function explorerTx(network: string, txHash: string): string {
  return `${explorerBase(network)}/tx/${txHash}`;
}

/** Explorer link for an address — an account or a contract. */
export function explorerAddress(network: string, address: string): string {
  return `${explorerBase(network)}/address/${address}`;
}

/** Explorer link for a token. */
export function explorerToken(network: string, address: string): string {
  return `${explorerBase(network)}/token/${address}`;
}
