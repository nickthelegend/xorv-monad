"use client";

import { useRouter } from "next/navigation";
import { ModelPicker, type ModelOption } from "./model-picker";
import { useWallet } from "@/components/wallet-provider";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BROKER_URL, formatUsd } from "@/lib/api";
import { EASE, useEntrance } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The composer.
 *
 * One input, centred, that takes a sentence and turns it into a paid job on
 * someone else's machine. It is the whole product in a single control, so it
 * gets the whole viewport rather than sharing a column with a list.
 *
 * The quote is disclosed *before* payment and never skipped: it is the moment
 * the buyer learns who is about to run their prompt and what it will cost. A
 * one-click "just do it" would be faster and worse.
 */

interface Quote {
  quoteId: string;
  priceUsdMicros: number;
  priceLabel: string;
  provider: {
    label: string;
    accountId: string;
    capability: string;
    adapter: string;
    model: string | null;
    stats: { jobsCompleted: number; jobsFailed: number };
  };
  accepts: Array<{ asset: string; amount: string }>;
}

const MODELS: ModelOption[] = [
  { id: "", label: "Any model", hint: "cheapest" },
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok" },
  { id: "opencode", label: "OpenCode" },
  { id: "openai-compatible", label: "OpenAI-compatible", hint: "local" },
  { id: "echo", label: "Echo", hint: "test" },
];

const HBAR = "0.0.0";

export function Composer() {
  const router = useRouter();
  const animate = useEntrance();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [maxUsd, setMaxUsd] = useState("0.50");
  const [asset, setAsset] = useState<"usdc" | "hbar">("usdc");
  const { session, accountId } = useWallet();

  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState<"quoting" | "paying" | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
  };

  async function getQuote(): Promise<void> {
    if (!prompt.trim()) return;
    setError(null);
    setBusy("quoting");
    setQuote(null);
    try {
      const maxPriceUsdMicros = Math.round(Number(maxUsd.replace(/[$,\s]/g, "")) * 1_000_000);
      if (!Number.isFinite(maxPriceUsdMicros) || maxPriceUsdMicros <= 0) {
        throw new Error("Set a maximum price above zero.");
      }
      const res = await fetch(`${BROKER_URL}/api/quotes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, adapter: model || null, maxPriceUsdMicros }),
      });
      const body = (await res.json()) as Quote & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Broker returned ${res.status}.`);
      setQuote(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function pay(): Promise<void> {
    if (!quote) return;
    setError(null);
    setBusy("paying");
    try {
      // With a wallet connected the x402 round trip happens in this tab and the
      // user signs their own transfer. Without one we fall back to the server
      // route, which pays from the deployment's demo account — same protocol,
      // different money, and worth being honest about in the button label.
      if (session) {
        const { payQuoteWithWallet } = await import("@/lib/pay-with-wallet");
        const { jobId } = await payQuoteWithWallet(session, BROKER_URL, quote.quoteId, asset);
        router.push(`/jobs/${jobId}`);
        return;
      }
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteId: quote.quoteId, asset }),
      });
      const body = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !body.jobId) throw new Error(body.error ?? `Payment failed (${res.status}).`);
      router.push(`/jobs/${body.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  const hbarAmount = quote?.accepts.find((a) => a.asset === HBAR)?.amount;
  const rise = (delay: number) =>
    animate
      ? {
          initial: { opacity: 0, y: 12 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.6, ease: EASE, delay },
        }
      : { initial: false as const, animate: { opacity: 1, y: 0 } };

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
        Paid per job in USDC, settled on Hedera in about three seconds, straight to the person whose
        machine ran it.
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
            options={MODELS}
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
                  </p>
                  <p className="mono mt-1.5 truncate text-[11.5px] text-fg-4">
                    pays → {quote.provider.accountId}
                  </p>
                </div>
                <p className="tnum shrink-0 text-[19px] font-semibold text-fg">{quote.priceLabel}</p>
              </div>

              <div className="mt-4 flex gap-2" role="group" aria-label="Payment asset">
                {(["usdc", "hbar"] as const).map((option) => {
                  const disabled = option === "hbar" && !hbarAmount;
                  return (
                    <button
                      key={option}
                      type="button"
                      disabled={disabled}
                      aria-pressed={asset === option}
                      onClick={() => setAsset(option)}
                      className={cn(
                        "flex-1 rounded-lg border px-3 py-2 text-[12.5px] font-medium transition-colors",
                        asset === option
                          ? "border-[var(--line-3)] bg-white/[0.07] text-fg"
                          : "border-[var(--line)] text-fg-3 hover:text-fg-2",
                        disabled && "cursor-not-allowed opacity-40",
                      )}
                    >
                      Pay in {option.toUpperCase()}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={pay}
                disabled={busy !== null}
                className="mt-3 w-full rounded-lg bg-white px-4 py-2.5 text-[13.5px] font-medium text-black transition-all hover:bg-white/90 active:scale-[0.985] disabled:opacity-40"
              >
                {busy === "paying"
                  ? "Signing and settling on Hedera…"
                  : `Pay ${quote.priceLabel} and run`}
              </button>

              <button
                type="button"
                onClick={reset}
                className="mt-2.5 w-full text-center text-[12px] text-fg-4 transition-colors hover:text-fg-2"
              >
                Cancel — nothing has been paid
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {error ? (
          <motion.p
            key={error}
            role="alert"
            initial={animate ? { opacity: 0, y: -4 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={animate ? { opacity: 0 } : undefined}
            transition={{ duration: 0.2, ease: EASE }}
            className="mt-4 rounded-lg border border-fail/25 bg-fail/[0.06] px-3.5 py-2.5 text-left text-[12.5px] leading-relaxed text-fail"
          >
            {error}
          </motion.p>
        ) : null}
      </AnimatePresence>
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
