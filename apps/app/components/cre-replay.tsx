"use client";

import { explorerTx, shortHex } from "@xorv/protocol/web";
import type { Job } from "@/lib/api";
import { IS_LOCAL_CHAIN, NETWORK } from "@/lib/network";
import { refundedByKeeper } from "@/lib/payment-timeline";
import { Ext, Panel } from "@/components/ui";

/**
 * How the buyer got their money back without the broker: the Chainlink CRE
 * refund keeper's path, step by step, with this job's real values. Shown for
 * a job the keeper refunded, and (as a promise) for one still held in escrow.
 */
export function CreReplay({ job, keeper }: { job: Job; keeper: string | null | undefined }) {
  const held = job.payment?.escrow;
  if (!held || !keeper) return null;
  const done = refundedByKeeper(job, keeper);
  if (!done && held.state !== "funded") return null;
  const deadline = new Date(held.deadline * 1000).toLocaleTimeString();

  const steps: { title: string; body: string; tx?: string | null }[] = [
    { title: "Cron trigger", body: "The workflow runs every 30 seconds on Chainlink's DON." },
    { title: "Find expired jobs", body: `HTTP query (with DON consensus) to the Envio index: funded EscrowJobs whose deadline passed. This job's deadline: ${deadline}.` },
    { title: "Check each on Monad", body: `EVM read: XorvEscrow.isRefundable(${shortHex(held.jobId)}).` },
    { title: "One signed report", body: "abi.encode(bytes32[] jobIds), signed by the DON." },
    {
      title: "Deliver and refund",
      body: `KeystoneForwarder → XorvRefundKeeper ${shortHex(keeper)}.onReport → XorvEscrow.refund. Refunds are never gated, and no one's permission is needed after the deadline.`,
      tx: done ? held.refundTx : null,
    },
  ];

  return (
    <section>
      <h2 className="mb-2.5 text-[13px] font-medium text-fg">{done ? "Refunded by the Chainlink CRE keeper" : "If this job never delivers"}</h2>
      <Panel className="p-4">
        <p className="text-[12.5px] leading-relaxed text-fg-3">
          {done
            ? "The broker didn't refund this job; Chainlink CRE did. This is the path the refund took."
            : `The money is held in XorvEscrow. If the job hasn't delivered by ${deadline}, the Chainlink CRE refund keeper refunds the buyer in full, whether or not this broker is still running.`}
        </p>
        <ol className="mt-3 space-y-2">
          {steps.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span className="mono mt-[1px] w-4 shrink-0 text-[11px] text-fg-4">{i + 1}</span>
              <div className="min-w-0">
                <p className="text-[12.5px] text-fg-2">{s.title}</p>
                <p className="text-[11.5px] leading-relaxed text-fg-4">{s.body}</p>
                {s.tx ? (
                  <p className="mono mt-0.5 text-[11px] text-fg-3">
                    <Ext href={explorerTx(NETWORK, s.tx)}>refund {shortHex(s.tx)} ↗</Ext>
                    {held.settledBy ? ` · sent by ${shortHex(held.settledBy)}` : ""}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        {done && IS_LOCAL_CHAIN ? (
          <p className="mt-3 text-[11px] leading-relaxed text-fg-4">
            On this local fork there is no DON: `pnpm demo` replayed the workflow&rsquo;s steps itself (the same
            isRefundable check and report encoding), with a local key standing in for the KeystoneForwarder. On testnet the
            report comes from `cre workflow simulate --broadcast` through Chainlink&rsquo;s MockKeystoneForwarder.
          </p>
        ) : null}
      </Panel>
    </section>
  );
}
