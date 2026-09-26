/**
 * The live provider registry and the matcher that picks who runs a job.
 *
 * State is in memory on purpose. A provider's membership is *liveness*, not a
 * record: it is only real while heartbeats keep arriving, so there is nothing
 * here worth surviving a restart. The durable half of the story — who
 * registered, who was alive, what each job paid — goes on-chain to XorvLedger
 * on Monad, where it is public and append-only rather than trapped in our
 * database.
 */

import {
  HEARTBEAT_OFFLINE_MS,
  PROVIDER_REAP_MS,
  type AdapterKind,
  type Capability,
  type Provider,
  type ProviderStats,
  type ProviderStatus,
  type RegisterRequest,
} from "@xorv/protocol";
import { createHash, randomBytes } from "node:crypto";
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

/** A registration whose address is already normalized and whose agent id is verified (or null). */
export type VerifiedRegistration = RegisterRequest & { agentId: string | null };

/**
 * The public provider id for a node: stable across broker restarts, and not
 * reversible to the node id.
 *
 * Stable matters more on-chain than it ever did in memory: the id is hashed
 * into XorvLedger events (`providerIdHash`) and baked into the provider's
 * ERC-8004 registration URI (`/agents/<id>.json`). A random id per broker
 * process would split one node into a new on-chain provider after every
 * deploy and break its agent URI. Not reversible matters because the node id
 * doubles as the node's re-registration credential.
 */
export function providerIdFor(nodeId: string): string {
  const digest = createHash("sha256").update(`xorv:provider:${nodeId}`, "utf8").digest();
  return `prv_${digest.subarray(0, 9).toString("base64url")}`;
}

function emptyStats(): ProviderStats {
  return { jobsCompleted: 0, jobsFailed: 0, earnedUsdcMicros: 0, avgDurationMs: 0 };
}

export class Registry {
  private providers = new Map<string, ProviderRecord>();
  private byToken = new Map<string, string>();
  private byNodeId = new Map<string, string>();
  /**
   * Providers the reaper dropped, kept (bounded) so their public pages — above
   * all the ERC-8004 registration file their agent URI points at — keep
   * resolving while they are away, marked inactive rather than 404ing.
   */
  private departed = new Map<string, ProviderRecord>();
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
      this.persistence.saveStats(provider.nodeId, provider.label, provider.address, provider.stats);
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
   *
   * The caller has already validated and normalized `address` and verified
   * `agentId` against the Identity Registry — see `validateRegistration` and
   * `verifyAgent` in app.ts.
   */
  register(req: VerifiedRegistration): ProviderRecord {
    const existingId = this.byNodeId.get(req.nodeId);
    const existing = existingId ? this.providers.get(existingId) : undefined;
    const now = Date.now();
    const restored = this.restoredStats.get(req.nodeId);

    const record: ProviderRecord = {
      id: existing?.id ?? providerIdFor(req.nodeId),
      nodeId: req.nodeId,
      label: req.label,
      address: req.address,
      agentId: req.agentId,
      endpoint: req.endpoint,
      capabilities: req.capabilities,
      status: "online",
      activeJobs: existing?.activeJobs ?? 0,
      lastHeartbeatAt: now,
      registeredAt: existing?.registeredAt ?? now,
      version: req.version,
      region: req.region ?? null,
      // Earnings and job counts belong to the operator, not to a process
      // lifetime — a restart must not zero them.
      stats: existing?.stats ?? (restored ? stripKeys(restored) : emptyStats()),
      token: existing?.token ?? randomBytes(24).toString("base64url"),
      available: Object.fromEntries(req.capabilities.map((c) => [c.id, true])),
      uptimeSeconds: 0,
      // A re-registration that changes the payout address or agent is a new
      // on-chain fact; the old registration tx no longer describes it.
      registryTxHash:
        existing && existing.address === req.address && existing.agentId === req.agentId
          ? (existing.registryTxHash ?? null)
          : null,
    };

    if (existing) this.byToken.delete(existing.token);
    this.departed.delete(record.id);
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

  /** A live provider, or one the reaper dropped recently (status "offline"). */
  find(id: string): ProviderRecord | undefined {
    const live = this.get(id);
    if (live) return live;
    const gone = this.departed.get(id);
    if (gone) gone.status = "offline";
    return gone;
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
   *
   * `exclude` is for reassignment: a job never goes back to a provider that
   * already had it.
   */
  match(opts: {
    adapter?: AdapterKind | null;
    maxPriceUsdMicros: number;
    exclude?: Iterable<string>;
  }): Match | null {
    const excluded = new Set(opts.exclude ?? []);
    const candidates: Match[] = [];

    for (const provider of this.live()) {
      if (excluded.has(provider.id)) continue;
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
  jobFinished(id: string, outcome: { ok: boolean; durationMs: number; usdcMicros?: number }): void {
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
    } else {
      provider.stats.jobsFailed += 1;
    }
    this.persistStats(provider);
  }

  /**
   * Free a provider's slot without judging it — for a job the *buyer*
   * cancelled, which says nothing about the provider's reliability.
   */
  jobReleased(id: string): void {
    const provider = this.providers.get(id);
    if (provider) provider.activeJobs = Math.max(0, provider.activeJobs - 1);
  }

  /**
   * Credit money to the provider that actually received it.
   *
   * Used when a paid job was reassigned: the USDC went to the quoted provider's
   * address at settlement, so that is whose earnings it is — not the provider
   * that happened to finish the job.
   */
  creditEarnings(id: string, usdcMicros: number): void {
    const provider = this.providers.get(id);
    if (!provider || usdcMicros <= 0) return;
    provider.stats.earnedUsdcMicros += usdcMicros;
    this.persistStats(provider);
  }

  /** Record the XorvLedger registration tx once it lands. */
  setRegistryTx(id: string, txHash: string): void {
    const provider = this.providers.get(id);
    if (provider) provider.registryTxHash = txHash;
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
        this.departed.set(id, provider);
        if (this.departed.size > 1_000) {
          const oldest = this.departed.keys().next().value;
          if (oldest !== undefined) this.departed.delete(oldest);
        }
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
function stripKeys(row: PersistedProviderStats): ProviderStats {
  return {
    jobsCompleted: row.jobsCompleted,
    jobsFailed: row.jobsFailed,
    earnedUsdcMicros: row.earnedUsdcMicros,
    avgDurationMs: row.avgDurationMs,
  };
}
