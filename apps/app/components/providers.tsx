"use client";

import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { PrivyWalletProvider, WalletProvider } from "@/components/wallet-provider";
import { DEFAULT_STABLECOIN, SUPPORTED_CHAINS, XORV_CHAIN } from "@/lib/chains";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();

/**
 * App-wide providers.
 *
 * With a Privy app id, sign-in is Privy: email creates an embedded wallet for
 * anyone without one, and existing wallets (MetaMask, Rabby, …) still connect
 * through the same modal. Privy takes arbitrary viem chains, so it is given the
 * Monad chains Xorv settles on, with the deployment's own chain as the default.
 *
 * Without `NEXT_PUBLIC_PRIVY_APP_ID` the app falls back to the injected wallet
 * — nothing about paying changes, only how the wallet is obtained — and a
 * visitor with no wallet at all can still pay from the demo account.
 */
export function Providers({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) return <WalletProvider>{children}</WalletProvider>;

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "wallet"],
        appearance: {
          theme: "dark",
          accentColor: "#ffffff",
          walletChainType: "ethereum-only",
          landingHeader: "Sign in to Xorv",
          loginMessage: `Pay per AI job in ${DEFAULT_STABLECOIN.symbol} on ${XORV_CHAIN.name}. No MON, no extension needed.`,
        },
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },
        defaultChain: XORV_CHAIN,
        supportedChains: SUPPORTED_CHAINS,
      }}
    >
      <PrivyWalletProvider>{children}</PrivyWalletProvider>
    </PrivyProvider>
  );
}
