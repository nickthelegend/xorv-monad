"use client";

import { useCallback, useState } from "react";
import { api, formatUsd, type Job } from "@/lib/api";
import { usePoll } from "@/lib/hooks";
import { ALL, OUTCOMES, filterJobs, outcomeCounts, providersIn, type JobQuery } from "@/lib/job-filter";
import { Button, Empty, Skeleton } from "@/components/ui";
import { JobRows } from "@/components/live-lists";
import { cn } from "@/lib/utils";

const PAGE = 25;

/**
 * Every job on the network, newest first: filter by outcome and provider,
 * search the prompt, title or job id. Read from the broker (its 500 most
 * recent jobs), refreshed every ten seconds, filtered in the browser.
 */
export function JobBrowser() {
  const { data: jobs, error } = usePoll<Job[]>(useCallback(() => api.jobs(500), []), 10_000);
  const [query, setQuery] = useState<JobQuery>(ALL);
  const [shown, setShown] = useState(PAGE);

  if (error && !jobs) return <Empty title="Can't reach the broker" hint="The list comes back as soon as it does." />;
  if (!jobs) return <Skeleton rows={5} />;

  const counts = outcomeCounts(jobs);
  const providers = providersIn(jobs);
  const matches = filterJobs(jobs, query);
  const paid = matches.reduce((sum, j) => sum + (j.priceUsdMicros ?? 0), 0);
  const set = (patch: Partial<JobQuery>): void => {
    setQuery((q) => ({ ...q, ...patch }));
    setShown(PAGE);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          value={query.text}
          onChange={(e) => set({ text: e.target.value })}
          placeholder="Search prompts, titles or job ids"
          aria-label="Search jobs"
          className="w-full rounded-lg border border-[var(--line)] bg-surface px-3.5 py-2.5 text-[13.5px] text-fg placeholder:text-fg-4 focus:border-[var(--line-3)] focus:outline-none sm:flex-1"
        />
        <select
          value={query.provider}
          onChange={(e) => set({ provider: e.target.value })}
          aria-label="Filter by provider"
          className="rounded-lg border border-[var(--line)] bg-surface px-3 py-2.5 text-[13px] text-fg-2 focus:border-[var(--line-3)] focus:outline-none"
        >
          <option value="all">All providers</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} ({p.count})
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by outcome">
        {OUTCOMES.map((outcome) => (
          <button
            key={outcome}
            type="button"
            onClick={() => set({ outcome })}
            aria-pressed={query.outcome === outcome}
            className={cn(
              "rounded-full border px-3 py-1 text-[12px] capitalize transition-colors",
              query.outcome === outcome
                ? "border-[var(--line-3)] bg-white/[0.06] text-fg"
                : "border-[var(--line)] text-fg-3 hover:border-[var(--line-2)] hover:text-fg-2",
            )}
          >
            {outcome} <span className="tnum text-fg-4">{counts[outcome]}</span>
          </button>
        ))}
      </div>

      <p className="text-[12px] text-fg-4">
        {matches.length} {matches.length === 1 ? "job" : "jobs"} · {formatUsd(paid)} in quoted prices
      </p>

      {matches.length === 0 ? (
        <Empty
          title={jobs.length === 0 ? "No jobs yet" : "No jobs match"}
          hint={jobs.length === 0 ? "Post one from the board; it settles on Monad in about a second." : "Try another outcome, provider or search."}
        />
      ) : (
        <>
          <JobRows jobs={matches.slice(0, shown)} />
          {matches.length > shown ? (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, matches.length - shown)} more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
