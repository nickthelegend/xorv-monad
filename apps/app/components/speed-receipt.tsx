"use client";

import { explorerAddress, explorerBlock, shortHex } from "@xorv/protocol/web";
import type { Job } from "@/lib/api";
import { NETWORK, NETWORK_LABEL } from "@/lib/network";
import { formatGas, formatMon, formatMs, vsEthereumSlot } from "@/lib/speed";
import { Ext, Panel, Row } from "@/components/ui";

/**
 * The speed receipt: how fast this job's money actually moved, with two
 * honest timers per transaction, both measured by the broker:
 *  - executed: from submitting the transaction to holding its receipt
 *    (on Monad, the block is proposed and executed; with
 *    eth_sendRawTransactionSync the receipt comes back in the send itself);
 *  - final: until the chain's `finalized` head holds that block (on Monad,
 *    about two slots; irreversible).
 * Every figure says where it was measured. On a local fork they are the
 * fork's timings and the page says so; it never presents them as Monad's.
 */
export function SpeedReceipt({ job }: { job: Job }) {
  const timing = job.payment?.timing;
  if (!timing) return null;
  const held = job.payment?.escrow;
  const settle = held?.settleTiming ?? null;
  const local = timing.chain === "local";
  const times = local ? null : vsEthereumSlot(timing.finalMs ?? timing.confirmMs);

  return (
    <Panel className="p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-medium text-fg">{local ? "Speed receipt" : "Monad speed receipt"}</h2>
        <span className="text-[11px] text-fg-4">{local ? "local fork · not Monad's timing" : `measured on ${NETWORK_LABEL}`}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <Timer label="payment executed" ms={timing.confirmMs} />
        {local ? (
          <div>
            <p className="text-[24px] font-semibold tracking-[-0.02em] text-fg-4">n/a</p>
            <p className="text-[11.5px] text-fg-3">final: a fork has no consensus</p>
          </div>
        ) : (
          <Timer label="payment final" ms={timing.finalMs ?? null} />
        )}
      </div>
      <div className="mt-3 border-t border-[var(--line)] pt-1">
        <Row label="block">
          {local ? (
            <span className="mono">#{timing.blockNumber.toLocaleString("en-US")}</span>
          ) : (
            <Ext href={explorerBlock(NETWORK, timing.blockNumber)}>#{timing.blockNumber.toLocaleString("en-US")}</Ext>
          )}
        </Row>
        <Row label="gas">
          <span className="tnum">
            {formatGas(timing.gasUsed)} · {formatMon(timing.gasPaidWei)}
          </span>
        </Row>
        <Row label="gas paid by">
          {local ? (
            <span className="mono">
              {held ? "the escrow's attester" : "the facilitator"} {shortHex(timing.gasPayer)}
            </span>
          ) : (
            <Ext href={explorerAddress(NETWORK, timing.gasPayer)}>
              {held ? "the escrow's attester" : "the facilitator"} {shortHex(timing.gasPayer)}
            </Ext>
          )}
        </Row>
        <Row label="buyer paid in gas">
          <span className="text-live">0 MON</span>
        </Row>
        {settle ? (
          <Row label={held?.state === "refunded" ? "refund" : "release"}>
            <span className="tnum">
              executed {settle.confirmMs !== null ? formatMs(settle.confirmMs) : "—"}
              {settle.finalMs != null ? ` · final ${formatMs(settle.finalMs)}` : ""}
              {settle.sendMode === "sync" ? " · receipt in the send" : ""}
            </span>
          </Row>
        ) : null}
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-fg-4">
        {local
          ? "Timed by the broker on a local anvil fork of Monad testnet (300 ms blocks, no consensus, so there is no finality to time). Monad itself proposes a block every 300 ms and finalizes it two slots later; see the live pipeline on the Network page."
          : `Timed by the broker: executed when it held the receipt${settle?.sendMode === "sync" ? " (escrow writes get it back in the send itself, via eth_sendRawTransactionSync)" : ""}, final when Monad's finalized head reached the block.`}
        {times ? ` For scale: one Ethereum block takes 12 s, ${times}× longer than this payment took to become final.` : ""}
      </p>
    </Panel>
  );
}

function Timer({ label, ms }: { label: string; ms: number | null }) {
  return (
    <div>
      <p className="tnum text-[24px] font-semibold tracking-[-0.02em] text-fg">{ms !== null ? formatMs(ms) : "—"}</p>
      <p className="text-[11.5px] text-fg-3">{label}</p>
    </div>
  );
}
