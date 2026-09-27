/**
 * Provider reputation for the deterministic matcher — Envio first, memory
 * second.
 *
 * When no router runs (a single candidate, the router off, a buyer who named
 * the adapter, a router that fell back), the registry's matcher picks:
 * cheapest first, then its rank. This book gives that rank a reputation term:
 * the provider's buyer ratings and Kimi verifier scores, read from the Envio
 * indexer (Provider.avgRating / ratingsCount, Agent.verifiedScore /
 * verifiedCount — the whole on-chain history, across broker restarts) when
 * XORV_INDEXER_URL is set, and from the broker's own job records otherwise or
 * while the indexer is down.
 *
 * The matcher sorts synchronously, so `score` never waits: it answers from
 * the last snapshot and, when that is stale, refreshes it in the background
 * (one batched GraphQL query for every provider it has been asked about).
 * The first quote after boot therefore ranks on memory, and every quote after
 * the refresh lands ranks on the indexer. Cheap by construction: one indexer
 * query a minute at most, and the job scan behind the memory figures is
 * cached too.
 */

import { providerIdHash } from "@xorv/protocol";
import { queryIndexer, toNumber, type IndexerOptions } from "../indexer.js";

/** How long an indexer snapshot is used before a background refresh. */
export const REPUTATION_INDEXER_TTL_MS = 60_000;
/** How long the in-memory figures (a scan of recent jobs) are reused. */
export const REPUTATION_MEMORY_TTL_MS = 15_000;
/**
 * The prior a provider's average is shrunk toward: a neutral 50 worth three
 * ratings. One perfect rating is 62, not 100; twenty of them are 93.
 */
export const REPUTATION_PRIOR = { value: 50, weight: 3 } as const;

export interface ReputationEntry {
  /** Mean buyer rating, 0–100; null when unrated. */
  avgRating: number | null;
  ratings: number;
  /** Mean Kimi verification score, 0–100; null when never verified. */
  avgVerified: number | null;
  verified: number;
  source: "indexer" | "memory";
}

/** A job as far as reputation cares. */
export interface ReputationJob {
  providerId?: string | null;
  rating?: { value: number } | null;
  verification?: { score: number } | null;
}

/**
 * One 0–100 score from ratings and verifier scores together, shrunk toward
 * the neutral prior so a single rating can't dominate. Null with no evidence
 * — which the matcher reads as "no opinion", not as 50.
 */
export function reputationScore(entry: ReputationEntry | null | undefined): number | null {
  if (!entry) return null;
  const n = entry.ratings + entry.verified;
  if (n === 0) return null;
  const sum = (entry.avgRating ?? 0) * entry.ratings + (entry.avgVerified ?? 0) * entry.verified;
  return (sum + REPUTATION_PRIOR.value * REPUTATION_PRIOR.weight) / (n + REPUTATION_PRIOR.weight);
}

const PROVIDERS_REPUTATION = /* GraphQL */ `
  query ProvidersReputation($ids: [String!]!) {
    Provider(where: { id: { _in: $ids } }) {
      id ratingsCount avgRating
      agent { verifiedCount verifiedScore }
    }
  }
`;

interface ReputationRow {
  id: string;
  ratingsCount: number;
  avgRating: string | number | null;
  agent: { verifiedCount: number; verifiedScore: string | number | null } | null;
}

export interface ReputationBookOptions {
  indexer: IndexerOptions | null;
  /** The broker's own job records, for the memory figures. */
  jobs: () => Iterable<ReputationJob>;
  indexerTtlMs?: number;
  memoryTtlMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

const MAX_TRACKED = 500;

export class ReputationBook {
  private readonly indexer: IndexerOptions | null;
  private readonly jobs: () => Iterable<ReputationJob>;
  private readonly indexerTtlMs: number;
  private readonly memoryTtlMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private indexed = new Map<string, ReputationEntry>();
  private indexedAt = 0;
  private refreshing: Promise<void> | null = null;
  private readonly tracked = new Set<string>();
  private memory: { at: number; entries: Map<string, ReputationEntry> } | null = null;
  private lastError: string | null = null;

  constructor(opts: ReputationBookOptions) {
    this.indexer = opts.indexer;
    this.jobs = opts.jobs;
    this.indexerTtlMs = opts.indexerTtlMs ?? REPUTATION_INDEXER_TTL_MS;
    this.memoryTtlMs = opts.memoryTtlMs ?? REPUTATION_MEMORY_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** The provider's reputation now: indexed when the indexer knows it, else from memory. Never waits. */
  entry(providerId: string): ReputationEntry | null {
    this.track(providerId);
    if (this.indexer && !this.refreshing && this.now() - this.indexedAt >= this.indexerTtlMs) {
      void this.refresh();
    }
    return this.indexed.get(providerId) ?? this.memoryEntries().get(providerId) ?? null;
  }

  /** The matcher's reputation term input (0–100), or null for no evidence. */
  score(providerId: string): number | null {
    return reputationScore(this.entry(providerId));
  }

  /** Where the figures come from right now, for diagnostics. */
  status(): { source: "indexer" | "memory"; indexedProviders: number; lastError: string | null } {
    return {
      source: this.indexer && this.indexed.size > 0 ? "indexer" : "memory",
      indexedProviders: this.indexed.size,
      lastError: this.lastError,
    };
  }

  /**
   * Re-read every tracked provider from the indexer. Concurrent calls share
   * one query; a failure keeps the previous snapshot (and backs off a TTL).
   */
  refresh(ids: Iterable<string> = this.tracked): Promise<void> {
    if (!this.indexer) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    const indexer = this.indexer;
    const byHash = new Map<string, string>();
    for (const id of ids) byHash.set(providerIdHash(id).toLowerCase(), id);
    this.indexedAt = this.now();
    if (byHash.size === 0) return Promise.resolve();
    this.refreshing = (async () => {
      try {
        const data = await queryIndexer<{ Provider: ReputationRow[] }>(indexer, PROVIDERS_REPUTATION, { ids: [...byHash.keys()] });
        const next = new Map<string, ReputationEntry>();
        for (const row of data.Provider ?? []) {
          const id = byHash.get(String(row.id).toLowerCase());
          if (!id) continue;
          const ratings = Math.max(0, Number(row.ratingsCount) || 0);
          const verified = Math.max(0, Number(row.agent?.verifiedCount) || 0);
          next.set(id, {
            avgRating: ratings > 0 ? toNumber(row.avgRating) : null,
            ratings,
            avgVerified: verified > 0 ? toNumber(row.agent?.verifiedScore) : null,
            verified,
            source: "indexer",
          });
        }
        // Providers not asked about this round keep their last indexed entry.
        const asked = new Set(byHash.values());
        for (const [id, entry] of this.indexed) {
          if (!asked.has(id)) next.set(id, entry);
        }
        this.indexed = next;
        this.lastError = null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message !== this.lastError) this.log(`[broker] reputation refresh from the indexer failed: ${message}`);
        this.lastError = message;
      } finally {
        this.indexedAt = this.now();
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private track(providerId: string): void {
    if (this.tracked.has(providerId)) return;
    if (this.tracked.size >= MAX_TRACKED) {
      const oldest = this.tracked.values().next().value;
      if (oldest !== undefined) this.tracked.delete(oldest);
    }
    this.tracked.add(providerId);
  }

  private memoryEntries(): Map<string, ReputationEntry> {
    if (this.memory && this.now() - this.memory.at < this.memoryTtlMs) return this.memory.entries;
    const sums = new Map<string, { r: number; rn: number; v: number; vn: number }>();
    for (const job of this.jobs()) {
      if (!job.providerId) continue;
      const s = sums.get(job.providerId) ?? { r: 0, rn: 0, v: 0, vn: 0 };
      if (job.rating && Number.isFinite(job.rating.value)) {
        s.r += job.rating.value;
        s.rn += 1;
      }
      if (job.verification && Number.isFinite(job.verification.score)) {
        s.v += job.verification.score;
        s.vn += 1;
      }
      sums.set(job.providerId, s);
    }
    const entries = new Map<string, ReputationEntry>();
    for (const [id, s] of sums) {
      if (s.rn === 0 && s.vn === 0) continue;
      entries.set(id, {
        avgRating: s.rn ? s.r / s.rn : null,
        ratings: s.rn,
        avgVerified: s.vn ? s.v / s.vn : null,
        verified: s.vn,
        source: "memory",
      });
    }
    this.memory = { at: this.now(), entries };
    return entries;
  }
}
