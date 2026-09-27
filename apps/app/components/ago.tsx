"use client";

import { useSyncExternalStore } from "react";
import { formatAgo } from "@/lib/api";

/**
 * "12s ago", rendered so the server and the browser agree.
 *
 * Relative time computed during render reads `Date.now()` twice for one
 * piece of markup: once on the server, once when the browser hydrates a
 * second or more later. Across a second boundary the two strings differ, and
 * React throws the server HTML away with a hydration error (in `next dev`,
 * the error badge lands on the page being demoed). So the server render and
 * the hydration render show a placeholder, and the relative time appears on
 * the next client render, ticking once a second from then on.
 */

let now: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    // Idle since the last page that used it: don't show a stale clock.
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  now ??= Date.now();
  return now;
}

function getServerSnapshot(): null {
  return null;
}

/** The wall clock, ticking once a second in the browser; null on the server and while hydrating. */
export function useNow(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** How long ago `at` (epoch ms) was, e.g. "12s ago"; "—" until the browser has taken over. */
export function Ago({ at }: { at: number }) {
  const current = useNow();
  const exact = Number.isFinite(at) ? new Date(at).toISOString() : undefined;
  return <span title={exact}>{current === null ? "—" : formatAgo(at, current)}</span>;
}
