"use client";

import { useEffect, useState } from "react";
import { api, formatUsd, type NetworkInfo } from "@/lib/api";
import { Empty, Ext, Panel, Row, Skeleton } from "@/components/ui";

interface Receipt {
  consensusAt: string;
  sequence: number;
  payload: {
    data?: {
      jobId?: string;
      providerAccountId?: string;
      payer?: string;
      amount?: string;
      asset?: string;
      transactionId?: string;
      durationMs?: number;
      ok?: boolean;
    };
  } | null;
}

const HBAR = "0.0.0";

export function NetworkView() {
  const [info, setInfo] = useState<NetworkInfo | null>(null);
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [topic, setTopic] = useState<{ id: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const [net, rec] = await Promise.all([api.network(), api.receipts()]);
        if (!alive) return;
        setInfo(net);
        // The broker types the topic payload as `unknown` on purpose — a
        // message on a public topic could have been written by anyone. Narrow
        // it here, where we know what shape our own receipts take.
        setReceipts(rec.receipts as Receipt[]);
        setTopic(rec.topic);
        setError(null);
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

  if (error && !info) return <Empty title="Can't reach the broker" hint={error} />;

  return (
    <div className="space-y-8">
      {/* Facts, as a definition list. Four numbers in four boxes would say
          "we have metrics" without saying anything true. */}
      <Panel className="p-5">
        <h2 className="text-[13px] font-medium text-fg">Settlement</h2>
        <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
          The facilitator co-signs and pays the network fee on every settlement, which is why a
          buyer needs no HBAR at all.
        </p>
        <div className="mt-4 border-t border-[var(--line)] pt-1">
          <Row label="network">{info?.network ?? "—"}</Row>
          <Row label="facilitator">{info?.facilitator.description ?? "—"}</Row>
          <Row label="fee payer">{info?.facilitator.feePayer ?? "—"}</Row>
          <Row label="usdc">
            {info ? (
              <Ext
                href={`https://hashscan.io/${
                  info.network === "hedera:mainnet" ? "mainnet" : "testnet"
                }/token/${info.usdc}`}
              >
                {info.usdc} ↗
              </Ext>
            ) : (
              "—"
            )}
          </Row>
          <Row label="providers live">
            <span className="tnum">{info?.stats.providersLive ?? "—"}</span>
          </Row>
          <Row label="jobs settled">
            <span className="tnum">{info?.stats.jobsCompleted ?? "—"}</span>
          </Row>
          <Row label="paid to providers">
            <span className="tnum">{info ? formatUsd(info.stats.paidUsdMicros) : "—"}</span>
          </Row>
        </div>
      </Panel>

      <Panel className="p-5">
        <h2 className="text-[13px] font-medium text-fg">Consensus topics</h2>
        <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
          Append-only, publicly readable, ordered by consensus timestamp. You don&rsquo;t have to
          trust this dashboard — read them yourself.
        </p>
        <div className="mt-4 border-t border-[var(--line)]">
          {info
            ? Object.entries(info.topics).map(([kind, t]) => (
                <div
                  key={kind}
                  className="flex items-center justify-between gap-4 border-b border-[var(--line)] py-3"
                >
                  <div>
                    <p className="text-[13px] capitalize text-fg-2">{kind}</p>
                    <p className="mono text-[11.5px] text-fg-4">{t?.id ?? "not configured"}</p>
                  </div>
                  <div className="text-right">
                    <p className="tnum text-[13px] text-fg">
                      {info.hcsPublished[kind as keyof NetworkInfo["hcsPublished"]] ?? 0}
                    </p>
                    {t ? (
                      <p className="text-[11.5px] text-fg-4">
                        <Ext href={t.url}>open ↗</Ext>
                      </p>
                    ) : null}
                  </div>
                </div>
              ))
            : null}
        </div>
      </Panel>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-medium text-fg">Receipts from the ledger</h2>
          {topic ? (
            <span className="text-[11.5px] text-fg-4">
              <Ext href={topic.url}>topic {topic.id} ↗</Ext>
            </span>
          ) : null}
        </div>

        {!receipts ? (
          <Skeleton rows={3} />
        ) : receipts.length === 0 ? (
          <Empty
            title="No receipts yet"
            hint="Every completed job writes one here, read straight from a Hedera mirror node."
          />
        ) : (
          <ul className="border-t border-[var(--line)]">
            {receipts.map((receipt) => {
              const d = receipt.payload?.data ?? {};
              return (
                <li
                  key={receipt.sequence}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[var(--line)] py-3.5"
                >
                  <span className="mono text-[12.5px] text-fg-2">{d.jobId ?? "—"}</span>
                  <span className="mono truncate text-[11.5px] text-fg-4">
                    {d.payer} → {d.providerAccountId}
                  </span>
                  <span className="mono tnum text-[12.5px] text-fg-2">
                    {d.amount} {d.asset === HBAR ? "tℏ" : "µUSDC"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
