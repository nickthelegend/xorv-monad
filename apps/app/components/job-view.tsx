"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EASE, useEntrance } from "@/lib/motion";
import {
  BROKER_URL,
  NETWORK,
  api,
  formatDuration,
  formatUsd,
  hashscanAccount,
  type Job,
  type JobEvent,
} from "@/lib/api";
import { Button, Empty, Ext, Panel, Row, Status } from "@/components/ui";
import { ResultMarkdown } from "@/components/result-markdown";
import { cn } from "@/lib/utils";

/**
 * Event glyphs.
 *
 * Monochrome. What kind of step this was is carried by the mark and the
 * indent, not by six different colours competing with the one thing on this
 * page that colour is reserved for — whether the job succeeded.
 */
const GLYPH: Record<JobEvent["kind"], { mark: string; tone: string }> = {
  status: { mark: "·", tone: "text-fg-4" },
  message: { mark: "▸", tone: "text-fg-2" },
  tool_call: { mark: "⌘", tone: "text-fg-3" },
  file_edit: { mark: "✎", tone: "text-fg-3" },
  reasoning: { mark: "…", tone: "text-fg-4 italic" },
  error: { mark: "✕", tone: "text-fail" },
};

function hashscanTx(transactionId: string): string {
  const net = NETWORK === "hedera:mainnet" ? "mainnet" : "testnet";
  return `https://hashscan.io/${net}/transaction/${transactionId
    .replace("@", "-")
    .replace(/\.(\d+)$/, "-$1")}`;
}

/**
 * One job, live.
 *
 * Subscribes to the broker's SSE stream while the job is in flight and stops as
 * soon as it reaches a terminal state — a finished job is a static document,
 * and holding an event stream open for it wastes a connection on both ends.
 */
export function JobView({ jobId, initial }: { jobId: string; initial: Job | null }) {
  const [job, setJob] = useState<Job | null>(initial);
  const [events, setEvents] = useState<JobEvent[]>(initial?.events ?? []);
  const [streaming, setStreaming] = useState(false);
  const animate = useEntrance();
  const logRef = useRef<HTMLDivElement | null>(null);

  const terminal = job?.status === "completed" || job?.status === "failed";

  useEffect(() => {
    if (terminal) return;
    const source = new EventSource(`${BROKER_URL}/api/jobs/${jobId}/stream`);

    source.addEventListener("open", () => setStreaming(true));
    source.addEventListener("snapshot", (e) => {
      const next = JSON.parse((e as MessageEvent).data) as Job;
      setJob(next);
      if (next.events) setEvents(next.events);
    });
    source.addEventListener("event", (e) => {
      setEvents((prev) => [...prev, JSON.parse((e as MessageEvent).data) as JobEvent]);
    });
    source.addEventListener("job", (e) => setJob(JSON.parse((e as MessageEvent).data) as Job));
    source.addEventListener("done", (e) => {
      const next = JSON.parse((e as MessageEvent).data) as Job;
      setJob(next);
      if (next.events) setEvents(next.events);
      source.close();
      setStreaming(false);
      // The HCS receipt is written a beat after settlement, so one delayed
      // refetch turns "publishing…" into a real link without polling forever.
      setTimeout(() => {
        void api.job(jobId).then(setJob).catch(() => {});
      }, 6_000);
    });
    source.addEventListener("error", () => setStreaming(false));

    return () => source.close();
  }, [jobId, terminal]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events.length]);

  if (!job) {
    return <Empty title="Job not found" hint="It may have expired, or the broker restarted." />;
  }

  const elapsed =
    job.completedAt && job.startedAt
      ? job.completedAt - job.startedAt
      : job.startedAt
        ? Date.now() - job.startedAt
        : 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="min-w-0 space-y-6">
        <div>
          <div className="flex items-center justify-between gap-3">
            <Status status={job.status} />
            <span className="mono text-[11.5px] text-fg-4">{job.id}</span>
          </div>
          <p className="mt-3 whitespace-pre-wrap text-[14.5px] leading-relaxed text-fg">
            {job.prompt}
          </p>
        </div>

        <AnimatePresence>
          {job.result ? (
            <motion.section
              key="result"
              initial={animate ? { opacity: 0, y: 8 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.34, ease: EASE }}
            >
            <h2 className="mb-2.5 text-[13px] font-medium text-fg">Result</h2>
            <Panel className="p-4">
              {/* Agent CLIs answer in markdown. Rendering it as raw text made
                  the thing the buyer just paid for look like a log line. */}
              <ResultMarkdown>{job.result}</ResultMarkdown>
            </Panel>
            </motion.section>
          ) : null}
        </AnimatePresence>

        {job.error ? (
          <section>
            <h2 className="mb-2.5 text-[13px] font-medium text-fail">Failed</h2>
            <Panel className="border-fail/25 bg-fail/[0.04] p-4">
              <p className="text-[13.5px] leading-relaxed text-fail">{job.error}</p>
            </Panel>
          </section>
        ) : null}

        <section>
          <div className="mb-2.5 flex items-center justify-between">
            <h2 className="text-[13px] font-medium text-fg">Execution log</h2>
            {streaming ? (
              <span className="inline-flex items-center gap-1.5 text-[11.5px] text-fg-3">
                <span className="breathe h-1.5 w-1.5 rounded-full bg-live" />
                streaming
              </span>
            ) : null}
          </div>
          <Panel className="p-4">
            <div ref={logRef} className="mono max-h-72 space-y-1 overflow-auto text-[12px]">
              {events.length === 0 ? (
                <p className="text-fg-4">waiting for the provider…</p>
              ) : (
                events.map((event, i) => {
                  const g = GLYPH[event.kind] ?? GLYPH.status;
                  return (
                    <motion.div
                      key={`${event.at}-${i}`}
                      // A short rise, no stagger: these arrive one at a time from
                      // a live socket, and staggering a stream would make the log
                      // lag behind the work it is reporting.
                      initial={animate ? { opacity: 0, y: 4 } : false}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.14, ease: EASE }}
                      className="flex gap-2.5"
                    >
                      <span className={cn("shrink-0 select-none", g.tone)}>{g.mark}</span>
                      <span className={cn("min-w-0 break-words", g.tone)}>{event.text}</span>
                    </motion.div>
                  );
                })
              )}
            </div>
          </Panel>
        </section>
      </div>

      <div className="space-y-6">
        <Panel className="p-4">
          <h2 className="text-[13px] font-medium text-fg">Provider</h2>
          <p className="mt-2 text-[14px] text-fg-2">{job.providerLabel ?? "unassigned"}</p>
          {job.providerAccountId ? (
            <p className="mono mt-1 text-[11.5px] text-fg-4">
              <Ext href={hashscanAccount(job.providerAccountId)}>{job.providerAccountId} ↗</Ext>
            </p>
          ) : null}
          <div className="mt-3 border-t border-[var(--line)] pt-1">
            <Row label="price">
              <span className="tnum">{formatUsd(job.priceUsdMicros)}</span>
            </Row>
            <Row label="took">{elapsed ? formatDuration(elapsed) : "—"}</Row>
            <Row label="events">
              <span className="tnum">{job.eventCount}</span>
            </Row>
          </div>
        </Panel>

        <Panel className={cn("p-4", job.payment && "border-[var(--line-2)]")}>
          <h2 className="text-[13px] font-medium text-fg">On-chain receipt</h2>

          {job.payment ? (
            <>
              <p className="tnum mt-2 text-[18px] font-semibold text-fg">
                {formatUsd(job.priceUsdMicros)}{" "}
                <span className="text-[12px] font-normal text-fg-3">
                  in {job.payment.asset.toUpperCase()}
                </span>
              </p>
              <div className="mt-3 border-t border-[var(--line)] pt-1">
                <Row label="payer">
                  <Ext href={hashscanAccount(job.payment.payer)}>{job.payment.payer}</Ext>
                </Row>
                <Row label="paid to">
                  <Ext href={hashscanAccount(job.payment.payTo)}>{job.payment.payTo}</Ext>
                </Row>
                <Row label="amount">
                  <span className="tnum">
                    {job.payment.amount} {job.payment.asset === "hbar" ? "tℏ" : "µUSDC"}
                  </span>
                </Row>
                <Row label="network">{job.payment.network}</Row>
              </div>

              <div className="mt-4 space-y-2">
                <Button href={job.payment.hashscanUrl} variant="secondary" external className="w-full">
                  View transfer on HashScan
                </Button>
                {job.receiptConsensusAt ? (
                  <Button
                    href={hashscanTx(job.receiptConsensusAt)}
                    variant="ghost"
                    external
                    className="w-full justify-center"
                  >
                    View HCS receipt
                  </Button>
                ) : (
                  <p className="text-center text-[11.5px] text-fg-4">HCS receipt publishing…</p>
                )}
              </div>

              {job.resultHash ? (
                <p className="mono mt-3 break-all text-[10.5px] leading-relaxed text-fg-4">
                  sha256 {job.resultHash}
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-[12.5px] leading-relaxed text-fg-3">
              Settling on Hedera — this usually takes about three seconds.
            </p>
          )}
        </Panel>

        <Link
          href="/"
          className="block text-[12.5px] text-fg-4 transition-colors hover:text-fg-2"
        >
          ← all jobs
        </Link>
      </div>
    </div>
  );
}
