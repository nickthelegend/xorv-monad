"use client";

/**
 * Wallet state for the app.
 *
 * Deliberately small — an address, a signer, and the verbs. Anything more
 * (balances, history) already has a home on the broker or an RPC and does not
 * belong in React state that has to stay correct across reloads.
 *
 * Two sources feed the same shape:
 *
 *  - **Privy**, when `NEXT_PUBLIC_PRIVY_APP_ID` is set. A visitor signs in with
 *    an email and gets an embedded wallet on Monad without installing anything —
 *    or connects MetaMask/Rabby through the same modal. Either way the wallet
 *    hands back an EIP-1193 provider, and the payment code below it is the
 *    unchanged EIP-712 path.
 *  - **The injected wallet** (`window.ethereum`) otherwise — the original path,
 *    kept so a deployment without a Privy app still works.
 *
 * Privy was removed from the Hedera version of this app because Hedera's x402
 * scheme settles a native protobuf transfer an EVM wallet cannot sign. On
 * Monad the payment is an EIP-3009 authorization — typed data — so Privy's embedded
 * wallet can pay directly, and it came back.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { XORV_CHAIN } from "@/lib/chains";
import {
  connectWallet,
  restoreWallet,
  refundEscrow as refundEscrowVia,
  sendStablecoin as sendStablecoinVia,
  sessionForProvider,
  switchProviderToXorvChain,
  switchToXorvChain,
  walletAvailable,
  watchWallet,
  type Eip1193Provider,
  type WalletSession,
} from "@/lib/wallet";

export interface WalletState {
  /** Which integration is live. */
  kind: "privy" | "injected";
  /** EVM address once connected, e.g. `0x0329…9F36`. */
  address: string | null;
  session: WalletSession | null;
  connecting: boolean;
  /** False until the restore attempt settles, so the UI can avoid flashing. */
  ready: boolean;
  /** Set when a connect attempt failed, for display rather than a toast. */
  error: string | null;
  /** False when there is no way to get a wallet at all. */
  available: boolean;
  /** True when the wallet is connected but pointed at some other network. */
  wrongChain: boolean;
  /** True for a Privy embedded wallet — created for the user, no extension. */
  embedded: boolean;
  /** The login identity Privy knows, when it is an email. */
  email: string | null;
  connect: () => Promise<void>;
  switchChain: () => Promise<void>;
  disconnect: () => Promise<void>;
  /**
   * Send a stablecoin (the default one — AUSD — unless `token` is given) from
   * the connected wallet. A real transfer: the sender pays MON gas. Resolves
   * to the tx hash.
   */
  sendStablecoin: (to: string, amount: string, token?: `0x${string}`) => Promise<`0x${string}`>;
  /** Refund an escrowed job to its buyer once its deadline has passed. Anyone may. */
  refundEscrow: (escrow: string, jobId: `0x${string}`) => Promise<`0x${string}`>;
}

const Ctx = createContext<WalletState | null>(null);

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Closing a modal is a decision, not a failure — don't shout about it. */
function isDismissal(text: string): boolean {
  return /reject|cancel|closed|User denied|4001|exited/i.test(text);
}

// ---------------------------------------------------------------------------
// Privy
// ---------------------------------------------------------------------------

export function PrivyWalletProvider({ children }: { children: ReactNode }) {
  const { ready: privyReady, authenticated, user, login, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const [connectedSession, setSession] = useState<WalletSession | null>(null);
  const [connectedProvider, setProvider] = useState<Eip1193Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Prefer the embedded wallet when the user has one: it is the wallet Privy
  // made for them, and the one that needs no extension to sign.
  const active = authenticated
    ? (wallets.find((w) => w.walletClientType === "privy") ?? wallets[0])
    : undefined;
  const activeAddress = active?.address ?? null;
  const activeChain = active?.chainId ?? null;
  // With no active wallet there is no session, whatever the last one was.
  const session = active ? connectedSession : null;
  const provider = active ? connectedProvider : null;

  useEffect(() => {
    let cancelled = false;
    if (!active) return;
    void (async () => {
      try {
        const p = (await active.getEthereumProvider()) as unknown as Eip1193Provider;
        const chainId = Number((await p.request({ method: "eth_chainId" })) as string);
        if (cancelled) return;
        setProvider(p);
        setSession(sessionForProvider(p, active.address, chainId));
      } catch (err) {
        if (!cancelled) setError(message(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `active` is a fresh object on every render; its address and chain are
    // what actually decide whether the session must be rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAddress, activeChain]);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      login();
    } catch (err) {
      const text = message(err);
      if (!isDismissal(text)) setError(text);
    } finally {
      setConnecting(false);
    }
  }, [login]);

  const switchChain = useCallback(async () => {
    setError(null);
    try {
      if (active) await active.switchChain(XORV_CHAIN.id);
      else if (provider) await switchProviderToXorvChain(provider);
    } catch (err) {
      setError(message(err));
    }
  }, [active, provider]);

  const disconnect = useCallback(async () => {
    await logout();
    setSession(null);
    setProvider(null);
  }, [logout]);

  const sendStablecoin = useCallback(
    async (to: string, amount: string, token?: `0x${string}`) => {
      if (!provider || !session) throw new Error("Sign in first.");
      return sendStablecoinVia(provider, session.address, to, amount, token);
    },
    [provider, session],
  );

  const refundEscrow = useCallback(
    async (escrow: string, jobId: `0x${string}`) => {
      if (!provider || !session) throw new Error("Sign in first.");
      return refundEscrowVia(provider, session.address, escrow, jobId);
    },
    [provider, session],
  );

  const value = useMemo<WalletState>(
    () => ({
      kind: "privy",
      address: session?.address ?? null,
      session,
      connecting,
      ready: privyReady && (!authenticated || walletsReady),
      error,
      available: true,
      wrongChain: Boolean(session) && session?.chainId !== XORV_CHAIN.id,
      embedded: active?.walletClientType === "privy",
      email: user?.email?.address ?? null,
      connect,
      switchChain,
      disconnect,
      sendStablecoin,
      refundEscrow,
    }),
    [
      session,
      connecting,
      privyReady,
      authenticated,
      walletsReady,
      error,
      active?.walletClientType,
      user?.email?.address,
      connect,
      switchChain,
      disconnect,
      sendStablecoin,
      refundEscrow,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ---------------------------------------------------------------------------
// Injected wallet (no Privy app configured)
// ---------------------------------------------------------------------------

export function WalletProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<WalletSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);

  // Most wallets inject `window.ethereum` before the page's scripts run, but
  // some inject late and announce it with `ethereum#initialized` (MetaMask's
  // documented convention). Read once at mount, a late wallet stayed invisible
  // behind "No wallet found" until a reload.
  useEffect(() => {
    const detect = () => setAvailable(walletAvailable());
    detect();
    window.addEventListener("ethereum#initialized", detect);
    return () => window.removeEventListener("ethereum#initialized", detect);
  }, []);

  // Reconnect silently if the wallet already granted access. `eth_accounts`
  // never prompts, so a reload doesn't force the user back through the modal.
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

  // A user who switches account or network in their wallet has changed who is
  // paying. Re-reading rather than trusting stale state is the difference
  // between paying from the address on screen and paying from another one.
  useEffect(
    () =>
      available
        ? watchWallet(() => {
            void restoreWallet().then(setSession);
          })
        : undefined,
    [available],
  );

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      setSession(await connectWallet());
    } catch (err) {
      const text = message(err);
      if (!isDismissal(text)) setError(text);
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchChain = useCallback(async () => {
    setError(null);
    try {
      await switchToXorvChain();
      setSession(await restoreWallet());
    } catch (err) {
      setError(message(err));
    }
  }, []);

  // There is no "disconnect" in EIP-1193 — a dapp cannot revoke its own access,
  // only the wallet can. Clearing local state is the honest extent of it, and
  // saying so beats a button that pretends to do more than it does.
  const disconnect = useCallback(async () => {
    setSession(null);
  }, []);

  const sendStablecoin = useCallback(
    async (to: string, amount: string, token?: `0x${string}`) => {
      if (!session || typeof window === "undefined" || !window.ethereum) {
        throw new Error("Connect a wallet first.");
      }
      return sendStablecoinVia(window.ethereum, session.address, to, amount, token);
    },
    [session],
  );

  const refundEscrow = useCallback(
    async (escrow: string, jobId: `0x${string}`) => {
      if (!session || typeof window === "undefined" || !window.ethereum) {
        throw new Error("Connect a wallet first.");
      }
      return refundEscrowVia(window.ethereum, session.address, escrow, jobId);
    },
    [session],
  );

  const value = useMemo<WalletState>(
    () => ({
      kind: "injected",
      address: session?.address ?? null,
      session,
      connecting,
      ready,
      error,
      available,
      wrongChain: Boolean(session) && session?.chainId !== XORV_CHAIN.id,
      embedded: false,
      email: null,
      connect,
      switchChain,
      disconnect,
      sendStablecoin,
      refundEscrow,
    }),
    [session, connecting, ready, error, available, connect, switchChain, disconnect, sendStablecoin, refundEscrow],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used inside a wallet provider");
  return ctx;
}
