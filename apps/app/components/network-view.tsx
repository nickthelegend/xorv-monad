"use client";

import { useEffect, useState } from "react";
import { api, formatUsd, type NetworkInfo } from "@/lib/api";
import { Empty, Ext, Panel, Row, Skeleton } from "@/components/ui";
import { XORV_CHAIN, explorerToken, stablecoinSymbol } from "@/lib/chains";

interface Receipt {
  sequence: number;
  blockNumber: number;
  transactionHash: string;
  author: string;
  payload: {
    data?: {
      jobId?: string;
      providerAddress?: string;
      payer?: string;
      amount?: string;
      asset?: string;
      transactionHash?: string;
      durationMs?: number;
      ok?: boolean;
      /** Where an escrowed payment ended up; absent for direct payments and older receipts. */
      settlement?: { escrow: string; state: "released" | "refunded"; paidTo: string; transactionHash: string };
    };
  } | null;
}

/**
 * What a receipt says happened to the money. An escrowed job's receipt names
 * the release or refund; without that, only a successful job paid its provider.
 */
function outcome(d: NonNullable<NonNullable<Receipt["payload"]>["data"]>): { to?: string; label: string } {
  if (d.settlement) {
    return d.settlement.state === "released"
      ? { to: d.settlement.paidTo, label: "released" }
      : { label: "refunded to the buyer" };
  }
  return d.ok === false ? { label: "not paid out" } : { to: d.providerAddress, label: "paid" };
}

export function NetworkView() {
  const [info, setInfo] = useState<NetworkInfo | null>(null);
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [log, setLog] = useState<{ address: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const [net, rec] = await Promise.all([api.network(), api.receipts()]);
        if (!alive) return;
        setInfo(net);
        // The broker types the entry payload as `unknown` on purpose — anyone
        // can append to the log, so an entry could have been written by someone
        // else. Narrow it here, where we know what shape our own receipts take.
        setReceipts(rec.receipts as Receipt[]);
        setLog(rec.log);
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
          The facilitator relays the buyer&rsquo;s signed authorization and pays the network fee
          in ETH, which is why a buyer needs no ETH at all — only the stablecoin they pay with.
        </p>
        <div className="mt-4 border-t border-[var(--line)] pt-1">
          <Row label="network">{info?.network ?? "—"}</Row>
          <Row label="facilitator">{info?.facilitator.description ?? "—"}</Row>
          <Row label="fee payer">{info?.facilitator.feePayer ?? "—"}</Row>
          {(info?.stablecoins ?? []).map((t, i) => (
            <Row key={t.address} label={i === 0 ? `${t.symbol.toLowerCase()} (default)` : t.symbol.toLowerCase()}>
              <Ext href={explorerToken(t.address)}>{t.address} ↗</Ext>
            </Row>
          ))}
          <Row label="providers live">
            <span className="tnum">{info?.stats.providersLive ?? "—"}</span>
          </Row>
          <Row label="jobs settled">
            <span className="tnum">{info?.stats.jobsSettled ?? "—"}</span>
          </Row>
          <Row label="paid to providers">
            <span className="tnum">{info ? formatUsd(info.stats.paidUsdMicros) : "—"}</span>
          </Row>
        </div>
      </Panel>

      {info?.escrow || info?.registry ? (
        <Panel className="p-5">
          <h2 className="text-[13px] font-medium text-fg">Contracts</h2>
          <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
            A buyer&rsquo;s money waits in the escrow until the job delivers, and anyone can refund it
            once the deadline passes. Every settlement writes the provider&rsquo;s track record into
            the registry — a Rust contract on Arbitrum Stylus — so reputation is earned on chain,
            not claimed.
          </p>
          <div className="mt-4 border-t border-[var(--line)] pt-1">
            {info.escrow ? (
              <>
                <Row label="XorvEscrow">
                  <Ext href={info.escrow.url}>{info.escrow.address} ↗</Ext>
                </Row>
                <Row label="refundable after">
                  <span className="tnum">{Math.round(info.escrow.deadlineSeconds / 60)} min</span>
                </Row>
              </>
            ) : null}
            {info.registry ? (
              <Row label="XorvRegistry (Stylus)">
                <Ext href={info.registry.url}>{info.registry.address} ↗</Ext>
              </Row>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <Panel className="p-5">
        <h2 className="text-[13px] font-medium text-fg">Audit log</h2>
        <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
          One contract, three indexed streams. Append-only, publicly readable, ordered by block.
          You don&rsquo;t have to trust this dashboard — read the events yourself from any {XORV_CHAIN.name} RPC.
        </p>
        {info && !info.log ? (
          <p className="mt-4 border-t border-[var(--line)] pt-3 text-[12.5px] text-fg-4">
            This broker has no audit log contract configured, so nothing is being written to one.
            Payments are still on-chain transfers you can look up.
          </p>
        ) : null}
        <div className="mt-4 border-t border-[var(--line)]">
          {info?.log
            ? Object.entries(info.logPublished).map(([stream, count]) => (
                <div
                  key={stream}
                  className="flex items-center justify-between gap-4 border-b border-[var(--line)] py-3"
                >
                  <p className="text-[13px] capitalize text-fg-2">{stream}</p>
                  <p className="tnum text-[13px] text-fg">{count}</p>
                </div>
              ))
            : null}
        </div>
        {info?.log ? (
          <p className="mono mt-3 truncate text-[11.5px] text-fg-4">
            <Ext href={info.log.url}>{info.log.address} ↗</Ext>
          </p>
        ) : null}
      </Panel>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-medium text-fg">Receipts from the chain</h2>
          {log ? (
            <span className="text-[11.5px] text-fg-4">
              <Ext href={log.url}>contract ↗</Ext>
            </span>
          ) : null}
        </div>

        {!receipts ? (
          <Skeleton rows={3} />
        ) : receipts.length === 0 ? (
          <Empty
            title="No receipts yet"
            hint="Every completed job writes one here, read straight from the chain."
          />
        ) : (
          <ul className="border-t border-[var(--line)]">
            {receipts.map((receipt) => {
              const d = receipt.payload?.data ?? {};
              const o = outcome(d);
              return (
                <li
                  key={receipt.sequence}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[var(--line)] py-3.5"
                >
                  <span className="mono text-[12.5px] text-fg-2">{d.jobId ?? "—"}</span>
                  <span className="mono truncate text-[11.5px] text-fg-4">
                    {o.to ? `${d.payer} → ${o.to}` : d.payer}
                  </span>
                  <span className="mono tnum text-[12.5px] text-fg-2">
                    {d.amount} units {d.asset ? stablecoinSymbol(d.asset) : ""} · {o.label}
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
