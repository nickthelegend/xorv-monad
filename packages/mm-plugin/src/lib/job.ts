/**
 * Following a paid job to its end.
 *
 * The broker streams a job over SSE (`snapshot`, `event`, `job`, `done`); the
 * plugin prints provider events as they arrive and returns the terminal job.
 * If the stream drops — a proxy that buffers SSE, a broker restart — it falls
 * back to polling `GET /api/jobs/:id`, because the job keeps running on the
 * provider either way and the buyer has already paid for it.
 */

import type { JobEvent, JobStatus, PublicJob } from "@xorv/protocol";
import type { BrokerClient } from "./broker.js";
import { XorvPluginError } from "./errors.js";

const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(["completed", "failed", "expired"]);
export const isTerminal = (status: string | null | undefined): boolean => TERMINAL.has(status as JobStatus);

export interface WatchOptions {
  broker: BrokerClient;
  jobId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: JobEvent) => void;
  onStatus?: (status: string) => void;
  pollIntervalMs?: number;
  /** Injectable clock and sleep, for tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function watchJob(opts: WatchOptions): Promise<PublicJob> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + opts.timeoutMs;
  const pollMs = opts.pollIntervalMs ?? 1_500;
  let lastStatus: string | null = null;
  const status = (next: string | null | undefined) => {
    if (next && next !== lastStatus) {
      lastStatus = next;
      opts.onStatus?.(next);
    }
  };

  // 1. Stream, bounded by the same deadline.
  const streamAbort = new AbortController();
  const timer = setTimeout(() => streamAbort.abort(), Math.max(0, deadline - now()));
  const relay = () => streamAbort.abort();
  opts.signal?.addEventListener("abort", relay, { once: true });
  let seenEvents = 0;
  try {
    for await (const item of opts.broker.stream(opts.jobId, streamAbort.signal)) {
      if (item.type === "event") {
        seenEvents += 1;
        opts.onEvent?.(item.event);
        continue;
      }
      status(item.job.status);
      if (item.type === "snapshot") {
        // Replay what already happened (a fast job may be half done by now).
        for (const event of item.job.events ?? []) {
          seenEvents += 1;
          opts.onEvent?.(event);
        }
      }
      if (item.type === "done" || isTerminal(item.job.status)) return item.job;
    }
  } catch {
    // Stream unavailable or dropped: fall through to polling.
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", relay);
  }

  // 2. Poll until terminal or out of time.
  while (true) {
    if (opts.signal?.aborted) throw aborted(opts.jobId);
    const job = await opts.broker.job(opts.jobId);
    status(job.status);
    const events = job.events ?? [];
    for (const event of events.slice(seenEvents)) opts.onEvent?.(event);
    seenEvents = Math.max(seenEvents, events.length);
    if (isTerminal(job.status)) return job;
    if (now() + pollMs > deadline) {
      throw new XorvPluginError(
        "XORV_JOB_TIMEOUT",
        `job ${opts.jobId} is still ${job.status} after ${Math.round(opts.timeoutMs / 1000)} s`,
        `It is paid for and keeps running. Check it later with: mm xorv job ${opts.jobId}`,
      );
    }
    await sleep(pollMs, opts.signal);
  }
}

function aborted(jobId: string): XorvPluginError {
  return new XorvPluginError(
    "XORV_JOB_TIMEOUT",
    `stopped waiting for job ${jobId}`,
    `It is paid for and keeps running. Check it later with: mm xorv job ${jobId}`,
  );
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
