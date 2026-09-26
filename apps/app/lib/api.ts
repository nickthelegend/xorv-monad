/**
 * Typed access to the broker.
 *
 * Reads are free and public — providers, jobs, ledger events, the leaderboard.
 * Writes that move money or reputation are signed by the *buyer's* wallet in
 * the browser (see lib/x402-pay.ts and lib/rating.ts); the broker only relays
 * them. The shapes come from `@xorv/protocol` as `import type`, so a rename on
 * the broker side is a compile error here rather than a blank panel at runtime,
 * and nothing from the protocol package lands in the bundle for it.
 */

import {
  formatAgo,
  formatDuration,
  formatUsd as formatUsdMicros,
  type LedgerEvent,
  type LedgerEventKind,
  type NetworkInfo,
  type PublicJob,
  type PublicProvider,
  type QuoteResponse,
} from "@xorv/protocol/web";
import { normalizeLeaderboard, normalizeLedgerFeed, type Leaderboard, type LedgerFeed } from "@/lib/wire";

export { NETWORK } from "@/lib/network";
export { formatAgo, formatDuration };

export const BROKER_URL = (
  process.env.NEXT_PUBLIC_XORV_BROKER_URL ?? "http://localhost:8402"
).replace(/\/+$/, "");

export type Job = PublicJob;
export type Provider = PublicProvider;
export type Quote = QuoteResponse;
export type { JobEvent, JobRouting, JobScreening, JobVerification, JobRating, PaymentRecord } from "@xorv/protocol/web";
export type { LedgerEvent, LedgerEventKind, NetworkInfo, Leaderboard, LedgerFeed };

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${path} → ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

export const api = {
  network: () => get<NetworkInfo>("/api/network"),
  providers: () => get<{ providers: Provider[] }>("/api/providers").then((r) => r.providers),
  jobs: (limit = 25) => get<{ jobs: Job[] }>(`/api/jobs?limit=${limit}`).then((r) => r.jobs),
  job: (id: string) => get<{ job: Job }>(`/api/jobs/${encodeURIComponent(id)}`).then((r) => r.job),
  /** XorvLedger events — from the Envio indexer when the broker has one, else an RPC log scan. */
  ledger: <K extends LedgerEventKind>(kind: K, limit = 20) =>
    get<unknown>(`/api/ledger?kind=${kind}&limit=${limit}`).then((r) => normalizeLedgerFeed(r, kind)),
  leaderboard: () => get<unknown>("/api/leaderboard").then(normalizeLeaderboard),
  quote: async (body: { prompt: string; adapter: string | null; maxPriceUsdMicros: number }): Promise<Quote> => {
    const res = await fetch(`${BROKER_URL}/api/quotes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Quote & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `Broker returned ${res.status}.`);
    return json;
  },
};

/** micro-USD → "$0.0010", or an em dash for "not priced yet". Same digits as the CLI. */
export function formatUsd(micros: number | null | undefined): string {
  if (micros == null) return "—";
  return formatUsdMicros(micros);
}

/** Narrow a ledger event feed to one kind without trusting the wire shape. */
export function eventsOf<K extends LedgerEventKind>(feed: LedgerFeed<K> | null): LedgerEvent<K>[] {
  return feed?.events ?? [];
}
