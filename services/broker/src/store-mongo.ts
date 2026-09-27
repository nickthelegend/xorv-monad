/**
 * MongoDB persistence, layered over the local SQLite store.
 *
 * ## Why layered rather than either/or
 *
 * The `Persistence` interface is synchronous, and deliberately so: it is called
 * from the middle of a request that has already taken someone's money, and a
 * write that can block or reject there is a write that can lose a paid job.
 * Mongo is a network round-trip, so it cannot sit on that path directly.
 *
 * So both run:
 *
 *  - **On write**, SQLite takes it synchronously and Mongo takes it in the
 *    background. A Mongo outage, a DNS hiccup, an expired cert — none of them
 *    can fail a settled job, and every write that missed Mongo is still on disk.
 *  - **On boot**, the two are merged record by record, never one wholesale
 *    over the other. SQLite is written first on every change, so it is
 *    normally the newer copy; Mongo is what survives losing the machine. For
 *    each job, provider and vault the more advanced copy wins (a job's `rev`,
 *    a provider's job count, a vault's version). What only Mongo had is
 *    written back to disk, and what Mongo is missing or has older is queued
 *    for upload, so the replay is rebuilt from SQLite on every boot rather
 *    than living only in memory.
 *  - **On reconnect**, the queue drains. A broker that booted while Mongo was
 *    unreachable keeps trying to connect, and when it does it queues whatever
 *    Mongo is missing. Uploads are conditional: an older copy never
 *    overwrites a newer one, whatever order two writes land in.
 *  - **On shutdown**, pending writes get a bounded chance to land before the
 *    client closes (`drain`).
 *
 * The failure this design refuses is the interesting one: a broker that is up,
 * taking payments, and silently not recording them because a database is
 * unreachable — or one that comes back from a restart with an older history
 * than the one it had.
 */

import type { Job, ProviderStats } from "@xorv/protocol";
import type { VaultMeta, VaultRecord } from "./vaults.js";
import {
  MemoryPersistence,
  upgradeJob,
  upgradeStats,
  type PersistedProviderStats,
  type Persistence,
} from "./store.js";

/** Used when no database name is configured; distinct from the Hedera-era "xorv". */
const DEFAULT_DB = "xorv_monad";
const JOB_WINDOW = 500;
const STATS_WINDOW = 1_000;
const VAULT_WINDOW = 10_000;
/** How many ids go into one `$in` read. */
const ID_CHUNK = 200;

interface MongoCollectionLike {
  find(
    filter: object,
    options?: { projection?: object },
  ): {
    sort(spec: object): { limit(n: number): { toArray(): Promise<unknown[]> } };
  };
  updateOne(filter: object, update: object, options?: object): Promise<unknown>;
  createIndex(spec: object, options?: object): Promise<unknown>;
}

export interface MongoLike {
  db(name?: string): { collection(name: string): MongoCollectionLike };
  connect(): Promise<unknown>;
  close(): Promise<void>;
}

export type MongoDriver = { MongoClient: new (uri: string, opts?: object) => MongoLike };

export interface LayeredOptions {
  /** The durable local store. Always written, always synchronous. */
  local: Persistence;
  uri: string;
  dbName?: string;
  /** Called with anything worth an operator's attention. */
  onStatus?: (message: string) => void;
  /** The driver to use; tests pass a fake. Defaults to the `mongodb` package. */
  driver?: MongoDriver | null;
}

/**
 * Load the driver without making it a hard dependency of the broker.
 *
 * Someone running Xorv with SQLite only should not have to install a MongoDB
 * driver, and a missing module must degrade rather than refuse to boot.
 */
async function loadDriver(): Promise<MongoDriver | null> {
  try {
    return (await import("mongodb")) as unknown as MongoDriver;
  } catch {
    return null;
  }
}

/** A job's save counter (see `StoredJob.rev`); -1 for a row written before there was one. */
function revOf(job: Job): number {
  const rev = (job as { rev?: unknown }).rev;
  return typeof rev === "number" && Number.isFinite(rev) ? rev : -1;
}

/** The copy of a job to keep: the higher `rev`, and the local one on a tie. */
export function newerJob(local: Job, remote: Job): Job {
  return revOf(remote) > revOf(local) ? remote : local;
}

/** The copy of a provider's stats to keep: more jobs seen, then more earned, then the local one. */
export function newerStats(local: PersistedProviderStats, remote: PersistedProviderStats): PersistedProviderStats {
  const seen = (s: ProviderStats) => s.jobsCompleted + s.jobsFailed;
  if (seen(remote) !== seen(local)) return seen(remote) > seen(local) ? remote : local;
  return remote.earnedUsdcMicros > local.earnedUsdcMicros ? remote : local;
}

/** A Mongo duplicate-key error: a conditional upsert found a newer (or equal) copy already there. */
function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 11000;
}

function sameStats(a: ProviderStats, b: ProviderStats): boolean {
  return (
    a.jobsCompleted === b.jobsCompleted &&
    a.jobsFailed === b.jobsFailed &&
    a.earnedUsdcMicros === b.earnedUsdcMicros &&
    a.avgDurationMs === b.avgDurationMs
  );
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class LayeredPersistence implements Persistence {
  readonly kind: "sqlite" | "memory";
  readonly location: string;

  private readonly local: Persistence;
  private client: MongoLike | null = null;
  private connected = false;
  private readonly onStatus: (message: string) => void;
  private driver: MongoDriver | null | undefined;
  private connecting: Promise<boolean> | null = null;

  /** Writes Mongo hasn't acknowledged yet, replayed when it comes back. */
  private pendingJobs = new Map<string, Job>();
  private pendingStats = new Map<string, PersistedProviderStats>();
  /**
   * Vaults to upload: the record itself when the local store can't serve it
   * back, otherwise just the version (the body is read from disk to send).
   */
  private pendingVaults = new Map<string, VaultRecord | number>();
  /** Background writes in flight, so shutdown can wait for them. */
  private inflight = new Set<Promise<void>>();

  /** The boot merge, when Mongo answered at boot. */
  private restoredJobs: Job[] | null = null;
  private restoredStats: Map<string, PersistedProviderStats> | null = null;
  /** Whole vault records, only when the local store can't hold vaults (memory mode). */
  private restoredVaults: VaultRecord[] | null = null;

  constructor(private readonly options: LayeredOptions) {
    this.local = options.local;
    this.kind = options.local.kind;
    this.location = `${options.local.location} + mongodb`;
    this.onStatus = options.onStatus ?? (() => {});
    this.driver = options.driver;
  }

  /**
   * Connect and merge state.
   *
   * Awaited once, before the HTTP server listens, so the first request already
   * sees restored history. A failure here is not final: `retryPending` keeps
   * trying to connect, and queues what Mongo missed once it does.
   */
  async connect(): Promise<{ ok: boolean; jobs: number; providers: number; error?: string }> {
    try {
      await this.open();
      const merged = await this.sync({ restore: true });
      return { ok: true, jobs: merged.jobs, providers: merged.providers };
    } catch (err) {
      // Start over from `retryPending`, which re-runs the comparison once it connects.
      if (this.client) await this.client.close().catch(() => {});
      this.client = null;
      this.connected = false;
      return { ok: false, jobs: 0, providers: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async open(): Promise<void> {
    if (this.driver === undefined) this.driver = await loadDriver();
    if (!this.driver) throw new Error("the mongodb driver is not installed");
    const client = new this.driver.MongoClient(this.options.uri, {
      // Fail fast. A broker that hangs for 30s on boot because a database is
      // unreachable is worse than one that starts on SQLite and says so.
      serverSelectionTimeoutMS: 8_000,
      connectTimeoutMS: 8_000,
      retryWrites: true,
    });
    try {
      await client.connect();
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    this.client = client;
    this.connected = true;
    const db = this.db();
    await db.collection("jobs").createIndex({ createdAt: -1 });
    await db.collection("jobs").createIndex({ id: 1 }, { unique: true });
    await db.collection("providerStats").createIndex({ nodeId: 1 }, { unique: true });
    await db.collection("vaults").createIndex({ id: 1 }, { unique: true });
  }

  private db() {
    if (!this.client) throw new Error("not connected to mongodb");
    return this.client.db(this.options.dbName ?? DEFAULT_DB);
  }

  /**
   * Compare Mongo with the local store, record by record. With `restore`
   * (boot), what only Mongo had (or had newer) is written to the local store
   * and served by the load methods. Either way, what Mongo is missing (or has
   * older) is queued for upload.
   */
  private async sync(opts: { restore: boolean }): Promise<{ jobs: number; providers: number }> {
    const db = this.db();

    // -- jobs: Mongo's newest window, plus Mongo's copy of every local job.
    const localJobs = this.local.loadJobs(JOB_WINDOW);
    const remoteJobs = new Map<string, Job>();
    const keep = (rows: unknown[]) => {
      for (const row of rows as Array<{ job?: unknown }>) {
        // Rows written by an older build carry older field names; upgrade them
        // on the way in rather than dropping the history.
        const job = upgradeJob(row.job);
        if (job) remoteJobs.set(job.id, job);
      }
    };
    keep(await db.collection("jobs").find({}).sort({ createdAt: -1 }).limit(JOB_WINDOW).toArray());
    for (const ids of chunks(localJobs.map((j) => j.id).filter((id) => !remoteJobs.has(id)), ID_CHUNK)) {
      keep(await db.collection("jobs").find({ id: { $in: ids } }).sort({ createdAt: -1 }).limit(ids.length).toArray());
    }
    const jobs = new Map<string, Job>();
    for (const job of localJobs) {
      const remote = remoteJobs.get(job.id);
      if (!remote) {
        jobs.set(job.id, job);
        this.pendingJobs.set(job.id, job);
        continue;
      }
      const winner = newerJob(job, remote);
      jobs.set(job.id, winner);
      if (winner === remote) {
        if (opts.restore) this.local.saveJob(remote);
      } else if (revOf(job) > revOf(remote)) {
        this.pendingJobs.set(job.id, job);
      } else if (revOf(job) < 0 && JSON.stringify(job) !== JSON.stringify(remote)) {
        // Rows from before revisions can't be ordered; the local write came first, so it is re-sent.
        this.pendingJobs.set(job.id, job);
      }
    }
    for (const [id, remote] of remoteJobs) {
      if (jobs.has(id)) continue;
      jobs.set(id, remote);
      if (opts.restore) this.local.saveJob(remote);
    }

    // -- provider stats
    const localStats = this.local.loadStats();
    const statRows = (await db
      .collection("providerStats")
      .find({})
      .sort({ nodeId: 1 })
      .limit(STATS_WINDOW)
      .toArray()) as Array<Record<string, unknown>>;
    const stats = new Map(localStats);
    const remoteStatIds = new Set<string>();
    for (const row of statRows) {
      if (typeof row.nodeId !== "string") continue;
      remoteStatIds.add(row.nodeId);
      const remote: PersistedProviderStats = {
        nodeId: row.nodeId,
        label: typeof row.label === "string" ? row.label : "",
        // `accountId` is the Hedera-era name for the same column.
        address: typeof row.address === "string" ? row.address : typeof row.accountId === "string" ? row.accountId : "",
        ...upgradeStats(row),
      };
      const local = localStats.get(row.nodeId);
      const winner = local ? newerStats(local, remote) : remote;
      stats.set(row.nodeId, winner);
      if (winner === remote) {
        if (opts.restore) this.local.saveStats(remote.nodeId, remote.label, remote.address, upgradeStats({ ...remote }));
      } else if (local && newerStats(remote, local) === local && !sameStats(local, remote)) {
        this.pendingStats.set(local.nodeId, local);
      }
    }
    for (const [nodeId, local] of localStats) if (!remoteStatIds.has(nodeId)) this.pendingStats.set(nodeId, local);

    // -- vaults: compare versions without pulling every ciphertext.
    const vaultRows = (await db
      .collection("vaults")
      .find({}, { projection: { id: 1, version: 1, updatedAt: 1 } })
      .sort({ updatedAt: -1 })
      .limit(VAULT_WINDOW)
      .toArray()) as Array<Record<string, unknown>>;
    const remoteVersions = new Map<string, number>();
    for (const row of vaultRows) {
      if (typeof row.id === "string" && typeof row.version === "number") remoteVersions.set(row.id, row.version);
    }
    const localIndex = typeof this.local.loadVault === "function" ? (this.local.loadVaultIndex?.() ?? null) : null;
    const canServe = localIndex !== null;
    const localVersions = new Map<string, number>();
    for (const meta of localIndex ?? []) localVersions.set(meta.id, meta.version);
    const fetchIds = [...remoteVersions].filter(([id, v]) => v > (localVersions.get(id) ?? 0)).map(([id]) => id);
    const fetched: VaultRecord[] = [];
    if (opts.restore) {
      for (const ids of chunks(fetchIds, ID_CHUNK)) {
        const rows = (await db
          .collection("vaults")
          .find({ id: { $in: ids } })
          .sort({ updatedAt: -1 })
          .limit(ids.length)
          .toArray()) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const vault = row.vault as VaultRecord | undefined;
          if (vault && typeof vault.id === "string" && typeof vault.version === "number") fetched.push(vault);
        }
      }
      if (canServe) for (const vault of fetched) this.local.saveVault?.(vault);
    }
    for (const [id, version] of localVersions) {
      if (version > (remoteVersions.get(id) ?? 0)) this.pendingVaults.set(id, version);
    }

    if (opts.restore) {
      this.restoredJobs = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, JOB_WINDOW);
      this.restoredStats = stats;
      this.restoredVaults = canServe ? null : fetched;
    }
    return { jobs: jobs.size, providers: stats.size };
  }

  // -- Persistence ----------------------------------------------------------

  /** The boot merge when Mongo answered; otherwise the local disk carries it. */
  loadJobs(limit = JOB_WINDOW): Job[] {
    if (this.restoredJobs) return this.restoredJobs.slice(0, limit);
    return this.local.loadJobs(limit);
  }

  loadStats(): Map<string, PersistedProviderStats> {
    if (this.restoredStats) return this.restoredStats;
    return this.local.loadStats();
  }

  /** Whole records: only used when the local store can't serve vaults back (memory mode). */
  loadVaults(): VaultRecord[] {
    if (this.restoredVaults) return this.restoredVaults;
    return this.local.loadVaults?.() ?? [];
  }

  /** The local index, which the boot merge brought up to date. */
  loadVaultIndex(): VaultMeta[] | null {
    return this.local.loadVaultIndex?.() ?? null;
  }

  loadVault(id: string): VaultRecord | null {
    return this.local.loadVault?.(id) ?? null;
  }

  saveVault(record: VaultRecord): void {
    this.local.saveVault?.(record);
    const servable = typeof this.local.loadVault === "function";
    this.pendingVaults.set(record.id, servable ? record.version : record);
    this.track(this.flushVault(record.id));
  }

  saveJob(job: Job): void {
    // Local first, synchronously. This is the write that must not fail.
    this.local.saveJob(job);
    this.pendingJobs.set(job.id, job);
    this.track(this.flushJob(job));
  }

  saveStats(nodeId: string, label: string, address: string, stats: ProviderStats): void {
    this.local.saveStats(nodeId, label, address, stats);
    const row: PersistedProviderStats = { nodeId, label, address, ...stats };
    this.pendingStats.set(nodeId, row);
    this.track(this.flushStats(row));
  }

  prune(olderThanMs: number): number {
    return this.local.prune(olderThanMs);
  }

  /**
   * Give pending and in-flight Mongo writes up to `timeoutMs` to land. Called
   * on shutdown before `close()`: the receipts flushed during shutdown patch
   * jobs, and closing the client under them used to leave Mongo behind.
   */
  async drain(timeoutMs = 2_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    const work = (async () => {
      await Promise.allSettled([...this.inflight]);
      if (this.pendingJobs.size + this.pendingStats.size + this.pendingVaults.size > 0) await this.retryPending();
    })();
    await Promise.race([work, deadline]).finally(() => clearTimeout(timer));
  }

  close(): void {
    this.local.close();
    void this.client?.close().catch(() => {});
  }

  // -- background ------------------------------------------------------------

  private track(pending: Promise<void>): void {
    this.inflight.add(pending);
    void pending.finally(() => this.inflight.delete(pending));
  }

  private collection(name: string): MongoCollectionLike | undefined {
    return this.client?.db(this.options.dbName ?? DEFAULT_DB).collection(name);
  }

  private async flushJob(job: Job): Promise<void> {
    if (!this.connected) return;
    // The revision this flush carries. The job object is the store's live one
    // and may move on while the write is in flight; that newer revision is
    // queued by its own save and must stay queued if this write lands first.
    const rev = revOf(job);
    const done = () => {
      const queued = this.pendingJobs.get(job.id);
      if (queued && revOf(queued) <= rev) this.pendingJobs.delete(job.id);
    };
    try {
      // Conditional on the revision, so an older copy that lands late (two
      // writes racing, a replay) never overwrites a newer one.
      await this.collection("jobs")?.updateOne(
        rev >= 0 ? { id: job.id, $or: [{ rev: { $lt: rev } }, { rev: { $exists: false } }] } : { id: job.id },
        { $set: { id: job.id, createdAt: job.createdAt, status: job.status, ...(rev >= 0 ? { rev } : {}), job } },
        { upsert: true },
      );
      done();
    } catch (err) {
      // Mongo already holds this revision or a newer one.
      if (isDuplicateKey(err)) return done();
      this.markDisconnected(err);
    }
  }

  private async flushStats(row: PersistedProviderStats): Promise<void> {
    if (!this.connected) return;
    try {
      await this.collection("providerStats")?.updateOne(
        { nodeId: row.nodeId },
        { $set: { ...row, updatedAt: Date.now() } },
        { upsert: true },
      );
      if (this.pendingStats.get(row.nodeId) === row) this.pendingStats.delete(row.nodeId);
    } catch (err) {
      this.markDisconnected(err);
    }
  }

  private async flushVault(id: string): Promise<void> {
    if (!this.connected) return;
    const pending = this.pendingVaults.get(id);
    if (pending === undefined) return;
    const record = typeof pending === "number" ? this.local.loadVault?.(id) ?? null : pending;
    if (!record) {
      this.pendingVaults.delete(id);
      return;
    }
    const done = () => {
      // Only clear it if no newer write replaced it while this one was in flight.
      const now = this.pendingVaults.get(id);
      const version = typeof now === "number" ? now : now?.version;
      if (version !== undefined && version <= record.version) this.pendingVaults.delete(id);
    };
    try {
      // Conditional on the version: an older flush landing after a newer one
      // must not roll the vault back.
      await this.collection("vaults")?.updateOne(
        { id: record.id, version: { $lt: record.version } },
        { $set: { id: record.id, version: record.version, updatedAt: record.updatedAt, vault: record } },
        { upsert: true },
      );
      done();
    } catch (err) {
      // Mongo already holds this version or a newer one.
      if (isDuplicateKey(err)) return done();
      this.markDisconnected(err);
    }
  }

  private markDisconnected(err: unknown): void {
    if (!this.connected) return;
    this.connected = false;
    this.onStatus(
      `mongodb write failed — falling back to local disk (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  /**
   * Retry anything Mongo missed.
   *
   * Called on a timer by the broker. Cheap when there is nothing pending, and
   * when there is, it drains in insertion order so the collection converges on
   * the same state the local store already has. A broker that could not reach
   * Mongo at boot connects here, and first queues everything Mongo is missing.
   */
  async retryPending(): Promise<{ retried: number; connected: boolean }> {
    if (!this.client) {
      if (!(await this.reconnect())) return { retried: 0, connected: false };
    }
    if (this.pendingJobs.size === 0 && this.pendingStats.size === 0 && this.pendingVaults.size === 0) {
      return { retried: 0, connected: this.connected };
    }

    // Optimistically assume the outage is over; the first failure will flip it
    // back and leave the queue intact.
    this.connected = true;
    let retried = 0;

    for (const job of [...this.pendingJobs.values()]) {
      const before = this.pendingJobs.size;
      await this.flushJob(job);
      if (this.pendingJobs.size < before) retried += 1;
      if (!this.connected) break;
    }
    for (const row of [...this.pendingStats.values()]) {
      if (!this.connected) break;
      const before = this.pendingStats.size;
      await this.flushStats(row);
      if (this.pendingStats.size < before) retried += 1;
    }
    for (const id of [...this.pendingVaults.keys()]) {
      if (!this.connected) break;
      const before = this.pendingVaults.size;
      await this.flushVault(id);
      if (this.pendingVaults.size < before) retried += 1;
    }

    if (retried > 0) this.onStatus(`mongodb reconnected — replayed ${retried} pending write(s)`);
    return { retried, connected: this.connected };
  }

  /** Connect after a failed boot, and queue what Mongo is missing. One attempt at a time. */
  private async reconnect(): Promise<boolean> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        await this.open();
        await this.sync({ restore: false });
        this.onStatus("mongodb connected — uploading what it missed while unreachable");
        return true;
      } catch {
        if (this.client) await this.client.close().catch(() => {});
        this.client = null;
        this.connected = false;
        return false;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  /** For the network panel, so an operator can see the two layers agree. */
  status(): { connected: boolean; pendingJobs: number; pendingStats: number; pendingVaults: number } {
    return {
      connected: this.connected,
      pendingJobs: this.pendingJobs.size,
      pendingStats: this.pendingStats.size,
      pendingVaults: this.pendingVaults.size,
    };
  }
}

/** No Mongo configured — the local store is the whole story. */
export function noMongo(local: Persistence = new MemoryPersistence()): Persistence {
  return local;
}
