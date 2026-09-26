/**
 * The live provider registry and the matcher that picks who runs a job.
 *
 * State is in memory on purpose. A provider's membership is *liveness*, not a
 * record: it is only real while heartbeats keep arriving, so there is nothing
 * here worth surviving a restart. The durable half of the story — who
 * registered, who was alive, what each job paid — goes to Hedera Consensus
 * Service, where it is public and append-only rather than trapped in our
 * database.
 */

import {
  HEARTBEAT_OFFLINE_MS,
  PROVIDER_REAP_MS,
  type AdapterKind,
  type Capability,
  type Provider,
  type ProviderStatus,
  type RegisterRequest,
  newId,
} from "@xorv/protocol";
import { randomBytes } from "node:crypto";
import { MemoryPersistence, type PersistedProviderStats, type Persistence } from "./store.js";

export interface ProviderRecord extends Provider {
  /** Bearer token this node authenticates with. Never leaves the broker. */
  token: string;
  /** Node-generated id, so a restarted node reclaims its slot instead of forking. */
  nodeId: string;
  /** Per-capability availability from the last heartbeat. */
  available: Record<string, boolean>;
  uptimeSeconds: number;
}

/** What the matcher settled on. */
export interface Match {
  provider: ProviderRecord;
  capability: Capability;
}

export class Registry {
  private providers = new Map<string, ProviderRecord>();
  private byToken = new Map<string, string>();
  private byNodeId = new Map<string, string>();
  private readonly persistence: Persistence;
  /**
   * Lifetime stats from disk, keyed by the node's stable id.
   *
   * Membership doesn't survive a restart — a provider is only real while it's
   * heartbeating — but *earnings* must. An operator watching a number go up
   * should not see it reset because we deployed.
   */
  private restoredStats: Map<string, PersistedProviderStats>;

  constructor(persistence: Persistence = new MemoryPersistence()) {
    this.persistence = persistence;
    this.restoredStats = persistence.loadStats();
  }

  /** How many providers' lifetime stats came back from disk. */
  get restoredStatsCount(): number {
    return this.restoredStats.size;
  }

  private persistStats(provider: ProviderRecord): void {
    try {
      this.persistence.saveStats(
        provider.nodeId,
        provider.label,
        provider.accountId,
        provider.stats,
      );
    } catch (err) {
      console.error("[broker] failed to persist stats:", err instanceof Error ? err.message : err);
    }
  }

  /**
   * Register, or re-register, a node.
   *
   * Keyed on `nodeId` rather than on a fresh id each time: a provider that
   * restarts is the same provider, and minting a new id would leave a ghost in
   * the fleet view until the reaper caught it, and would reset the earnings
   * counters the operator is watching.
   */
  register(req: RegisterRequest): ProviderRecord {
    const existingId = this.byNodeId.get(req.nodeId);
    const existing = existingId ? this.providers.get(existingId) : undefined;
    const now = Date.now();

    const record: ProviderRecord = {
      id: existing?.id ?? newId("prv"),
      nodeId: req.nodeId,
      label: req.label,
      accountId: req.accountId,
      endpoint: req.endpoint,
      capabilities: req.capabilities,
      status: "online",
      activeJobs: 0,
      lastHeartbeatAt: now,
      registeredAt: existing?.registeredAt ?? now,
      version: req.version,
      region: req.region ?? null,
      // Earnings and job counts belong to the operator, not to a process
      // lifetime — a restart must not zero them.
      stats:
        existing?.stats ??
        stripKeys(this.restoredStats.get(req.nodeId)) ?? {
          jobsCompleted: 0,
          jobsFailed: 0,
          earnedUsdcMicros: 0,
          earnedTinybars: 0,
          avgDurationMs: 0,
        },
      token: existing?.token ?? randomBytes(24).toString("base64url"),
      available: Object.fromEntries(req.capabilities.map((c) => [c.id, true])),
      uptimeSeconds: 0,
      registryConsensusAt: existing?.registryConsensusAt ?? null,
    };

    if (existing) this.byToken.delete(existing.token);
    this.providers.set(record.id, record);
    this.byToken.set(record.token, record.id);
    this.byNodeId.set(record.nodeId, record.id);
    return record;
  }

  /**
   * Look up a provider, with its status recomputed.
   *
   * Status is a function of the clock, not a stored fact — it is only ever
   * correct at the moment you ask. Returning the record without re-deriving it
   * handed callers a stale value, and one of those callers is the guard that
   * decides whether a quoted provider is still alive enough to be paid. A node
   * that had gone silent could still be sold.
   */
  get(id: string): ProviderRecord | undefined {
    const provider = this.providers.get(id);
    if (!provider) return undefined;
    provider.status = deriveStatus(provider);
    return provider;
  }

  byAuthToken(token: string): ProviderRecord | undefined {
    const id = this.byToken.get(token);
    return id ? this.get(id) : undefined;
  }

  heartbeat(
    id: string,
    input: { activeJobs: number; uptimeSeconds: number; available: Record<string, boolean> },
  ): ProviderRecord | undefined {
    const provider = this.providers.get(id);
    if (!provider) return undefined;
    provider.lastHeartbeatAt = Date.now();
    provider.activeJobs = input.activeJobs;
    provider.uptimeSeconds = input.uptimeSeconds;
    provider.available = input.available;
    provider.status = deriveStatus(provider);
    return provider;
  }

  /** Every provider, freshest heartbeat first, with status recomputed. */
  list(): ProviderRecord[] {
    const all = [...this.providers.values()];
    for (const p of all) p.status = deriveStatus(p);
    return all.sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt);
  }

  /** Providers currently eligible to take work. */
  live(): ProviderRecord[] {
    return this.list().filter((p) => p.status !== "offline");
  }

  /**
   * Choose a provider for a job.
   *
   * Cheapest-first, because the poster set a ceiling and any provider under it
   * is acceptable — competing on price is the point of a capacity market. Ties
   * break toward the node with the better track record, then the emptier one,
   * so a reliable provider is rewarded and load still spreads.
   */
  match(opts: {
    adapter?: AdapterKind | null;
    maxPriceUsdMicros: number;
  }): Match | null {
    const candidates: Match[] = [];

    for (const provider of this.live()) {
      for (const capability of provider.capabilities) {
        if (opts.adapter && capability.adapter !== opts.adapter) continue;
        if (capability.priceUsdMicros > opts.maxPriceUsdMicros) continue;
        // A node that reported this adapter as unavailable on its last beat is
        // busy or broken; skip it rather than queue behind it.
        if (provider.available[capability.id] === false) continue;
        if (provider.activeJobs >= totalConcurrency(provider.capabilities)) continue;
        candidates.push({ provider, capability });
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      if (a.capability.priceUsdMicros !== b.capability.priceUsdMicros) {
        return a.capability.priceUsdMicros - b.capability.priceUsdMicros;
      }
      const aScore = successScore(a.provider);
      const bScore = successScore(b.provider);
      if (aScore !== bScore) return bScore - aScore;
      return a.provider.activeJobs - b.provider.activeJobs;
    });

    return candidates[0] ?? null;
  }

  /** Note that a job started on a provider. */
  jobStarted(id: string): void {
    const provider = this.providers.get(id);
    if (provider) provider.activeJobs += 1;
  }

  /** Note that a job finished, folding the outcome into the provider's stats. */
  jobFinished(
    id: string,
    outcome: { ok: boolean; durationMs: number; usdcMicros?: number; tinybars?: number },
  ): void {
    const provider = this.providers.get(id);
    if (!provider) return;
    provider.activeJobs = Math.max(0, provider.activeJobs - 1);
    if (outcome.ok) {
      const n = provider.stats.jobsCompleted;
      provider.stats.jobsCompleted = n + 1;
      // Running mean, so the number stays honest without keeping every sample.
      provider.stats.avgDurationMs = Math.round(
        (provider.stats.avgDurationMs * n + outcome.durationMs) / (n + 1),
      );
      provider.stats.earnedUsdcMicros += outcome.usdcMicros ?? 0;
      provider.stats.earnedTinybars += outcome.tinybars ?? 0;
    } else {
      provider.stats.jobsFailed += 1;
    }
    this.persistStats(provider);
  }

  /** Drop providers that have been silent long enough to be gone for good. */
  reap(): string[] {
    const cutoff = Date.now() - PROVIDER_REAP_MS;
    const removed: string[] = [];
    for (const [id, provider] of this.providers) {
      if (provider.lastHeartbeatAt < cutoff) {
        this.providers.delete(id);
        this.byToken.delete(provider.token);
        this.byNodeId.delete(provider.nodeId);
        removed.push(id);
      }
    }
    return removed;
  }
}

function totalConcurrency(capabilities: Capability[]): number {
  return capabilities.reduce((sum, c) => sum + Math.max(1, c.maxConcurrency), 0);
}

function deriveStatus(provider: ProviderRecord): ProviderStatus {
  if (Date.now() - provider.lastHeartbeatAt > HEARTBEAT_OFFLINE_MS) return "offline";
  if (provider.activeJobs >= totalConcurrency(provider.capabilities)) return "busy";
  return "online";
}

/**
 * Reliability, as a number the sort can use.
 *
 * A brand-new provider scores 0.5 rather than 0 or 1: unproven, but not
 * punished into never getting a first job, and not trusted over a node with a
 * real record either.
 */
function successScore(provider: ProviderRecord): number {
  const { jobsCompleted, jobsFailed } = provider.stats;
  const total = jobsCompleted + jobsFailed;
  if (total === 0) return 0.5;
  return jobsCompleted / total;
}


/** Drop the identity columns, leaving just the ProviderStats shape. */
function stripKeys(row: PersistedProviderStats | undefined) {
  if (!row) return undefined;
  const { nodeId: _n, label: _l, accountId: _a, ...stats } = row;
  return stats;
}
