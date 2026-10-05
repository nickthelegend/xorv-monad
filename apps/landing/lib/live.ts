"use client";

import { useEffect, useState } from "react";
import { BROKER_URL } from "@/lib/links";

/**
 * The broker's live state, for every visual on the page that shows numbers.
 *
 * Nothing on the landing page is a made-up figure: providers, prices, jobs,
 * earnings and transaction hashes all come from the broker the site is
 * configured against, polled every 15 seconds. When the broker can't be
 * reached, the visuals say so instead of inventing a plausible picture.
 */

export interface LiveProvider {
  id: string;
  label: string;
  status: string;
  lastHeartbeatAt: number;
  activeJobs: number;
  capabilities: Array<{ id: string; adapter: string; displayName: string; priceUsdMicros: number }>;
  available?: Record<string, boolean>;
  stats: { jobsCompleted: number; jobsFailed: number; earnedUsdcMicros: number };
  onchain?: { registered: boolean; completed: number; failed: number; score: number; sponsorTx?: string | null } | null;
}

export interface LiveJob {
  id: string;
  status: string;
  adapter: string | null;
  providerLabel: string | null;
  priceUsdMicros: number | null;
  createdAt: number;
  completedAt: number | null;
  payment: {
    amount: string;
    asset: string;
    transactionHash: string;
    scheme?: string;
    escrow?: { state: string; releaseTx?: string; refundTx?: string } | null;
  } | null;
}

export interface LiveState {
  reachable: boolean;
  loaded: boolean;
  providers: LiveProvider[];
  jobs: LiveJob[];
  network: { network: string; escrow?: { address: string } | null } | null;
}

const EMPTY: LiveState = { reachable: false, loaded: false, providers: [], jobs: [], network: null };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

let shared: Promise<LiveState> | null = null;
let sharedAt = 0;

/** One fetch shared by every component that mounts in the same 5 seconds. */
function load(): Promise<LiveState> {
  if (shared && Date.now() - sharedAt < 5_000) return shared;
  sharedAt = Date.now();
  shared = Promise.all([
    get<{ providers: LiveProvider[] }>("/api/providers"),
    get<{ jobs: LiveJob[] }>("/api/jobs?limit=200"),
    get<LiveState["network"]>("/api/network"),
  ])
    .then(([p, j, n]) => ({ reachable: true, loaded: true, providers: p.providers, jobs: j.jobs, network: n }))
    .catch(() => ({ ...EMPTY, loaded: true }));
  return shared;
}

export function useLive(): LiveState {
  const [state, setState] = useState<LiveState>(EMPTY);
  useEffect(() => {
    let alive = true;
    const tick = () => void load().then((s) => alive && setState(s));
    tick();
    const timer = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return state;
}

export function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

export function shortHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}

/** Stablecoin actually paid to providers for a job (6dp units), 0 if nothing settled to them. */
export function paidToProvider(job: LiveJob): number {
  if (!job.payment) return 0;
  const escrow = job.payment.escrow;
  if (escrow && escrow.state !== "released") return 0;
  return Number(job.payment.amount) || 0;
}
