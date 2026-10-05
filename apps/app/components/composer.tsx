"use client";

import { useRouter } from "next/navigation";
import { ModelPicker, type ModelOption } from "./model-picker";
import { useWallet } from "@/components/wallet-provider";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BROKER_URL, api, formatUsd } from "@/lib/api";
import { DEFAULT_STABLECOIN, XORV_CHAIN } from "@/lib/chains";
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
  /** Epoch ms after which the broker refuses payment for this quote. */
  expiresAt: number;
  provider: {
    label: string;
    address: string;
    capability: string;
    adapter: string;
    model: string | null;
    stats: { jobsCompleted: number; jobsFailed: number };
  };
  /** One row per stablecoin the broker accepts, USDG first. */
  accepts: Array<{ asset: string; amount: string; symbol?: string }>;
  /** Present when the broker settles through XorvEscrow: where the money waits, and until when. */
  escrow?: { address: string; jobId: string; deadline: number; addressUrl?: string } | null;
}

const MODELS: ModelOption[] = [
  { id: "", label: "Any model", hint: "cheapest" },
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok" },
  { id: "opencode", label: "OpenCode" },
  { id: "openai-compatible", label: "OpenAI-compatible", hint: "local" },
];

/** A browser network failure says "Failed to fetch"; say what it means instead. */
function friendly(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(message)) {
    return `Can't reach the broker at ${BROKER_URL} — it may be offline. Nothing was paid; try again in a moment.`;
  }
  // EIP-1193 code 4001, which x402 wraps in "Failed to create payment
  // payload: …" and every wallet words differently.
  if ((err as { code?: number })?.code === 4001 || /user (denied|rejected)|rejected the request|request rejected/i.test(message)) {
    return "You declined the signature in your wallet, so nothing was paid. Press pay again when you're ready.";
  }
  return message;
}

/** The broker refuses longer prompts (services/broker: "prompt is too long"). */
const PROMPT_MAX = 20_000;

export function Composer() {
  const router = useRouter();
  const animate = useEntrance();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const [prompt, setPrompt] = useState("");
  // Whether this broker pays through XorvEscrow, which decides what the
  // promise under the headline may honestly say. Unknown (null) until the
  // broker answers: defaulting to "no" printed "straight to the provider"
  // on an escrow deployment whenever the broker was unreachable.
  const [escrowed, setEscrowed] = useState<boolean | null>(null);
  useEffect(() => {
    void api
      .network()
      .then((info) => setEscrowed(Boolean(info.escrow)))
      .catch(() => {});
  }, []);
  const [model, setModel] = useState("");
  const [maxUsd, setMaxUsd] = useState("0.50");
  const { session, address } = useWallet();

  const [quote, setQuote] = useState<Quote | null>(null);
  /** Stablecoin symbol the buyer picked; null means "the first one my wallet can afford". */
  const [token, setToken] = useState<string | null>(null);
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
    setToken(null);
    setError(null);
  };

  // A ref, not the `busy` state: a double click lands twice before React
  // re-renders the disabled button, and each landed as its own request — three
  // payment attempts for one quote, found by triple-clicking Pay.
  const inFlight = useRef(false);

  // A quote is payable for a few minutes. Left open past that, the card used to
  // offer "Run it" until the broker answered 404; now it says so itself and
  // offers a fresh quote with the same prompt.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!quote) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [quote]);
  const expired = quote ? clock >= quote.expiresAt : false;

  async function getQuote(): Promise<void> {
    if (!prompt.trim() || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy("quoting");
    setQuote(null);
    try {
      // Checked here so an oversized prompt never leaves the browser — a pasted
      // 200 KB file used to be uploaded just to be told it was too long.
      if (prompt.length > PROMPT_MAX) {
        throw new Error(
          `Keep the prompt under ${PROMPT_MAX.toLocaleString()} characters — this one is ${prompt.length.toLocaleString()}.`,
        );
      }
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
      setError(friendly(err));
    } finally {
      setBusy(null);
      inFlight.current = false;
    }
  }

  async function pay(): Promise<void> {
    if (!quote || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy("paying");
    try {
      // With a wallet connected the x402 round trip happens in this tab and the
      // user signs their own transfer. Without one we fall back to the server
      // route, which pays from the deployment's demo account — same protocol,
      // different money, and worth being honest about in the button label.
      if (session) {
        const { payQuoteWithWallet } = await import("@/lib/pay-with-wallet");
        const { jobId } = await payQuoteWithWallet(session, BROKER_URL, quote.quoteId, {
          accepts: quote.accepts,
          token,
        });
        router.push(`/jobs/${jobId}`);
        return;
      }
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteId: quote.quoteId }),
      });
      const body = (await res.json()) as { jobId?: string; error?: string };
      // 409 with a job id: this quote was already paid (Pay pressed again after
      // going back). That job is the one the buyer wants, not an error.
      if (res.status === 409 && body.jobId) {
        router.push(`/jobs/${body.jobId}`);
        return;
      }
      if (!res.ok || !body.jobId) throw new Error(body.error ?? `Payment failed (${res.status}).`);
      router.push(`/jobs/${body.jobId}`);
    } catch (err) {
      setError(friendly(err));
      setBusy(null);
      inFlight.current = false;
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
        {escrowed === null ? (
          <>Paid per job in {DEFAULT_STABLECOIN.symbol} on {XORV_CHAIN.name}.</>
        ) : escrowed ? (
          <>
            Paid per job in {DEFAULT_STABLECOIN.symbol} on {XORV_CHAIN.name}, held in escrow until
            the work is delivered — and refundable if it isn&rsquo;t.
          </>
        ) : (
          <>
            Paid per job in {DEFAULT_STABLECOIN.symbol}, settled on {XORV_CHAIN.name} in about a
            second, straight to the person whose machine ran it.
          </>
        )}
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
        {prompt.length > PROMPT_MAX * 0.9 ? (
          <span className={prompt.length > PROMPT_MAX ? "text-fail" : undefined}>
            {" "}
            · {prompt.length.toLocaleString()} / {PROMPT_MAX.toLocaleString()} characters
          </span>
        ) : null}
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
                    {quote.escrow ? (
                      <>pays → XorvEscrow {quote.escrow.address} · then {quote.provider.address}</>
                    ) : (
                      <>pays → {quote.provider.address}</>
                    )}
                  </p>
                </div>
                <p className="tnum shrink-0 text-[19px] font-semibold text-fg">{quote.priceLabel}</p>
              </div>

              {/*
                Which stablecoin to pay with. Only shown when the broker offers
                more than one, and only meaningful with a wallet: "auto" pays in
                the first one the wallet holds enough of, USDG first.
              */}
              {session && quote.accepts.length > 1 ? (
                <div className="mt-4 flex items-center gap-1.5 text-[12px]">
                  <span className="text-fg-4">Pay with</span>
                  {[null, ...quote.accepts.map((a) => a.symbol ?? a.asset)].map((sym) => (
                    <button
                      key={sym ?? "auto"}
                      type="button"
                      onClick={() => setToken(sym)}
                      className={cn(
                        "rounded-md border px-2 py-0.5 transition-colors",
                        token === sym
                          ? "border-[var(--line-3)] text-fg"
                          : "border-[var(--line-2)] text-fg-3 hover:text-fg-2",
                      )}
                    >
                      {sym ?? "auto"}
                    </button>
                  ))}
                </div>
              ) : null}
              <p className="mt-4 text-[12px] leading-relaxed text-fg-3">
                Paid in{" "}
                {quote.accepts.map((a) => a.symbol ?? "stablecoin").join(" or ") ||
                  DEFAULT_STABLECOIN.symbol}
                {quote.escrow ? (
                  <>
                    , held in escrow until the job delivers and refundable if it doesn&rsquo;t — by
                    anyone, after {new Date(quote.escrow.deadline * 1000).toLocaleTimeString()}.
                  </>
                ) : (
                  <>, straight to the provider.</>
                )}{" "}
                You need <span className="text-fg-2">no ETH</span> — you sign an authorization and
                the facilitator pays the gas.
              </p>

              {expired && busy !== "paying" ? (
                <>
                  <p className="mt-3 text-[12px] text-fg-3">
                    This quote expired — prices and providers move, so it is only good for a few minutes.
                    Nothing was paid.
                  </p>
                  <button
                    type="button"
                    onClick={() => void getQuote()}
                    disabled={busy !== null}
                    className="mt-2 w-full rounded-lg bg-white px-4 py-2.5 text-[13.5px] font-medium text-black transition-all hover:bg-white/90 active:scale-[0.985] disabled:opacity-40"
                  >
                    {busy === "quoting" ? "Getting a new quote…" : "Get a new quote"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={pay}
                  disabled={busy !== null}
                  className="mt-3 w-full rounded-lg bg-white px-4 py-2.5 text-[13.5px] font-medium text-black transition-all hover:bg-white/90 active:scale-[0.985] disabled:opacity-40"
                >
                  {busy === "paying"
                    ? `Signing and settling on ${XORV_CHAIN.name}…`
                    : session
                      ? `Pay ${quote.priceLabel} from your wallet and run`
                      : `Run it — the demo account pays ${quote.priceLabel}`}
                </button>
              )}

              <button
                type="button"
                onClick={reset}
                // Once signing has started the payment may land, so offering
                // "nothing has been paid" would be a promise we can't keep.
                disabled={busy === "paying"}
                className="mt-2.5 w-full text-center text-[12px] text-fg-4 transition-colors hover:text-fg-2 disabled:cursor-default disabled:opacity-40 disabled:hover:text-fg-4"
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
