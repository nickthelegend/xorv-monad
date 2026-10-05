export const REPO_URL = "https://github.com/nickthelegend/xorv-arbitrum";
/** Public broker the live-stats strip reads. Optional: the page works without it. */
export const BROKER_URL = (
  process.env.NEXT_PUBLIC_XORV_BROKER_URL ?? "http://localhost:8402"
).replace(/\/+$/, "");
export const APP_URL = process.env.NEXT_PUBLIC_XORV_APP_URL ?? "http://localhost:3002";
export const LOOM_URL = "https://loompad.tech";
export const X402_URL = "https://x402.org";
export const ARBITRUM_URL = "https://arbitrum.io";
/** Robinhood Chain Testnet (an Arbitrum Orbit chain), via its explorer. */
export const ROBINHOOD_CHAIN_URL = "https://explorer.testnet.chain.robinhood.com";
export const USDG_URL = "https://paxos.com/usdg/";
export const PRIVY_URL = "https://www.privy.io";
/** The CLI isn't on npm yet; this is the build-from-source guide. */
export const INSTALL_URL = `${REPO_URL}#quickstart`;

/**
 * The live testnet ids this site links to.
 *
 * Every number quoted on the page resolves to something a reader can open on
 * Arbiscan. A marketing site for a payments network that can't show you the
 * payments is just a claim.
 */
/**
 * Arbitrum Sepolia by default. A deployment on the local Nitro stack
 * (NEXT_PUBLIC_XORV_NETWORK=eip155:412346) has no public explorer, so its
 * links go to the app's own /chain viewer, and its token is the one in env.
 */
const LOCAL = process.env.NEXT_PUBLIC_XORV_NETWORK?.trim() === "eip155:412346";
const EXPLORER = LOCAL ? `${APP_URL.replace(/\/+$/, "")}/chain` : "https://sepolia.arbiscan.io";
const USDG = "0xFFC95faa3d63Cde504a05B567C600B78C0b41892";
const USDC = LOCAL
  ? process.env.NEXT_PUBLIC_XORV_STABLECOIN?.trim() || "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"
  : "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
/**
 * The audit log on Arbitrum Sepolia. Set at build time once the contract is
 * deployed; until then the page links the explorer rather than a stale address.
 */
const LOG = process.env.NEXT_PUBLIC_XORV_LOG_ADDRESS?.trim() || null;
/** XorvEscrow and XorvRegistry (Stylus), once deployed; set at build time like the log. */
const ESCROW = process.env.NEXT_PUBLIC_XORV_ESCROW_ADDRESS?.trim() || null;
const REGISTRY = process.env.NEXT_PUBLIC_XORV_REGISTRY_ADDRESS?.trim() || null;

export const CHAIN = {
  network: LOCAL ? "eip155:412346" : "eip155:421614",
  /** The stablecoins this deployment settles in, default first. */
  tokens: (LOCAL
    ? [{ label: `${process.env.NEXT_PUBLIC_XORV_STABLECOIN_SYMBOL?.trim() || "USDC"} (default)`, address: USDC }]
    : [
        { label: "USDG (default)", address: USDG },
        { label: "USDC", address: USDC },
      ]
  ).map((t) => ({ ...t, url: `${EXPLORER}/token/${t.address}` })),
  chainId: LOCAL ? 412346 : 421614,
  name: LOCAL ? "Nitro dev node" : "Arbitrum Sepolia",
  explorerName: LOCAL ? "chain viewer" : "Arbiscan",
  explorerUrl: EXPLORER,
  /** Paxos Global Dollar — the default settlement token. */
  usdg: USDG,
  usdgUrl: `${EXPLORER}/token/${USDG}`,
  /** Circle USDC — accepted as the alternative. */
  usdc: USDC,
  usdcUrl: `${EXPLORER}/token/${USDC}`,
  /**
   * The audit log.
   *
   * Three Hedera Consensus Service topics collapsed into one contract with
   * three indexed event streams — event logs give the same ordered,
   * append-only, publicly-readable guarantee.
   */
  log: LOG,
  logUrl: LOG ? `${EXPLORER}/address/${LOG}` : EXPLORER,
  escrow: ESCROW,
  escrowUrl: ESCROW ? `${EXPLORER}/address/${ESCROW}` : null,
  registry: REGISTRY,
  registryUrl: REGISTRY ? `${EXPLORER}/address/${REGISTRY}` : null,
  txUrl: (hash: string) => `${EXPLORER}/tx/${hash}`,
  addressUrl: (address: string) => `${EXPLORER}/address/${address}`,
};

/** The token a job is paid in by default, as the hero names it. */
const LOCAL_SYMBOL = process.env.NEXT_PUBLIC_XORV_STABLECOIN_SYMBOL?.trim() || "USDC";
export const PRIMARY_TOKEN = LOCAL
  ? { name: `Circle ${LOCAL_SYMBOL}`, symbol: LOCAL_SYMBOL, url: CHAIN.tokens[0]!.url }
  : { name: "Paxos USDG", symbol: "USDG", url: USDG_URL };

/** Arbitrum Stylus, which runs the Rust reputation registry. */
export const STYLUS_URL = "https://docs.arbitrum.io/stylus/gentle-introduction";

export const NAV = [
  { label: "How it works", href: "#how" },
  { label: "Contracts", href: "#contracts" },
  { label: "The network", href: "#bento" },
  { label: "Earn", href: "#earn" },
  { label: "Adapters", href: "#adapters" },
  { label: "Receipts", href: "#ledger" },
  { label: "Security", href: "#security" },
  { label: "FAQ", href: "#faq" },
];
