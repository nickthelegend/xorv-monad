"use client";

import { useEffect, useRef, useState } from "react";
import { shortHash, usd, useLive, type LiveState } from "@/lib/live";
import { cn } from "@/lib/utils";

/**
 * The network, right now, as a provider's terminal would print it.
 *
 * Every line is read from the broker this site points at — the live nodes,
 * what they sell and have earned, their on-chain record, and the most recent
 * jobs with the transactions that settled them. It plays in line by line the
 * first time it arrives and refreshes quietly after. If the broker can't be
 * reached it says exactly that; it never falls back to a made-up session.
 *
 * Marked `aria-hidden`: a screen reader walking a terminal line by line gains
 * nothing, and the same facts are stated in prose and in the ledger below.
 */

type Line = () => React.ReactNode;

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

function linesFor(live: LiveState): Line[] {
  const lines: Line[] = [
    () => (
      <>
        <span className="text-fg-4">$</span> <span className="text-fg">xorv status</span>
      </>
    ),
  ];
  if (!live.loaded) return lines;
  if (!live.reachable) {
    lines.push(() => <span className="text-fg-3">broker unreachable — no live data to show</span>);
    return lines;
  }
  const online = live.providers.filter((p) => p.status !== "offline");
  lines.push(() => (
    <>
      <Ok /> <span className="text-fg-2">{online.length} provider{online.length === 1 ? "" : "s"} live</span>
      {online.length ? (
        <span className="text-fg-4">
          {" "}
          —{" "}
          {[
            ...new Set(
              online.flatMap((p) =>
                p.capabilities.filter((c) => p.available?.[c.id] !== false).map((c) => c.displayName),
              ),
            ),
          ].join(", ") || "none available right now"}
        </span>
      ) : null}
    </>
  ));
  lines.push(() => <Rule />);
  for (const p of online.slice(0, 2)) {
    const sellable = p.capabilities.filter((c) => p.available?.[c.id] !== false);
    const cheapest = Math.min(...(sellable.length ? sellable : p.capabilities).map((c) => c.priceUsdMicros));
    lines.push(() => (
      <>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-live align-middle" />{" "}
        <span className="font-medium text-fg">LIVE</span>
        <Sep />
        <span className="text-fg-2">{p.label}</span>
        <Sep />
        <span className="text-fg-3">beat {ago(p.lastHeartbeatAt)}</span>
      </>
    ));
    lines.push(() => (
      <>
        <span className="tnum text-fg-2">earned</span>{" "}
        <span className="tnum font-medium text-fg">{usd(p.stats.earnedUsdcMicros)}</span>
        <Sep />
        <span className="tnum text-fg-2">{p.stats.jobsCompleted} done</span>
        <Sep />
        <span className="tnum text-fg-3">from {usd(cheapest)}</span>
      </>
    ));
    if (p.onchain?.registered) {
      lines.push(() => (
        <>
          <Ok /> <span className="text-fg-2">on-chain record</span>{" "}
          <span className="tnum text-fg-3">
            {p.onchain!.completed}✓ {p.onchain!.failed}✕ · score {(p.onchain!.score / 100).toFixed(0)}%
          </span>
        </>
      ));
    }
  }
  if (!online.length) {
    lines.push(() => <span className="text-fg-3">no provider online — start one with xorv start</span>);
  }
  const recent = live.jobs.filter((j) => j.payment).slice(0, 3);
  if (recent.length) lines.push(() => <Rule />);
  for (const j of recent) {
    const tx = j.payment!.escrow?.releaseTx ?? j.payment!.escrow?.refundTx ?? j.payment!.transactionHash;
    const verb = j.payment!.escrow
      ? j.payment!.escrow.state === "released"
        ? "released"
        : j.payment!.escrow.state === "refunded"
          ? "refunded"
          : "in escrow"
      : "settled";
    lines.push(() => (
      <>
        <span className="text-fg-4">▸</span> <span className="text-fg">{j.id}</span>{" "}
        <span className="text-fg-3">{j.adapter ?? "any"}</span>{" "}
        <span className="tnum text-fg-2">{usd(j.priceUsdMicros ?? 0)}</span>{" "}
        <span className="text-fg-3">{j.status}</span>
      </>
    ));
    lines.push(() => (
      <span className="pl-4 text-fg-4">
        {verb} {shortHash(tx)}
      </span>
    ));
  }
  if (!recent.length) lines.push(() => <span className="text-fg-4">no paid jobs yet</span>);
  return lines;
}

export function NodePanel({ animate = true }: { animate?: boolean }) {
  const live = useLive();
  const lines = linesFor(live);
  const [shown, setShown] = useState(animate ? 0 : 999);
  const played = useRef(false);

  // Play in once, the first time real data arrives; later refreshes swap in place.
  useEffect(() => {
    if (!animate || played.current || !live.loaded) return;
    played.current = true;
    setShown(0);
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= 40) clearInterval(timer);
    }, 180);
    return () => clearInterval(timer);
  }, [animate, live.loaded]);

  const visible = lines.slice(0, shown);
  const done = shown >= lines.length;

  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-t-[20px] border border-b-0 border-[var(--line)] bg-black md:rounded-t-[26px]"
    >
      {/* Window chrome. Monochrome dots — three coloured circles would be the
          only decorative colour on the page, and they mean nothing here. */}
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3">
        <span className="flex gap-1.5">
          <Dot />
          <Dot />
          <Dot />
        </span>
        <span className="mono ml-2 text-[11px] text-fg-4">xorv — the network, live</span>
        <span className="ml-auto flex items-center gap-1.5 rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] text-fg-4">
          {live.reachable ? <span className="h-1 w-1 rounded-full bg-live" /> : null}
          {live.reachable ? "live from the broker" : live.loaded ? "broker unreachable" : "connecting"}
        </span>
      </div>

      <div className="mono min-h-[300px] space-y-[7px] overflow-hidden p-5 text-[12.5px] leading-relaxed sm:min-h-[330px] sm:p-6 sm:text-[13px]">
        {visible.map((line, i) => (
          <div key={i} className="truncate">
            {line()}
          </div>
        ))}
        {done ? (
          <div className="pt-1">
            <span className="text-fg-4">$</span>{" "}
            <span className="cursor inline-block h-[13px] w-[7px] translate-y-[2px] bg-fg-3" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Ok() {
  return <span className="text-fg-3">✓</span>;
}

function Dot() {
  return <span className="h-2.5 w-2.5 rounded-full border border-[var(--line-2)]" />;
}

function Sep() {
  return <span className="px-2 text-fg-4">│</span>;
}

function Rule() {
  return <span className={cn("block text-fg-4")}>{"─".repeat(38)}</span>;
}
