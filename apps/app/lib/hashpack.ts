"use client";

/**
 * The HashPack connection.
 *
 * WalletConnect (HIP-820) rather than HashConnect: the same session works with
 * HashPack, Blade and Kabila, so this is "a Hedera wallet" rather than one
 * vendor. `DAppConnector` opens the modal, holds the session, and hands back a
 * `DAppSigner` whose `signTransaction` is exactly the hook `hedera-wallet.ts`
 * needs.
 *
 * Everything here is browser-only and lazily imported. `@hashgraph/sdk` plus
 * WalletConnect is a large dependency with `window` assumptions, and pulling it
 * into the server bundle breaks the build — so the module is loaded on first
 * connect, not at import time.
 */

import type { AccountId, Transaction } from "@hashgraph/sdk";

/** A WalletConnect project id, free from cloud.reown.com. */
export const PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

export const NETWORK =
  process.env.NEXT_PUBLIC_XORV_NETWORK === "hedera:mainnet" ? "mainnet" : "testnet";

export interface WalletSession {
  /** Hedera account id, e.g. `0.0.9848440` — not an EVM address. */
  accountId: string;
  /** Adds the account's signature to a frozen transaction. */
  signTransaction: <T extends Transaction>(transaction: T) => Promise<T>;
  disconnect: () => Promise<void>;
}

/**
 * The connector is a singleton.
 *
 * WalletConnect keeps a relay socket and a session store; constructing a
 * second one leaves the first connected and produces two sessions racing over
 * the same account.
 */
let connectorPromise: Promise<unknown> | null = null;

async function getConnector() {
  if (!PROJECT_ID) {
    throw new Error(
      "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set — get one free at cloud.reown.com",
    );
  }
  if (!connectorPromise) {
    connectorPromise = (async () => {
      const [{ DAppConnector, HederaChainId, HederaJsonRpcMethod }, { LedgerId }] = await Promise.all([
        import("@hashgraph/hedera-wallet-connect"),
        import("@hashgraph/sdk"),
      ]);

      const connector = new DAppConnector(
        {
          name: "Xorv",
          description: "Rent out idle AI subscription quota, paid per job in USDC over x402.",
          url: typeof window !== "undefined" ? window.location.origin : "https://xorv.vercel.app",
          icons: [
            typeof window !== "undefined" ? `${window.location.origin}/icon.svg` : "",
          ].filter(Boolean),
        },
        NETWORK === "mainnet" ? LedgerId.MAINNET : LedgerId.TESTNET,
        PROJECT_ID,
        // Only the methods this app uses. `signTransaction` collects the buyer's
        // signature WITHOUT executing — the facilitator submits, because it is
        // the one paying the fee. Requesting signAndExecute instead would have
        // the buyer pay gas, which is the whole thing x402 on Hedera avoids.
        [HederaJsonRpcMethod.SignTransaction, HederaJsonRpcMethod.GetNodeAddresses],
        [],
        [NETWORK === "mainnet" ? HederaChainId.Mainnet : HederaChainId.Testnet],
      );
      await connector.init({ logger: "error" });
      return connector;
    })().catch((err) => {
      // A failed init must not poison every later attempt.
      connectorPromise = null;
      throw err;
    });
  }
  return connectorPromise as Promise<{
    openModal: () => Promise<unknown>;
    signers: Array<{ getAccountId: () => AccountId; signTransaction: WalletSession["signTransaction"] }>;
    disconnectAll: () => Promise<void>;
  }>;
}

/** Open the wallet modal and wait for the user to approve a session. */
export async function connectWallet(): Promise<WalletSession> {
  const connector = await getConnector();
  await connector.openModal();
  return sessionFrom(connector);
}

/** An already-approved session, if the relay restored one. Never opens a modal. */
export async function restoreWallet(): Promise<WalletSession | null> {
  if (!PROJECT_ID) return null;
  try {
    const connector = await getConnector();
    return connector.signers.length > 0 ? sessionFrom(connector) : null;
  } catch {
    return null;
  }
}

function sessionFrom(connector: Awaited<ReturnType<typeof getConnector>>): WalletSession {
  const signer = connector.signers[0];
  if (!signer) throw new Error("wallet connected but exposed no account");
  return {
    accountId: signer.getAccountId().toString(),
    signTransaction: (transaction) => signer.signTransaction(transaction),
    disconnect: async () => {
      await connector.disconnectAll();
      connectorPromise = null;
    },
  };
}
