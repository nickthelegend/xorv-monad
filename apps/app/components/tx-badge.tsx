"use client";

import { useEffect, useState } from "react";
import type { TxState } from "@xorv/protocol/web";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const DONE = new Set<TxState>(["finalized", "reverted", "dropped"]);

const STYLE: Record<TxState, string> = {
  pending: "border-[var(--line-2)] text-fg-3",
  proposed: "border-[var(--line-2)] text-fg-3",
  voted: "border-fg-3 text-fg-2",
  finalized: "border-live/50 text-live",
  reverted: "border-fail/50 text-fail",
  dropped: "border-fail/50 text-fail",
  unknown: "border-[var(--line)] text-fg-4",
};

/**
 * One transaction's live state on the broker's chain: pending in Monad's
 * txpool, then Proposed, Voted and Finalized as consensus advances. Polls
 * once a second until it is final (or reverted, or dropped), then stops.
 * On a local fork there is no consensus to watch, so it just says "mined".
 */
export function TxBadge({ hash }: { hash: string }) {
  const [state, setState] = useState<{ state: TxState; local: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      polls += 1;
      try {
        const s = await api.tx(hash);
        if (!alive) return;
        setState({ state: s.state, local: s.chain === "local" });
        if (DONE.has(s.state) || s.chain === "local") return;
      } catch {
        if (!alive) return;
      }
      if (polls < 60) timer = setTimeout(tick, 1_000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [hash]);

  if (!state) return null;
  // A fork has no consensus (anvil's safe/finalized tags just trail latest), so any mined
  // transaction there is simply mined.
  const mined = state.state === "proposed" || state.state === "voted" || state.state === "finalized";
  const label = state.local && mined ? "mined · local fork" : state.state;
  return (
    <span
      className={cn("ml-1.5 inline-block rounded border px-1 align-middle text-[10px] leading-[14px]", STYLE[state.local && mined ? "finalized" : state.state])}
      title={state.local ? "A local fork has no consensus: mined means done" : "From Monad's txpool and its latest / safe / finalized heads"}
      data-tx-state={state.state}
    >
      {label}
    </span>
  );
}
