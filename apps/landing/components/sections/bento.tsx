"use client";

import { useRef, type ReactNode } from "react";
import { Section, SectionHeading } from "@/components/ui/kit";
import { Reveal } from "@/components/ui/reveal";
import { canAnimate, gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/utils";

/**
 * The bento.
 *
 * Four cards, each showing a real mechanic rather than an icon standing in for
 * one. The motion here is **explanatory** — that is the one purpose that earns a
 * longer beat and a marketing budget: the network card draws its own routing,
 * the earnings card grows its own bars, the receipt card settles a real payment.
 * A reader who watches these for four seconds understands the product.
 *
 * Every timeline is scroll-triggered and plays once. Nothing loops: a card that
 * animates forever is a card you stop reading.
 */

function Card({
  className,
  visual,
  title,
  body,
}: {
  className?: string;
  visual: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-surface",
        className,
      )}
    >
      <div className="relative min-h-[210px] flex-1 overflow-hidden">{visual}</div>
      <div className="p-6">
        <h3 className="text-[16px] font-medium tracking-[-0.015em] text-fg">{title}</h3>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-fg-2">{body}</p>
      </div>
    </div>
  );
}

export function Bento() {
  const scope = useRef<HTMLDivElement | null>(null);

  useGSAP(
    () => {
      if (!canAnimate()) return;

      // Hide only what the timeline is about to reveal, and only now that we
      // know it will run. Encoding these in the markup would leave the card
      // blank for anyone the animation never reaches.
      gsap.set("[data-winner]", { opacity: 0 });
      gsap.set("[data-settle-fill]", { scaleX: 0 });
      gsap.set("[data-wire]", { strokeDashoffset: 260 });

      const once = (trigger: string) => ({
        trigger,
        start: "top 82%",
        once: true,
      });

      // 1 — routing. Wires draw, then a packet runs the winning path.
      const routing = gsap.timeline({ scrollTrigger: once("[data-bento='routing']") });
      routing
        .fromTo(
          "[data-wire]",
          { strokeDashoffset: 260 },
          { strokeDashoffset: 0, duration: 0.9, stagger: 0.12, ease: "power2.inOut" },
        )
        .from("[data-node]", { scale: 0, opacity: 0, duration: 0.45, stagger: 0.07, ease: "back.out(2)" }, "-=0.5")
        .set("[data-packet]", { attr: { cx: 24, cy: 44 }, opacity: 1 })
        .to("[data-packet]", {
          keyframes: [
            { attr: { cx: 96, cy: 44 } },
            { attr: { cx: 168, cy: 92 } },
            { attr: { cx: 244, cy: 60 } },
          ],
          duration: 1.1,
          ease: "power1.inOut",
        })
        .to("[data-packet]", { opacity: 0, duration: 0.25 })
        .fromTo("[data-winner]", { opacity: 0 }, { opacity: 1, duration: 0.3 }, "-=0.2");

      // 2 — earnings. Bars grow from the baseline; the latest one lands last.
      gsap.from("[data-bar]", {
        scrollTrigger: once("[data-bento='earnings']"),
        scaleY: 0,
        transformOrigin: "bottom",
        duration: 0.7,
        stagger: 0.06,
        ease: "power3.out",
      });
      gsap.from("[data-earn-total]", {
        scrollTrigger: once("[data-bento='earnings']"),
        opacity: 0,
        y: 6,
        duration: 0.5,
        delay: 0.5,
        ease: "power3.out",
      });

      // 3 — adapters. The grid settles, then the one that won the job lights up.
      const adapters = gsap.timeline({ scrollTrigger: once("[data-bento='adapters']") });
      adapters
        .from("[data-chip]", { opacity: 0, scale: 0.86, duration: 0.4, stagger: { each: 0.05, from: "center" }, ease: "power2.out" })
        .to("[data-chip-active]", { borderColor: "rgba(255,255,255,0.4)", color: "#fafafa", duration: 0.35 }, "-=0.15");

      // 4 — settlement. The three states of a payment, in order.
      const settle = gsap.timeline({ scrollTrigger: once("[data-bento='settle']") });
      settle
        .from("[data-settle-row]", { opacity: 0, x: -8, duration: 0.4, stagger: 0.18, ease: "power2.out" })
        .fromTo("[data-settle-fill]", { scaleX: 0 }, { scaleX: 1, duration: 0.8, ease: "power2.inOut" }, "-=0.4")
        .from("[data-settle-tx]", { opacity: 0, y: 4, duration: 0.4 }, "-=0.15");
    },
    { scope },
  );

  return (
    <Section id="bento" className="border-t border-[var(--line)]">
      <Reveal>
        <SectionHeading
          title="What actually happens"
          sub="Four mechanics, not four adjectives. The network routes on price and liveness, the money moves on-chain, and the record is public."
        />
      </Reveal>

      <div ref={scope} className="mt-16 grid gap-4 md:grid-cols-2">
        <Reveal className="md:col-span-1">
          <Card
            className="h-full"
            visual={<RoutingVisual />}
            title="Routed to the cheapest live node"
            body="Providers prove liveness by heartbeat, not by a status page. The matcher sorts on price, then track record, then load."
          />
        </Reveal>

        <Reveal delay={0.06}>
          <Card
            className="h-full"
            visual={<EarningsVisual />}
            title="Earnings you can watch accrue"
            body="Every completed job pays out immediately, in full, to the provider's own account. No payout schedule, no platform float."
          />
        </Reveal>

        <Reveal delay={0.1}>
          <Card
            className="h-full"
            visual={<AdaptersVisual />}
            title="Whatever you already have installed"
            body="Claude Code, Codex, Grok, OpenCode, or any OpenAI-compatible endpoint — including a local model on your own GPU."
          />
        </Reveal>

        <Reveal delay={0.14}>
          <Card
            className="h-full"
            visual={<SettleVisual />}
            title="Settled, then receipted"
            body="A signed transfer, co-signed by the facilitator so the buyer never needs gas, then a receipt written to Hedera Consensus Service."
          />
        </Reveal>
      </div>
    </Section>
  );
}

/* --------------------------------------------------------------------------
   Visuals. All monochrome, all aria-hidden — they are diagrams of a mechanic,
   and the mechanic is stated in the prose beneath each one.
-------------------------------------------------------------------------- */

function RoutingVisual() {
  return (
    <div data-bento="routing" className="absolute inset-0 flex items-center justify-center p-6">
      <svg viewBox="0 0 320 140" className="w-full max-w-[320px]" aria-hidden>
        {/* wires */}
        <g fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="1">
          {[
            "M24 44 C 60 44, 62 92, 96 44",
            "M96 44 C 130 44, 134 92, 168 92",
            "M168 92 C 205 92, 208 60, 244 60",
            "M244 60 C 274 60, 280 70, 296 70",
          ].map((d, i) => (
            <path key={i} data-wire d={d} strokeDasharray="260" strokeDashoffset="0" />
          ))}
        </g>

        {/* nodes */}
        {[
          [24, 44, "buyer"],
          [96, 44, "$0.42"],
          [168, 92, "$0.25"],
          [244, 60, "$0.31"],
        ].map(([x, y, label], i) => (
          <g key={i} data-node>
            <circle cx={x as number} cy={y as number} r="4" fill="#0a0a0a" stroke="rgba(255,255,255,0.34)" />
            <text
              x={x as number}
              y={(y as number) - 12}
              textAnchor="middle"
              className="fill-[#6e6e6e] font-mono"
              style={{ fontSize: 9 }}
            >
              {label}
            </text>
          </g>
        ))}

        {/* the packet, and the node it lands on */}
        <circle data-packet cx="168" cy="92" r="3" fill="#fafafa" opacity="0" />
        <circle data-winner cx="168" cy="92" r="9" fill="none" stroke="#4ade80" strokeWidth="1" opacity="1" />
      </svg>
    </div>
  );
}

function EarningsVisual() {
  // Real shape of a week: quiet, then a run of jobs.
  const bars = [18, 34, 26, 52, 40, 74, 62];
  return (
    <div data-bento="earnings" className="absolute inset-0 flex flex-col justify-end p-6">
      <div className="rounded-xl border border-[var(--line)] bg-black p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] text-fg-4">Last 7 days</span>
          <span data-earn-total className="tnum text-[13px] font-medium text-fg">
            $4.9100
          </span>
        </div>
        <div className="mt-4 flex h-[76px] items-end gap-1.5">
          {bars.map((h, i) => (
            <div
              key={i}
              data-bar
              className={cn(
                "flex-1 rounded-[3px]",
                i === bars.length - 2 ? "bg-white" : "bg-white/[0.16]",
              )}
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function AdaptersVisual() {
  const chips = [
    "claude",
    "codex",
    "grok",
    "opencode",
    "ollama",
    "vLLM",
    "LM Studio",
    "openrouter",
    "echo",
  ];
  return (
    <div data-bento="adapters" className="absolute inset-0 flex items-center justify-center p-6">
      <div className="grid grid-cols-3 gap-2">
        {chips.map((chip, i) => (
          <span
            key={chip}
            data-chip
            {...(i === 4 ? { "data-chip-active": true } : {})}
            className={cn(
              "mono flex h-[42px] items-center justify-center rounded-lg border px-2 text-[10.5px]",
              i === 4
                ? "border-[var(--line-2)] text-fg-2"
                : "border-[var(--line)] text-fg-4",
            )}
          >
            {chip}
          </span>
        ))}
      </div>
    </div>
  );
}

function SettleVisual() {
  return (
    <div data-bento="settle" className="absolute inset-0 flex flex-col justify-center gap-2.5 p-6">
      {[
        ["402", "Payment Required"],
        ["sign", "buyer signs a transfer"],
        ["+gas", "facilitator co-signs"],
      ].map(([tag, label]) => (
        <div key={tag} data-settle-row className="flex items-center gap-3">
          <span className="mono w-[42px] shrink-0 text-right text-[10.5px] text-fg-4">{tag}</span>
          <span className="text-[12px] text-fg-3">{label}</span>
        </div>
      ))}

      <div className="mt-1.5 h-px w-full overflow-hidden bg-white/[0.08]">
        <div
          data-settle-fill
          className="h-full w-full origin-left bg-white/50"
        />
      </div>

      <div data-settle-tx className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-live" />
        <span className="mono truncate text-[10.5px] text-fg-3">
          0.0.9842030@1785477682.129
        </span>
      </div>
    </div>
  );
}
