/**
 * Network-level constants shared by the CLI, the broker and both frontends.
 *
 * Anything here is protocol surface: change a value and every participant has
 * to agree on the change, so they live in one place rather than being retyped
 * per package.
 *
 * ## Monad in one paragraph
 *
 * Xorv settles on Monad: Monad testnet (chain 10143) by default, Monad mainnet
 * (143) when it goes live, and a local Anvil node for development. Gas is
 * **MON**, and only one party ever spends it — the operator's facilitator,
 * which relays signed EIP-3009 authorizations. Buyers sign typed data and
 * providers just receive a transfer, so neither needs to hold any MON at all.
 *
 * Jobs are priced in a **stablecoin**, and a network can offer more than one.
 * Agora's AUSD is the default, with Circle's USDC as the alternative. Both are
 * 6-decimal ERC-20s implementing EIP-3009, so **every amount in this codebase
 * is 6 decimals** whichever one a buyer pays with.
 */

/** CAIP-2 for Monad testnet — chain id 10143. The default network. */
export const MONAD_TESTNET_CAIP2 = "eip155:10143";

/** CAIP-2 for Monad mainnet — chain id 143. */
export const MONAD_MAINNET_CAIP2 = "eip155:143";

/**
 * CAIP-2 for a local Anvil node — chain id 31337.
 *
 * Not somewhere to take payments: it is where the whole system runs end to end
 * offline (scripts/local-stack.sh). It has no stablecoin of its own, so it is
 * paired with `XORV_STABLECOIN` pointing at a test token.
 */
export const ANVIL_CAIP2 = "eip155:31337";

/** EVM chain ids, for wallet `switchChain` and RPC checks. */
export const MONAD_TESTNET_CHAIN_ID = 10143;
export const MONAD_MAINNET_CHAIN_ID = 143;
export const ANVIL_CHAIN_ID = 31337;

/** The network every participant assumes when nothing says otherwise. */
export const DEFAULT_NETWORK = MONAD_TESTNET_CAIP2;

/**
 * Every stablecoin Xorv prices in has 6 decimals, which is also why micro-USD
 * and a token's smallest unit are the same integer (see money.ts).
 */
export const STABLECOIN_DECIMALS = 6;

/** The gas token on every supported network. Only the facilitator spends it. */
export const GAS_TOKEN_SYMBOL = "MON";

/** MON's decimals — used only to render the operator's gas balance. */
export const GAS_TOKEN_DECIMALS = 18;

/**
 * One stablecoin a network can settle in.
 *
 * `eip712` is the token's EIP-712 domain `(name, version)`. It is configured
 * here rather than read from the contract, because the domain name is not
 * always the token's `name()`: AUSD's `name()` is "AUSD" but it signs under
 * "Agora Dollar", and Circle's test USDC signs under "USDC". What every EIP-3009
 * token *does* expose is `DOMAIN_SEPARATOR()`, so these values are checked by
 * recomputing the separator and comparing (see `verifyStablecoinDomain` in
 * chain.ts).
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

/** Per-network facts. Anything not listed falls back to Monad testnet. */
export interface NetworkInfo {
  caip2: string;
  chainId: number;
  name: string;
  label: string;
  rpcUrl: string;
  explorer: string;
  /** What to call the explorer in UI copy: "Monadscan". */
  explorerName: string;
  /**
   * The stablecoins this network settles in, default first.
   *
   * AUSD leads. Order is meaningful: it is the order of the 402's `accepts`
   * array, and x402 clients pay the first option they support.
   */
  stablecoins: StablecoinInfo[];
  testnet: boolean;
}

const AUSD_DOMAIN = { name: "Agora Dollar", version: "1" } as const;

export const NETWORKS: Record<string, NetworkInfo> = {
  [MONAD_TESTNET_CAIP2]: {
    caip2: MONAD_TESTNET_CAIP2,
    chainId: MONAD_TESTNET_CHAIN_ID,
    name: "Monad Testnet",
    label: "monad-testnet",
    rpcUrl: "https://testnet-rpc.monad.xyz",
    explorer: "https://testnet.monadscan.com",
    explorerName: "Monadscan",
    stablecoins: [
      {
        // Agora AUSD. EIP-3009 (transfer/receiveWithAuthorization), ERC-2612,
        // ERC-1271. DOMAIN_SEPARATOR checked against ("Agora Dollar", "1") on
        // 2026-10-05; a test faucet lives at 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C.
        symbol: "AUSD",
        address: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
        decimals: 6,
        eip712: AUSD_DOMAIN,
        verified: true,
      },
      {
        // Circle's test USDC. Signs under ("USDC", "2"), checked 2026-10-05.
        symbol: "USDC",
        address: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
        decimals: 6,
        eip712: { name: "USDC", version: "2" },
        verified: true,
      },
    ],
    testnet: true,
  },
  [MONAD_MAINNET_CAIP2]: {
    caip2: MONAD_MAINNET_CAIP2,
    chainId: MONAD_MAINNET_CHAIN_ID,
    name: "Monad",
    label: "monad",
    rpcUrl: "https://rpc.monad.xyz",
    explorer: "https://monadscan.com",
    explorerName: "Monadscan",
    stablecoins: [
      {
        symbol: "AUSD",
        address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
        decimals: 6,
        eip712: AUSD_DOMAIN,
        verified: false,
      },
      {
        symbol: "USDC",
        address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
        decimals: 6,
        eip712: { name: "USD Coin", version: "2" },
        verified: false,
      },
    ],
    testnet: false,
  },
  [ANVIL_CAIP2]: {
    caip2: ANVIL_CAIP2,
    chainId: ANVIL_CHAIN_ID,
    name: "Anvil",
    label: "anvil",
    rpcUrl: "http://127.0.0.1:8648",
    // No public explorer: set XORV_EXPLORER_URL (the local stack uses the app's /chain viewer).
    explorer: "http://127.0.0.1:8648",
    explorerName: "chain viewer",
    // None of its own: set XORV_STABLECOIN (+ _NAME/_VERSION/_SYMBOL) to a test token.
    stablecoins: [],
    testnet: true,
  },
};

/** Facts for a CAIP-2 network, defaulting to Monad testnet for anything unknown. */
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
 * `XORV_STABLECOIN` picks the default: a symbol (`AUSD`, `USDC`) or an address.
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
  // A symbol this network doesn't have:
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
  // Monad testnet: filled in by scripts/deploy-testnet.sh once deployed.
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
 * only the stock `exact` scheme and pays providers directly.
 */
export function escrowAddress(network?: string): string | null {
  return deployed("XORV_ESCROW_ADDRESS", network, "escrow");
}

/** The XorvRegistry contract holding provider reputation, or null. */
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
  return Number.isFinite(parsed) ? parsed : MONAD_TESTNET_CHAIN_ID;
}

/** Block explorer base URL for a network — Monadscan. */
export function explorerBase(network: string): string {
  // A local node has no public explorer; XORV_EXPLORER_URL points links at one
  // that can read it (the app's own /chain viewer on the local stack).
  const override = process.env.XORV_EXPLORER_URL?.trim().replace(/\/+$/, "");
  return override || networkInfo(network).explorer;
}

/** What to call a network's explorer in copy: "Monadscan". */
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
