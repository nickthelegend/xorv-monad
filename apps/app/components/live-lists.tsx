"use client";

import Link from "next/link";
import { useCallback } from "react";
import { AnimatePresence, motion } from "motion/react";
import { explorerAddress, explorerAgent, formatUsdc, sameAddress, shortHex } from "@xorv/protocol/web";
import { EASE, useEntrance } from "@/lib/motion";
import { api, formatAgo, formatUsd, type Job, type Leaderboard, type Provider } from "@/lib/api";
import { usePoll } from "@/lib/hooks";
import { NETWORK } from "@/lib/network";
import type { LeaderboardRow } from "@/lib/wire";
import { Empty, Ext, Skeleton, Status } from "@/components/ui";
import { valueToStars } from "@/lib/rating";

/** Match a live provider to its leaderboard row: by broker id when known, else by payout address. */
function rowFor(provider: Provider, board: Leaderboard | null): LeaderboardRow | null {
  if (!board) return null;
  return (
    board.rows.find((r) => r.providerId === provider.id) ??
    board.rows.find((r) => sameAddress(r.address, provider.address)) ??
    null
  );
}

/**
 * Live providers.
 *
 * `detailed` (the providers page) adds what a buyer weighs before trusting a
 * stranger's machine: the ERC-8004 identity, reputation from buyer ratings,
 * success rate and lifetime USDC earned — joined from the leaderboard, which
 * the Envio indexer serves when the broker has one.
 */
export function ProviderList({ detailed = false }: { detailed?: boolean }) {
  const { data: providers, error } = usePoll<Provider[]>(useCallback(() => api.providers(), []));
  const { data: board } = usePoll<Leaderboard | null>(
    useCallback(() => (detailed ? api.leaderboard().catch(() => null) : Promise.resolve(null)), [detailed]),
    15_000,
  );

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
            machine with Claude Code, Codex, Qwen Code or a Qwen / Kimi / Hunyuan API key.
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
        const rank = detailed ? rowFor(p, board) : null;
        const jobs = p.stats.jobsCompleted + p.stats.jobsFailed;
        const successRate = rank?.successRate ?? (jobs > 0 ? p.stats.jobsCompleted / jobs : null);
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
                <Ext href={p.addressUrl || explorerAddress(NETWORK, p.address)}>{shortHex(p.address)}</Ext>
                {p.agentId ? (
                  <>
                    {" · "}
                    <Ext href={p.agentUrl || explorerAgent(NETWORK, p.agentId)}>agent #{p.agentId}</Ext>
                  </>
                ) : detailed ? (
                  " · no ERC-8004 identity"
                ) : null}
                {p.region ? ` · ${p.region}` : ""} · beat {formatAgo(p.lastHeartbeatAt)}
              </p>
              {detailed ? (
                <p className="mt-1.5 text-[11.5px] text-fg-3">
                  {rank?.avgRating != null ? (
                    <>
                      <span className="text-fg-2">{"★".repeat(valueToStars(rank.avgRating))}</span>{" "}
                      <span className="tnum">{Math.round(rank.avgRating)}/100</span> from {rank.ratings} rating
                      {rank.ratings === 1 ? "" : "s"}
                    </>
                  ) : (
                    "no ratings yet"
                  )}
                  {successRate != null ? (
                    <>
                      {" · "}
                      <span className="tnum">{Math.round(successRate * 100)}%</span> success
                    </>
                  ) : null}
                </p>
              ) : null}
            </div>
            <div className="shrink-0 text-right">
              <p className="tnum text-[14px] font-medium text-fg">
                {Number.isFinite(cheapest) ? formatUsd(cheapest) : "—"}
              </p>
              <p className="tnum mt-0.5 text-[11.5px] text-fg-4">{p.stats.jobsCompleted} done</p>
              {detailed ? (
                <p className="tnum mt-0.5 text-[11.5px] text-fg-3">
                  {formatUsdc(rank?.earnedUsdcUnits ?? p.stats.earnedUsdcMicros)} earned
                </p>
              ) : null}
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
        hint="Post one above — it settles on Monad in about a second."
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
                {job.payment ? " · paid in USDC" : ""}
                {job.rating ? ` · ${"★".repeat(valueToStars(job.rating.value))}` : ""}
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
