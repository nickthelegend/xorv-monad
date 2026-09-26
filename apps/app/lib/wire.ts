/**
 * Defensive readers for the broker responses that are not (yet) pinned by a
 * protocol type: the ledger feed and the leaderboard.
 *
 * Both can be served by two backends — the Envio indexer's GraphQL when the
 * broker has `XORV_INDEXER_URL`, or the broker's own RPC scan / in-memory
 * stats when it does not — and the two naturally disagree on field names
 * (`jobsCompleted` vs `okCount`, micro-USDC as a number vs a string). Rather
 * than let one spelling blank the network page, these accept the plausible
 * variants and normalize to one shape the UI renders. Anything that does not
 * look like a row is dropped, not rendered as "undefined".
 */

import type { LedgerEvent, LedgerEventKind } from "@xorv/protocol/web";

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (typeof value === "bigint") return Number(value);
  return null;
}

function first<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) if (value !== null && value !== undefined) return value;
  return null;
}

/** Integer-string of smallest units, from a number, string or bigint; null when unusable. */
function units(value: unknown): string | null {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value).toString();
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim()).toString();
  return null;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardRow {
  /** The broker's provider id, when the source knows it (in-memory stats do; the chain only has its hash). */
  providerId: string | null;
  label: string | null;
  address: string | null;
  agentId: string | null;
  /** Jobs recorded on the ledger for this provider. */
  jobs: number;
  jobsOk: number;
  /** 0–1, or null before the first job. */
  successRate: number | null;
  /** Lifetime USDC earned, smallest units (6dp), integer string. */
  earnedUsdcUnits: string;
  /** Buyer ratings relayed into ERC-8004. */
  ratings: number;
  /** Mean rating on the 0–100 ERC-8004 scale, or null when unrated. */
  avgRating: number | null;
}

export interface Leaderboard {
  /** "indexer" when Envio served it, "memory" for the broker's own stats. */
  source: string;
  rows: LeaderboardRow[];
}

function leaderboardRow(raw: unknown): LeaderboardRow | null {
  if (!isObject(raw)) return null;
  const provider = isObject(raw.provider) ? raw.provider : {};
  const stats = isObject(raw.stats) ? raw.stats : {};
  const reputation = isObject(raw.reputation) ? raw.reputation : {};

  const address = first(str(raw.address), str(raw.payTo), str(provider.address));
  const agentId = first(str(raw.agentId), str(provider.agentId));
  const providerId = first(str(raw.providerId), str(raw.id), str(provider.id));
  if (!address && !agentId && !providerId) return null;

  const jobsOk = first(num(raw.jobsOk), num(raw.okCount), num(raw.successCount), num(raw.jobsCompleted), num(stats.jobsCompleted)) ?? 0;
  const jobsFailed = first(num(raw.jobsFailed), num(raw.failCount), num(stats.jobsFailed)) ?? 0;
  const jobs = first(num(raw.jobs), num(raw.jobsTotal), num(raw.jobCount), num(raw.receiptCount)) ?? jobsOk + jobsFailed;

  let successRate = first(num(raw.successRate), num(raw.success_rate));
  // Accept a percentage (87.5) as readily as a fraction (0.875).
  if (successRate !== null && successRate > 1) successRate = successRate / 100;
  if (successRate === null && jobs > 0) successRate = jobsOk / jobs;

  // micro-USD and USDC's smallest unit are the same integer (6 decimals).
  const earnedUsdcUnits =
    first(
      units(raw.earnedUsdcUnits),
      units(raw.earnedUsdc),
      units(raw.totalEarned),
      units(raw.earned),
      units(raw.earnedUsdcMicros),
      units(stats.earnedUsdcMicros),
    ) ?? "0";

  const ratings = first(num(raw.ratingCount), num(raw.ratings), num(raw.feedbackCount), num(reputation.count)) ?? 0;
  const ratingSum = first(num(raw.ratingSum), num(reputation.sum));
  const avgRating = first(
    num(raw.avgRating),
    num(raw.averageRating),
    num(reputation.average),
    ratingSum !== null && ratings > 0 ? ratingSum / ratings : null,
  );

  return {
    providerId,
    label: first(str(raw.label), str(provider.label)),
    address,
    agentId,
    jobs,
    jobsOk,
    successRate,
    earnedUsdcUnits,
    ratings,
    avgRating,
  };
}

/** Normalize `GET /api/leaderboard`, whichever backend answered. Sorted by earnings, highest first. */
export function normalizeLeaderboard(json: unknown): Leaderboard {
  const body = isObject(json) ? json : {};
  const list = Array.isArray(json)
    ? json
    : ([body.leaderboard, body.providers, body.rows, body.items].find(Array.isArray) as unknown[] | undefined) ?? [];
  const rows = list.map(leaderboardRow).filter((row): row is LeaderboardRow => row !== null);
  rows.sort((a, b) => {
    const diff = BigInt(b.earnedUsdcUnits) - BigInt(a.earnedUsdcUnits);
    return diff > 0n ? 1 : diff < 0n ? -1 : b.jobs - a.jobs;
  });
  const source = str(body.source) ?? (body.indexer ? "indexer" : "memory");
  return { source, rows };
}

// ---------------------------------------------------------------------------
// Ledger feed
// ---------------------------------------------------------------------------

export interface LedgerFeed<K extends LedgerEventKind = LedgerEventKind> {
  kind: K;
  source: string | null;
  events: LedgerEvent<K>[];
}

/** Normalize `GET /api/ledger?kind=…`: keep only rows that carry a tx hash and a data payload. */
export function normalizeLedgerFeed<K extends LedgerEventKind>(json: unknown, kind: K): LedgerFeed<K> {
  const body = isObject(json) ? json : {};
  const list = Array.isArray(json)
    ? json
    : ([body.events, body.items, body.receipts, body.ratings].find(Array.isArray) as unknown[] | undefined) ?? [];
  const events: LedgerEvent<K>[] = [];
  for (const raw of list) {
    if (!isObject(raw) || !isObject(raw.data)) continue;
    const txHash = str(raw.txHash);
    if (!txHash) continue;
    const blockNumber = num(raw.blockNumber) ?? 0;
    events.push({
      kind,
      id: str(raw.id) ?? `${blockNumber}:${events.length}`,
      blockNumber,
      txHash,
      at: num(raw.at) ?? 0,
      data: raw.data as unknown as LedgerEvent<K>["data"],
    });
  }
  return { kind, source: str(body.source), events };
}
