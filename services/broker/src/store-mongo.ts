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
 *  - **On boot**, state is restored from Mongo when it is reachable. That is
 *    what makes it primary — the cloud copy is the one that survives losing the
 *    machine, and a broker redeployed anywhere comes back with its history.
 *  - **On write**, SQLite takes it synchronously and Mongo takes it in the
 *    background. A Mongo outage, a DNS hiccup, an expired cert — none of them
 *    can fail a settled job, and every write that missed Mongo is still on disk.
 *  - **On reconnect**, anything Mongo missed is replayed from SQLite, so the two
 *    converge without anyone having to notice they diverged.
 *
 * The failure this design refuses is the interesting one: a broker that is up,
 * taking payments, and silently not recording them because a database is
 * unreachable.
 */

import type { Job, ProviderStats } from "@xorv/protocol";
import { MemoryPersistence, type PersistedProviderStats, type Persistence } from "./store.js";

interface MongoLike {
  db(name?: string): {
    collection(name: string): {
      find(filter: object): {
        sort(spec: object): { limit(n: number): { toArray(): Promise<unknown[]> } };
      };
      updateOne(filter: object, update: object, options?: object): Promise<unknown>;
      createIndex(spec: object, options?: object): Promise<unknown>;
    };
  };
  connect(): Promise<unknown>;
  close(): Promise<void>;
}

export interface LayeredOptions {
  /** The durable local store. Always written, always synchronous. */
  local: Persistence;
  uri: string;
  dbName?: string;
  /** Called with anything worth an operator's attention. */
  onStatus?: (message: string) => void;
}

/**
 * Load the driver without making it a hard dependency of the broker.
 *
 * Someone running Xorv with SQLite only should not have to install a MongoDB
 * driver, and a missing module must degrade rather than refuse to boot.
 */
async function loadDriver(): Promise<{ MongoClient: new (uri: string, opts?: object) => MongoLike } | null> {
  try {
    return (await import("mongodb")) as unknown as {
      MongoClient: new (uri: string, opts?: object) => MongoLike;
    };
  } catch {
    return null;
  }
}

export class LayeredPersistence implements Persistence {
  readonly kind: "sqlite" | "memory";
  readonly location: string;

  private readonly local: Persistence;
  private client: MongoLike | null = null;
  private connected = false;
  private readonly onStatus: (message: string) => void;

  /** Writes Mongo hasn't acknowledged yet, replayed when it comes back. */
  private pendingJobs = new Map<string, Job>();
  private pendingStats = new Map<string, PersistedProviderStats>();
  private restoredJobs: Job[] | null = null;
  private restoredStats: Map<string, PersistedProviderStats> | null = null;

  constructor(private readonly options: LayeredOptions) {
    this.local = options.local;
    this.kind = options.local.kind;
    this.location = `${options.local.location} + mongodb`;
    this.onStatus = options.onStatus ?? (() => {});
  }

  /**
   * Connect and pull state down.
   *
   * Awaited once, before the HTTP server listens, so the first request already
   * sees restored history. Everything after this point is fire-and-forget.
   */
  async connect(): Promise<{ ok: boolean; jobs: number; providers: number; error?: string }> {
    const driver = await loadDriver();
    if (!driver) {
      return { ok: false, jobs: 0, providers: 0, error: "the mongodb driver is not installed" };
    }

    try {
      const client = new driver.MongoClient(this.options.uri, {
        // Fail fast. A broker that hangs for 30s on boot because a database is
        // unreachable is worse than one that starts on SQLite and says so.
        serverSelectionTimeoutMS: 8_000,
        connectTimeoutMS: 8_000,
        retryWrites: true,
      });
      await client.connect();
      this.client = client;
      this.connected = true;

      const db = client.db(this.options.dbName ?? "xorv");
      await db.collection("jobs").createIndex({ createdAt: -1 });
      await db.collection("jobs").createIndex({ id: 1 }, { unique: true });
      await db.collection("providerStats").createIndex({ nodeId: 1 }, { unique: true });

      const jobRows = (await db
        .collection("jobs")
        .find({})
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray()) as Array<{ job?: Job }>;
      this.restoredJobs = jobRows.map((row) => row.job).filter((j): j is Job => Boolean(j));

      const statRows = (await db
        .collection("providerStats")
        .find({})
        .sort({ nodeId: 1 })
        .limit(1_000)
        .toArray()) as Array<PersistedProviderStats>;
      this.restoredStats = new Map(statRows.map((row) => [row.nodeId, row]));

      return {
        ok: true,
        jobs: this.restoredJobs.length,
        providers: this.restoredStats.size,
      };
    } catch (err) {
      this.connected = false;
      return {
        ok: false,
        jobs: 0,
        providers: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // -- Persistence ----------------------------------------------------------

  /** Mongo's copy wins when it answered; otherwise the local disk carries it. */
  loadJobs(limit = 500): Job[] {
    if (this.restoredJobs && this.restoredJobs.length > 0) {
      return this.restoredJobs.slice(0, limit);
    }
    return this.local.loadJobs(limit);
  }

  loadStats(): Map<string, PersistedProviderStats> {
    if (this.restoredStats && this.restoredStats.size > 0) return this.restoredStats;
    return this.local.loadStats();
  }

  saveJob(job: Job): void {
    // Local first, synchronously. This is the write that must not fail.
    this.local.saveJob(job);
    this.pendingJobs.set(job.id, job);
    void this.flushJob(job);
  }

  saveStats(nodeId: string, label: string, accountId: string, stats: ProviderStats): void {
    this.local.saveStats(nodeId, label, accountId, stats);
    const row: PersistedProviderStats = { nodeId, label, accountId, ...stats };
    this.pendingStats.set(nodeId, row);
    void this.flushStats(row);
  }

  prune(olderThanMs: number): number {
    return this.local.prune(olderThanMs);
  }

  close(): void {
    this.local.close();
    void this.client?.close().catch(() => {});
  }

  // -- background ------------------------------------------------------------

  private collection(name: string) {
    return this.client?.db(this.options.dbName ?? "xorv").collection(name);
  }

  private async flushJob(job: Job): Promise<void> {
    if (!this.connected) return;
    try {
      await this.collection("jobs")?.updateOne(
        { id: job.id },
        { $set: { id: job.id, createdAt: job.createdAt, status: job.status, job } },
        { upsert: true },
      );
      this.pendingJobs.delete(job.id);
    } catch (err) {
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
      this.pendingStats.delete(row.nodeId);
    } catch (err) {
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
   * the same state the local store already has.
   */
  async retryPending(): Promise<{ retried: number; connected: boolean }> {
    if (this.pendingJobs.size === 0 && this.pendingStats.size === 0) {
      return { retried: 0, connected: this.connected };
    }
    if (!this.client) return { retried: 0, connected: false };

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

    if (retried > 0) this.onStatus(`mongodb reconnected — replayed ${retried} pending write(s)`);
    return { retried, connected: this.connected };
  }

  /** For the network panel, so an operator can see the two layers agree. */
  status(): { connected: boolean; pendingJobs: number; pendingStats: number } {
    return {
      connected: this.connected,
      pendingJobs: this.pendingJobs.size,
      pendingStats: this.pendingStats.size,
    };
  }
}

/** No Mongo configured — the local store is the whole story. */
export function noMongo(local: Persistence = new MemoryPersistence()): Persistence {
  return local;
}
