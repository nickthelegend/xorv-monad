"use client";

import { useEffect, useState } from "react";
import { api, formatUsd, type NetworkInfo } from "@/lib/api";
import { Empty, Ext, Panel, Row, Skeleton } from "@/components/ui";
import { XORV_CHAIN, explorerAddress, explorerToken, stablecoinSymbol } from "@/lib/chains";
import { IndexedHistoryPanel } from "@/components/indexed-history";

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
          in MON, which is why a buyer needs no MON at all — only the stablecoin they pay with.
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
            the registry contract on {XORV_CHAIN.name} — so reputation is earned on chain,
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
              <Row label="XorvRegistry">
                <Ext href={info.registry.url}>{info.registry.address} ↗</Ext>
              </Row>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {info ? <TrustPanel info={info} /> : null}

      <IndexedHistoryPanel />

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

/**
 * Who may move money, and what the broker's own key may sign.
 *
 * Both are enforced outside this broker: the identity gate in the escrow
 * contract (Cleanverse A-Pass), the operator's limits in Privy's policy
 * engine. This panel only reports them.
 */
function TrustPanel({ info }: { info: NetworkInfo }) {
  const gate = info.escrow?.identityGate ?? null;
  const signer = info.operator.signer;
  if (!info.escrow && !signer) return null;
  return (
    <Panel className="p-5">
      <h2 className="text-[13px] font-medium text-fg">Identity and signing</h2>
      <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
        Who can pay and be paid through the escrow, and what the broker&rsquo;s operator wallet is
        allowed to sign.{" "}
        {gate && signer?.mode === "privy"
          ? "Neither depends on trusting this broker: the escrow contract checks identity, and Privy’s policy engine checks every transaction before it is signed."
          : gate
            ? "The escrow contract checks identity itself, so it doesn’t depend on trusting this broker."
            : signer?.mode === "privy"
              ? "Privy’s policy engine checks every operator transaction before it is signed, so it doesn’t depend on trusting this broker."
              : "On this deployment neither is enforced: there is no identity gate on the escrow, and the operator key is not behind a Privy policy."}
      </p>
      <div className="mt-4 border-t border-[var(--line)] pt-1">
        {info.escrow ? (
          <Row label="identity gate" wrap>
            {gate ? (
              <span>
                Cleanverse CVI · buyer and provider need an active A-Pass{" "}
                <Ext href={explorerAddress(gate.address)}>gate ↗</Ext>
                {gate.apass ? (
                  <>
                    {" · "}
                    <Ext href={explorerAddress(gate.apass)}>A-Pass ↗</Ext>
                  </>
                ) : null}
                <span className="block text-[11.5px] text-fg-4">
                  {gate.pool
                    ? `plus the compliance validator's rules for pool ${gate.pool.slice(0, 10)}…`
                    : "A-Pass validity only; no compliance-validator pool registered yet"}
                </span>
              </span>
            ) : (
              <span className="text-fg-3">off — anyone can fund and be paid</span>
            )}
          </Row>
        ) : null}
        {signer ? (
          <>
            <Row label="operator signer" wrap>
              {signer.mode === "privy" ? (
                <span>
                  Privy server wallet, policy-locked
                  <span className="block text-[11.5px] text-fg-4">{signer.description}</span>
                </span>
              ) : (
                <span>
                  a local key
                  <span className="block text-[11.5px] text-fg-4">
                    Privy not configured on this broker: no policy limits what the operator can sign
                  </span>
                </span>
              )}
            </Row>
            {signer.policy ? (
              <Row label="policy allows" wrap>
                <span className="text-[12px] text-fg-2">
                  {signer.policy.allows.map((rule) => rule.replace(/ on \d+$/, "")).join(" · ")}
                  <span className="block text-[11.5px] text-fg-4">
                    on this chain only, zero value; everything else is denied before signing
                  </span>
                </span>
              </Row>
            ) : null}
          </>
        ) : null}
      </div>
    </Panel>
  );
}
