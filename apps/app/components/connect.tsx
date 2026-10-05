"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { createPublicClient, erc20Abi, http, getAddress, formatUnits, isAddress } from "viem";
import { EASE, useEntrance } from "@/lib/motion";
import {
  EXPLORER_NAME,
  STABLECOINS,
  XORV_CHAIN,
  explorerAddress,
  explorerTx,
} from "@/lib/chains";
import { useWallet } from "@/components/wallet-provider";
import { shortAddress } from "@/lib/wallet";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Sign in, and the wallet that comes with it.
 *
 * With Privy configured this is an email box away from a working wallet: Privy
 * creates an embedded wallet on Arbitrum, and that wallet can pay for a job straight
 * away, because a job payment is an EIP-712 signature rather than a
 * transaction. External wallets still connect through the same modal.
 *
 * The popover carries the second financial flow — sending a stablecoin — because a
 * wallet you can receive into but not send from is only half a wallet, and an
 * embedded wallet has no extension UI to do it in.
 *
 * Balances are read straight from each token contract rather than an indexer,
 * because the contract is authoritative.
 */

interface Balances {
  /** One row per stablecoin this deployment accepts, default (USDG) first. */
  tokens: Array<{ symbol: string; address: `0x${string}`; amount: number }>;
  /** ETH, for gas. Paying for jobs never needs it; sending a transfer does. */
  eth: number;
}

export function Connect() {
  const {
    kind,
    address,
    connecting,
    ready,
    error,
    available,
    wrongChain,
    embedded,
    email,
    connect,
    switchChain,
    disconnect,
    sendStablecoin,
  } = useWallet();
  const [open, setOpen] = useState(false);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendToken, setSendToken] = useState<`0x${string}`>(STABLECOINS[0]!.address);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const animate = useEntrance();

  const refreshBalances = useCallback(async () => {
    if (!address) {
      setBalances(null);
      return;
    }
    try {
      const client = createPublicClient({ chain: XORV_CHAIN, transport: http() });
      const account = getAddress(address);
      const [wei, ...units] = await Promise.all([
        client.getBalance({ address: account }),
        ...STABLECOINS.map((t) =>
          client.readContract({
            address: t.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [account],
          }),
        ),
      ]);
      setBalances({
        tokens: STABLECOINS.map((t, i) => ({
          symbol: t.symbol,
          address: t.address,
          amount: Number(formatUnits(units[i] ?? 0n, 6)),
        })),
        eth: Number(formatUnits(wei, 18)),
      });
    } catch {
      /* a balance we couldn't read is not worth an error state */
    }
  }, [address]);

  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  // Close the menu on outside click — a popover that only closes via its own
  // trigger is a popover people leave open.
  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  /**
   * Why this transfer can't go, in words, or null. Checked before the wallet
   * is asked: the form used to hand anything to viem and show its message —
   * 'Address "0x123" is invalid. - Address must be a hex value of 20 bytes …
   * Version: viem@2.55.10' — or let the token revert on chain.
   */
  function sendProblem(): string | null {
    const to = sendTo.trim();
    const amountText = sendAmount.trim();
    if (!isAddress(to, { strict: false })) return "That isn't an address — it should be 0x followed by 40 hex characters.";
    if (!/^\d*\.?\d+$/.test(amountText)) return "Enter the amount as a number, like 1.50.";
    const amount = Number(amountText);
    if (!(amount > 0)) return "Amount must be above zero.";
    if ((amountText.split(".")[1]?.length ?? 0) > 6) return "Stablecoins have 6 decimal places — use at most 6 after the point.";
    const held = balances?.tokens.find((t) => t.address === sendToken);
    if (held && amount > held.amount) return `This wallet holds ${held.amount} ${held.symbol} — not enough to send ${amount}.`;
    if (balances && balances.eth === 0) return "Sending is an on-chain transfer, so it needs a little ETH for gas — this wallet has none. (Paying for jobs never does.)";
    return null;
  }

  async function onSend(): Promise<void> {
    setSendError(null);
    setSent(null);
    const problem = sendProblem();
    if (problem) {
      setSendError(problem);
      return;
    }
    setSending(true);
    try {
      const hash = await sendStablecoin(getAddress(sendTo.trim().toLowerCase()), sendAmount.trim(), sendToken);
      setSent(hash);
      setSendAmount("");
      // Arbitrum blocks are ~0.25s; one short wait is enough for the balance.
      setTimeout(() => void refreshBalances(), 2_500);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (/reject|cancel|denied|4001/i.test(text)) return;
      setSendError(
        /exceeds balance|insufficient/i.test(text)
          ? "Not enough in this wallet for that transfer (or for its gas)."
          : (text.split("\n")[0] ?? text).replace(/\s*Version: viem@[\d.]+/, ""),
      );
    } finally {
      setSending(false);
    }
  }

  if (!available) {
    return (
      <a
        href="https://metamask.io/download/"
        target="_blank"
        rel="noreferrer"
        className="text-[12px] text-fg-4 underline underline-offset-2 transition-colors hover:text-fg-2"
      >
        No wallet found
      </a>
    );
  }

  if (!ready) {
    return <div className="h-[34px] w-[104px] animate-pulse rounded-lg bg-white/[0.04]" />;
  }

  if (!address) {
    return (
      <div className="flex items-center gap-2">
        {error ? (
          <span className="max-w-[220px] truncate text-[12px] text-[#f87171]">{error}</span>
        ) : null}
        <Button
          onClick={() => void connect()}
          disabled={connecting}
          className="px-3.5 py-2 text-[13px]"
        >
          {connecting ? "Waiting for wallet…" : kind === "privy" ? "Sign in" : "Connect"}
        </Button>
      </div>
    );
  }

  if (wrongChain) {
    // Worth its own state rather than a silent failure. An EIP-712 domain
    // includes the chain id, so a signature made on the wrong network is
    // structurally valid and verifies against nothing.
    return (
      <Button onClick={() => void switchChain()} className="px-3.5 py-2 text-[13px]">
        Switch to {XORV_CHAIN.name}
      </Button>
    );
  }

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Wallet ${address}`}
        className="flex items-center gap-2 rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-[12px] text-fg-2 transition-colors hover:border-[var(--line-2)]"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--live)]" aria-hidden />
        <span className="mono">{email ?? shortAddress(address)}</span>
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={animate ? { opacity: 0, y: -4 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16, ease: EASE }}
            className={cn(
              "absolute right-0 z-50 mt-1.5 w-[320px] rounded-xl border border-[var(--line-2)] bg-black p-4",
              "shadow-[0_16px_40px_rgba(0,0,0,0.9)]",
            )}
          >
            <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-fg-4">
              <span>{XORV_CHAIN.name}</span>
              <span>{embedded ? "Privy embedded wallet" : kind === "privy" ? "via Privy" : "injected"}</span>
            </div>
            {email ? <div className="mt-1.5 text-[12px] text-fg-3">{email}</div> : null}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(address).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1_500);
                });
              }}
              title={`Copy address — send testnet ${STABLECOINS.map((t) => t.symbol).join(" or ")} here to fund it`}
              className="mono mt-1.5 block break-all text-left text-[12px] text-fg transition-colors hover:text-fg-2"
            >
              {address}
              <span className="ml-1.5 text-[11px] text-fg-4">{copied ? "copied" : "copy"}</span>
            </button>

            {balances ? (
              <dl className="mt-4 space-y-2 border-t border-[var(--line)] pt-3 text-[12.5px]">
                {balances.tokens.map((t) => (
                  <div key={t.address} className="flex justify-between">
                    <dt className="text-fg-3">{t.symbol}</dt>
                    <dd className="mono text-fg">${t.amount.toFixed(2)}</dd>
                  </div>
                ))}
                <div className="flex justify-between">
                  <dt
                    className="text-fg-3"
                    title="Gas. Paying for a job needs none — only sending a transfer does."
                  >
                    ETH
                  </dt>
                  <dd className="mono text-fg-3">{balances.eth.toFixed(6)}</dd>
                </div>
              </dl>
            ) : null}

            {balances && balances.tokens.every((t) => t.amount === 0) ? (
              <p className="mt-3 text-[12px] leading-relaxed text-fg-3">
                Empty. Copy the address above and fund it with testnet{" "}
                {balances.tokens.map((t) => t.symbol).join(" or ")} on {XORV_CHAIN.name}
                {balances.tokens.some((t) => t.symbol === "USDC") ? (
                  <>
                    {" "}
                    — USDC is at{" "}
                    <a
                      href="https://faucet.circle.com"
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-fg"
                    >
                      faucet.circle.com
                    </a>
                  </>
                ) : null}
                .
              </p>
            ) : null}

            <p className="mt-3 text-[12px] leading-relaxed text-fg-3">
              Paying for a job is a signature, not a transaction — you need no ETH and Xorv never
              holds your key. Sending below is a real transfer, so it needs a little ETH for gas.
            </p>

            <form
              className="mt-3 space-y-2 border-t border-[var(--line)] pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                void onSend();
              }}
            >
              <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-fg-4">
                <span>Send</span>
                {STABLECOINS.length > 1 ? (
                  <select
                    value={sendToken}
                    onChange={(e) => setSendToken(e.target.value as `0x${string}`)}
                    aria-label="Token to send"
                    className="rounded border border-[var(--line)] bg-black px-1 py-0.5 text-[11px] normal-case tracking-normal text-fg-2"
                  >
                    {STABLECOINS.map((t) => (
                      <option key={t.address} value={t.address}>
                        {t.symbol}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span>{STABLECOINS[0]!.symbol}</span>
                )}
              </div>
              <input
                value={sendTo}
                onChange={(e) => setSendTo(e.target.value)}
                placeholder="0x… recipient"
                spellCheck={false}
                className="mono w-full rounded-lg border border-[var(--line)] bg-transparent px-2.5 py-1.5 text-[12px] text-fg outline-none placeholder:text-fg-4 focus:border-[var(--line-2)]"
              />
              <div className="flex gap-2">
                <input
                  value={sendAmount}
                  onChange={(e) => setSendAmount(e.target.value)}
                  placeholder="0.10"
                  inputMode="decimal"
                  className="mono w-full rounded-lg border border-[var(--line)] bg-transparent px-2.5 py-1.5 text-[12px] text-fg outline-none placeholder:text-fg-4 focus:border-[var(--line-2)]"
                />
                <button
                  type="submit"
                  disabled={sending || !sendTo || !sendAmount}
                  className="shrink-0 rounded-lg border border-[var(--line-2)] px-3 py-1.5 text-[12px] text-fg transition-colors hover:bg-white/[0.04] disabled:opacity-40"
                >
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
              {sent ? (
                <a
                  href={explorerTx(sent)}
                  target="_blank"
                  rel="noreferrer"
                  className="mono block truncate text-[11.5px] text-[var(--live)] underline underline-offset-2"
                >
                  sent · {shortAddress(sent, 10, 8)}
                </a>
              ) : null}
              {sendError ? (
                <p className="text-[11.5px] leading-relaxed text-[#f87171]">{sendError}</p>
              ) : null}
            </form>

            <a
              href={explorerAddress(address)}
              target="_blank"
              rel="noreferrer"
              className="mt-3 block text-[12px] text-fg-2 underline underline-offset-2 transition-colors hover:text-fg"
            >
              View on {EXPLORER_NAME}
            </a>

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void disconnect();
              }}
              className="mt-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-[12px] text-fg-2 transition-colors hover:border-[var(--line-2)] hover:text-fg"
            >
              {kind === "privy" ? "Sign out" : "Forget this wallet"}
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
