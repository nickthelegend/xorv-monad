"use client";

import { useEffect, useState } from "react";
import { Empty, Ext, Panel, Row, Skeleton } from "@/components/ui";
import { explorerAddress } from "@/lib/chains";
import { fetchHistory, INDEXER_URL, type IndexedHistory, unitsToUsd } from "@/lib/indexer";

/**
 * The network's history, from the Envio index: totals, time to settle, the
 * provider leaderboard by on-chain score, and the last week day by day.
 *
 * Rendered only when an indexer is configured. Monad's RPC can't serve this
 * history directly (100 blocks per log query), so without the index there is
 * honestly nothing to show, and no empty panel pretends otherwise.
 */
export function IndexedHistoryPanel() {
  const [data, setData] = useState<IndexedHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!INDEXER_URL) return;
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const next = await fetchHistory();
        if (alive) {
          setData(next);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!INDEXER_URL) return null;

  const net = data?.network;
  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium text-fg">History</h2>
        <span className="text-[11.5px] text-fg-4">indexed by Envio HyperIndex</span>
      </div>
      <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
        Every escrowed job, every provider&rsquo;s on-chain record and the day-by-day totals,
        folded from the escrow, registry and audit-log events.
      </p>

      {error && !data ? (
        <p role="alert" className="mt-4 border-t border-[var(--line)] pt-3 text-[12.5px] text-fail">
          Can&rsquo;t reach the indexer right now ({error}). The live numbers above still come from the broker.
        </p>
      ) : !data ? (
        <div className="mt-4">
          <Skeleton rows={4} />
        </div>
      ) : !net ? (
        <div className="mt-4">
          <Empty title="Nothing indexed yet" hint="The first funded job will appear here within seconds." />
        </div>
      ) : (
        <>
          <div className="mt-4 border-t border-[var(--line)] pt-1">
            <Row label="jobs funded">
              <span className="tnum">{net.jobsFunded}</span>
            </Row>
            <Row label="released · refunded">
              <span className="tnum">
                {net.jobsReleased} · {net.jobsRefunded}
                {net.refundsAtFault ? ` (${net.refundsAtFault} provider at fault)` : ""}
              </span>
            </Row>
            <Row label="volume · paid to providers">
              <span className="tnum">
                {unitsToUsd(net.volume)} · {unitsToUsd(net.paidToProviders)}
              </span>
            </Row>
            <Row label="mean time to settle">
              <span className="tnum">{net.settledCount ? `${Number(net.meanSecondsToSettle)} s` : "—"}</span>
            </Row>
            <Row label="providers · buyers">
              <span className="tnum">
                {net.providers} · {net.buyers}
              </span>
            </Row>
          </div>

          {data.providers.length ? (
            <div className="mt-6">
              <h3 className="text-[12px] font-medium text-fg-2">Providers by on-chain score</h3>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[30rem] text-left text-[12.5px]">
                  <thead>
                    <tr className="border-b border-[var(--line)] text-[11.5px] text-fg-4">
                      <th className="py-2 font-normal">provider</th>
                      <th className="py-2 font-normal">score</th>
                      <th className="py-2 font-normal">done · failed</th>
                      <th className="py-2 text-right font-normal">earned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.providers.map((p) => (
                      <tr key={p.id} className="border-b border-[var(--line)]">
                        <td className="mono py-2.5 text-fg-2">
                          <Ext href={explorerAddress(p.id)}>
                            {p.id.slice(0, 8)}…{p.id.slice(-4)}
                          </Ext>
                          {!p.active ? <span className="ml-2 text-[11px] text-fg-4">inactive</span> : null}
                        </td>
                        <td className="tnum py-2.5 text-fg">{(p.scoreBps / 100).toFixed(1)}%</td>
                        <td className="tnum py-2.5 text-fg-3">
                          {Number(p.completed)} · {Number(p.failed)}
                        </td>
                        <td className="tnum py-2.5 text-right text-fg-2">{unitsToUsd(p.earned)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {data.days.length ? (
            <div className="mt-6">
              <h3 className="text-[12px] font-medium text-fg-2">By day (UTC)</h3>
              <ul className="mt-2 border-t border-[var(--line)]">
                {data.days.map((d) => (
                  <li key={d.day} className="flex items-baseline justify-between gap-4 border-b border-[var(--line)] py-2.5 text-[12.5px]">
                    <span className="mono text-fg-3">{d.day}</span>
                    <span className="tnum text-fg-2">
                      {d.jobsReleased} released · {d.jobsRefunded} refunded · {unitsToUsd(d.volume)}
                      {d.activeProviders ? ` · ${d.activeProviders} provider${d.activeProviders === 1 ? "" : "s"} active` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}
