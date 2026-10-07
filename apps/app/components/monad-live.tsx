"use client";

import { createContext, useContext, type ReactNode } from "react";
import { explorerAddress, explorerBlock, explorerTx, shortHex } from "@xorv/protocol/web";
import { COMMIT_STATES, headOf, medianMs, type CommitState, type TrackedBlock } from "@/lib/commit-states";
import { CHAIN_CONFIG, IS_LOCAL_CHAIN, LIVE_LEDGER, MONAD_WS_URL, NETWORK, NETWORK_LABEL } from "@/lib/network";
import { useMonadLive, type LiveLog, type LiveStatus } from "@/lib/use-monad-live";
import { Ext, Panel } from "@/components/ui";
import { cn } from "@/lib/utils";

type Live = ReturnType<typeof useMonadLive>;
const LiveContext = createContext<Live | null>(null);

const WATCHED = [LIVE_LEDGER[NETWORK], CHAIN_CONFIG.erc8004.identity, CHAIN_CONFIG.erc8004.reputation].filter((a): a is `0x${string}` => Boolean(a));

/** One socket per tab, shared by the rail's heartbeat and the network page's pipeline. */
export function MonadLiveProvider({ children }: { children: ReactNode }) {
  const live = useMonadLive(MONAD_WS_URL, WATCHED);
  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

function useLive(): Live {
  const live = useContext(LiveContext);
  if (!live) throw new Error("MonadLiveProvider is missing");
  return live;
}

const CHIP: Record<CommitState, string> = {
  Proposed: "border-[var(--line-2)] bg-transparent text-fg-3",
  Voted: "border-fg-3 bg-white/[0.06] text-fg-2",
  Finalized: "border-live/60 bg-live/10 text-live",
  Verified: "border-live bg-live/20 text-live",
};

function statusText(status: LiveStatus): string {
  return status === "live" ? "live" : status === "paused" ? "paused (tab hidden)" : status === "unavailable" ? "unavailable" : "connecting…";
}

/** The rail's footer line: Monad's newest finalized block, and where this app's own contracts run. */
export function LiveHeartbeat() {
  const { pipeline, status } = useLive();
  const finalized = headOf(pipeline, "Finalized");
  const ms = medianMs(pipeline, "Finalized");
  return (
    <div className="mt-1.5 space-y-0.5">
      <p className="mono text-[11px] text-fg-4">
        {NETWORK_LABEL} ·{" "}
        {finalized !== null ? (
          <>
            final #{finalized.toLocaleString("en-US")}
            {ms !== null ? ` · ~${ms} ms` : ""}
          </>
        ) : (
          statusText(status)
        )}
      </p>
      {IS_LOCAL_CHAIN ? <p className="mono text-[11px] text-fg-4">payments: local fork</p> : null}
    </div>
  );
}

/**
 * The block pipeline, live: each new Monad block as a chip that moves from
 * Proposed to Voted, Finalized and Verified, with the milliseconds each step
 * took as this browser saw it, and Xorv's own contract events on the same
 * network with the commit state each has reached.
 */
export function CommitPipeline() {
  const { pipeline, logs, status } = useLive();
  const blocks = pipeline.blocks.slice(-12);

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium text-fg">Monad, live: every block through consensus</h2>
        <span className="flex items-center gap-1.5 text-[11.5px] text-fg-4">
          <span className={cn("h-1.5 w-1.5 rounded-full", status === "live" ? "breathe bg-live" : "bg-fg-4")} />
          {statusText(status)} · read-only <code className="mono">monadNewHeads</code> from {NETWORK_LABEL}
        </span>
      </div>
      <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
        Monad re-sends each block as consensus advances: Proposed and speculatively executed, Voted one slot later,
        Finalized after two (irreversible), Verified once its state root is agreed. These are this browser&rsquo;s
        timings from first sight of each proposal.
        {IS_LOCAL_CHAIN
          ? " This deployment's own payments run on a local fork of Monad testnet, so their timings are the fork's; this strip is the real network."
          : ""}
      </p>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {(["Voted", "Finalized", "Verified"] as const).map((state) => {
          const ms = medianMs(pipeline, state);
          return (
            <div key={state}>
              <p className="tnum text-[20px] font-semibold tracking-[-0.02em] text-fg">{ms !== null ? `${ms} ms` : "—"}</p>
              <p className="text-[11.5px] text-fg-4">median to {state.toLowerCase()}</p>
            </div>
          );
        })}
      </div>

      <ol className="mt-4 flex flex-wrap gap-1.5" aria-label="Recent Monad blocks">
        {blocks.length === 0 ? <li className="text-[12px] text-fg-4">waiting for the next block…</li> : null}
        {blocks.map((block) => (
          <BlockChip key={block.blockId} block={block} />
        ))}
      </ol>
      <p className="mt-2 flex flex-wrap gap-3 text-[11px] text-fg-4">
        {COMMIT_STATES.map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span className={cn("inline-block h-2 w-2 rounded-sm border", CHIP[s])} />
            {s}
          </span>
        ))}
        {pipeline.dropped > 0 ? <span>· {pipeline.dropped} competing proposal(s) dropped at finality</span> : null}
      </p>

      <div className="mt-5 border-t border-[var(--line)] pt-4">
        <p className="text-[12px] text-fg-2">
          Xorv on {NETWORK_LABEL}, live{" "}
          <span className="text-fg-4">
            · <code className="mono">monadLogs</code> for XorvLedger{LIVE_LEDGER[NETWORK] ? ` ${shortHex(LIVE_LEDGER[NETWORK]!)}` : ""} and the ERC-8004 registries
          </span>
        </p>
        {logs.length === 0 ? (
          <p className="mt-1.5 text-[12px] text-fg-4">
            No receipts, registrations or ratings since this page opened. Each one appears here the moment its block is
            proposed, then turns final.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {logs.slice(0, 8).map((log) => (
              <LogRow key={log.key} log={log} />
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function BlockChip({ block }: { block: TrackedBlock }) {
  const ms = block.ms[block.state];
  return (
    <li
      className={cn("mono rounded-md border px-2 py-1 text-[11px] transition-colors duration-300", CHIP[block.state])}
      title={`#${block.number} ${block.state}${COMMIT_STATES.map((s) => (block.ms[s] !== undefined ? ` · ${s} +${block.ms[s]} ms` : "")).join("")}`}
      data-state={block.state}
    >
      <Ext live href={explorerBlock(NETWORK, block.number)}>…{String(block.number).slice(-4)}</Ext>
      <span className="ml-1 opacity-80">{block.state === "Proposed" ? "·" : ms !== undefined ? `${ms}` : block.state[0]}</span>
    </li>
  );
}

const LABELS: Record<string, string> = Object.fromEntries(
  [
    [LIVE_LEDGER[NETWORK], "XorvLedger"],
    [CHAIN_CONFIG.erc8004.identity, "ERC-8004 identity"],
    [CHAIN_CONFIG.erc8004.reputation, "ERC-8004 reputation"],
  ]
    .filter((pair): pair is [string, string] => Boolean(pair[0]))
    .map(([address, name]) => [address.toLowerCase(), name]),
);

function LogRow({ log }: { log: LiveLog }) {
  const ms = log.ms.Finalized;
  return (
    <li className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="mono min-w-0 truncate text-fg-3">
        <Ext live href={explorerAddress(NETWORK, log.address)}>{LABELS[log.address.toLowerCase()] ?? shortHex(log.address)}</Ext>
        {" · "}
        <Ext live href={explorerTx(NETWORK, log.txHash)}>{shortHex(log.txHash)} ↗</Ext>
      </span>
      <span className={cn("shrink-0 rounded border px-1.5 text-[11px]", CHIP[log.state])}>
        {log.state}
        {ms !== undefined ? ` · ${ms} ms` : ""}
      </span>
    </li>
  );
}
