"use client";

/**
 * Wallet state for the app.
 *
 * Replaces the Privy provider. The difference is not cosmetic: Privy gave an
 * EVM address and an OAuth session, neither of which can sign the native
 * Hedera transfer x402 settles. This holds a HashPack/Blade/Kabila session
 * whose signature the facilitator actually accepts, so the browser can pay.
 *
 * Deliberately small — an account id, a signer, and the two verbs. Anything
 * more (balances, history) already has a home on the broker or the mirror node
 * and does not belong in React state that has to stay correct across reloads.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { PROJECT_ID, connectWallet, restoreWallet, type WalletSession } from "@/lib/hashpack";

interface WalletState {
  /** Hedera account id once connected, e.g. `0.0.9848440`. */
  accountId: string | null;
  session: WalletSession | null;
  connecting: boolean;
  /** Null until the restore attempt settles, so the UI can avoid flashing. */
  ready: boolean;
  /** Set when a connect attempt failed, for display rather than a toast. */
  error: string | null;
  /** False when no WalletConnect project id is configured. */
  available: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<WalletSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore a session the relay already holds, so a reload doesn't force the
  // user back through the modal. Never opens one.
  useEffect(() => {
    let cancelled = false;
    restoreWallet()
      .then((restored) => {
        if (!cancelled && restored) setSession(restored);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      setSession(await connectWallet());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Closing the modal is a decision, not a failure — don't shout about it.
      if (!/reject|cancel|closed|User denied/i.test(message)) setError(message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await session?.disconnect();
    } finally {
      setSession(null);
    }
  }, [session]);

  const value = useMemo<WalletState>(
    () => ({
      accountId: session?.accountId ?? null,
      session,
      connecting,
      ready,
      error,
      available: PROJECT_ID.length > 0,
      connect,
      disconnect,
    }),
    [session, connecting, ready, error, connect, disconnect],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
