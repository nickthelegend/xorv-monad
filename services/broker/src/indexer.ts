/**
 * The Envio indexer, as the broker reads it.
 *
 * The indexer (services/indexer) follows XorvLedger and the ERC-8004
 * registries and serves derived entities over Hasura GraphQL — provider
 * earnings, success rates, buyer ratings, reputation — so the broker doesn't
 * have to walk the chain in 100-block windows to answer "who is the best
 * provider?" or "what were the last 50 receipts?".
 *
 * It is an accelerator, never a dependency: every caller falls back to the
 * in-memory registry or a bounded RPC scan when the indexer is unset, slow or
 * erroring. The queries below use only the fields the broker needs, so the
 * indexer's schema can grow without breaking this file.
 *
 * Wire encoding (Hasura): addresses and bytes32 are lowercase hex; BigInt and
 * Float columns may arrive as strings or numbers; timestamps are unix seconds.
 */

import { getAddress, isAddress } from "viem";
import type { LedgerEvent, LedgerEventKind } from "@xorv/protocol";

export class IndexerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexerError";
  }
}

type Numeric = string | number | null | undefined;

export interface IndexerOptions {
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** POST one query and return `data`; throws IndexerError on HTTP, GraphQL or timeout failures. */
export async function queryIndexer<T>(
  opts: IndexerOptions,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
  } catch (err) {
    throw new IndexerError(`indexer request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new IndexerError(`indexer HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  } | null;
  if (!body) throw new IndexerError("indexer returned a non-JSON body");
  if (body.errors?.length) {
    throw new IndexerError(`indexer GraphQL error: ${body.errors.map((e) => e.message ?? "unknown").join("; ")}`);
  }
  if (body.data === undefined) throw new IndexerError("indexer returned no data");
  return body.data;
}

const RECENT_JOBS = /* GraphQL */ `
  query RecentJobs($limit: Int!) {
    Job(order_by: [{ blockTimestamp: desc }, { logIndex: desc }], limit: $limit) {
      id agent_id buyer_id payTo amount paymentTx requestHash resultHash durationMs ok
      blockNumber blockTimestamp txHash logIndex
    }
  }
`;

const RECENT_RATINGS = /* GraphQL */ `
  query RecentRatings($limit: Int!) {
    Rating(order_by: { blockTimestamp: desc }, limit: $limit) {
      id agent_id buyer_id value feedbackHash blockTimestamp txHash
    }
  }
`;

const RECENT_PROVIDERS = /* GraphQL */ `
  query RecentProviders($limit: Int!) {
    Provider(order_by: { updatedAt: desc }, limit: $limit) {
      id payTo agent_id label capabilities registeredTx updatedAt
    }
  }
`;

const LEADERBOARD = /* GraphQL */ `
  query Leaderboard($limit: Int!) {
    Provider(order_by: [{ earnedUsdc: desc }, { jobsOk: desc }], limit: $limit) {
      id label payTo agent_id jobsTotal jobsOk jobsFailed successRate earnedUsdc
      avgDurationMs ratingsCount avgRating lastHeartbeatAt
      agent { feedbackCount feedbackAvg verifiedScore }
    }
  }
`;

interface JobRow {
  id: string;
  agent_id: string | null;
  buyer_id: string;
  payTo: string;
  amount: Numeric;
  paymentTx: string;
  requestHash: string;
  resultHash: string;
  durationMs: number;
  ok: boolean;
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
  logIndex?: number;
}

interface RatingRow {
  id: string;
  agent_id: string;
  buyer_id: string;
  value: number;
  feedbackHash: string;
  blockTimestamp: number;
  txHash: string;
}

interface ProviderRow {
  id: string;
  payTo: string;
  agent_id: string | null;
  label: string;
  capabilities: string;
  registeredTx: string;
  updatedAt: number;
}

export interface IndexerLeaderboardRow {
  /** providerIdHash (bytes32). */
  id: string;
  label: string;
  payTo: string;
  agent_id: string | null;
  jobsTotal: number;
  jobsOk: number;
  jobsFailed: number;
  successRate: Numeric;
  earnedUsdc: Numeric;
  avgDurationMs: number;
  ratingsCount: number;
  avgRating: Numeric;
  lastHeartbeatAt: number | null;
  agent: { feedbackCount: number; feedbackAvg: Numeric; verifiedScore: Numeric } | null;
}

const ZERO_HASH = `0x${"0".repeat(64)}`;

function address(value: string): string {
  return isAddress(value, { strict: false }) ? getAddress(value) : value;
}

export function toNumber(value: Numeric): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function toBigIntString(value: Numeric): string {
  if (value === null || value === undefined || value === "") return "0";
  if (typeof value === "number") return BigInt(Math.trunc(value)).toString();
  return BigInt(value.split(".")[0] || "0").toString();
}

/** Indexer entity id → the `<block>:<logIndex>` shape the RPC feed uses, when the row has one. */
function eventId(row: { blockNumber?: number; logIndex?: number; id: string }): string {
  return row.blockNumber !== undefined && row.logIndex !== undefined ? `${row.blockNumber}:${row.logIndex}` : row.id;
}

/** Which feeds the indexer can serve. Heartbeats are aggregated there, not kept per event. */
export function indexerServes(kind: LedgerEventKind): boolean {
  return kind === "receipts" || kind === "ratings" || kind === "registrations";
}

/** One feed from the indexer, in the same `LedgerEvent` shape the RPC reader returns. */
export async function readIndexerEvents(
  opts: IndexerOptions,
  kind: LedgerEventKind,
  limit: number,
): Promise<LedgerEvent[]> {
  switch (kind) {
    case "receipts": {
      const data = await queryIndexer<{ Job: JobRow[] }>(opts, RECENT_JOBS, { limit });
      return data.Job.map(
        (row): LedgerEvent<"receipts"> => ({
          kind: "receipts",
          id: eventId(row),
          blockNumber: row.blockNumber,
          txHash: row.txHash,
          at: row.blockTimestamp * 1000,
          data: {
            jobId: row.id,
            agentId: row.agent_id,
            buyer: address(row.buyer_id),
            payTo: address(row.payTo),
            amount: toBigIntString(row.amount),
            paymentTx: !row.paymentTx || row.paymentTx === ZERO_HASH ? null : row.paymentTx,
            requestHash: row.requestHash,
            resultHash: row.resultHash,
            durationMs: row.durationMs,
            ok: row.ok,
          },
        }),
      );
    }
    case "ratings": {
      const data = await queryIndexer<{ Rating: RatingRow[] }>(opts, RECENT_RATINGS, { limit });
      return data.Rating.map(
        (row): LedgerEvent<"ratings"> => ({
          kind: "ratings",
          id: row.id,
          blockNumber: 0,
          txHash: row.txHash,
          at: row.blockTimestamp * 1000,
          data: {
            jobId: row.id,
            agentId: row.agent_id,
            buyer: address(row.buyer_id),
            value: row.value,
            feedbackHash: row.feedbackHash,
          },
        }),
      );
    }
    case "registrations": {
      const data = await queryIndexer<{ Provider: ProviderRow[] }>(opts, RECENT_PROVIDERS, { limit });
      return data.Provider.map(
        (row): LedgerEvent<"registrations"> => ({
          kind: "registrations",
          id: row.id,
          blockNumber: 0,
          txHash: row.registeredTx,
          at: row.updatedAt * 1000,
          data: {
            providerId: row.id,
            payTo: address(row.payTo),
            agentId: row.agent_id,
            label: row.label,
            capabilities: row.capabilities,
          },
        }),
      );
    }
    default:
      throw new IndexerError(`the indexer does not keep individual ${kind} events`);
  }
}

export async function readIndexerLeaderboard(opts: IndexerOptions, limit: number): Promise<IndexerLeaderboardRow[]> {
  const data = await queryIndexer<{ Provider: IndexerLeaderboardRow[] }>(opts, LEADERBOARD, { limit });
  return data.Provider;
}
