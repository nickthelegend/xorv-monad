"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { NETWORK } from "@/lib/api";
import { EASE, useEntrance } from "@/lib/motion";
import { useWallet } from "@/components/wallet-provider";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Connect a Hedera wallet.
 *
 * This used to be Privy, and the swap is the point rather than a detail.
 * Privy signs EVM transactions; Hedera's x402 scheme settles a **native**
 * protobuf transfer. So the old button could authenticate you and then not pay
 * for anything — the payment quietly happened server-side with a key the app
 * held. HashPack (or Blade, or Kabila, over the same WalletConnect session)
 * signs the transaction the facilitator actually verifies, so the account
 * shown here is the account that pays.
 *
 * One consequence worth noticing: there is no "connected but no Hedera account
 * yet" state anymore. A wallet session *is* a Hedera account id — the ledger
 * already knows it. That whole class of confusion belonged to the EVM-address
 * path and left with it.
 */

interface Balances {
  usdc: number;
  hbar: number;
  canReceive: boolean;
}

const USDC_TOKEN = process.env.NEXT_PUBLIC_XORV_STABLECOIN ?? "0.0.429274";

function mirrorNode(network: string): string {
  return network === "hedera:mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
}

export function Connect() {
  const { accountId, connecting, ready, error, available, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [balances, setBalances] = useState<Balances | null>(null);
  const animate = useEntrance();

  useEffect(() => {
    if (!accountId) {
      setBalances(null);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${mirrorNode(NETWORK)}/api/v1/accounts/${accountId}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          balance?: { balance?: number; tokens?: Array<{ token_id: string; balance: number }> };
          max_automatic_token_associations?: number;
        };
        const tokens = body.balance?.tokens ?? [];
        const usdc = tokens.find((t) => t.token_id === USDC_TOKEN);
        const auto = body.max_automatic_token_associations ?? 0;
        setBalances({
          usdc: (usdc?.balance ?? 0) / 1e6,
          hbar: (body.balance?.balance ?? 0) / 1e8,
          // The trap this surfaces: an account with neither an association nor
          // a free auto-slot silently cannot be paid in USDC.
          canReceive: Boolean(usdc) || auto === -1 || auto > tokens.length,
        });
      } catch {
        /* a balance we couldn't read is not worth an error state */
      }
    })();
    return () => controller.abort();
  }, [accountId]);

  // Close the menu on outside click — a popover that only closes via its own
  // trigger is a popover people leave open.
  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  if (!available) {
    return (
      <span
        className="text-[12px] text-fg-4"
        title="NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set"
      >
        wallet unavailable
      </span>
    );
  }

  if (!ready) {
    return <div className="h-[34px] w-[104px] animate-pulse rounded-lg bg-white/[0.04]" />;
  }

  if (!accountId) {
    return (
      <div className="flex items-center gap-2">
        {error ? (
          <span className="max-w-[220px] truncate text-[12px] text-[#f87171]">{error}</span>
        ) : null}
        <Button onClick={() => void connect()} disabled={connecting} className="px-3.5 py-2 text-[13px]">
          {connecting ? "Waiting for wallet…" : "Connect"}
        </Button>
      </div>
    );
  }

  const explorer = NETWORK === "hedera:mainnet" ? "mainnet" : "testnet";

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Wallet ${accountId}`}
        className="flex items-center gap-2 rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-[12px] text-fg-2 transition-colors hover:border-[var(--line-2)]"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--live)]" aria-hidden />
        <span className="mono">{accountId}</span>
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={animate ? { opacity: 0, y: -4 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16, ease: EASE }}
            className={cn(
              "absolute right-0 z-50 mt-1.5 w-[280px] rounded-xl border border-[var(--line-2)] bg-black p-4",
              "shadow-[0_16px_40px_rgba(0,0,0,0.9)]",
            )}
          >
            <div className="text-[11px] uppercase tracking-[0.14em] text-fg-4">Hedera account</div>
            <div className="mono mt-1.5 text-[13px] text-fg">{accountId}</div>

            {balances ? (
              <dl className="mt-4 space-y-2 border-t border-[var(--line)] pt-3 text-[12.5px]">
                <div className="flex justify-between">
                  <dt className="text-fg-3">USDC</dt>
                  <dd className="mono text-fg">${balances.usdc.toFixed(2)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-fg-3">HBAR</dt>
                  <dd className="mono text-fg-2">{balances.hbar.toFixed(4)} ℏ</dd>
                </div>
              </dl>
            ) : null}

            {balances && !balances.canReceive ? (
              <p className="mt-3 text-[12px] leading-relaxed text-[#fbbf24]">
                This account isn&rsquo;t associated with USDC and has no automatic slots, so it
                can&rsquo;t hold the token yet.
              </p>
            ) : null}

            <p className="mt-3 text-[12px] leading-relaxed text-fg-3">
              You sign each payment in your wallet. Xorv never holds your key, and the network fee
              is paid by the facilitator — not by you.
            </p>

            <a
              href={`https://hashscan.io/${explorer}/account/${accountId}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 block text-[12px] text-fg-2 underline underline-offset-2 transition-colors hover:text-fg"
            >
              View on HashScan
            </a>

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void disconnect();
              }}
              className="mt-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-[12px] text-fg-2 transition-colors hover:border-[var(--line-2)] hover:text-fg"
            >
              Disconnect
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
