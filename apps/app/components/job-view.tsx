"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { explorerAddress, explorerAgent, explorerTx, formatUsdc, shortHex } from "@xorv/protocol/web";
import { EASE, useEntrance } from "@/lib/motion";
import { BROKER_URL, api, formatDuration, formatUsd, type Job, type JobEvent } from "@/lib/api";
import { NETWORK, NETWORK_LABEL } from "@/lib/network";
import { useNetworkInfo } from "@/lib/hooks";
import { Button, Empty, Ext, Panel, Row, Status } from "@/components/ui";
import { ResultMarkdown } from "@/components/result-markdown";
import { RateJob } from "@/components/rate-job";
import { PrivateTag } from "@/components/passkey-panel";
import { PrivatePrompt, SealedResultSection } from "@/components/private-result";
import { receiptMatchesCiphertext } from "@/lib/private/result";
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

const TERMINAL = new Set<Job["status"]>(["completed", "failed", "expired"]);

/**
 * Wall-clock time, ticking once a second while `active` — the running job's
 * "took" figure. Read in a timer rather than during render so the render
 * stays pure; null until the first tick.
 */
function useClock(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const tick = (): void => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active]);
  return now;
}

/**
 * One job, live.
 *
 * Subscribes to the broker's SSE stream while the job is in flight and stops as
 * soon as it reaches a terminal state — a finished job is a static document,
 * and holding an event stream open for it wastes a connection on both ends.
 *
 * `settlementTx` is the hash the payer's own x402 client got back, passed in
 * the URL by the composer, so the transfer is linkable on first paint even
 * before the broker's payment record reaches the stream.
 */
export function JobView({
  jobId,
  initial,
  settlementTx,
}: {
  jobId: string;
  initial: Job | null;
  settlementTx?: string | null;
}) {
  const [job, setJob] = useState<Job | null>(initial);
  const [events, setEvents] = useState<JobEvent[]>(initial?.events ?? []);
  const [streaming, setStreaming] = useState(false);
  const animate = useEntrance();
  const logRef = useRef<HTMLDivElement | null>(null);

  const terminal = job ? TERMINAL.has(job.status) : false;
  const now = useClock(Boolean(job?.startedAt) && !job?.completedAt && !terminal);

  useEffect(() => {
    if (terminal) return;
    const source = new EventSource(`${BROKER_URL}/api/jobs/${encodeURIComponent(jobId)}/stream`);
    let refetch: ReturnType<typeof setTimeout> | null = null;

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
      // The ledger receipt is batched and written a beat after the job ends
      // (and the verifier's feedback after that), so one delayed refetch turns
      // "recording…" into real links without polling forever.
      refetch = setTimeout(() => {
        void api.job(jobId).then(setJob).catch(() => {});
      }, 8_000);
    });
    source.addEventListener("error", () => setStreaming(false));

    return () => {
      source.close();
      if (refetch) clearTimeout(refetch);
    };
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
      : job.startedAt && now
        ? Math.max(0, now - job.startedAt)
        : 0;

  const paymentTx = job.payment?.txHash ?? settlementTx ?? null;

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="min-w-0 space-y-6">
        <div>
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2.5">
              <Status status={job.status} />
              {job.private ? <PrivateTag /> : null}
            </span>
            <span className="mono text-[11.5px] text-fg-4">{job.id}</span>
          </div>
          {job.private ? (
            <PrivatePrompt jobId={job.id} />
          ) : (
            <p className="mt-3 whitespace-pre-wrap text-[14.5px] leading-relaxed text-fg">
              {job.prompt}
            </p>
          )}
        </div>

        {/* A private job's result is an envelope; SealedResultSection decides
            whether this viewer can open it. */}
        {job.private ? <SealedResultSection job={job} /> : null}

        <AnimatePresence>
          {job.result && !job.private ? (
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

        <AiChecks job={job} />

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
              <Ext href={explorerAddress(NETWORK, job.providerAddress)}>{shortHex(job.providerAddress)} ↗</Ext>
              {job.providerAgentId ? (
                <>
                  {" · "}
                  <Ext href={explorerAgent(NETWORK, job.providerAgentId)}>agent #{job.providerAgentId} ↗</Ext>
                </>
              ) : null}
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
                {formatUsdc(job.payment.amount)}{" "}
                <span className="text-[12px] font-normal text-fg-3">in USDC</span>
              </p>
              <div className="mt-3 border-t border-[var(--line)] pt-1">
                <Row label="payer">
                  <Ext href={explorerAddress(NETWORK, job.payment.payer)}>{shortHex(job.payment.payer)}</Ext>
                </Row>
                <Row label="paid to">
                  <Ext href={explorerAddress(NETWORK, job.payment.payTo)}>{shortHex(job.payment.payTo)}</Ext>
                </Row>
                <Row label="amount">
                  <span className="tnum">{job.payment.amount} units (6 dp)</span>
                </Row>
                <Row label="network">{job.payment.network === NETWORK ? NETWORK_LABEL : job.payment.network}</Row>
              </div>

              <div className="mt-4 space-y-2">
                <Button
                  href={job.payment.explorerUrl || explorerTx(NETWORK, job.payment.txHash)}
                  variant="secondary"
                  external
                  className="w-full"
                >
                  View USDC transfer
                </Button>
                {job.receiptTxHash ? (
                  <Button
                    href={explorerTx(NETWORK, job.receiptTxHash)}
                    variant="ghost"
                    external
                    className="w-full justify-center"
                  >
                    View XorvLedger receipt
                  </Button>
                ) : TERMINAL.has(job.status) ? (
                  <p className="text-center text-[11.5px] text-fg-4">Recording the receipt on XorvLedger…</p>
                ) : (
                  <p className="text-center text-[11.5px] text-fg-4">The receipt is recorded when the job finishes.</p>
                )}
              </div>

              {job.resultHash ? (
                <p className="mono mt-3 break-all text-[10.5px] leading-relaxed text-fg-4">
                  keccak256 {job.resultHash}
                </p>
              ) : null}
              {job.private && job.result && job.resultHash ? (
                <p className="mt-1.5 text-[11px] leading-relaxed text-fg-4">
                  {receiptMatchesCiphertext(job.result, job.resultHash)
                    ? "✓ the sealed envelope hashes to this value — the receipt commits to ciphertext only the buyer can open"
                    : "✕ the envelope served does not hash to this value"}
                </p>
              ) : null}
            </>
          ) : paymentTx ? (
            <div className="mt-2 space-y-3">
              <p className="text-[12.5px] leading-relaxed text-fg-3">
                Settled — waiting for the broker to record the payment.
              </p>
              <Button href={explorerTx(NETWORK, paymentTx)} variant="secondary" external className="w-full">
                View USDC transfer
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-[12.5px] leading-relaxed text-fg-3">
              Settling on Monad — this usually takes about a second.
            </p>
          )}
        </Panel>

        <RateJob job={job} onRated={(rating) => setJob((prev) => (prev ? { ...prev, rating } : prev))} />

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
 * What the network's AI roles said about this job, when they ran: the prompt
 * screen (Hunyuan), the router (Qwen) and the result verifier (Kimi), whose
 * score becomes ERC-8004 feedback. Each is optional — a broker with a role
 * switched off simply doesn't send it — and each names the exact model, so the
 * buyer knows which model judged their job.
 */
function AiChecks({ job }: { job: Job }) {
  const info = useNetworkInfo();
  const { screening, routing, verification } = job;
  if (!screening && !routing && !verification) return null;

  return (
    <section>
      <h2 className="mb-2.5 text-[13px] font-medium text-fg">Network checks</h2>
      <Panel className="divide-y divide-[var(--line)] px-4">
        {screening ? (
          <Check
            label="Screened"
            by={screening.by}
            model={screening.model}
            verdict={screening.verdict === "allow" ? "allowed" : "blocked"}
            bad={screening.verdict !== "allow"}
            text={screening.reason}
          />
        ) : null}
        {routing ? (
          <Check
            label="Routed"
            by={routing.by}
            model={routing.model}
            verdict={routing.adapter ? `→ ${routing.adapter}` : "→ price match"}
            text={routing.reason}
          />
        ) : null}
        {verification ? (
          <Check
            label="Verified"
            by={verification.by}
            model={verification.model}
            verdict={`${verification.score}/100 · ${verification.pass ? "pass" : "fail"}`}
            bad={!verification.pass}
            text={verification.rationale}
            link={
              verification.feedbackTxHash
                ? { href: explorerTx(NETWORK, verification.feedbackTxHash), label: "ERC-8004 feedback ↗" }
                : info?.ai.verifier
                  ? { label: "feedback pending" }
                  : null
            }
          />
        ) : null}
      </Panel>
    </section>
  );
}

function Check({
  label,
  by,
  model,
  verdict,
  bad,
  text,
  link,
}: {
  label: string;
  by: string;
  model: string;
  verdict: string;
  bad?: boolean;
  text: string;
  link?: { href?: string; label: string } | null;
}) {
  return (
    <div className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-[12.5px] text-fg-2">
          {label} by <span className="capitalize">{by}</span>{" "}
          <span className="mono text-[11.5px] text-fg-4">{model}</span>
        </p>
        <span className={cn("text-[12px]", bad ? "text-fail" : "text-fg-2")}>{verdict}</span>
      </div>
      {text ? <p className="mt-1 text-[12px] leading-relaxed text-fg-3">{text}</p> : null}
      {link ? (
        <p className="mt-1 text-[11.5px] text-fg-4">{link.href ? <Ext href={link.href}>{link.label}</Ext> : link.label}</p>
      ) : null}
    </div>
  );
}
