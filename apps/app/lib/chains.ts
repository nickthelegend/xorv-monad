import { defineChain, type Chain } from "viem";

/**
 * The Monad chains Xorv settles on, as viem, Privy and the wallet see them.
 *
 * Gas is MON, and a buyer never spends any: paying for a job is an EIP-712
 * signature that the broker's facilitator relays. Money is a 6-decimal
 * stablecoin — Agora AUSD by default, Circle USDC as the alternative.
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

const MON = { name: "Monad", symbol: "MON", decimals: 18 } as const;

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: MON,
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_XORV_RPC_URL?.trim() || "https://testnet-rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "Monadscan", url: "https://testnet.monadscan.com" } },
  testnet: true,
});

export const monadMainnet = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: MON,
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "Monadscan", url: "https://monadscan.com" } },
});

/**
 * A local Anvil node (chain 31337), used to run the whole product with real
 * contracts offline (see scripts/local-stack.sh). It has no public explorer, so
 * links go to the app's own on-chain viewer (`/chain/...`), which reads the node
 * directly.
 */
export const anvilDevnode = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: MON,
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_XORV_RPC_URL?.trim() || "http://127.0.0.1:8648"] } },
  testnet: true,
});

const AUSD_DOMAIN = { name: "Agora Dollar", version: "1" };

/** Stablecoins per chain id, default (AUSD) first — mirrors the protocol table. */
export const STABLECOINS_BY_CHAIN: Record<number, Stablecoin[]> = {
  [monadTestnet.id]: [
    { symbol: "AUSD", address: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC", decimals: 6, eip712: AUSD_DOMAIN },
    { symbol: "USDC", address: "0x534b2f3A21130d7a60830c2Df862319e593943A3", decimals: 6, eip712: { name: "USDC", version: "2" } },
  ],
  [monadMainnet.id]: [
    { symbol: "AUSD", address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", decimals: 6, eip712: AUSD_DOMAIN },
    { symbol: "USDC", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6, eip712: { name: "USD Coin", version: "2" } },
  ],
  // None of its own, like the protocol table; see envStablecoin below.
  [anvilDevnode.id]: [],
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
  "eip155:10143": monadTestnet,
  "eip155:143": monadMainnet,
  "eip155:31337": anvilDevnode,
};

/** The chain this deployment settles on: `NEXT_PUBLIC_XORV_NETWORK`, default Monad testnet. */
export const XORV_CHAIN: Chain =
  CHAINS_BY_CAIP2[process.env.NEXT_PUBLIC_XORV_NETWORK?.trim() ?? ""] ?? monadTestnet;

/** CAIP-2 for the chain above, which is how x402 names networks. */
export const XORV_NETWORK = `eip155:${XORV_CHAIN.id}`;

/**
 * Chains a wallet is offered: the configured chain first, then Monad testnet.
 */
export const SUPPORTED_CHAINS: [Chain, ...Chain[]] = [
  XORV_CHAIN,
  ...[monadTestnet].filter((c) => c.id !== XORV_CHAIN.id),
];

/** The stablecoins this deployment accepts, default first (an env-configured token leads). */
export const STABLECOINS: Stablecoin[] = (() => {
  const table = STABLECOINS_BY_CHAIN[XORV_CHAIN.id] ?? [];
  const extra = envStablecoin();
  if (!extra) return table;
  return [extra, ...table.filter((t) => t.address.toLowerCase() !== extra.address.toLowerCase())];
})();

/** The default stablecoin — AUSD. */
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

/** What to call the explorer in copy: "Monadscan", or "the chain viewer". */
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
