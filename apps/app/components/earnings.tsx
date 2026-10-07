"use client";

import Link from "next/link";
import { useCallback } from "react";
import { explorerTx, formatUsdc, shortHex } from "@xorv/protocol/web";
import { api, type Job, type Provider } from "@/lib/api";
import { usePoll } from "@/lib/hooks";
import { NETWORK } from "@/lib/network";
import { providerEarnings, type PayoutState } from "@/lib/earnings";
import { Ext, Panel, Skeleton } from "@/components/ui";
import { Ago, useNow } from "@/components/ago";
import { cn } from "@/lib/utils";

const STATE: Record<PayoutState, { label: string; tone: string }> = {
  paid: { label: "paid", tone: "text-live" },
  released: { label: "released", tone: "text-live" },
  held: { label: "in escrow", tone: "text-fg-2" },
  refunded: { label: "refunded", tone: "text-fg-4" },
};

/**
 * What a provider has earned, and where each dollar is: released to them, held
 * in XorvEscrow while a job runs, or refunded to a buyer. Every payout links
 * to the transaction that moved it. Read from the broker's job records, which
 * keep those transaction hashes; refreshed every 15 seconds.
 */
export function EarningsPanel({ provider }: { provider: Provider }) {
  const { data: jobs, error } = usePoll<Job[]>(useCallback(() => api.jobs(500, provider.id), [provider.id]), 15_000);
  // The clock after hydration (components/ago.tsx); before it, the newest job stands in for "today".
  const now = useNow();

  if (!jobs) {
    return (
      <section>
        <h2 className="mb-3 text-[13px] font-medium text-fg">Earnings</h2>
        {error ? <p className="text-[12.5px] text-fg-4">Can&rsquo;t reach the broker right now.</p> : <Skeleton rows={2} />}
      </section>
    );
  }

  const e = providerEarnings(jobs, provider.address, { now: now ?? Math.max(0, ...jobs.map((j) => j.createdAt)) });
  const peak = e.byDay.reduce((m, d) => (d.units > m ? d.units : m), 0n);

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium text-fg">Earnings</h2>
        <span className="text-[11.5px] text-fg-4">every payout links to its transaction on Monad</span>
      </div>
      <Panel className="p-5">
        <div className="grid grid-cols-3 gap-4">
          <Figure label="earned" value={formatUsdc(e.earned)} strong />
          <Figure label="held in escrow" value={formatUsdc(e.held)} />
          <Figure label="refunded to buyers" value={formatUsdc(e.refunded)} />
        </div>

        <div className="mt-5 border-t border-[var(--line)] pt-4">
          <p className="mb-2 text-[11.5px] text-fg-4">earned per day, last {e.byDay.length} days (UTC)</p>
          <div className="flex h-24 items-end gap-[3px]" role="img" aria-label="Earnings per day">
            {e.byDay.map((d) => {
              const pct = peak === 0n ? 0 : Number((d.units * 1000n) / peak) / 10;
              return (
                <div key={d.day} className="flex h-full flex-1 flex-col justify-end" title={`${d.day}: ${formatUsdc(d.units)}`}>
                  <div
                    className={cn("w-full rounded-[2px]", d.units > 0n ? "bg-fg-2" : "bg-[var(--line)]")}
                    style={{ height: d.units > 0n ? `${Math.max(pct, 4)}%` : "2px" }}
                  />
                </div>
              );
            })}
          </div>
          <div className="mono mt-1.5 flex justify-between text-[10.5px] text-fg-4">
            <span>{e.byDay[0]?.day.slice(5)}</span>
            <span>today</span>
          </div>
        </div>
      </Panel>

      {e.payouts.length === 0 ? (
        <p className="mt-3 text-[12.5px] text-fg-4">No paid jobs yet. A payout appears here the moment a buyer&rsquo;s payment lands.</p>
      ) : (
        <ul className="mt-3 border-t border-[var(--line)]">
          {e.payouts.slice(0, 20).map((p) => (
            <li key={p.jobId} className="flex items-baseline justify-between gap-3 border-b border-[var(--line)] py-2.5">
              <div className="min-w-0">
                <Link href={`/jobs/${encodeURIComponent(p.jobId)}`} className="block truncate text-[13px] text-fg-2 hover:text-fg">
                  {p.title}
                </Link>
                <p className="mono mt-0.5 truncate text-[11px] text-fg-4">
                  <Ago at={p.at} />
                  {p.tx ? (
                    <>
                      {" · "}
                      <Ext href={explorerTx(NETWORK, p.tx)}>{shortHex(p.tx)} ↗</Ext>
                    </>
                  ) : null}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className={cn("tnum text-[13px] font-medium", p.state === "refunded" ? "text-fg-4 line-through" : "text-fg")}>
                  {formatUsdc(p.units)}
                </p>
                <p className={cn("text-[11px]", STATE[p.state].tone)}>{STATE[p.state].label}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <p className={cn("tnum truncate font-semibold tracking-[-0.01em]", strong ? "text-[22px] text-fg" : "text-[16px] text-fg-2")}>{value}</p>
      <p className="mt-0.5 text-[11.5px] text-fg-4">{label}</p>
    </div>
  );
}
