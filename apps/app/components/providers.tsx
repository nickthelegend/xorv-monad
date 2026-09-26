"use client";

import type { ReactNode } from "react";
import { WalletProvider } from "@/components/wallet-provider";

/**
 * App-wide providers.
 *
 * Privy lived here until it turned out it could not sign what Hedera's x402
 * scheme settles — an EVM signature over an RLP transaction, where the
 * facilitator verifies a native protobuf transfer. HashPack signs the real
 * thing, so the wallet that connects is the wallet that pays, and the
 * server-side signer is no longer load-bearing.
 */
export function Providers({ children }: { children: ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}
