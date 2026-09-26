import { defineChain } from "viem";

/**
 * Hedera testnet, as an EVM chain.
 *
 * Hedera runs a JSON-RPC relay in front of the ledger, so wallets can treat it
 * like any EVM network. Two things about it routinely surprise people:
 *
 *  - **HBAR is 18 decimals here, not 8.** The ledger counts tinybars (8dp); the
 *    relay scales to weibars (18dp) so `value` fields behave like every other
 *    EVM chain. A balance read through a wallet and one read through the Hedera
 *    SDK will differ by 10^10 if you forget.
 *  - **Chain id 296 is testnet**, 295 is mainnet, 297 is previewnet.
 *
 * Defined locally rather than imported from viem/chains so the RPC and explorer
 * are pinned in one readable place next to that warning.
 */
export const hederaTestnet = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testnet.hashio.io/api"] },
  },
  blockExplorers: {
    default: { name: "HashScan", url: "https://hashscan.io/testnet" },
  },
  testnet: true,
});

export const hederaMainnet = defineChain({
  id: 295,
  name: "Hedera",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://mainnet.hashio.io/api"] },
  },
  blockExplorers: {
    default: { name: "HashScan", url: "https://hashscan.io/mainnet" },
  },
});

export const XORV_CHAIN =
  process.env.NEXT_PUBLIC_XORV_NETWORK === "hedera:mainnet" ? hederaMainnet : hederaTestnet;
