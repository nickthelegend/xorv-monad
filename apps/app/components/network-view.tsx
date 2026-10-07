"use client";

import { useCallback } from "react";
import {
  explorerAddress,
  explorerAgent,
  explorerToken,
  explorerTx,
  formatAgo,
  formatUsdc,
  shortHex,
  type LedgerJobRated,
  type LedgerJobReceipt,
} from "@xorv/protocol/web";
import { api, formatUsd, type Leaderboard, type LedgerEvent, type NetworkInfo } from "@/lib/api";
import { aiRoles, describeLatency, type AiRoleName } from "@/lib/ai";
import { usePoll } from "@/lib/hooks";
import { NETWORK } from "@/lib/network";
import { valueToStars } from "@/lib/rating";
import { Empty, Ext, Panel, Row, Skeleton } from "@/components/ui";
import { NansenPanel } from "@/components/trust";
import { readNansenStatus } from "@/lib/trust";

/**
 * The network, as the chain sees it.
 *
 * Xorv keeps live state (who is online, which job is running) in the broker's
 * memory, and everything that has to be *believed* on Monad: providers
 * registered and job receipts recorded on the XorvLedger contract, payments as
 * USDC transfers, reputation in the ERC-8004 registries. This page reads those
 * back — through the Envio indexer when the broker has one, a bounded RPC log
 * scan when it doesn't — and links every row to the explorer, so none of it
 * has to be taken on this dashboard's word.
 *
 * Event payloads are narrowed defensively: they arrive as JSON from whichever
 * backend answered, and a missing field should render as a dash, not crash.
 */
export function NetworkView() {
  const { data: info, error } = usePoll<NetworkInfo>(useCallback(() => api.network(), []), 15_000);
  const { data: receipts } = usePoll(useCallback(() => api.ledger("receipts", 12), []), 15_000);
  const { data: ratings } = usePoll(useCallback(() => api.ledger("ratings", 8), []), 15_000);
  const { data: board } = usePoll<Leaderboard>(useCallback(() => api.leaderboard(), []), 30_000);

  if (error && !info) return <Empty title="Can't reach the broker" hint="The network page reads everything through it." />;

  const indexed = Boolean(info?.indexer);
  const nansen = readNansenStatus(info);
  const via = indexed ? "Envio HyperIndex" : "an RPC log scan";

  return (
    <div className="space-y-8">
      {/* Facts, as a definition list. Four numbers in four boxes would say
          "we have metrics" without saying anything true. */}
      <Panel className="p-5">
        <h2 className="text-[13px] font-medium text-fg">Settlement</h2>
        <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
          Every job is paid with an x402 EIP-3009 authorization: the buyer signs, the facilitator submits the
          USDC transfer and pays the gas, so a buyer needs no MON at all. The money goes straight to the
          provider.
        </p>
        <div className="mt-4 border-t border-[var(--line)] pt-1">
          <Row label="network">{info ? `Monad ${info.label} · chain ${info.chainId}` : "—"}</Row>
          <Row label="facilitator">{info?.facilitator.description ?? "—"}</Row>
          <Row label="gas payer">
            {info?.facilitator.address ? (
              <Ext href={explorerAddress(NETWORK, info.facilitator.address)}>{shortHex(info.facilitator.address)} ↗</Ext>
            ) : info ? (
              "managed by the hosted facilitator"
            ) : (
              "—"
            )}
          </Row>
          <Row label="usdc">
            {info ? <Ext href={explorerToken(NETWORK, info.usdc.address)}>{shortHex(info.usdc.address)} ↗</Ext> : "—"}
          </Row>
          <Row label="providers live">
            <span className="tnum">{info?.stats.providersLive ?? "—"}</span>
          </Row>
          <Row label="jobs completed">
            <span className="tnum">{info?.stats.jobsCompleted ?? "—"}</span>
          </Row>
          <Row label="paid to providers">
            <span className="tnum">{info ? formatUsd(info.stats.paidUsdMicros) : "—"}</span>
          </Row>
        </div>
      </Panel>

      <Panel className="p-5">
        <h2 className="text-[13px] font-medium text-fg">On-chain record</h2>
        <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
          Registrations, heartbeats and job receipts are XorvLedger events; buyer ratings are relayed into the
          ERC-8004 Reputation Registry. Receipts carry hashes of the prompt and result, never the text.
        </p>
        <div className="mt-4 border-t border-[var(--line)] pt-1">
          <Row label="XorvLedger">
            {info?.ledger ? (
              <Ext href={info.ledger.url || explorerAddress(NETWORK, info.ledger.address)}>
                {shortHex(info.ledger.address)} ↗
              </Ext>
            ) : info ? (
              "not configured"
            ) : (
              "—"
            )}
          </Row>
          <Row label="XorvEscrow">
            {info?.escrow ? (
              <Ext href={info.escrow.url || explorerAddress(NETWORK, info.escrow.address)}>
                {shortHex(info.escrow.address)} ↗ · refundable after {Math.round(info.escrow.deadlineSeconds / 60)} min
              </Ext>
            ) : info ? (
              "off: providers are paid directly"
            ) : (
              "—"
            )}
          </Row>
          {info?.escrow ? (
            <Row label="identity gate">
              {info.escrow.identityGate ? (
                <span>
                  Cleanverse CVI ·{" "}
                  <Ext href={explorerAddress(NETWORK, info.escrow.identityGate.address)}>gate ↗</Ext>
                  {info.escrow.identityGate.apass ? (
                    <>
                      {" · "}
                      <Ext href={explorerAddress(NETWORK, info.escrow.identityGate.apass)}>A-Pass ↗</Ext>
                    </>
                  ) : null}
                </span>
              ) : (
                "off: anyone can fund and be paid"
              )}
            </Row>
          ) : null}
          <Row label="ERC-8004 identity">
            {info ? <Ext href={explorerAddress(NETWORK, info.erc8004.identity)}>{shortHex(info.erc8004.identity)} ↗</Ext> : "—"}
          </Row>
          <Row label="ERC-8004 reputation">
            {info ? (
              <Ext href={explorerAddress(NETWORK, info.erc8004.reputation)}>{shortHex(info.erc8004.reputation)} ↗</Ext>
            ) : (
              "—"
            )}
          </Row>
          <Row label="read via">
            {info?.indexer ? <Ext href={info.indexer.url}>Envio HyperIndex ↗</Ext> : info ? "RPC log scan" : "—"}
          </Row>
          {info
            ? (["registrations", "heartbeats", "receipts", "ratings"] as const).map((kind) => (
                <Row key={kind} label={`${kind} published`}>
                  <span className="tnum">{info.published?.[kind] ?? 0}</span>
                </Row>
              ))
            : null}
        </div>
        {info?.lastPublishError ? (
          <p className="mt-3 break-words text-[12px] leading-relaxed text-warn">
            Last ledger write failed: {info.lastPublishError}
          </p>
        ) : null}
      </Panel>

      {info ? <AiRoles info={info} /> : null}

      {nansen ? <NansenPanel status={nansen} /> : null}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-medium text-fg">Leaderboard</h2>
          {board ? (
            <span className="text-[11.5px] text-fg-4">
              {board.source === "indexer" || board.source === "envio" ? "indexed by Envio" : "broker stats"}
            </span>
          ) : null}
        </div>
        {!board ? (
          <Skeleton rows={2} />
        ) : board.rows.length === 0 ? (
          <Empty title="No providers ranked yet" hint="Rankings fill in as receipts and ratings land on-chain." />
        ) : (
          <ol className="border-t border-[var(--line)]">
            {board.rows.slice(0, 10).map((row, i) => (
              <li
                key={row.providerId ?? row.address ?? row.agentId ?? i}
                className="flex items-start justify-between gap-4 border-b border-[var(--line)] py-3.5"
              >
                <div className="flex min-w-0 gap-3">
                  <span className="tnum w-5 shrink-0 text-[12.5px] text-fg-4">{i + 1}</span>
                  <div className="min-w-0">
                    <p className="truncate text-[13px] text-fg-2">
                      {row.label ?? (row.address ? shortHex(row.address) : `agent #${row.agentId}`)}
                    </p>
                    <p className="mono mt-0.5 truncate text-[11.5px] text-fg-4">
                      {row.address ? <Ext href={explorerAddress(NETWORK, row.address)}>{shortHex(row.address)}</Ext> : null}
                      {row.agentId ? (
                        <>
                          {row.address ? " · " : ""}
                          <Ext href={explorerAgent(NETWORK, row.agentId)}>agent #{row.agentId}</Ext>
                        </>
                      ) : null}
                    </p>
                  </div>
                </div>
                <div className="shrink-0 text-right text-[11.5px] text-fg-4">
                  <p className="tnum text-[13px] font-medium text-fg">{formatUsdc(row.earnedUsdcUnits)}</p>
                  <p className="tnum mt-0.5">
                    {row.jobs} job{row.jobs === 1 ? "" : "s"}
                    {row.successRate != null ? ` · ${Math.round(row.successRate * 100)}%` : ""}
                    {row.avgRating != null ? ` · ★ ${Math.round(row.avgRating)}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-medium text-fg">Receipts from the ledger</h2>
          {info?.ledger ? (
            <span className="text-[11.5px] text-fg-4">
              <Ext href={info.ledger.url || explorerAddress(NETWORK, info.ledger.address)}>JobRecorded events ↗</Ext>
            </span>
          ) : null}
        </div>
        {!receipts ? (
          <Skeleton rows={3} />
        ) : receipts.events.length === 0 ? (
          <Empty title="No receipts yet" hint={`Every finished job writes one to XorvLedger, read back here via ${via}.`} />
        ) : (
          <ul className="border-t border-[var(--line)]">
            {receipts.events.map((event) => (
              <ReceiptRow key={event.id} event={event} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-[13px] font-medium text-fg">Buyer ratings</h2>
        {!ratings ? (
          <Skeleton rows={2} />
        ) : ratings.events.length === 0 ? (
          <Empty title="No ratings yet" hint="A buyer's rating is one gasless signature, relayed into ERC-8004 reputation." />
        ) : (
          <ul className="border-t border-[var(--line)]">
            {ratings.events.map((event) => (
              <RatingRow key={event.id} event={event} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * The three sponsor models in the job loop, and their state right now. Each
 * row names the exact model, what it decides, how fast it has been, and —
 * when a role is off — why, because "off" alone doesn't tell an operator
 * which key to set.
 */
function AiRoles({ info }: { info: NetworkInfo }) {
  const state = aiRoles(info);
  const roles: Array<{ name: AiRoleName; label: string; what: string }> = [
    { name: "screener", label: "Screener", what: "checks every prompt for abuse aimed at provider machines, before a quote exists" },
    {
      name: "router",
      label: "Router",
      what: "when the buyer chooses Auto, reads the prompt and each candidate's ERC-8004 reputation, receipts and wallet trust on Monad, then picks the provider",
    },
    { name: "verifier", label: "Verifier", what: "scores every result and writes it to ERC-8004 as reputation" },
  ];
  return (
    <Panel className="p-5">
      <h2 className="text-[13px] font-medium text-fg">AI roles</h2>
      <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
        Three models take a turn on every job. A role that is slow or down never blocks one: the router falls back
        to the price matcher and the verifier simply skips.
      </p>
      <div className="mt-3 border-t border-[var(--line)]">
        {roles.map(({ name, label, what }) => {
          const role = state[name];
          const latency = describeLatency(role.stats);
          const feedback = name === "verifier" && role.enabled ? role.feedback : undefined;
          return (
            <div key={name} className="border-b border-[var(--line)] py-3 last:border-b-0">
              <div className="flex items-baseline justify-between gap-4">
                <p className="text-[12.5px] text-fg-2">{label}</p>
                {role.enabled ? (
                  <span className="shrink-0 text-right text-[12px] text-fg-2">
                    {role.label} <span className="mono text-[11.5px] text-fg-4">{role.model}</span>
                  </span>
                ) : (
                  <span className="shrink-0 text-[12px] text-fg-4">off</span>
                )}
              </div>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-4">{what}</p>
              {role.enabled ? (
                <p className="mt-1 text-[11.5px] leading-relaxed text-fg-4">
                  {[
                    latency,
                    role.timeoutMs ? `${role.timeoutMs / 1_000} s limit` : null,
                    name === "screener" && role.failMode
                      ? role.failMode === "open"
                        ? "fails open (marked unscreened)"
                        : "fails closed"
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : role.reason && role.reason !== "off" ? (
                <p className="mt-1 break-words text-[11.5px] leading-relaxed text-fg-4">{role.reason}</p>
              ) : null}
              {feedback ? (
                <p className="mt-1 break-words text-[11.5px] leading-relaxed text-fg-4">
                  {feedback.onChain && feedback.address ? (
                    <>
                      writes <span className="mono">{feedback.tag1}</span> feedback as{" "}
                      <Ext href={explorerAddress(NETWORK, feedback.address)}>{shortHex(feedback.address)} ↗</Ext>
                      {feedback.published > 0 ? ` · ${feedback.published} written` : ""}
                    </>
                  ) : (
                    `scores stay off-chain${feedback.reason ? `: ${feedback.reason}` : ""}`
                  )}
                </p>
              ) : null}
              {role.enabled && role.stats?.lastError ? (
                <p className="mt-1 break-words text-[11.5px] leading-relaxed text-warn">last failure: {role.stats.lastError}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function ReceiptRow({ event }: { event: LedgerEvent<"receipts"> }) {
  const d: Partial<LedgerJobReceipt> = event.data ?? {};
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[var(--line)] py-3.5">
      <span className="mono text-[12px] text-fg-2">
        <Ext href={explorerTx(NETWORK, event.txHash)}>{d.jobId ? shortHex(d.jobId, 10, 6) : shortHex(event.txHash)}</Ext>
        <span className={d.ok === false ? "ml-2 text-fail" : "ml-2 text-fg-4"}>{d.ok === false ? "failed" : "ok"}</span>
      </span>
      <span className="mono truncate text-[11.5px] text-fg-4">
        {d.buyer ? shortHex(d.buyer) : "—"} → {d.payTo ? shortHex(d.payTo) : "—"}
        {d.agentId ? ` · agent #${d.agentId}` : ""}
      </span>
      <span className="text-[11.5px] text-fg-4">
        <span className="mono tnum text-[12.5px] text-fg-2">{d.amount ? formatUsdc(d.amount) : "—"}</span>
        {event.at ? ` · ${formatAgo(event.at)}` : ""}
      </span>
    </li>
  );
}

function RatingRow({ event }: { event: LedgerEvent<"ratings"> }) {
  const d: Partial<LedgerJobRated> = event.data ?? {};
  const value = typeof d.value === "number" ? d.value : Number(d.value ?? Number.NaN);
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[var(--line)] py-3">
      <span className="text-[13px]">
        {Number.isFinite(value) ? (
          <>
            <span className="text-fg">{"★".repeat(valueToStars(value))}</span>
            <span className="text-fg-4">{"★".repeat(5 - valueToStars(value))}</span>
            <span className="tnum ml-2 text-[11.5px] text-fg-3">{value}/100</span>
          </>
        ) : (
          "—"
        )}
      </span>
      <span className="mono truncate text-[11.5px] text-fg-4">
        {d.agentId ? <Ext href={explorerAgent(NETWORK, d.agentId)}>agent #{d.agentId}</Ext> : "—"} · by{" "}
        {d.buyer ? shortHex(d.buyer) : "—"}
      </span>
      <span className="text-[11.5px] text-fg-4">
        <Ext href={explorerTx(NETWORK, event.txHash)}>tx ↗</Ext>
        {event.at ? ` · ${formatAgo(event.at)}` : ""}
      </span>
    </li>
  );
}
