"use client";

import { explorerAddress, explorerBlock, shortHex } from "@xorv/protocol/web";
import type { Job } from "@/lib/api";
import { NETWORK, NETWORK_LABEL } from "@/lib/network";
import { formatGas, formatMon, formatMs, vsEthereumSlot } from "@/lib/speed";
import { Ext, Panel, Row } from "@/components/ui";

/**
 * The Monad speed receipt: how fast this job's money actually moved.
 *
 * The headline is the payment's settlement time as the broker measured it,
 * from submitting the transaction to holding its confirmed receipt. Below it,
 * what the receipt says: the block, the gas, who paid it (never the buyer),
 * and the escrow's release or refund timed the same way. Shown only once the
 * broker has measured something; a job paid before this existed has no row.
 */
export function SpeedReceipt({ job }: { job: Job }) {
  const timing = job.payment?.timing;
  if (!timing) return null;
  const held = job.payment?.escrow;
  const settle = held?.settleTiming ?? null;
  const times = vsEthereumSlot(timing.confirmMs);

  return (
    <Panel className="p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-medium text-fg">Monad speed receipt</h2>
        <span className="text-[11px] text-fg-4">measured</span>
      </div>
      {timing.confirmMs !== null ? (
        <p className="mt-2 flex items-baseline gap-2">
          <span className="tnum text-[26px] font-semibold tracking-[-0.02em] text-fg">{formatMs(timing.confirmMs)}</span>
          <span className="text-[12px] text-fg-3">from payment to final, on {NETWORK_LABEL}</span>
        </p>
      ) : null}
      <div className="mt-3 border-t border-[var(--line)] pt-1">
        <Row label="block">
          <Ext href={explorerBlock(NETWORK, timing.blockNumber)}>#{timing.blockNumber.toLocaleString("en-US")}</Ext>
        </Row>
        <Row label="gas">
          <span className="tnum">
            {formatGas(timing.gasUsed)} · {formatMon(timing.gasPaidWei)}
          </span>
        </Row>
        <Row label="gas paid by">
          <Ext href={explorerAddress(NETWORK, timing.gasPayer)}>
            {held ? "the escrow's attester" : "the facilitator"} {shortHex(timing.gasPayer)}
          </Ext>
        </Row>
        <Row label="buyer paid in gas">
          <span className="text-live">0 MON</span>
        </Row>
        {settle ? (
          <Row label={held?.state === "refunded" ? "refund final in" : "release final in"}>
            <span className="tnum">
              {settle.confirmMs !== null ? formatMs(settle.confirmMs) : "—"} · block #{settle.blockNumber.toLocaleString("en-US")}
            </span>
          </Row>
        ) : null}
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-fg-4">
        Timed by the broker from submitting the transaction to holding its receipt.
        {times ? ` For scale: one Ethereum block takes 12 s, ${times}× longer than this whole payment.` : " For scale: one Ethereum block takes 12 s."}
      </p>
    </Panel>
  );
}
