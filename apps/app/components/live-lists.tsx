"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EASE, useEntrance } from "@/lib/motion";
import { api, formatAgo, formatUsd, type Job, type Provider } from "@/lib/api";
import { Empty, Skeleton, Status } from "@/components/ui";

/**
 * Polling, not sockets.
 *
 * The broker streams per-job events over SSE — that's what the job page uses.
 * These two lists are summaries that change on the order of seconds, so a
 * five-second poll is a dozen lines and survives a broker restart with no
 * reconnection logic. A socket here would be machinery for its own sake.
 */
function usePoll<T>(load: () => Promise<T>, intervalMs = 5_000): { data: T | null; error: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const stable = useCallback(load, [load]);

  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      try {
        const next = await stable();
        if (!alive) return;
        setData(next);
        setError(false);
      } catch {
        if (alive) setError(true);
      }
    };
    void run();
    const timer = setInterval(run, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [stable, intervalMs]);

  return { data, error };
}

export function ProviderList() {
  const { data: providers, error } = usePoll<Provider[]>(useCallback(() => api.providers(), []));

  if (error) {
    return (
      <Empty
        title="Can't reach the broker"
        hint={
          <>
            Start it with <span className="mono text-fg-3">pnpm broker</span> in the xorv repo.
          </>
        }
      />
    );
  }
  if (!providers) return <Skeleton rows={2} />;
  if (providers.length === 0) {
    return (
      <Empty
        title="No providers online"
        hint={
          <>
            Run <span className="mono text-fg-3">npm i -g @xorv/cli &amp;&amp; xorv init</span> on any
            machine with Claude Code, Codex or Grok installed.
          </>
        }
      />
    );
  }

  return (
    <ul className="border-t border-[var(--line)]">
      {providers.map((p) => {
        const cheapest = p.capabilities.reduce(
          (min, c) => Math.min(min, c.priceUsdMicros),
          Number.POSITIVE_INFINITY,
        );
        return (
          <li
            key={p.id}
            className="flex items-start justify-between gap-4 border-b border-[var(--line)] py-4"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <span className="truncate text-[14px] font-medium text-fg">{p.label}</span>
                <Status status={p.status} />
              </div>
              <p className="mt-1 truncate text-[12.5px] text-fg-3">
                {p.capabilities.map((c) => c.displayName).join(" · ")}
              </p>
              <p className="mono mt-1 truncate text-[11.5px] text-fg-4">
                {p.accountId}
                {p.region ? ` · ${p.region}` : ""} · beat {formatAgo(p.lastHeartbeatAt)}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="tnum text-[14px] font-medium text-fg">
                {Number.isFinite(cheapest) ? formatUsd(cheapest) : "—"}
              </p>
              <p className="tnum mt-0.5 text-[11.5px] text-fg-4">{p.stats.jobsCompleted} done</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function JobList({ limit = 15 }: { limit?: number }) {
  const load = useCallback(() => api.jobs(limit), [limit]);
  const { data: jobs, error } = usePoll<Job[]>(load);
  const animate = useEntrance();

  if (error) return <Empty title="Can't reach the broker" />;
  if (!jobs) return <Skeleton rows={3} />;
  if (jobs.length === 0) {
    return (
      <Empty
        title="No jobs yet"
        hint="Post one above — it settles on Hedera in about three seconds."
      />
    );
  }

  return (
    <ul className="border-t border-[var(--line)]">
      <AnimatePresence initial={false}>
      {jobs.map((job) => (
        <motion.li
          key={job.id}
          layout={animate}
          // Keyed on the job id, so a five-second poll that returns the same
          // rows doesn't re-animate them — only a genuinely new job enters.
          initial={animate ? { opacity: 0, height: 0 } : false}
          animate={{ opacity: 1, height: "auto" }}
          exit={animate ? { opacity: 0, height: 0 } : undefined}
          transition={{ duration: 0.22, ease: EASE }}
          className="overflow-hidden border-b border-[var(--line)]"
        >
          <Link
            href={`/jobs/${job.id}`}
            className="flex items-start justify-between gap-4 py-4 transition-opacity hover:opacity-70"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <Status status={job.status} />
                <span className="mono truncate text-[11.5px] text-fg-4">{job.id}</span>
              </div>
              <p className="mt-1.5 line-clamp-2 text-[13.5px] leading-relaxed text-fg-2">
                {job.prompt}
              </p>
              <p className="mt-1 truncate text-[11.5px] text-fg-4">
                {job.providerLabel ?? "unassigned"} · {formatAgo(job.createdAt)}
                {job.payment ? ` · ${job.payment.asset.toUpperCase()}` : ""}
              </p>
            </div>
            <span className="tnum shrink-0 text-[14px] font-medium text-fg">
              {formatUsd(job.priceUsdMicros)}
            </span>
          </Link>
        </motion.li>
      ))}
      </AnimatePresence>
    </ul>
  );
}
