"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { explorerAddress, formatMon, formatUsdc, shortHex } from "@xorv/protocol/web";
import { CHAIN_CONFIG, IS_TESTNET, NETWORK, NETWORK_LABEL } from "@/lib/network";
import { EASE, useEntrance } from "@/lib/motion";
import { useWallet } from "@/components/wallet-provider";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * The header wallet: log in, see what you can spend, get test funds, leave.
 *
 * With Privy this is a login button — email, Google, passkey or an existing
 * wallet — and the address it shows afterwards is the embedded wallet Privy
 * created for you on Monad, which is the wallet every job you buy is paid from
 * and every rating you leave is signed by. Without Privy it connects the
 * browser's injected wallet instead.
 *
 * The balances are the two numbers that decide whether a payment can work.
 * USDC is what a job costs. MON is shown for honesty but you don't need any:
 * the facilitator pays settlement gas and the broker pays for rating relays.
 */
export function Connect() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const animate = useEntrance();

  // Close on outside click — a popover that only closes via its own trigger is
  // a popover people leave open.
  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  if (!wallet.ready) {
    return <div className="h-[34px] w-[104px] animate-pulse rounded-lg bg-white/[0.04]" />;
  }

  if (!wallet.available) {
    return (
      <span
        className="text-[12px] text-fg-4"
        title="Set NEXT_PUBLIC_PRIVY_APP_ID for embedded wallets, or install a browser wallet"
      >
        no wallet · demo account only
      </span>
    );
  }

  if (wallet.creatingWallet) {
    return <span className="text-[12px] text-fg-3">Creating your wallet…</span>;
  }

  if (!wallet.address) {
    return (
      <div className="flex items-center gap-2">
        {wallet.error ? (
          <span className="max-w-[220px] truncate text-[12px] text-fail">{wallet.error}</span>
        ) : null}
        <Button onClick={wallet.login} disabled={wallet.connecting} className="px-3.5 py-2 text-[13px]">
          {wallet.connecting ? "Waiting for wallet…" : wallet.mode === "privy" ? "Log in" : "Connect wallet"}
        </Button>
      </div>
    );
  }

  const address = wallet.address;
  const walletLabel =
    wallet.kind === "embedded" ? "Privy embedded wallet" : wallet.mode === "privy" ? "Your wallet, via Privy" : "Browser wallet";

  const copy = (): void => {
    void navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Wallet ${address}`}
        className="flex items-center gap-2 rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-[12px] text-fg-2 transition-colors hover:border-[var(--line-2)]"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-live" aria-hidden />
        <span className="mono">{shortHex(address)}</span>
        {wallet.balances ? (
          <span className="tnum hidden text-fg-3 sm:inline">{formatUsdc(wallet.balances.usdcUnits)}</span>
        ) : null}
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={animate ? { opacity: 0, y: -4 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16, ease: EASE }}
            className={cn(
              "absolute right-0 z-50 mt-1.5 w-[300px] rounded-xl border border-[var(--line-2)] bg-black p-4",
              "shadow-[0_16px_40px_rgba(0,0,0,0.9)]",
            )}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] uppercase tracking-[0.14em] text-fg-4">{walletLabel}</span>
              <span className="text-[11px] text-fg-4">{NETWORK_LABEL}</span>
            </div>
            {wallet.identity ? <p className="mt-1 truncate text-[12px] text-fg-3">{wallet.identity}</p> : null}

            <div className="mt-2 flex items-start gap-2">
              <span className="mono min-w-0 flex-1 break-all text-[12.5px] leading-relaxed text-fg">{address}</span>
              <button
                type="button"
                onClick={copy}
                className="shrink-0 rounded-md border border-[var(--line)] px-2 py-0.5 text-[11px] text-fg-3 transition-colors hover:border-[var(--line-2)] hover:text-fg"
              >
                {copied ? "copied" : "copy"}
              </button>
            </div>

            <dl className="mt-4 space-y-2 border-t border-[var(--line)] pt-3 text-[12.5px]">
              <div className="flex justify-between">
                <dt className="text-fg-3">USDC</dt>
                <dd className="mono text-fg">{wallet.balances ? formatUsdc(wallet.balances.usdcUnits) : "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-fg-3">MON</dt>
                <dd className="mono text-fg-2">{wallet.balances ? formatMon(wallet.balances.monWei) : "—"}</dd>
              </div>
            </dl>
            {wallet.balancesError ? (
              <p className="mt-2 text-[11.5px] text-warn">Couldn&rsquo;t read balances from the RPC just now.</p>
            ) : null}

            {IS_TESTNET && (CHAIN_CONFIG.faucets.usdc || CHAIN_CONFIG.faucets.mon) ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {CHAIN_CONFIG.faucets.usdc ? (
                  <FaucetLink href={CHAIN_CONFIG.faucets.usdc} label="Test USDC" hint="Circle faucet · pick Monad Testnet" />
                ) : null}
                {CHAIN_CONFIG.faucets.mon ? (
                  <FaucetLink href={CHAIN_CONFIG.faucets.mon} label="Test MON" hint="Monad faucet" />
                ) : null}
              </div>
            ) : null}

            <p className="mt-3 text-[12px] leading-relaxed text-fg-3">
              You sign each payment and rating in this wallet. Xorv never holds your key, and gas is paid by
              the facilitator and the relay — you only need USDC.
            </p>

            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
              <a
                href={explorerAddress(NETWORK, address)}
                target="_blank"
                rel="noreferrer"
                className="text-fg-2 underline underline-offset-2 transition-colors hover:text-fg"
              >
                View on explorer
              </a>
              {wallet.exportKey ? (
                <button
                  type="button"
                  onClick={() => void wallet.exportKey?.()}
                  className="text-fg-2 underline underline-offset-2 transition-colors hover:text-fg"
                >
                  Export key
                </button>
              ) : null}
            </div>

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void wallet.logout();
              }}
              className="mt-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-[12px] text-fg-2 transition-colors hover:border-[var(--line-2)] hover:text-fg"
            >
              {wallet.mode === "privy" ? "Log out" : "Disconnect"}
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function FaucetLink({ href, label, hint }: { href: string; label: string; hint: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={hint}
      className="rounded-md border border-[var(--line)] px-2.5 py-1 text-[11.5px] text-fg-2 transition-colors hover:border-[var(--line-2)] hover:text-fg"
    >
      {label} ↗
    </a>
  );
}
