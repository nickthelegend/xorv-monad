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
  providerIdFor,
  type AdapterKind,
  type Capability,
  type Provider,
  type ProviderStats,
  type ProviderStatus,
  type RegisterRequest,
} from "@xorv/protocol";
import { randomBytes, timingSafeEqual } from "node:crypto";
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

export interface MatchOptions {
  adapter?: AdapterKind | null;
  maxPriceUsdMicros: number;
  exclude?: Iterable<string>;
}

/** A registration whose address is already normalized and whose agent id is verified (or null). */
export type VerifiedRegistration = RegisterRequest & { agentId: string | null };

/** A wallet's trust score, 0–100, or null for "no opinion" (see src/trust/). */
export type TrustScorer = (address: string) => number | null;

/**
 * How far a Nansen trust score can move a provider's reliability rank: at
 * most ±0.1 on the 0–1 success scale, at a score of 100 or 0. Enough to
 * order two equally priced, equally proven nodes; never enough to beat a
 * cheaper node, or to outrank a real track record (a node that finished
 * every job still beats an unproven one with a perfect wallet).
 */
export const TRUST_TIEBREAK_WEIGHT = 0.1;

/**
 * The public provider id for a node: stable across broker restarts, and not
 * reversible to the node id. It lives in @xorv/protocol because the CLI
 * computes it too, to build its agent URI without asking the broker.
 */
export { providerIdFor };

/**
 * A registration for a node id that another session holds live.
 *
 * Once a session exists, the node id proves nothing: whoever holds that
 * session's bearer token is the node. Letting the node id alone re-register a
 * live record handed its payout address and its token to anyone who learned
 * the id. Answered 409, with when the other session would go offline if it
 * has really gone away.
 */
export class RegistrationRefused extends Error {
  readonly code = "node_live";
  constructor(readonly retryAfterMs: number) {
    super(
      "this node id already has a live session on the broker; re-registering it needs that session's " +
        "bearer token (Authorization: Bearer <token>). If this is the same node restarting without its " +
        `token, the old session goes offline in about ${Math.ceil(retryAfterMs / 1000)}s and can be claimed then`,
    );
    this.name = "RegistrationRefused";
  }
}

/** What `registerNode` did. */
export interface RegisterOutcome {
  provider: ProviderRecord;
  /**
   * False when the caller proved only the node id, so a fresh token was
   * minted. A socket still attached under this provider id belongs to
   * whoever held the old token, and the caller must close it.
   */
  authenticated: boolean;
}

/**
 * How far back a provider's recent failures count against it, and how many
 * it may have in that window (while also failing more than it completes)
 * before the matcher stops offering it at all. Price ranks first, so without
 * this a provider that fails every job (or never opens its control channel)
 * kept winning quotes at the lowest price and only lost ties.
 */
export const RECENT_OUTCOME_WINDOW_MS = 30 * 60_000;
export const RECENT_FAILURE_LIMIT = 3;
const RECENT_OUTCOMES_KEPT = 50;

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
  private trustScore: TrustScorer | null = null;
  /** Whether a provider can be handed a job right now (its control channel is open); null = anyone live. */
  private eligible: ((id: string) => boolean) | null = null;
  /** Recent job outcomes per provider id, newest last (in memory, bounded). */
  private recentOutcomes = new Map<string, Array<{ at: number; ok: boolean }>>();

  constructor(persistence: Persistence = new MemoryPersistence()) {
    this.persistence = persistence;
    this.restoredStats = persistence.loadStats();
  }

  /** Let the matcher weigh payout-wallet trust (Nansen) when it breaks ties. */
  setTrustScorer(scorer: TrustScorer | null): void {
    this.trustScore = scorer;
  }

  /**
   * Only match providers this says can take a job now. The broker wires it
   * to "holds an open control socket": heartbeats arrive over HTTP, so a node
   * that never connected its WebSocket still looked online, won quotes, got
   * paid, and every job then went to someone else for free.
   */
  setEligibility(predicate: ((id: string) => boolean) | null): void {
    this.eligible = predicate;
  }

  private noteOutcome(id: string, ok: boolean): void {
    const outcomes = this.recentOutcomes.get(id) ?? [];
    outcomes.push({ at: Date.now(), ok });
    if (outcomes.length > RECENT_OUTCOMES_KEPT) outcomes.splice(0, outcomes.length - RECENT_OUTCOMES_KEPT);
    this.recentOutcomes.set(id, outcomes);
  }

  /**
   * True while a provider has failed at least RECENT_FAILURE_LIMIT jobs in
   * the last RECENT_OUTCOME_WINDOW_MS and more than it completed. It is left
   * out of matching until those failures age out of the window.
   */
  isFailingRecently(id: string, now = Date.now()): boolean {
    const outcomes = this.recentOutcomes.get(id);
    if (!outcomes) return false;
    let failed = 0;
    let ok = 0;
    for (const outcome of outcomes) {
      if (now - outcome.at > RECENT_OUTCOME_WINDOW_MS) continue;
      if (outcome.ok) ok += 1;
      else failed += 1;
    }
    return failed >= RECENT_FAILURE_LIMIT && failed > ok;
  }

  /**
   * The rank ties are broken on: reliability, nudged by wallet trust. A
   * provider the scorer knows nothing about is neutral, not penalised.
   */
  private rankScore(provider: ProviderRecord): number {
    const reliability = successScore(provider);
    const trust = this.trustScore?.(provider.address);
    if (trust === null || trust === undefined || !Number.isFinite(trust)) return reliability;
    const clamped = Math.max(0, Math.min(100, trust));
    return reliability + (TRUST_TIEBREAK_WEIGHT * (clamped - 50)) / 50;
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
   *
   * Who may re-register a node id that is already here:
   *
   *  - **Its current token holder**, always. The session keeps its token, so
   *    the node's open socket stays valid.
   *  - **Anyone with the node id, only while the record is not live** (it
   *    went offline, was reaped, or the broker restarted and lost every
   *    token). That is how a node rejoins after a broker restart. A new token
   *    is minted every time, so a caller who proved only the node id never
   *    receives a token someone else is using; the caller closes the old
   *    socket (see `RegisterOutcome.authenticated`).
   *  - A live record with anything else throws `RegistrationRefused`.
   */
  register(req: VerifiedRegistration, auth: { token?: string | null } = {}): ProviderRecord {
    return this.registerNode(req, auth).provider;
  }

  registerNode(req: VerifiedRegistration, auth: { token?: string | null } = {}): RegisterOutcome {
    const existingId = this.byNodeId.get(req.nodeId);
    const existing = existingId ? this.providers.get(existingId) : undefined;
    const now = Date.now();
    const restored = this.restoredStats.get(req.nodeId);

    const authenticated = Boolean(existing && auth.token && sameToken(auth.token, existing.token));
    if (existing && !authenticated) {
      const silentFor = now - existing.lastHeartbeatAt;
      if (silentFor <= HEARTBEAT_OFFLINE_MS) {
        throw new RegistrationRefused(Math.max(1_000, HEARTBEAT_OFFLINE_MS - silentFor + 1_000));
      }
    }

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
      // Never hand an existing token to a caller that did not present it.
      token: authenticated && existing ? existing.token : randomBytes(24).toString("base64url"),
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
    return { provider: record, authenticated };
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
   * break toward the node with the better track record — nudged by its payout
   * wallet's Nansen trust score when one is known (`TRUST_TIEBREAK_WEIGHT`) —
   * then the emptier one, so a reliable provider is rewarded and load still
   * spreads.
   *
   * `exclude` is for reassignment: a job never goes back to a provider that
   * already had it.
   */
  match(opts: MatchOptions): Match | null {
    return this.candidates(opts)[0] ?? null;
  }

  /**
   * Every capability that could take this job right now, in the order
   * `match` would pick them — what the AI router chooses between when the
   * buyer left the adapter open.
   */
  candidates(opts: MatchOptions): Match[] {
    const excluded = new Set(opts.exclude ?? []);
    const candidates: Match[] = [];

    for (const provider of this.live()) {
      if (excluded.has(provider.id)) continue;
      if (this.eligible && !this.eligible(provider.id)) continue;
      if (this.isFailingRecently(provider.id)) continue;
      for (const capability of provider.capabilities) {
        if (opts.adapter && capability.adapter !== opts.adapter) continue;
        // Never quote a price that is not a whole, positive number of
        // micro-USD (registration refuses one): it would ask for 0 USDC.
        if (!Number.isInteger(capability.priceUsdMicros) || capability.priceUsdMicros < 1) continue;
        if (capability.priceUsdMicros > opts.maxPriceUsdMicros) continue;
        // A node that reported this adapter as unavailable on its last beat is
        // busy or broken; skip it rather than queue behind it.
        if (provider.available[capability.id] === false) continue;
        if (provider.activeJobs >= totalConcurrency(provider.capabilities)) continue;
        candidates.push({ provider, capability });
      }
    }

    candidates.sort((a, b) => {
      if (a.capability.priceUsdMicros !== b.capability.priceUsdMicros) {
        return a.capability.priceUsdMicros - b.capability.priceUsdMicros;
      }
      const aScore = this.rankScore(a.provider);
      const bScore = this.rankScore(b.provider);
      if (aScore !== bScore) return bScore - aScore;
      return a.provider.activeJobs - b.provider.activeJobs;
    });

    return candidates;
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
    this.noteOutcome(id, outcome.ok);
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
   * Count a failure against a provider that never started the job — a paid
   * dispatch its control channel could not take. Unlike `jobFinished` this
   * leaves `activeJobs` alone: `jobStarted` was never called for it.
   */
  recordFailure(id: string): void {
    const provider = this.providers.get(id);
    if (!provider) return;
    provider.stats.jobsFailed += 1;
    this.noteOutcome(id, false);
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

/** Constant-time token comparison: the token is a bearer credential. */
function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
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
