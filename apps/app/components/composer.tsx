"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { explorerAddress, shortHex } from "@xorv/protocol/web";
import { ModelPicker, type ModelOption } from "./model-picker";
import { useWallet } from "@/components/wallet-provider";
import { api, BROKER_URL, type Quote } from "@/lib/api";
import { useDemoPayer, useNetworkInfo } from "@/lib/hooks";
import { CHAIN_CONFIG, IS_TESTNET, NETWORK } from "@/lib/network";
import { PaymentError, classifyPaymentError, payQuote, payableQuote, type PaymentFailureKind } from "@/lib/x402-pay";
import { EASE, useEntrance } from "@/lib/motion";
import { describeRouting, describeScreening, roleLabel } from "@/lib/ai";
import { RoutingTrace } from "@/components/routing-trace";
import { cn } from "@/lib/utils";
import { usePrivateKeys } from "@/components/private-keys";
import { LockGlyph } from "@/components/passkey-panel";

/**
 * The composer.
 *
 * One input, centred, that takes a sentence and turns it into a paid job on
 * someone else's machine. It is the whole product in a single control, so it
 * gets the whole viewport rather than sharing a column with a list.
 *
 * The quote is disclosed *before* payment and never skipped: it is the moment
 * the buyer learns who is about to run their prompt and what it will cost. A
 * one-click "just do it" would be faster and worse. The payment that follows
 * is pinned to that quote — the x402 client refuses to sign for any other
 * payee or amount (lib/x402-pay.ts).
 *
 * A private job is the same flow with one more field on the quote: the
 * buyer's passkey-derived inbox key (`encryptTo`). The provider seals the
 * answer to it before it leaves their machine, and after payment the job is
 * added to the buyer's encrypted history vault — the only place its prompt
 * stays readable to them, since public views redact it.
 */

const ADAPTERS: ModelOption[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok" },
  { id: "opencode", label: "OpenCode" },
  { id: "qwen", label: "Qwen 3.8 Max" },
  { id: "kimi", label: "Kimi K3" },
  { id: "hunyuan", label: "Hunyuan", hint: "hy4" },
  { id: "qwen-code", label: "Qwen Code" },
  { id: "openai-compatible", label: "OpenAI-compatible", hint: "local" },
  { id: "echo", label: "Echo", hint: "test" },
];

type Busy = "unlocking" | "quoting" | "signing" | "settling" | "saving" | null;

/** Refusals only the demo route gives: over the per-job cap, rate-limited, out of today's budget, or a quote it already tried. */
type DemoRefusalKind = "over_cap" | "rate_limited" | "daily_cap" | "already_paid";

/** How long a private job's history write may hold up the redirect to its page. */
const HISTORY_SAVE_WAIT_MS = 8_000;

/** When a payment landed, for the history entry. Only ever called from a payment handler. */
function paidAt(): number {
  return Date.now();
}

interface PayFailure {
  message: string;
  kind: PaymentFailureKind | DemoRefusalKind | null;
  /** The demo account failed, not the visitor's wallet — different advice. */
  demo?: boolean;
}

export function Composer() {
  const router = useRouter();
  const animate = useEntrance();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const wallet = useWallet();
  const demo = useDemoPayer();
  const info = useNetworkInfo();
  const keys = usePrivateKeys();

  const [prompt, setPrompt] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  /** The inbox key the current quote was taken for — set only for a private quote. */
  const [quotedKey, setQuotedKey] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [maxUsd, setMaxUsd] = useState("0.50");

  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<PayFailure | null>(null);

  // "Auto" hands the choice to the broker: the Qwen router (which reads the
  // candidates' on-chain record and picks a provider) when it runs one, the
  // cheapest live provider, best-rated on a tie, when it doesn't. The hint
  // says which.
  const aiRouter = info?.ai.router ?? null;
  const models: ModelOption[] = [
    { id: "", label: "Auto", hint: aiRouter ? `${roleLabel(aiRouter) ?? aiRouter.model} routes` : "cheapest" },
    ...ADAPTERS,
  ];

  // Grow with the content rather than scrolling inside a fixed box — a prompt
  // you can't see all of is a prompt you can't check before paying for it.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [prompt]);

  const reset = (): void => {
    setQuote(null);
    setQuotedKey(null);
    setError(null);
  };

  async function getQuote(): Promise<void> {
    if (!prompt.trim()) return;
    setError(null);
    setQuote(null);
    setQuotedKey(null);
    try {
      const maxPriceUsdMicros = Math.round(Number(maxUsd.replace(/[$,\s]/g, "")) * 1_000_000);
      if (!Number.isFinite(maxPriceUsdMicros) || maxPriceUsdMicros <= 0) {
        throw new Error("Set a maximum price above zero.");
      }
      // A private quote needs the inbox key now, and the vault keys right
      // after payment — so all three are unlocked up front, one passkey
      // confirmation each, rather than interrupting the redirect later.
      let encryptTo: string | null = null;
      if (isPrivate) {
        if (!keys.ready) {
          setBusy("unlocking");
          if (!(await keys.unlock())) {
            setBusy(null);
            return;
          }
        }
        encryptTo = keys.keyring.encryptTo();
      }
      setBusy("quoting");
      setQuote(await api.quote({ prompt, adapter: model || null, maxPriceUsdMicros, encryptTo }));
      setQuotedKey(encryptTo);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), kind: null });
    } finally {
      setBusy(null);
    }
  }

  async function paid(jobId: string, txHash: string | null): Promise<void> {
    if (quotedKey && quote) {
      // Paid is paid: the history write is bounded, and if it fails the entry
      // waits in memory for a retry (see PrivateKeysProvider) rather than
      // keeping the buyer from their job.
      setBusy("saving");
      await Promise.race([
        keys.saveToHistory({
          jobId,
          title: null,
          prompt,
          createdAt: paidAt(),
          priceUsdMicros: quote.priceUsdMicros,
          providerLabel: quote.provider.label,
          encryptTo: quotedKey,
        }),
        new Promise((resolve) => setTimeout(resolve, HISTORY_SAVE_WAIT_MS)),
      ]);
    }
    // The settlement tx rides along so the job page can link it on first
    // paint, before the broker's payment record reaches the stream.
    router.push(`/jobs/${encodeURIComponent(jobId)}${txHash ? `?tx=${txHash}` : ""}`);
  }

  /**
   * Pay from the visitor's own wallet, in this tab. The only thing that leaves
   * the wallet is one EIP-712 signature; the facilitator settles it on Monad
   * and pays the gas.
   */
  async function payFromWallet(): Promise<void> {
    if (!quote) return;
    setError(null);
    setBusy("signing");
    try {
      const terms = payableQuote(quote);
      // Check the balance first: asking someone to sign a payment their wallet
      // cannot cover, only for the facilitator to refuse it, is a worse way to
      // learn the same thing.
      const balances = await wallet.refreshBalances();
      if (balances && BigInt(balances.usdcUnits) < BigInt(terms.usdcAmount)) {
        throw new PaymentError(
          "insufficient_funds",
          `This wallet holds less USDC than the job costs (${quote.priceLabel}). Nothing was signed.`,
        );
      }
      const signer = await wallet.getSigner();
      const result = await payQuote({
        quote: terms,
        network: NETWORK,
        brokerUrl: BROKER_URL,
        signer: {
          address: signer.address,
          signTypedData: async (message) => {
            const signature = await signer.signTypedData(message);
            setBusy("settling");
            return signature;
          },
        },
      });
      void wallet.refreshBalances();
      await paid(result.jobId, result.txHash);
    } catch (err) {
      const failure = classifyPaymentError(err);
      setError({ message: failure.message, kind: failure.kind });
      setBusy(null);
    }
  }

  /** Pay from the deployment's demo account — same protocol, not the visitor's money. */
  async function payFromDemo(): Promise<void> {
    if (!quote) return;
    setError(null);
    setBusy("settling");
    try {
      const terms = payableQuote(quote);
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(terms),
      });
      const body = (await res.json().catch(() => ({}))) as {
        jobId?: string;
        txHash?: string | null;
        error?: string;
        kind?: PaymentFailureKind | DemoRefusalKind;
      };
      if (!res.ok || !body.jobId) {
        setError({ message: body.error ?? `Payment failed (${res.status}).`, kind: body.kind ?? null, demo: true });
        setBusy(null);
        return;
      }
      await paid(body.jobId, body.txHash ?? null);
    } catch (err) {
      setError({ message: classifyPaymentError(err).message, kind: null, demo: true });
      setBusy(null);
    }
  }

  const rise = (delay: number) =>
    animate
      ? {
          initial: { opacity: 0, y: 12 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.6, ease: EASE, delay },
        }
      : { initial: false as const, animate: { opacity: 1, y: 0 } };

  const demoReady = Boolean(demo?.configured);
  const walletAddress = wallet.address;

  // The primary button says whose money moves. Never a generic "Pay": with a
  // wallet it names the wallet, and the demo path is labelled as the demo's.
  let primary: { label: string; onClick: () => void; disabled?: boolean };
  if (walletAddress) {
    const whose = wallet.kind === "embedded" ? "your Privy wallet" : shortHex(walletAddress);
    primary = { label: `Pay ${quote?.priceLabel ?? ""} USDC from ${whose}`, onClick: () => void payFromWallet() };
  } else if (wallet.available && !wallet.creatingWallet) {
    primary = {
      label: wallet.mode === "privy" ? `Log in to pay ${quote?.priceLabel ?? ""}` : `Connect a wallet to pay ${quote?.priceLabel ?? ""}`,
      onClick: wallet.login,
      disabled: wallet.connecting,
    };
  } else if (wallet.creatingWallet) {
    primary = { label: "Creating your wallet…", onClick: () => {}, disabled: true };
  } else if (demoReady) {
    primary = { label: `Pay ${quote?.priceLabel ?? ""} from demo account`, onClick: () => void payFromDemo() };
  } else {
    primary = { label: "No wallet available", onClick: () => {}, disabled: true };
  }
  const offerDemo = demoReady && (walletAddress !== null || wallet.available);

  return (
    <div className="mx-auto max-w-2xl text-center">
      <motion.div {...rise(0)}>
        <span className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white/[0.02] py-1 pl-1 pr-3 text-[12.5px] text-fg-3">
          <span className="rounded-full bg-white px-2 py-0.5 text-[10.5px] font-semibold text-black">
            NEW
          </span>
          Describe it. The network runs it.
        </span>
      </motion.div>

      <motion.div {...rise(0.06)} className="mt-8 flex justify-center">
        <Disc />
      </motion.div>

      <motion.h1
        {...rise(0.12)}
        className="mt-7 text-balance text-[26px] font-semibold leading-[1.15] tracking-[-0.03em] sm:text-[32px]"
      >
        Run a job on someone else&rsquo;s{" "}
        <span className="inline-flex translate-y-[2px] items-center gap-1.5 rounded-lg border border-[var(--line-2)] px-2.5 py-0.5 align-baseline text-[22px] sm:text-[27px]">
          Claude
        </span>
      </motion.h1>

      <motion.p {...rise(0.18)} className="mx-auto mt-3.5 max-w-md text-[14px] leading-relaxed text-fg-3">
        {info?.escrow
          ? "Paid per job in USDC from your own wallet, settled on Monad in about a second, and held in escrow until the work is delivered: released to the person whose machine ran it, or refunded."
          : "Paid per job in USDC from your own wallet, settled on Monad in about a second, straight to the person whose machine ran it."}
      </motion.p>

      {/* --- the input ------------------------------------------------------ */}
      <motion.div
        {...rise(0.24)}
        className="mt-8 rounded-2xl border border-[var(--line-2)] bg-surface p-2 text-left transition-colors focus-within:border-[var(--line-3)]"
      >
        <textarea
          ref={inputRef}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            reset();
          }}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter submits. Plain Enter must insert a newline — prompts
            // are multi-line by nature and losing one to a stray keystroke is
            // the kind of thing people don't forgive.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void getQuote();
            }
          }}
          rows={2}
          placeholder="Tell the network what to build…"
          aria-label="What needs doing?"
          className="w-full resize-none bg-transparent px-3.5 pb-2 pt-2.5 text-[14.5px] leading-relaxed text-fg outline-none placeholder:text-fg-4"
        />

        <div className="flex items-center gap-2 px-1.5 pb-1">
          <ModelPicker
            value={model}
            options={models}
            onChange={(id) => {
              setModel(id);
              reset();
            }}
          />

          <label className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-[12px] text-fg-3 transition-colors focus-within:border-[var(--line-2)]">
            <span className="text-fg-4">max</span>
            <span aria-hidden>$</span>
            <input
              value={maxUsd}
              onChange={(e) => {
                setMaxUsd(e.target.value);
                reset();
              }}
              inputMode="decimal"
              aria-label="Most you'll pay in US dollars"
              className="tnum w-[42px] bg-transparent text-fg outline-none"
            />
          </label>

          <button
            type="button"
            onClick={getQuote}
            disabled={busy !== null || prompt.trim().length === 0}
            aria-label="Get a quote"
            className={cn(
              "ml-auto flex h-8 w-8 items-center justify-center rounded-full transition-all duration-200",
              "bg-white text-black hover:bg-white/90 active:scale-95",
              "disabled:pointer-events-none disabled:bg-white/10 disabled:text-fg-4",
            )}
          >
            {busy === "quoting" ? (
              <span className="block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
            ) : (
              <span aria-hidden className="-translate-y-px text-[15px]">↑</span>
            )}
          </button>
        </div>
      </motion.div>

      <motion.div {...rise(0.27)}>
        <PrivateToggle
          on={isPrivate}
          busy={busy === "unlocking"}
          onChange={(next) => {
            setPrivate(next);
            reset();
          }}
        />
      </motion.div>

      <motion.p {...rise(0.3)} className="mt-2.5 text-[11.5px] text-fg-4">
        ⌘↵ to quote · you see the provider and the price before anything is paid
      </motion.p>

      {/* --- quote ---------------------------------------------------------- */}
      <AnimatePresence>
        {quote ? (
          <motion.div
            initial={animate ? { opacity: 0, height: 0 } : false}
            animate={{ opacity: 1, height: "auto" }}
            exit={animate ? { opacity: 0, height: 0 } : undefined}
            transition={{ duration: 0.32, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="mt-5 rounded-2xl border border-[var(--line-2)] bg-surface p-5 text-left">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[14.5px] font-medium text-fg">{quote.provider.label}</p>
                  <p className="mt-0.5 truncate text-[12.5px] text-fg-3">
                    {quote.provider.capability}
                    {quote.provider.model ? ` · ${quote.provider.model}` : ""} ·{" "}
                    {quote.provider.stats.jobsCompleted} done
                    {quote.provider.agentId ? ` · agent #${quote.provider.agentId}` : ""}
                  </p>
                  <p className="mono mt-1.5 truncate text-[11.5px] text-fg-4">
                    {quote.escrow ? (
                      <>
                        <a
                          href={quote.escrow.explorerUrl || explorerAddress(NETWORK, quote.escrow.address)}
                          target="_blank"
                          rel="noreferrer"
                          className="underline-offset-4 hover:text-fg-2 hover:underline"
                        >
                          XorvEscrow {shortHex(quote.escrow.address)}
                        </a>{" "}
                        holds it →{" "}
                      </>
                    ) : null}
                    pays →{" "}
                    <a
                      href={quote.provider.addressUrl || explorerAddress(NETWORK, quote.provider.address)}
                      target="_blank"
                      rel="noreferrer"
                      className="underline-offset-4 hover:text-fg-2 hover:underline"
                    >
                      {shortHex(quote.provider.address)}
                    </a>{" "}
                    {quote.escrow ? " on delivery" : " · the provider, never the broker"}
                  </p>
                </div>
                <p className="tnum shrink-0 text-[19px] font-semibold text-fg">{quote.priceLabel}</p>
              </div>

              {quotedKey ? (
                <p className="mt-3 flex items-center gap-1.5 border-t border-[var(--line)] pt-3 text-[11.5px] leading-relaxed text-fg-3">
                  <LockGlyph className="text-fg-2" />
                  Private — the answer is sealed to your inbox key{" "}
                  <span className="mono text-fg-2">{keys.snapshot.inbox?.fingerprint}</span>{" "}on the provider&rsquo;s machine.
                </p>
              ) : null}

              {quote.screening || quote.routing ? (
                <div className="mt-3 space-y-1 border-t border-[var(--line)] pt-3 text-[11.5px] leading-relaxed text-fg-4">
                  {quote.screening ? (
                    <p>
                      {describeScreening(quote.screening)}{" "}
                      <span className="mono text-fg-4">· {quote.screening.model}</span>
                    </p>
                  ) : null}
                  {quote.routing ? (
                    <>
                      <p>
                        {describeRouting(quote.routing)} <span className="mono text-fg-4">· {quote.routing.model}</span>
                      </p>
                      <RoutingTrace routing={quote.routing} className="pt-1" />
                    </>
                  ) : null}
                </div>
              ) : null}

              <button
                type="button"
                onClick={primary.onClick}
                disabled={busy !== null || primary.disabled}
                className="mt-4 w-full rounded-lg bg-white px-4 py-2.5 text-[13.5px] font-medium text-black transition-all hover:bg-white/90 active:scale-[0.985] disabled:opacity-40"
              >
                {busy === "signing"
                  ? "Approve the payment in your wallet…"
                  : busy === "settling"
                    ? "Settling on Monad…"
                    : busy === "saving"
                      ? "Saving to your encrypted history…"
                      : primary.label}
              </button>

              {offerDemo ? (
                <button
                  type="button"
                  onClick={() => void payFromDemo()}
                  disabled={busy !== null}
                  className="mt-2 w-full rounded-lg border border-[var(--line)] px-4 py-2 text-[12.5px] text-fg-2 transition-colors hover:border-[var(--line-2)] hover:text-fg disabled:opacity-40"
                >
                  Pay from demo account instead
                </button>
              ) : null}

              <p className="mt-2.5 text-center text-[11.5px] leading-relaxed text-fg-4">
                {quote.escrow
                  ? `You sign once, for exactly ${quote.priceLabel} into XorvEscrow. It goes to this provider only when the job delivers, and comes back to you in full if it doesn't; after ${new Date(quote.escrow.deadline * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} anyone can refund it. The facilitator pays the gas.`
                  : `You sign once, for exactly ${quote.priceLabel} to this provider. The facilitator pays the gas.`}
              </p>

              <button
                type="button"
                onClick={reset}
                className="mt-1.5 w-full text-center text-[12px] text-fg-4 transition-colors hover:text-fg-2"
              >
                Cancel — nothing has been paid
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {error ? (
          <motion.div
            key={error.message}
            role="alert"
            initial={animate ? { opacity: 0, y: -4 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={animate ? { opacity: 0 } : undefined}
            transition={{ duration: 0.2, ease: EASE }}
            className={cn(
              "mt-4 rounded-lg border px-3.5 py-2.5 text-left text-[12.5px] leading-relaxed",
              error.kind === "rejected"
                ? "border-[var(--line)] bg-white/[0.02] text-fg-3"
                : "border-fail/25 bg-fail/[0.06] text-fail",
            )}
          >
            <p>{error.message}</p>
            {error.kind === "insufficient_funds" && !error.demo && IS_TESTNET && CHAIN_CONFIG.faucets.usdc ? (
              <p className="mt-1.5 text-fg-3">
                Get test USDC from the{" "}
                <a
                  href={CHAIN_CONFIG.faucets.usdc}
                  target="_blank"
                  rel="noreferrer"
                  className="text-fg-2 underline underline-offset-2 hover:text-fg"
                >
                  Circle faucet ↗
                </a>{" "}
                (choose Monad Testnet){walletAddress ? <> for <span className="mono">{shortHex(walletAddress)}</span></> : null}
                {demoReady ? ", or pay from the demo account." : "."}
              </p>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * The private-job switch, and — when it is on — what it does and doesn't
 * hide, stated before anyone pays. The honest version matters more than the
 * reassuring one: the prompt is still read by the screen, the router and the
 * provider; what's sealed is the answer.
 */
function PrivateToggle({ on, busy, onChange }: { on: boolean; busy: boolean; onChange: (next: boolean) => void }) {
  const keys = usePrivateKeys();
  const { snapshot, error } = keys;
  const anyOpen = Boolean(snapshot.inbox || snapshot.vault || snapshot.vaultAuth);

  return (
    <div className="mt-3 text-left">
      <div className="flex items-center gap-2.5 px-1">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Private job"
          onClick={() => onChange(!on)}
          className={cn(
            "relative h-[18px] w-[30px] shrink-0 rounded-full border transition-colors duration-200",
            on ? "border-white bg-white" : "border-[var(--line-2)] bg-transparent hover:border-[var(--line-3)]",
          )}
        >
          <span
            className={cn(
              "absolute top-[2px] h-3 w-3 rounded-full transition-all duration-200",
              on ? "left-[14px] bg-black" : "left-[2px] bg-fg-3",
            )}
          />
        </button>
        <span className="text-[12.5px] text-fg-2">Private job</span>
        <span className="text-[11.5px] text-fg-4">· answer sealed to your passkey</span>
      </div>

      {on ? (
        <div className="mt-2.5 rounded-xl border border-[var(--line)] bg-white/[0.015] px-3.5 py-3 text-[11.5px] leading-relaxed text-fg-3">
          <p>
            <span className="text-fg-2">Sealed:</span>{" "}the answer. The provider encrypts it on their machine to a key only your
            passkey can re-derive, so the broker, the public job list and the on-chain receipt hold ciphertext. Open it here or on
            any device your passkey syncs to.
          </p>
          <p className="mt-1.5">
            <span className="text-fg-2">Not sealed:</span>{" "}the prompt. The safety screen, the router and the provider read it; the
            public job list doesn&rsquo;t show it, and your copy goes into your encrypted history.
          </p>
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-2.5">
            <span className="mono text-[11px] text-fg-4">
              {busy
                ? `confirm with your passkey · ${snapshot.pending ?? "…"}`
                : keys.ready
                  ? `keys unlocked · inbox ${snapshot.inbox?.fingerprint}`
                  : "quoting asks your passkey 3 times: inbox, vault, vault-auth"}
            </span>
            {!anyOpen && !busy ? (
              <button
                type="button"
                onClick={() => void keys.create().then((ok) => (ok ? keys.unlock() : false))}
                className="rounded-md border border-[var(--line-2)] px-2 py-1 text-[11.5px] text-fg-2 transition-colors hover:border-[var(--line-3)] hover:text-fg"
              >
                New here? Create an encryption passkey
              </button>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className={cn("mt-2", error.kind === "cancelled" ? "text-fg-3" : "text-fail")}>
              {error.message}
            </p>
          ) : null}
          <p className="mt-2 text-fg-4">
            The passkey only derives encryption keys; it is not a wallet and can&rsquo;t move money.{" "}
            <Link href="/private" className="text-fg-3 underline underline-offset-2 hover:text-fg-2">
              How it works
            </Link>
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The disc.
 *
 * Ripar puts a brushed-metal orb here. Xorv's palette has no metal in it, so
 * this is the mark's own geometry instead — four beams and a hub, rotating
 * once on arrival and then stopping. Decorative, hence `aria-hidden`.
 */
function Disc() {
  return (
    <div aria-hidden className="relative h-[68px] w-[68px]">
      <div className="absolute inset-0 rounded-full border border-[var(--line-2)]" />
      <div className="absolute inset-[9px] rounded-full border border-[var(--line)]" />
      <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full p-[19px] text-fg">
        <g stroke="currentColor" strokeWidth="7" strokeLinecap="round" fill="none">
          <path d="M14 14 L27 27" />
          <path d="M37 37 L50 50" />
          <path d="M50 14 L37 27" />
          <path d="M27 37 L14 50" />
        </g>
        <rect
          x="27.6"
          y="27.6"
          width="8.8"
          height="8.8"
          rx="2.2"
          transform="rotate(45 32 32)"
          fill="currentColor"
        />
      </svg>
    </div>
  );
}
