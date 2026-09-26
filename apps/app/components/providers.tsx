"use client";

import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { PRIVY_APP_ID, WalletProvider } from "@/components/wallet-provider";
import { PrivateKeysProvider } from "@/components/private-keys";
import { APP_CHAIN } from "@/lib/network";

/**
 * App-wide providers.
 *
 * Privy is the wallet here because on Monad paying for a job *is* signing
 * typed data: x402's `exact` scheme asks the buyer for an EIP-3009
 * authorization over USDC, and a rating is an EIP-712 message too. An embedded
 * wallet created at login signs both, so a visitor who arrives with nothing
 * but an email address can pay per job and rate the result — no extension, no
 * MON for gas (the facilitator and the rating relay pay it).
 *
 * The chain is pinned to the one configured network (`APP_CHAIN`), so the
 * embedded wallet is born on Monad and an external wallet is asked to switch
 * rather than sign for the wrong chain.
 *
 * Without `NEXT_PUBLIC_PRIVY_APP_ID` the app still works: the wallet provider
 * falls back to an injected browser wallet, and the composer offers the demo
 * account.
 */
export function Providers({ children }: { children: ReactNode }) {
  // The private-job keyring sits inside the wallet but is independent of it:
  // Privy pays, the passkey only derives encryption keys.
  const inner = <PrivateKeysProvider>{children}</PrivateKeysProvider>;
  if (!PRIVY_APP_ID) return <WalletProvider>{inner}</WalletProvider>;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      clientId={process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID?.trim() || undefined}
      config={{
        loginMethods: ["email", "google", "passkey", "wallet"],
        appearance: {
          theme: "dark",
          accentColor: "#FAFAFA",
          logo: "/brand/xorv-logo.svg",
          landingHeader: "Log in to Xorv",
          walletChainType: "ethereum-only",
        },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: APP_CHAIN,
        supportedChains: [APP_CHAIN],
      }}
    >
      <WalletProvider>{inner}</WalletProvider>
    </PrivyProvider>
  );
}
