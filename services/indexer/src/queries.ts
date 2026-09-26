/**
 * GraphQL queries the broker and the apps run against the indexer, plus the row shapes
 * they return. The indexer serves Hasura GraphQL: every entity in schema.graphql is a
 * root field (`Provider(where:, order_by:, limit:)`) with a `<Entity>_by_pk(id:)`
 * companion, and every @derivedFrom list is a nested field taking the same arguments.
 *
 * Endpoint: XORV_INDEXER_URL, e.g.
 *   local        http://localhost:8080/v1/graphql            (envio dev, admin secret "testing")
 *   Envio Cloud  https://indexer.dev.hyperindex.xyz/<deployment-id>/v1/graphql   (public)
 *
 * This file has no dependencies and imports nothing from envio, so it can be copied
 * verbatim into services/broker or the apps (this package is outside the workspace).
 *
 * Value encoding over the wire:
 *   - Addresses and bytes32 are lowercase hex. Lowercase an address before filtering.
 *   - BigInt columns (USDC base units, 6 dp) and Float columns may arrive as JSON strings
 *     or numbers depending on Hasura's stringify setting; read them with toBigInt/toNumber.
 *   - Timestamps are unix seconds.
 *   - Aggregate root fields (`*_aggregate`) are not assumed to exist; the NetworkStats /
 *     DailyStats rows carry every total the UI needs.
 */

// ---------------------------------------------------------------------------------------
// Fragments (inlined below; exported for callers composing their own queries)

export const PROVIDER_FIELDS = /* GraphQL */ `
  id
  label
  payTo
  agent_id
  adapters
  registeredAt
  lastHeartbeatAt
  heartbeats
  activeJobs
  capacity
  jobsTotal
  jobsOk
  jobsFailed
  successRate
  earnedUsdc
  settledUsdc
  avgDurationMs
  ratingsCount
  avgRating
  lastJobAt
`;

export const AGENT_SCORE_FIELDS = /* GraphQL */ `
  id
  owner
  wallet
  agentURI
  isXorvProvider
  feedbackCount
  feedbackAvg
  buyerRatingCount
  buyerRatingAvg
  verifiedCount
  verifiedScore
`;

export const JOB_FIELDS = /* GraphQL */ `
  id
  provider_id
  agent_id
  buyer_id
  payTo
  amount
  paid
  paymentTx
  requestHash
  resultHash
  durationMs
  ok
  rated
  rating
  blockNumber
  blockTimestamp
  txHash
  logIndex
`;

/** One ERC-8004 feedback entry, as the agent page lists it. */
export const FEEDBACK_FIELDS = /* GraphQL */ `
  id
  client
  feedbackIndex
  value
  decimals
  normalizedValue
  tag1
  tag2
  endpoint
  feedbackURI
  feedbackHash
  kind
  revoked
  responsesCount
  job_id
  blockNumber
  blockTimestamp
  txHash
`;

// ---------------------------------------------------------------------------------------
// Queries

/**
 * The provider leaderboard: highest earnings first, then most delivered jobs, then best
 * buyer rating. Providers without jobs yet are included (they sort last), so a fresh
 * network still shows who is registered. Each row nests the provider's ERC-8004 agent
 * with its reputation split into buyer ratings and verifier scores. Vars: { limit }
 */
export const LEADERBOARD_QUERY = /* GraphQL */ `
  query Leaderboard($limit: Int!) {
    Provider(
      order_by: [{ earnedUsdc: desc }, { jobsOk: desc }, { avgRating: desc }, { registeredAt: asc }]
      limit: $limit
    ) {
      ${PROVIDER_FIELDS}
      agent { ${AGENT_SCORE_FIELDS} }
    }
  }
`;

/** Best-rated providers with a minimum number of buyer ratings. Vars: { limit, minRatings } */
export const LEADERBOARD_BY_RATING_QUERY = /* GraphQL */ `
  query LeaderboardByRating($limit: Int!, $minRatings: Int!) {
    Provider(
      where: { ratingsCount: { _gte: $minRatings } }
      order_by: [{ avgRating: desc }, { ratingsCount: desc }]
      limit: $limit
    ) {
      ${PROVIDER_FIELDS}
      agent { ${AGENT_SCORE_FIELDS} }
    }
  }
`;

/** Latest receipts, newest first (landing ledger, network page). Vars: { limit } */
export const RECENT_JOBS_QUERY = /* GraphQL */ `
  query RecentJobs($limit: Int!) {
    Job(order_by: [{ blockTimestamp: desc }, { logIndex: desc }], limit: $limit) {
      ${JOB_FIELDS}
      provider { id label }
    }
  }
`;

/** Latest buyer ratings (XorvLedger.JobRated), newest first. Vars: { limit } */
export const RECENT_RATINGS_QUERY = /* GraphQL */ `
  query RecentRatings($limit: Int!) {
    Rating(order_by: [{ blockTimestamp: desc }, { logIndex: desc }], limit: $limit) {
      id
      job_id
      provider_id
      agent_id
      buyer_id
      value
      feedbackHash
      feedback_id
      blockNumber
      blockTimestamp
      txHash
      logIndex
    }
  }
`;

/** Network totals plus the last N days of activity. Vars: { days } */
export const NETWORK_STATS_QUERY = /* GraphQL */ `
  query NetworkStats($days: Int!) {
    NetworkStats_by_pk(id: "global") {
      providers
      agentsTotal
      agentsLinked
      buyers
      jobs
      okJobs
      failedJobs
      paidJobs
      successRate
      volumeUsdc
      earnedUsdc
      ratings
      avgRating
      heartbeats
      feedbacks
      verifiedFeedbacks
      lastBlock
      lastUpdated
    }
    DailyStats(order_by: { dayStart: desc }, limit: $days) {
      id
      dayStart
      jobs
      okJobs
      failedJobs
      volumeUsdc
      earnedUsdc
      uniqueBuyers
      activeProviders
      newBuyers
      newProviders
      ratings
      avgRating
      heartbeats
      feedbacks
    }
  }
`;

/** One provider with offers, identity/reputation, recent jobs and a daily series.
 *  Vars: { id (providerId, lowercase 0x bytes32), jobs, days } */
export const PROVIDER_BY_ID_QUERY = /* GraphQL */ `
  query ProviderById($id: String!, $jobs: Int!, $days: Int!) {
    Provider_by_pk(id: $id) {
      ${PROVIDER_FIELDS}
      capabilities
      registrations
      registeredTx
      updatedAt
      uptimeSeconds
      capabilityOffers(where: { active: { _eq: true } }, order_by: { priceUsdMicros: asc }) {
        adapter
        priceUsdMicros
      }
      agent { ${AGENT_SCORE_FIELDS} registeredAt transfers }
      jobs(order_by: { blockTimestamp: desc }, limit: $jobs) {
        ${JOB_FIELDS}
      }
      days(order_by: { dayStart: desc }, limit: $days) {
        day
        dayStart
        jobs
        okJobs
        earnedUsdc
        ratings
        ratingSum
      }
    }
  }
`;

/**
 * An ERC-8004 agent's reputation, split the way Xorv weighs it: the aggregate scores, then
 * the latest non-revoked entries of each kind side by side (buyer ratings relayed by
 * XorvLedger, the verifier's "xorv-verified" scores, and open feedback from anyone else).
 * Vars: { agentId (decimal string), limit (per kind) }
 */
export const AGENT_FEEDBACK_QUERY = /* GraphQL */ `
  query AgentFeedback($agentId: String!, $limit: Int!) {
    Agent_by_pk(id: $agentId) {
      ${AGENT_SCORE_FIELDS}
      agentId
      feedbackRevoked
      buyerRatingSum
      verifiedSum
      lastFeedbackAt
      provider_id
      buyerRatings: feedbacks(
        where: { kind: { _eq: "BUYER_RATING" }, revoked: { _eq: false } }
        order_by: [{ blockNumber: desc }, { logIndex: desc }]
        limit: $limit
      ) {
        ${FEEDBACK_FIELDS}
      }
      verifications: feedbacks(
        where: { kind: { _eq: "XORV_VERIFIED" }, revoked: { _eq: false } }
        order_by: [{ blockNumber: desc }, { logIndex: desc }]
        limit: $limit
      ) {
        ${FEEDBACK_FIELDS}
      }
      otherFeedback: feedbacks(
        where: { kind: { _eq: "OTHER" }, revoked: { _eq: false } }
        order_by: [{ blockNumber: desc }, { logIndex: desc }]
        limit: $limit
      ) {
        ${FEEDBACK_FIELDS}
      }
    }
  }
`;

/**
 * One page of an agent's non-revoked feedback of one kind. Vars: { agentId, limit, offset }.
 * The kind is inlined rather than passed as a variable: Hasura exposes the Postgres enum
 * as a custom scalar whose GraphQL type name depends on the database schema, so a typed
 * `$kind` variable would break between local and hosted deployments.
 */
export function agentFeedbackByKindQuery(kind: FeedbackKind): string {
  if (!FEEDBACK_KINDS.includes(kind)) throw new Error(`unknown feedback kind: ${String(kind)}`);
  return /* GraphQL */ `
  query AgentFeedbackByKind($agentId: String!, $limit: Int!, $offset: Int!) {
    Feedback(
      where: { agent_id: { _eq: $agentId }, kind: { _eq: "${kind}" }, revoked: { _eq: false } }
      order_by: [{ blockNumber: desc }, { logIndex: desc }]
      limit: $limit
      offset: $offset
    ) {
      ${FEEDBACK_FIELDS}
    }
  }
`;
}

/** A buyer's receipts, newest first. Vars: { buyer (lowercase address), limit } */
export const BUYER_JOBS_QUERY = /* GraphQL */ `
  query BuyerJobs($buyer: String!, $limit: Int!) {
    Buyer_by_pk(id: $buyer) {
      id
      jobsTotal
      jobsOk
      spentUsdc
      ratingsGiven
      firstJobAt
      lastJobAt
    }
    Job(where: { buyer_id: { _eq: $buyer } }, order_by: { blockTimestamp: desc }, limit: $limit) {
      ${JOB_FIELDS}
      provider { id label }
    }
  }
`;

/** Cheapest active offers for one adapter. Vars: { adapter, limit } */
export const OFFERS_BY_ADAPTER_QUERY = /* GraphQL */ `
  query OffersByAdapter($adapter: String!, $limit: Int!) {
    ProviderCapability(
      where: { adapter: { _eq: $adapter }, active: { _eq: true } }
      order_by: { priceUsdMicros: asc }
      limit: $limit
    ) {
      priceUsdMicros
      provider { ${PROVIDER_FIELDS} }
    }
  }
`;

/** One receipt with its rating and the relayed ERC-8004 feedback. Vars: { id (jobId) } */
export const JOB_BY_ID_QUERY = /* GraphQL */ `
  query JobById($id: String!) {
    Job_by_pk(id: $id) {
      ${JOB_FIELDS}
      ratedAt
      provider { id label payTo }
      agent { id wallet verifiedScore }
    }
    Rating_by_pk(id: $id) {
      value
      feedbackHash
      feedback_id
      blockTimestamp
      txHash
    }
  }
`;

/**
 * The five queries the broker and the apps are built around, by name:
 *   leaderboard   { limit }                  -> LeaderboardResult
 *   recentJobs    { limit }                  -> RecentJobsResult
 *   networkStats  { days }                   -> NetworkStatsResult
 *   providerById  { id, jobs, days }         -> ProviderByIdResult
 *   agentFeedback { agentId, limit }         -> AgentFeedbackResult
 */
export const QUERIES = {
  leaderboard: LEADERBOARD_QUERY,
  recentJobs: RECENT_JOBS_QUERY,
  networkStats: NETWORK_STATS_QUERY,
  providerById: PROVIDER_BY_ID_QUERY,
  agentFeedback: AGENT_FEEDBACK_QUERY,
} as const;

// ---------------------------------------------------------------------------------------
// Row shapes

/** Hasura may serialise numeric/float8 columns as strings; never assume either. */
export type Numeric = string | number;

export interface ProviderRow {
  id: string;
  label: string;
  payTo: string;
  agent_id: string | null;
  adapters: string[];
  registeredAt: number;
  lastHeartbeatAt: number | null;
  heartbeats: number;
  activeJobs: number;
  capacity: number;
  jobsTotal: number;
  jobsOk: number;
  jobsFailed: number;
  successRate: Numeric;
  earnedUsdc: Numeric;
  settledUsdc: Numeric;
  avgDurationMs: number;
  ratingsCount: number;
  avgRating: Numeric;
  lastJobAt: number | null;
}

export interface AgentScoreRow {
  id: string;
  owner: string | null;
  wallet: string | null;
  agentURI: string | null;
  isXorvProvider: boolean;
  feedbackCount: number;
  feedbackAvg: Numeric;
  buyerRatingCount: number;
  buyerRatingAvg: Numeric;
  verifiedCount: number;
  verifiedScore: Numeric;
}

export interface LeaderboardRow extends ProviderRow {
  agent: AgentScoreRow | null;
}

export interface JobRow {
  id: string;
  provider_id: string | null;
  agent_id: string | null;
  buyer_id: string;
  payTo: string;
  amount: Numeric;
  paid: boolean;
  paymentTx: string;
  requestHash: string;
  resultHash: string;
  durationMs: number;
  ok: boolean;
  rated: boolean;
  rating: number | null;
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
  logIndex: number;
  provider?: { id: string; label: string } | null;
}

export interface RatingRow {
  id: string;
  job_id: string;
  provider_id: string | null;
  agent_id: string;
  buyer_id: string;
  value: number;
  feedbackHash: string;
  feedback_id: string | null;
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
  logIndex: number;
}

export interface FeedbackRow {
  id: string;
  client: string;
  feedbackIndex: Numeric;
  /** Raw int128; normalizedValue = value / 10^decimals. */
  value: Numeric;
  decimals: number;
  normalizedValue: Numeric;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
  kind: FeedbackKind;
  revoked: boolean;
  responsesCount: number;
  job_id: string | null;
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
}

export interface AgentFeedbackRow extends AgentScoreRow {
  agentId: Numeric;
  feedbackRevoked: number;
  buyerRatingSum: Numeric;
  verifiedSum: Numeric;
  lastFeedbackAt: number | null;
  provider_id: string | null;
  buyerRatings: FeedbackRow[];
  verifications: FeedbackRow[];
  otherFeedback: FeedbackRow[];
}

export interface ProviderDayRow {
  day: string;
  dayStart: number;
  jobs: number;
  okJobs: number;
  earnedUsdc: Numeric;
  ratings: number;
  ratingSum: number;
}

export interface ProviderDetailRow extends ProviderRow {
  capabilities: string;
  registrations: number;
  registeredTx: string;
  updatedAt: number;
  uptimeSeconds: number;
  capabilityOffers: Array<{ adapter: string; priceUsdMicros: Numeric }>;
  agent: (AgentScoreRow & { registeredAt: number | null; transfers: number }) | null;
  jobs: JobRow[];
  days: ProviderDayRow[];
}

export interface NetworkStatsRow {
  providers: number;
  agentsTotal: number;
  agentsLinked: number;
  buyers: number;
  jobs: number;
  okJobs: number;
  failedJobs: number;
  paidJobs: number;
  successRate: Numeric;
  volumeUsdc: Numeric;
  earnedUsdc: Numeric;
  ratings: number;
  avgRating: Numeric;
  heartbeats: number;
  feedbacks: number;
  verifiedFeedbacks: number;
  lastBlock: number;
  lastUpdated: number;
}

export interface DailyStatsRow {
  id: string;
  dayStart: number;
  jobs: number;
  okJobs: number;
  failedJobs: number;
  volumeUsdc: Numeric;
  earnedUsdc: Numeric;
  uniqueBuyers: number;
  activeProviders: number;
  newBuyers: number;
  newProviders: number;
  ratings: number;
  avgRating: Numeric;
  heartbeats: number;
  feedbacks: number;
}

export const FEEDBACK_KINDS = ["BUYER_RATING", "XORV_VERIFIED", "OTHER"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface LeaderboardResult {
  Provider: LeaderboardRow[];
}
export interface RecentJobsResult {
  Job: JobRow[];
}
export interface RecentRatingsResult {
  Rating: RatingRow[];
}
export interface NetworkStatsResult {
  NetworkStats_by_pk: NetworkStatsRow | null;
  DailyStats: DailyStatsRow[];
}
export interface ProviderByIdResult {
  Provider_by_pk: ProviderDetailRow | null;
}
export interface AgentFeedbackResult {
  Agent_by_pk: AgentFeedbackRow | null;
}

// ---------------------------------------------------------------------------------------
// Client helpers

export function toBigInt(value: Numeric | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  return typeof value === "number" ? BigInt(Math.trunc(value)) : BigInt(value.split(".")[0] ?? "0");
}

export function toNumber(value: Numeric | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  return typeof value === "number" ? value : Number(value);
}

/** The indexer stores addresses lowercase; filter with this. */
export function indexerAddress(address: string): string {
  return address.toLowerCase();
}

export class IndexerQueryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly errors?: unknown,
  ) {
    super(message);
    this.name = "IndexerQueryError";
  }
}

/**
 * POST a query to XORV_INDEXER_URL and return `data`. Throws IndexerQueryError on HTTP
 * failures, GraphQL errors or timeouts, so callers can fall back to their RPC scan.
 * `fetch` is injectable for tests (no network in the test suites).
 */
export async function queryIndexer<T>(
  url: string,
  query: string,
  variables: Record<string, unknown> = {},
  options: { fetch?: typeof fetch; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<T> {
  const doFetch = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!res.ok) throw new IndexerQueryError(`indexer HTTP ${res.status}`, res.status);
    const body = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (body.errors?.length) {
      throw new IndexerQueryError(
        `indexer GraphQL error: ${body.errors.map((e) => e.message ?? "unknown").join("; ")}`,
        res.status,
        body.errors,
      );
    }
    if (body.data === undefined) throw new IndexerQueryError("indexer returned no data", res.status);
    return body.data;
  } catch (err) {
    if (err instanceof IndexerQueryError) throw err;
    const reason = controller.signal.aborted ? "timed out" : (err as Error).message;
    throw new IndexerQueryError(`indexer request failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}
