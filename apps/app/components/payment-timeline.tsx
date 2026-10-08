"use client";

import { motion } from "motion/react";
import { explorerAddress, explorerTx, shortHex } from "@xorv/protocol/web";
import type { Job } from "@/lib/api";
import { NETWORK } from "@/lib/network";
import { EASE, useEntrance } from "@/lib/motion";
import { offsetLabel, paymentTimeline, type StepState } from "@/lib/payment-timeline";
import { Ext, Panel } from "@/components/ui";
import { TxBadge } from "@/components/tx-badge";
import { cn } from "@/lib/utils";

/**
 * The money's path through a job, live: paid into XorvEscrow, running,
 * delivered, released to the provider (or refunded to the buyer), receipted.
 * Each step carries its time, as an offset from the payment, and the
 * transaction that proves it.
 *
 * Monochrome like the rest of the app: a filled mark for done, a breathing
 * one for what is happening now, a hollow one for what is still to come. Green
 * is kept for the one step that means the provider got paid.
 */
export function PaymentTimeline({ job, keeper }: { job: Job; keeper?: string | null }) {
  const animate = useEntrance();
  const steps = paymentTimeline(job, { keeper });
  const start = job.payment?.settledAt ?? null;
  const escrow = job.payment?.escrow ?? null;

  return (
    <section>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-medium text-fg">{escrow ? "Where the money is" : "Payment"}</h2>
        {escrow ? (
          <span className="mono text-[11px] text-fg-4">
            <Ext href={explorerAddress(NETWORK, escrow.address)}>XorvEscrow {shortHex(escrow.address)} ↗</Ext>
          </span>
        ) : null}
      </div>
      <Panel className="px-4 py-3">
        <ol className="relative">
          {steps.map((step, i) => {
            const last = i === steps.length - 1;
            const paid = step.key === "settled" && step.state === "done" && escrow?.state === "released";
            const offset = step.key === "paid" ? null : offsetLabel(step.at, start);
            return (
              <motion.li
                key={step.key}
                initial={animate ? { opacity: 0, y: 4 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: EASE, delay: animate ? i * 0.04 : 0 }}
                className="relative flex gap-3 pb-3.5 last:pb-0.5"
                data-step={step.key}
                data-state={step.state}
              >
                {!last ? (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute left-[5px] top-[15px] bottom-0 w-px",
                      step.state === "done" ? "bg-[var(--line-3)]" : "bg-[var(--line)]",
                    )}
                  />
                ) : null}
                <Mark state={step.state} paid={paid} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <p
                      className={cn(
                        "text-[13px]",
                        step.state === "pending" ? "text-fg-4" : step.state === "failed" ? "text-fg-2" : "text-fg",
                        paid && "text-live",
                      )}
                    >
                      {step.title}
                    </p>
                    <span className="mono tnum text-[11px] text-fg-4">
                      {step.key === "paid" && step.at ? new Date(step.at).toLocaleTimeString() : offset ?? ""}
                    </span>
                  </div>
                  {step.detail ? <p className="mt-0.5 text-[12px] leading-relaxed text-fg-3">{step.detail}</p> : null}
                  {step.tx ? (
                    <p className="mono mt-0.5 text-[11px] text-fg-4">
                      <Ext href={explorerTx(NETWORK, step.tx)}>{shortHex(step.tx)} ↗</Ext>
                      <TxBadge hash={step.tx} />
                    </p>
                  ) : null}
                </div>
              </motion.li>
            );
          })}
        </ol>
      </Panel>
    </section>
  );
}

function Mark({ state, paid }: { state: StepState; paid: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-[1] mt-[4px] h-[11px] w-[11px] shrink-0 rounded-full border",
        state === "done" && (paid ? "border-live bg-live" : "border-fg-2 bg-fg-2"),
        state === "active" && "breathe border-fg bg-fg",
        state === "pending" && "border-[var(--line-3)] bg-bg",
        state === "failed" && "border-fg-3 bg-bg",
      )}
    />
  );
}
