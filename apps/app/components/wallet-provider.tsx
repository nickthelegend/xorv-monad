"use client";

/**
 * Wallet state for the app — one shape, two backends.
 *
 * **Privy** (when `NEXT_PUBLIC_PRIVY_APP_ID` is set) is the main path. A
 * visitor logs in with email, Google, a passkey or an existing wallet, and
 * anyone without a wallet gets an embedded EVM wallet created on login. That
 * wallet is not decoration: on Monad an x402 payment is an EIP-712 signature
 * (EIP-3009 `TransferWithAuthorization` over USDC), and so is a job rating —
 * exactly what an embedded wallet produces. So the account in the header is
 * the account that pays for jobs and the account that rates them, with no gas
 * and no browser extension.
 *
 * **Injected** (no Privy app id) falls back to `window.ethereum` through a viem
 * custom transport: same signer shape, same pay and rate code, the visitor's
 * own extension doing the signing.
 *
 * Either way the rest of the app sees `{ address, balances, getSigner() }`,
 * and `getSigner()` returns a plain `{ address, signTypedData }` after putting
 * the wallet on the right chain — wallets refuse typed data whose domain
 * `chainId` differs from the one they are on.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toViemAccount, useExportWallet, usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { createWalletClient, custom, getAddress, type Address, type EIP1193Provider, type PublicClient } from "viem";
import { fetchBalances, publicClientFor, sameAddress, type AccountBalances } from "@xorv/protocol/web";
import { APP_CHAIN, NETWORK, PUBLIC_RPC_URL } from "@/lib/network";
import { errorMessage, isUserRejection } from "@/lib/errors";
import { jsonSafeSigner } from "@/lib/typed-data";
import type { PaymentSigner } from "@/lib/x402-pay";
import type { RatingSigner } from "@/lib/rating";

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() ?? "";

export type WalletMode = "privy" | "injected";

export interface WalletState {
  mode: WalletMode;
  /** False until the backend has restored (or ruled out) a session, so the header doesn't flash. */
  ready: boolean;
  /** Can this visitor get a wallet at all? Privy: always. Injected: only with an extension. */
  available: boolean;
  /** Checksummed address of the wallet that pays, once there is one. */
  address: Address | null;
  /** A Privy embedded wallet, or a wallet the visitor brought (via Privy or injected). */
  kind: "embedded" | "external" | null;
  /** Logged in, but the embedded wallet is still being created. */
  creatingWallet: boolean;
  /** How the visitor logged in, for display: an email, or null. */
  identity: string | null;
  connecting: boolean;
  error: string | null;
  balances: AccountBalances | null;
  balancesError: boolean;
  refreshBalances: () => Promise<AccountBalances | null>;
  login: () => void;
  logout: () => Promise<void>;
  /** A signer on the app's chain. Throws when there is no wallet. */
  getSigner: () => Promise<PaymentSigner>;
  /** Open Privy's key-export modal (embedded wallets only). */
  exportKey: (() => Promise<void>) | null;
}

const Ctx = createContext<WalletState | null>(null);

/**
 * A payment signer, seen as a rating signer.
 *
 * Both are "sign this EIP-712 payload"; the types differ only because x402
 * declares its message loosely (`Record<string, unknown>`) and the rating's is
 * a precise struct.
 */
export function asRatingSigner(signer: PaymentSigner): RatingSigner {
  return {
    address: signer.address,
    signTypedData: (typedData) => signer.signTypedData(typedData as unknown as Parameters<PaymentSigner["signTypedData"]>[0]),
  };
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/**
 * MON and USDC for the connected address, read straight from Monad.
 *
 * Polled slowly (20 s) and refreshed on demand after a payment. State is keyed
 * by address so switching accounts never shows the previous one's balance.
 */
function useBalances(address: Address | null) {
  const [state, setState] = useState<{ address: Address | null; balances: AccountBalances | null; error: boolean }>({
    address: null,
    balances: null,
    error: false,
  });
  const client = useRef<PublicClient | null>(null);

  const refresh = useCallback(async (): Promise<AccountBalances | null> => {
    if (!address) return null;
    try {
      client.current ??= publicClientFor(NETWORK, { rpcUrl: PUBLIC_RPC_URL });
      const balances = await fetchBalances(NETWORK, address, { client: client.current });
      setState({ address, balances, error: false });
      return balances;
    } catch {
      // "Couldn't ask" is not "you have zero" — keep the last figure, flag it.
      setState((prev) => ({ address, balances: prev.address === address ? prev.balances : null, error: true }));
      return null;
    }
  }, [address]);

  useEffect(() => {
    if (!address) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(timer);
  }, [address, refresh]);

  const current = address && state.address === address ? state : null;
  return { balances: current?.balances ?? null, balancesError: current?.error ?? false, refreshBalances: refresh };
}

// ---------------------------------------------------------------------------
// Privy
// ---------------------------------------------------------------------------

/** The wallet that pays: the embedded one when there is one, else the one they logged in with. */
function pickWallet(wallets: ConnectedWallet[], linked: string | undefined): ConnectedWallet | null {
  return (
    wallets.find((w) => w.walletClientType === "privy") ??
    wallets.find((w) => sameAddress(w.address, linked)) ??
    wallets[0] ??
    null
  );
}

function PrivyWalletProvider({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { exportWallet } = useExportWallet();

  const wallet = authenticated ? pickWallet(wallets, user?.wallet?.address) : null;
  const address = wallet ? getAddress(wallet.address) : null;
  const kind = wallet ? (wallet.walletClientType === "privy" ? "embedded" : "external") : null;
  const { balances, balancesError, refreshBalances } = useBalances(address);

  const getSigner = useCallback(async (): Promise<PaymentSigner> => {
    if (!wallet) throw new Error("Log in first — there's no wallet to pay from yet.");
    if (wallet.chainId !== `eip155:${APP_CHAIN.id}`) await wallet.switchChain(APP_CHAIN.id);
    // A viem LocalAccount whose signTypedData goes through Privy (its own
    // confirmation modal for the embedded wallet, the extension for others).
    // Only the typed-data signer is handed on: an x402 exact payment and a
    // rating need nothing else, and nothing else should be reachable.
    //
    // Privy forwards the payload untouched, and its sign modal renders it with
    // a bare JSON.stringify — which throws on the bigints viem uses for every
    // uint256 and takes the whole app down mid-render. So Privy only ever sees
    // the JSON-safe form (same digest, same signature): see lib/typed-data.ts.
    const account = await toViemAccount({ wallet });
    return {
      address: account.address,
      signTypedData: jsonSafeSigner((typedData) => account.signTypedData(typedData as never)),
    };
  }, [wallet]);

  const exportKey = useCallback(async () => {
    if (address) await exportWallet({ address });
  }, [address, exportWallet]);

  const value = useMemo<WalletState>(
    () => ({
      mode: "privy",
      ready: ready && (!authenticated || walletsReady),
      available: true,
      address,
      kind,
      creatingWallet: ready && authenticated && walletsReady && !wallet,
      identity: user?.email?.address ?? user?.google?.email ?? null,
      connecting: false,
      error: null,
      balances,
      balancesError,
      refreshBalances,
      login: () => login(),
      logout: () => logout(),
      getSigner,
      exportKey: kind === "embedded" ? exportKey : null,
    }),
    [ready, authenticated, walletsReady, address, kind, wallet, user, balances, balancesError, refreshBalances, login, logout, getSigner, exportKey],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ---------------------------------------------------------------------------
// Injected (window.ethereum) fallback
// ---------------------------------------------------------------------------

function injectedProvider(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null;
}

function hasCode(err: unknown, code: number): boolean {
  for (let link: unknown = err, depth = 0; link && depth < 8; depth += 1) {
    if ((link as { code?: unknown }).code === code) return true;
    link = (link as { cause?: unknown }).cause;
  }
  return false;
}

function InjectedWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address | null>(null);
  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { balances, balancesError, refreshBalances } = useBalances(address);

  // Restore an already-authorized account without opening a prompt
  // (`eth_accounts`, never `eth_requestAccounts`), and follow account switches.
  useEffect(() => {
    const eth = injectedProvider();
    let cancelled = false;
    const onAccounts = (accounts: readonly string[]) => setAddress(accounts[0] ? getAddress(accounts[0]) : null);
    void (async () => {
      try {
        if (eth) onAccounts((await eth.request({ method: "eth_accounts" })) as string[]);
      } catch {
        /* a wallet that won't answer eth_accounts is simply "not connected" */
      } finally {
        if (!cancelled) {
          setAvailable(Boolean(eth));
          setReady(true);
        }
      }
    })();
    eth?.on?.("accountsChanged", onAccounts);
    return () => {
      cancelled = true;
      eth?.removeListener?.("accountsChanged", onAccounts);
    };
  }, []);

  const login = useCallback(() => {
    const eth = injectedProvider();
    if (!eth) return;
    setError(null);
    setConnecting(true);
    void (async () => {
      try {
        const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
        setAddress(accounts[0] ? getAddress(accounts[0]) : null);
      } catch (err) {
        // Closing the prompt is a decision, not a failure — don't shout about it.
        if (!isUserRejection(err)) setError(errorMessage(err));
      } finally {
        setConnecting(false);
      }
    })();
  }, []);

  const logout = useCallback(async () => {
    const eth = injectedProvider();
    try {
      // Extensions that support it drop the site's permission; the rest just forget it here.
      await eth?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] } as never);
    } catch {
      /* not supported — forgetting locally is all we can do */
    }
    setAddress(null);
  }, []);

  const getSigner = useCallback(async (): Promise<PaymentSigner> => {
    const eth = injectedProvider();
    if (!eth || !address) throw new Error("Connect a wallet first.");
    const client = createWalletClient({ account: address, chain: APP_CHAIN, transport: custom(eth) });
    if ((await client.getChainId()) !== APP_CHAIN.id) {
      try {
        await client.switchChain({ id: APP_CHAIN.id });
      } catch (err) {
        // 4902: the wallet has never heard of Monad — add it (which also switches).
        if (!hasCode(err, 4902)) throw err;
        await client.addChain({ chain: APP_CHAIN });
      }
    }
    return {
      address,
      signTypedData: (message) => client.signTypedData({ ...message, account: address } as never),
    };
  }, [address]);

  const value = useMemo<WalletState>(
    () => ({
      mode: "injected",
      ready,
      available,
      address,
      kind: address ? "external" : null,
      creatingWallet: false,
      identity: null,
      connecting,
      error,
      balances,
      balancesError,
      refreshBalances,
      login,
      logout,
      getSigner,
      exportKey: null,
    }),
    [ready, available, address, connecting, error, balances, balancesError, refreshBalances, login, logout, getSigner],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Privy when the app has an id for it, the injected wallet otherwise. Decided at build time. */
export function WalletProvider({ children }: { children: ReactNode }) {
  return PRIVY_APP_ID ? (
    <PrivyWalletProvider>{children}</PrivyWalletProvider>
  ) : (
    <InjectedWalletProvider>{children}</InjectedWalletProvider>
  );
}

export function useWallet(): WalletState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
