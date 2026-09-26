"use client";

import { useEffect, useState } from "react";
import { api, type NetworkInfo } from "@/lib/api";

/**
 * Polling, not sockets.
 *
 * The broker streams per-job events over SSE — that's what the job page uses.
 * Lists, the leaderboard and the network facts are summaries that change on
 * the order of seconds, so a poll is a dozen lines and survives a broker
 * restart with no reconnection logic. A socket here would be machinery for its
 * own sake.
 *
 * `load` must be stable (wrap it in `useCallback`), or every render restarts
 * the timer.
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs = 5_000): { data: T | null; error: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const run = async (): Promise<void> => {
      try {
        const next = await load();
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
  }, [load, intervalMs]);

  return { data, error };
}

/**
 * One in-flight request shared by every component that asks, so a page with
 * three consumers makes one call rather than three.
 */
function once<T>(load: () => Promise<T>, ttlMs: number): () => Promise<T> {
  let cached: { at: number; value: Promise<T> } | null = null;
  return () => {
    if (!cached || Date.now() - cached.at > ttlMs) {
      const value = load();
      cached = { at: Date.now(), value };
      // A failure should not be remembered for the whole TTL.
      value.catch(() => {
        if (cached?.value === value) cached = null;
      });
    }
    return cached.value;
  };
}

function useOnce<T>(load: () => Promise<T>): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    load().then(
      (next) => {
        if (alive) setValue(next);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [load]);
  return value;
}

const networkOnce = once(() => api.network(), 30_000);

/** `/api/network`, fetched once per 30 s across the page — ledger address, AI roles, facilitator. */
export function useNetworkInfo(): NetworkInfo | null {
  return useOnce(networkOnce);
}

export interface DemoPayerInfo {
  configured: boolean;
  /** The demo account's address — the payer recorded for jobs it buys. */
  address: string | null;
  /** Largest job it will pay for, in USDC units. */
  maxUsdcUnits?: string;
  reason?: string;
}

const demoOnce = once(
  (): Promise<DemoPayerInfo> =>
    fetch("/api/pay", { cache: "no-store" })
      .then((res) => res.json() as Promise<DemoPayerInfo>)
      .catch(() => ({ configured: false, address: null })),
  60_000,
);

/** Whether this deployment has a demo account to pay (and rate) from. */
export function useDemoPayer(): DemoPayerInfo | null {
  return useOnce(demoOnce);
}
