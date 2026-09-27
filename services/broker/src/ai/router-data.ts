/**
 * The real data behind the router's tools (router-tools.ts): Monad RPC for
 * ERC-8004, the broker's ledger reader for XorvLedger receipts (indexer
 * first, RPC fallback), the Envio indexer for provider aggregates, and the
 * Nansen trust cache.
 *
 * Every read is cached briefly (30 s by default). A quote with a real choice
 * runs a handful of reads, and a burst of quotes should cost the RPC and the
 * indexer one round of them, not one per buyer. Failures are not cached: the
 * next quote tries again.
 */

import {
  RATING_TAG1,
  networkConfig,
  providerIdHash,
  reputationSummary,
  sameAddress,
  type ReputationSummary,
} from "@xorv/protocol";
import { queryIndexer, toNumber, type IndexerOptions } from "../indexer.js";
import type { LedgerReader } from "../ledger-reader.js";
import type { PublicTrustSignal } from "../trust/index.js";
import { VERIFIED_TAG1 } from "./feedback.js";
import type { CandidateRef, Erc8004Read, IndexerStatsRead, ReceiptsRead, RouterData } from "./router-tools.js";

export const ROUTER_DATA_CACHE_MS = 30_000;
/** How many of the ledger's latest receipts and ratings `recent_receipts` searches. */
export const ROUTER_RECEIPT_SCAN = 200;

type Numeric = string | number | null | undefined;

export interface RouterDataOptions {
  network: string;
  /** XorvLedger — the ERC-8004 client every buyer rating is relayed from. */
  ledgerAddress: string | null;
  /** The verifier EOA whose "xorv-verified" scores count; read on every call (it can be absent). */
  verifierAddress?: () => string | null;
  reader: LedgerReader | null;
  indexer: IndexerOptions | null;
  trust?: { readonly enabled: boolean; publicSignal(address: string): PublicTrustSignal | null };
  /** Identity Registry `getAgentWallet`. */
  agentWallet?: (agentId: string) => Promise<string | null>;
  /** Reputation Registry `getSummary`; defaults to the protocol read over the network's RPC. */
  reputationSummary?: (agentId: string, clients: string[], tag1: string) => Promise<ReputationSummary>;
  cacheMs?: number;
  scanLimit?: number;
  now?: () => number;
}

const PROVIDER_STATS = /* GraphQL */ `
  query RouterProviderStats($id: String!) {
    Provider_by_pk(id: $id) {
      id jobsTotal jobsOk jobsFailed successRate earnedUsdc avgDurationMs ratingsCount avgRating lastJobAt
      agent { feedbackCount buyerRatingCount buyerRatingAvg verifiedCount verifiedScore }
    }
  }
`;

interface ProviderStatsRow {
  id: string;
  jobsTotal: number;
  jobsOk: number;
  jobsFailed: number;
  successRate: Numeric;
  earnedUsdc: Numeric;
  avgDurationMs: number;
  ratingsCount: number;
  avgRating: Numeric;
  lastJobAt: number | null;
  agent: {
    feedbackCount: number;
    buyerRatingCount: number;
    buyerRatingAvg: Numeric;
    verifiedCount: number;
    verifiedScore: Numeric;
  } | null;
}

function units(value: Numeric): string {
  if (value === null || value === undefined || value === "") return "0";
  try {
    return BigInt(typeof value === "number" ? Math.trunc(value) : value.split(".")[0] || "0").toString();
  } catch {
    return "0";
  }
}

export function createRouterData(opts: RouterDataOptions): RouterData {
  const cacheMs = opts.cacheMs ?? ROUTER_DATA_CACHE_MS;
  const scan = opts.scanLimit ?? ROUTER_RECEIPT_SCAN;
  const now = opts.now ?? Date.now;
  const net = networkConfig(opts.network);
  const summary =
    opts.reputationSummary ??
    ((agentId: string, clients: string[], tag1: string) => reputationSummary(opts.network, agentId, clients, { tag1 }));

  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return hit.value as Promise<T>;
    const value = load();
    cache.set(key, { at: now(), value });
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key);
    });
    if (cache.size > 500) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return value;
  }

  const data: RouterData = { network: opts.network };

  data.erc8004 = (agentId, payTo) => {
    const verifier = opts.verifierAddress?.() ?? null;
    return cached(`erc8004:${agentId}:${payTo.toLowerCase()}:${verifier ?? ""}`, async (): Promise<Erc8004Read> => {
      const ledger = opts.ledgerAddress;
      const [buyer, scores, wallet] = await Promise.allSettled([
        ledger ? summary(agentId, [ledger], RATING_TAG1) : Promise.resolve(null),
        verifier ? summary(agentId, [verifier], VERIFIED_TAG1) : Promise.resolve(null),
        opts.agentWallet ? opts.agentWallet(agentId) : Promise.reject(new Error("no agent wallet reader")),
      ]);
      const failed: string[] = [];
      const read = (r: PromiseSettledResult<ReputationSummary | null>, what: string) => {
        if (r.status === "rejected") {
          failed.push(what);
          return null;
        }
        return r.value ? { count: r.value.count, average: r.value.average } : null;
      };
      const buyerRatings = read(buyer, "buyer ratings");
      const verifierScores = read(scores, "verifier scores");
      let agentWallet: string | null = null;
      if (wallet.status === "fulfilled") agentWallet = wallet.value;
      else failed.push("agent wallet");
      // Every read failing is a failed tool, not an empty reputation.
      const attempted = (ledger ? 1 : 0) + (verifier ? 1 : 0) + 1;
      if (failed.length >= attempted) throw new Error(`ERC-8004 reads failed: ${failed.join(", ")}`);
      return {
        agentId,
        identityRegistry: net.erc8004.identity,
        reputationRegistry: net.erc8004.reputation,
        ledger,
        verifier,
        buyerRatings,
        verifierScores,
        agentWallet,
        walletMatchesPayout: agentWallet !== null && sameAddress(agentWallet, payTo),
        failed,
      };
    });
  };

  if (opts.reader) {
    const reader = opts.reader;
    data.receipts = (candidate: CandidateRef) =>
      cached(`receipts:${candidate.providerId}:${candidate.address.toLowerCase()}`, async (): Promise<ReceiptsRead> => {
        const [receiptFeed, ratingFeed] = await Promise.all([
          reader.events("receipts", scan),
          reader.events("ratings", scan).catch(() => null),
        ]);
        const mine = receiptFeed.events.filter((e) => {
          if (e.kind !== "receipts") return false;
          const d = e.data as { payTo: string; agentId: string | null };
          return sameAddress(d.payTo, candidate.address) || (candidate.agentId !== null && d.agentId === candidate.agentId);
        });
        const jobIds = new Set(mine.map((e) => (e.data as { jobId: string }).jobId.toLowerCase()));
        const ratings = (ratingFeed?.events ?? []).filter((e) => {
          const d = e.data as { jobId: string; agentId: string };
          return jobIds.has(d.jobId.toLowerCase()) || (candidate.agentId !== null && d.agentId === candidate.agentId);
        });
        let earned = 0n;
        let ok = 0;
        for (const e of mine) {
          const d = e.data as { ok: boolean; amount: string; paymentTx: string | null };
          if (d.ok) ok += 1;
          if (d.ok && d.paymentTx) {
            try {
              earned += BigInt(d.amount);
            } catch {
              /* a malformed amount counts as nothing */
            }
          }
        }
        const values = ratings.map((e) => (e.data as { value: number }).value).filter((v) => Number.isFinite(v));
        return {
          source: receiptFeed.source,
          ledger: opts.ledgerAddress,
          scanned: receiptFeed.events.length,
          receipts: mine.length,
          ok,
          failed: mine.length - ok,
          earnedUnits: earned.toString(),
          lastAt: mine[0]?.at ?? null,
          ratings: values.length,
          avgRating: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
          latest: mine.slice(0, 3).map((e) => ({ txHash: e.txHash, ok: (e.data as { ok: boolean }).ok, at: e.at })),
          ...(receiptFeed.indexerError ? { indexerDown: true } : {}),
        };
      });
  }

  data.indexerStats = (providerId: string) => {
    const indexer = opts.indexer;
    if (!indexer) return Promise.resolve({ configured: false } as const);
    return cached(`indexer:${providerId}`, async (): Promise<IndexerStatsRead> => {
      const res = await queryIndexer<{ Provider_by_pk: ProviderStatsRow | null }>(indexer, PROVIDER_STATS, {
        id: providerIdHash(providerId).toLowerCase(),
      });
      const row = res.Provider_by_pk;
      if (!row) return { configured: true, found: false };
      return {
        configured: true,
        found: true,
        jobsTotal: row.jobsTotal ?? 0,
        jobsOk: row.jobsOk ?? 0,
        jobsFailed: row.jobsFailed ?? 0,
        successRate: toNumber(row.successRate),
        earnedUnits: units(row.earnedUsdc),
        avgDurationMs: row.avgDurationMs ?? 0,
        ratingsCount: row.ratingsCount ?? 0,
        avgRating: toNumber(row.avgRating),
        lastJobAt: row.lastJobAt ?? null,
        agent: row.agent
          ? {
              feedbackCount: row.agent.feedbackCount ?? 0,
              buyerRatingCount: row.agent.buyerRatingCount ?? 0,
              buyerRatingAvg: toNumber(row.agent.buyerRatingAvg),
              verifiedCount: row.agent.verifiedCount ?? 0,
              verifiedScore: toNumber(row.agent.verifiedScore),
            }
          : null,
      };
    });
  };

  if (opts.trust) {
    const trust = opts.trust;
    data.trust = (address: string) => ({ enabled: trust.enabled, signal: trust.publicSignal(address) });
  }

  return data;
}
