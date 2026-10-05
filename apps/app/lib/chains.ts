import { defineChain, type Chain } from "viem";

/**
 * The Arbitrum chains Xorv settles on, as viem, Privy and the wallet see them.
 *
 * Gas is ETH on every one of them, and a buyer never spends any: paying for a
 * job is an EIP-712 signature that the broker's facilitator relays. Money is a
 * 6-decimal stablecoin — Paxos USDG by default, Circle USDC where deployed.
 *
 * The network and token table is duplicated from `@xorv/protocol` rather than
 * imported, because that package's entry point pulls in Node-only modules that
 * do not belong in a browser bundle. `test/wallet.test.ts` asserts the two
 * tables agree, so they cannot drift silently.
 */

export interface Stablecoin {
  symbol: string;
  address: `0x${string}`;
  decimals: 6;
  eip712: { name: string; version: string };
}

export const arbitrumSepolia = defineChain({
  id: 421614,
  name: "Arbitrum Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rollup.arbitrum.io/rpc"] } },
  blockExplorers: { default: { name: "Arbiscan", url: "https://sepolia.arbiscan.io" } },
  testnet: true,
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Robinhood Explorer", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  testnet: true,
});

export const arbitrumOne = defineChain({
  id: 42161,
  name: "Arbitrum One",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://arb1.arbitrum.io/rpc"] } },
  blockExplorers: { default: { name: "Arbiscan", url: "https://arbiscan.io" } },
});

export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

/**
 * A local Nitro dev node (chain 412346): Arbitrum's own node software, used to
 * run the whole product with real contracts when there are no testnet funds
 * (see scripts/local-stack.sh). It has no public explorer, so links go to the
 * app's own on-chain viewer (`/chain/...`), which reads the node directly.
 */
export const nitroDevnode = defineChain({
  id: 412346,
  name: "Nitro dev node",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_XORV_RPC_URL?.trim() || "http://127.0.0.1:8547"] } },
  testnet: true,
});

const USDG_DOMAIN = { name: "Global Dollar", version: "1" };
const USDC_DOMAIN = { name: "USD Coin", version: "2" };

/** Stablecoins per chain id, default (USDG) first — mirrors the protocol table. */
export const STABLECOINS_BY_CHAIN: Record<number, Stablecoin[]> = {
  [arbitrumSepolia.id]: [
    { symbol: "USDG", address: "0xFFC95faa3d63Cde504a05B567C600B78C0b41892", decimals: 6, eip712: USDG_DOMAIN },
    { symbol: "USDC", address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", decimals: 6, eip712: USDC_DOMAIN },
  ],
  [robinhoodTestnet.id]: [
    { symbol: "USDG", address: "0x7E955252E15c84f5768B83c41a71F9eba181802F", decimals: 6, eip712: USDG_DOMAIN },
  ],
  [arbitrumOne.id]: [
    { symbol: "USDG", address: "0x004B506865409877C9fA29bfb1ebA929984B9bbC", decimals: 6, eip712: USDG_DOMAIN },
    { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, eip712: USDC_DOMAIN },
  ],
  [robinhoodMainnet.id]: [
    { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, eip712: USDG_DOMAIN },
  ],
  // None of its own, like the protocol table; see envStablecoin below.
  [nitroDevnode.id]: [],
};

/**
 * `NEXT_PUBLIC_XORV_STABLECOIN` (+ _NAME/_VERSION/_SYMBOL): a token this
 * deployment accepts that the table doesn't know — the mirror of the broker's
 * XORV_STABLECOIN. On the local stack it is Circle's FiatTokenV2_2.
 */
function envStablecoin(): Stablecoin | null {
  const address = process.env.NEXT_PUBLIC_XORV_STABLECOIN?.trim();
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return {
    symbol: process.env.NEXT_PUBLIC_XORV_STABLECOIN_SYMBOL?.trim() || "TOKEN",
    address: address as `0x${string}`,
    decimals: 6,
    eip712: {
      name: process.env.NEXT_PUBLIC_XORV_STABLECOIN_NAME?.trim() || "USD Coin",
      version: process.env.NEXT_PUBLIC_XORV_STABLECOIN_VERSION?.trim() || "2",
    },
  };
}

const CHAINS_BY_CAIP2: Record<string, Chain> = {
  "eip155:421614": arbitrumSepolia,
  "eip155:46630": robinhoodTestnet,
  "eip155:42161": arbitrumOne,
  "eip155:4663": robinhoodMainnet,
  "eip155:412346": nitroDevnode,
};

/** The chain this deployment settles on: `NEXT_PUBLIC_XORV_NETWORK`, default Arbitrum Sepolia. */
export const XORV_CHAIN: Chain =
  CHAINS_BY_CAIP2[process.env.NEXT_PUBLIC_XORV_NETWORK?.trim() ?? ""] ?? arbitrumSepolia;

/** CAIP-2 for the chain above, which is how x402 names networks. */
export const XORV_NETWORK = `eip155:${XORV_CHAIN.id}`;

/**
 * Chains a wallet is offered: both testnets, plus mainnet when this deployment
 * is on it. The configured chain is always first.
 */
export const SUPPORTED_CHAINS: [Chain, ...Chain[]] = [
  XORV_CHAIN,
  ...[arbitrumSepolia, robinhoodTestnet].filter((c) => c.id !== XORV_CHAIN.id),
];

/** The stablecoins this deployment accepts, default first (an env-configured token leads). */
export const STABLECOINS: Stablecoin[] = (() => {
  const table = STABLECOINS_BY_CHAIN[XORV_CHAIN.id] ?? [];
  const extra = envStablecoin();
  if (!extra) return table;
  return [extra, ...table.filter((t) => t.address.toLowerCase() !== extra.address.toLowerCase())];
})();

/** The default stablecoin — USDG wherever it exists. */
export const DEFAULT_STABLECOIN: Stablecoin = STABLECOINS[0]!;

/** Symbol for a token address on this chain, or "stablecoin" for one we don't know. */
export function stablecoinSymbol(address: string | null | undefined): string {
  if (!address) return "stablecoin";
  const target = address.toLowerCase();
  return STABLECOINS.find((s) => s.address.toLowerCase() === target)?.symbol ?? "stablecoin";
}

/**
 * Where explorer links go: the chain's public explorer, or — for a chain with
 * none, like a local node — this app's own viewer at /chain, which reads
 * transactions and addresses straight from the RPC.
 */
const OWN_VIEWER = !XORV_CHAIN.blockExplorers?.default.url;

/** What to call the explorer in copy: "Arbiscan", "Robinhood Explorer", or "the chain viewer". */
export const EXPLORER_NAME = OWN_VIEWER ? "the chain viewer" : XORV_CHAIN.blockExplorers!.default.name;

function explorerBase(): string {
  return OWN_VIEWER ? "/chain" : XORV_CHAIN.blockExplorers!.default.url;
}

/** Explorer link for a transaction hash. */
export function explorerTx(hash: string): string {
  return `${explorerBase()}/tx/${hash}`;
}

/** Explorer link for an address or contract. */
export function explorerAddress(address: string): string {
  return `${explorerBase()}/address/${address}`;
}

/** Explorer link for a token. */
export function explorerToken(address: string): string {
  return `${explorerBase()}/token/${address}`;
}
