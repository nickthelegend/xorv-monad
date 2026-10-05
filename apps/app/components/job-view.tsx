"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EASE, useEntrance } from "@/lib/motion";
import {
  BROKER_URL,
  api,
  formatDuration,
  formatUsd,
  explorerAddress,
  explorerTx,
  type EscrowRecord,
  type Job,
  type JobEvent,
} from "@/lib/api";
import { useWallet } from "@/components/wallet-provider";
import { Button, Empty, Ext, Panel, Row, Status } from "@/components/ui";
import { ResultMarkdown } from "@/components/result-markdown";
import { EXPLORER_NAME, XORV_CHAIN, stablecoinSymbol } from "@/lib/chains";
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

/**
 * One job, live.
 *
 * Subscribes to the broker's SSE stream while the job is in flight and stops as
 * soon as it reaches a terminal state — a finished job is a static document,
 * and holding an event stream open for it wastes a connection on both ends.
 */
export function JobView({
  jobId,
  initial,
  loadError = null,
}: {
  jobId: string;
  initial: Job | null;
  /** Why the server-side fetch came back empty, when it did. */
  loadError?: "not_found" | "unreachable" | null;
}) {
  const [job, setJob] = useState<Job | null>(initial);
  const [events, setEvents] = useState<JobEvent[]>(initial?.events ?? []);
  const [streaming, setStreaming] = useState(false);
  // Bumped to reopen the event stream after it closed for good (see below).
  const [streamEpoch, setStreamEpoch] = useState(0);
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
    });
    // EventSource retries a dropped connection on its own, but an HTTP error —
    // what a tunnel answers while the broker is down — closes it for good. The
    // page then sat on "Can't reach the broker" forever, even after the broker
    // came back. So when it closes, look the job up again after a pause and
    // reopen the stream; a finished job needs no stream, a 404 needs no retry.
    let retry: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener("error", () => {
      setStreaming(false);
      if (source.readyState !== EventSource.CLOSED) return;
      retry = setTimeout(() => {
        api
          .job(jobId)
          .then((fresh) => {
            setJob(fresh);
            if (fresh.events) setEvents(fresh.events);
            setStreamEpoch((n) => n + 1);
          })
          .catch((err: unknown) => {
            if (err instanceof Error && / → 404\b/.test(err.message)) return;
            setStreamEpoch((n) => n + 1);
          });
      }, 5_000);
    });

    return () => {
      source.close();
      clearTimeout(retry);
    };
  }, [jobId, terminal, streamEpoch]);

  // The on-chain receipt is an audit-log transaction written after the job
  // finishes, when the stream has already closed. A single refetch six seconds
  // later left "receipt publishing…" on screen for good whenever that write took
  // longer, so a finished, paid job without a receipt asks again until it has
  // one — for up to two minutes, so a broker that never writes it can't keep a
  // tab polling forever.
  // Escrowed money that hasn't moved yet (release or refund lands a few
  // seconds after the job ends) keeps the page polling the same way.
  const awaitingReceipt =
    terminal &&
    Boolean(job?.payment) &&
    (!job?.receiptTxHash || job?.payment?.escrow?.state === "funded");
  useEffect(() => {
    if (!awaitingReceipt) return;
    const deadline = Date.now() + 120_000;
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        return;
      }
      void api
        .job(jobId)
        .then((fresh) => {
          if (fresh.receiptTxHash || fresh.payment?.escrow?.state !== job?.payment?.escrow?.state) {
            setJob(fresh);
          }
        })
        .catch(() => {});
    }, 3_000);
    return () => clearInterval(timer);
  }, [awaitingReceipt, jobId, job?.payment?.escrow?.state]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events.length]);

  // A running job's "took" is a live clock. Read from Date.now() during render,
  // the server's HTML and the browser's first render disagree by however long
  // the page took to arrive, and React throws hydration error #418. So the
  // ticking value exists only after mount; both renders start from the same "—".
  const [now, setNow] = useState<number | null>(null);
  const startedAt = job?.startedAt ?? null;
  useEffect(() => {
    if (terminal || !startedAt) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [terminal, startedAt]);

  if (!job) {
    // An unreachable broker is not evidence the job is gone: saying "not found"
    // about a paid job that exists sends its buyer looking for a lost payment.
    // The event stream above keeps retrying, so the page fills in by itself
    // once the broker answers again.
    if (loadError === "unreachable") {
      return (
        <Empty
          title="Can't reach the broker"
          hint="The job may still exist — this page will load it as soon as the broker answers."
        />
      );
    }
    return <Empty title="Job not found" hint="This broker has no job with that id — check the link. Jobs are kept permanently, so a real one does not disappear." />;
  }

  const elapsed =
    job.completedAt && job.startedAt
      ? job.completedAt - job.startedAt
      : job.startedAt && now !== null
        ? now - job.startedAt
        : 0;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-6">
        <div>
          <div className="flex items-center justify-between gap-3">
            <Status status={job.status} />
            <span className="mono text-[11.5px] text-fg-4">{job.id}</span>
          </div>
          {!terminal ? <StopJob jobId={job.id} escrowed={Boolean(job.payment?.escrow)} onStopped={setJob} /> : null}
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
          {job.providerAddress ? (
            <p className="mono mt-1 text-[11.5px] text-fg-4">
              <Ext href={explorerAddress(job.providerAddress)}>{job.providerAddress} ↗</Ext>
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
                  in {paidSymbol(job.payment)}
                </span>
              </p>
              <div className="mt-3 border-t border-[var(--line)] pt-1">
                <Row label="payer">
                  <Ext href={explorerAddress(job.payment.payer)}>{job.payment.payer}</Ext>
                </Row>
                <Row label="paid to">
                  <Ext href={explorerAddress(job.payment.payTo)}>{job.payment.payTo}</Ext>
                </Row>
                <Row label="amount">
                  <span className="tnum">
                    {job.payment.amount} units ({paidSymbol(job.payment)}, 6dp)
                  </span>
                </Row>
                <Row label="network">{job.payment.network}</Row>
              </div>

              <div className="mt-4 space-y-2">
                <Button href={job.payment.explorerUrl} variant="secondary" external className="w-full">
                  {job.payment.escrow ? "View escrow deposit" : "View transfer"} on {EXPLORER_NAME}
                </Button>
                {job.receiptTxHash ? (
                  <Button
                    href={explorerTx(job.receiptTxHash)}
                    variant="ghost"
                    external
                    className="w-full justify-center"
                  >
                    View on-chain receipt
                  </Button>
                ) : (
                  <p className="text-center text-[11.5px] text-fg-4">receipt publishing…</p>
                )}
              </div>

              {job.payment.escrow ? (
                <EscrowSection
                  escrow={job.payment.escrow}
                  onRefunded={() => void api.job(jobId).then(setJob).catch(() => {})}
                />
              ) : null}

              {job.resultHash ? (
                <p className="mono mt-3 break-all text-[10.5px] leading-relaxed text-fg-4">
                  sha256 {job.resultHash}
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-[12.5px] leading-relaxed text-fg-3">
              Settling on {XORV_CHAIN.name} — this usually takes about a second.
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

/**
 * The stablecoin a payment used. Newer records carry the symbol; older ones
 * carry "usdc", so fall back to looking the token address up.
 */
function paidSymbol(payment: { asset: string; assetId: string }): string {
  const known = stablecoinSymbol(payment.assetId);
  return known !== "stablecoin" ? known : payment.asset.toUpperCase();
}

const ESCROW_COPY: Record<EscrowRecord["state"], { label: string; tone: string; line: string }> = {
  funded: {
    label: "held in escrow",
    tone: "text-fg-2",
    line: "The payment waits in XorvEscrow until the job delivers.",
  },
  released: {
    label: "released",
    tone: "text-live",
    line: "Paid to the provider, with the result's hash recorded on chain.",
  },
  refunded: {
    label: "refunded",
    tone: "text-fg-2",
    line: "Returned in full to the buyer.",
  },
};

/**
 * Where the money is. The escrow is the part of this page a buyer should
 * never have to trust: every state links to the transaction that caused it,
 * and a payment still held after its deadline can be refunded from here by
 * any connected wallet — the contract only ever pays the buyer.
 */
function EscrowSection({
  escrow,
  onRefunded,
}: {
  escrow: EscrowRecord;
  onRefunded: () => void;
}) {
  const wallet = useWallet();
  const [now, setNow] = useState<number | null>(null);
  const [refunding, setRefunding] = useState(false);
  const [refundTx, setRefundTx] = useState<string | null>(null);
  const [refundError, setRefundError] = useState<string | null>(null);

  useEffect(() => {
    if (escrow.state !== "funded") return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [escrow.state]);

  const copy = ESCROW_COPY[escrow.state];
  const refundable = escrow.state === "funded" && now !== null && now > escrow.deadline * 1000;

  async function refund() {
    setRefunding(true);
    setRefundError(null);
    try {
      if (!wallet.session) await wallet.connect();
      const tx = await wallet.refundEscrow(escrow.address, escrow.jobId);
      setRefundTx(tx);
      setTimeout(onRefunded, 4_000);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setRefundError(
        (err as { code?: number })?.code === 4001 || /user (denied|rejected)|rejected the request/i.test(text)
          ? "You declined the transaction in your wallet. The payment is still in escrow — refund whenever you're ready."
          : text,
      );
    } finally {
      setRefunding(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-[var(--line)] p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12.5px] text-fg-4">escrow</span>
        <span className={cn("text-[12.5px] font-medium", copy.tone)}>{copy.label}</span>
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-fg-3">{copy.line}</p>
      <div className="mt-2">
        <Row label="contract">
          <Ext href={escrow.explorerUrl}>{escrow.address}</Ext>
        </Row>
        {escrow.releaseTx ? (
          <Row label="release">
            <Ext href={explorerTx(escrow.releaseTx)}>{escrow.releaseTx}</Ext>
          </Row>
        ) : null}
        {escrow.refundTx || refundTx ? (
          <Row label="refund">
            <Ext href={explorerTx(escrow.refundTx ?? refundTx!)}>{escrow.refundTx ?? refundTx}</Ext>
          </Row>
        ) : null}
        {escrow.reassignTxs?.length ? (
          <Row label="reassigned">
            <span className="tnum">{escrow.reassignTxs.length}×</span>
          </Row>
        ) : null}
        {escrow.state === "funded" ? (
          <Row label="refundable">
            <span className="tnum">
              {now === null
                ? "—"
                : refundable
                  ? "now, by anyone"
                  : `in ${formatDuration(escrow.deadline * 1000 - now)}`}
            </span>
          </Row>
        ) : null}
      </div>
      {escrow.lastError && escrow.state === "funded" ? (
        <p className="mt-2 text-[11px] leading-relaxed text-fail">{escrow.lastError}</p>
      ) : null}
      {refundable && !refundTx ? (
        <Button onClick={refund} disabled={refunding} variant="secondary" className="mt-3 w-full">
          {refunding ? "Refunding…" : "Refund the buyer"}
        </Button>
      ) : null}
      {refundError ? (
        <p className="mt-2 text-[11px] leading-relaxed text-fail">{refundError}</p>
      ) : null}
    </div>
  );
}

/**
 * Stop a job that is still running. With escrow the money never left the
 * contract, so stopping refunds it; paid directly, it can't, and the button
 * says so before anyone presses it.
 */
function StopJob({
  jobId,
  escrowed,
  onStopped,
}: {
  jobId: string;
  escrowed: boolean;
  onStopped: (job: Job) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function stop() {
    setBusy(true);
    setError(null);
    try {
      await api.cancel(jobId);
      onStopped(await api.job(jobId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <Button onClick={stop} disabled={busy} variant="secondary">
        {busy ? "Stopping…" : escrowed ? "Stop this job — refund me" : "Stop this job"}
      </Button>
      <span className="text-[11.5px] text-fg-4">
        {escrowed
          ? "The payment is still in escrow, so stopping returns it to you."
          : "Paid directly to the provider, so stopping does not refund."}
      </span>
      {error ? <span className="text-[11.5px] text-fail">{error}</span> : null}
    </div>
  );
}
