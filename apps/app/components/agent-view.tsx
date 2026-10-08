"use client";

import Link from "next/link";
import { useCallback } from "react";
import { explorerAddress, shortHex } from "@xorv/protocol/web";
import { api, formatAgo, formatUsd, type AgentSession, type Job } from "@/lib/api";
import { usePoll } from "@/lib/hooks";
import { NETWORK } from "@/lib/network";
import { Empty, Ext, Panel, Row, Skeleton } from "@/components/ui";
import { JobRows } from "@/components/live-lists";

/** How much of its budget an agent has used: spent, plus held in escrow, as a share. */
export function budgetUse(s: Pick<AgentSession, "budgetUsdMicros" | "spentUsdMicros" | "heldUsdMicros">): { spentPct: number; heldPct: number } | null {
  if (!s.budgetUsdMicros) return null;
  const pct = (v: number) => Math.min(100, (v / s.budgetUsdMicros!) * 100);
  return { spentPct: pct(s.spentUsdMicros), heldPct: Math.min(100 - pct(s.spentUsdMicros), pct(s.heldUsdMicros)) };
}

function Budget({ s }: { s: AgentSession }) {
  const use = budgetUse(s);
  if (!use) return <p className="text-[12px] text-fg-4">No session budget declared: only the per-job cap applies.</p>;
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.06]" role="img" aria-label={`Budget: ${use.spentPct.toFixed(0)}% spent`}>
        <div className="h-full bg-fg-2" style={{ width: `${use.spentPct}%` }} />
        <div className="h-full bg-fg-4" style={{ width: `${use.heldPct}%` }} />
      </div>
      <p className="tnum mt-1.5 text-[12px] text-fg-3">
        {formatUsd(s.spentUsdMicros)} spent
        {s.heldUsdMicros ? ` · ${formatUsd(s.heldUsdMicros)} held in escrow` : ""} of {formatUsd(s.budgetUsdMicros)} budget
        {s.refundedUsdMicros ? ` · ${formatUsd(s.refundedUsdMicros)} refunded` : ""}
      </p>
    </div>
  );
}

/** Every agent session the broker has seen, newest first. */
export function AgentList() {
  const { data, error } = usePoll<AgentSession[]>(useCallback(() => api.agents(), []), 10_000);
  if (error && !data) return <Empty title="Can't reach the broker" />;
  if (!data) return <Skeleton rows={3} />;
  if (data.length === 0) {
    return (
      <Empty
        title="No agents have bought anything yet"
        hint="An MCP agent (packages/mcp) tags its quotes with its session; its jobs, spend and budget appear here."
      />
    );
  }
  return (
    <ul className="space-y-3">
      {data.map((s) => (
        <li key={s.session}>
          <Link href={`/agents/${s.session}`} className="block transition-opacity hover:opacity-80">
            <Panel className="p-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[14px] text-fg">{s.name}</p>
                <span className="text-[11.5px] text-fg-4">
                  {s.jobs} job{s.jobs === 1 ? "" : "s"} · last {formatAgo(s.lastAt)}
                </span>
              </div>
              <p className="mono mt-0.5 text-[11px] text-fg-4">
                {s.client.toUpperCase()} session {s.session}
              </p>
              <div className="mt-3">
                <Budget s={s} />
              </div>
            </Panel>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** One agent session: who paid, what it bought, how much of its budget it used. */
export function AgentView({ session }: { session: string }) {
  const { data, error } = usePoll<AgentSession & { jobList: Job[] }>(useCallback(() => api.agent(session), [session]), 5_000);
  if (error && !data) return <Empty title="No such agent session" hint="It may be from before the broker restarted, or the link is wrong." />;
  if (!data) return <Skeleton rows={3} />;
  return (
    <div className="space-y-6">
      <Panel className="p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[13px] font-medium text-fg">{data.name}</h2>
          <span className="text-[11.5px] text-fg-4">{data.client.toUpperCase()} agent</span>
        </div>
        <p className="mono mt-1 break-all text-[11px] text-fg-4">session {data.session}</p>
        <div className="mt-4">
          <Budget s={data} />
        </div>
        <div className="mt-4 border-t border-[var(--line)] pt-1">
          <Row label="paid from">
            {data.payers.map((p, i) => (
              <span key={p}>
                {i ? ", " : ""}
                <Ext href={explorerAddress(NETWORK, p)}>{shortHex(p)}</Ext>
              </span>
            ))}
          </Row>
          <Row label="jobs">
            <span className="tnum">
              {data.jobs} bought · {data.completed} completed
            </span>
          </Row>
          <Row label="active">
            {new Date(data.firstAt).toLocaleTimeString()} – {new Date(data.lastAt).toLocaleTimeString()}
          </Row>
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed text-fg-4">
          The session and its budget are what the agent declared with its quotes; the spend is the broker&rsquo;s own payment
          records, each with its transaction. The MCP server enforces the budget itself: past it, it refuses to pay.
        </p>
      </Panel>
      <section>
        <h2 className="mb-3 text-[13px] font-medium text-fg">What it bought</h2>
        <JobRows jobs={data.jobList} />
      </section>
    </div>
  );
}
