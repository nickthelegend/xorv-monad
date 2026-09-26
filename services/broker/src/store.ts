/**
 * Durable state for the broker.
 *
 * The registry stays in memory on purpose — membership *is* liveness, and a
 * provider that isn't heartbeating shouldn't survive a restart. But three
 * things genuinely must: the jobs people paid for, the receipts that prove it,
 * and the lifetime earnings an operator is watching. Losing those to a deploy
 * is the difference between a demo and a product.
 *
 * Backed by `node:sqlite`, which ships with Node — no native build step, no
 * dependency to audit, and real transactions. When it isn't available (or
 * `XORV_DB=off`), the broker falls back to a no-op store and says so at boot
 * rather than pretending it persisted anything.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Job, ProviderStats } from "@xorv/protocol";
import type { VaultRecord } from "./vaults.js";

export interface PersistedProviderStats extends ProviderStats {
  nodeId: string;
  label: string;
  /** The provider's payout address (0x…) when these stats were last saved. */
  address: string;
}

/**
 * Bring a stored job up to the current shape.
 *
 * Rows are JSON blobs, so a field rename is a read-time upgrade rather than a
 * migration. The broker only ever writes the current names, but a row can
 * come from an older build (a Mongo restore, an operator pointing XORV_DB at
 * an old file), and a job that loses its payment record on the way in is a
 * job whose receipt can never be written. Legacy names map as:
 *
 *   providerAccountId  → providerAddress
 *   receiptConsensusAt → receiptTxHash
 *   payment.transactionId / assetId / hashscanUrl → txHash / assetAddress / explorerUrl
 */
export function upgradeJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== "object") return null;
  const job = { ...(raw as Record<string, unknown>) };
  if (typeof job.id !== "string" || typeof job.createdAt !== "number" || typeof job.status !== "string") {
    return null;
  }
  if (!("providerAddress" in job) && "providerAccountId" in job) job.providerAddress = job.providerAccountId;
  if (!("receiptTxHash" in job) && "receiptConsensusAt" in job) job.receiptTxHash = job.receiptConsensusAt;
  delete job.providerAccountId;
  delete job.receiptConsensusAt;
  if (job.payment && typeof job.payment === "object") {
    const payment = { ...(job.payment as Record<string, unknown>) };
    if (!("txHash" in payment) && "transactionId" in payment) payment.txHash = payment.transactionId;
    if (!("assetAddress" in payment) && "assetId" in payment) payment.assetAddress = payment.assetId;
    if (!("explorerUrl" in payment) && "hashscanUrl" in payment) payment.explorerUrl = payment.hashscanUrl;
    delete payment.transactionId;
    delete payment.assetId;
    delete payment.hashscanUrl;
    job.payment = payment;
  }
  if (!Array.isArray(job.events)) job.events = [];
  if (!job.request || typeof job.request !== "object") return null;
  return job as unknown as Job;
}

/** Stats as stored, minus fields that no longer exist (Hedera-era `earnedTinybars`). */
export function upgradeStats(raw: Record<string, unknown>): ProviderStats {
  const num = (key: string) => (typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : 0);
  return {
    jobsCompleted: num("jobsCompleted"),
    jobsFailed: num("jobsFailed"),
    earnedUsdcMicros: num("earnedUsdcMicros"),
    avgDurationMs: num("avgDurationMs"),
  };
}

export interface Persistence {
  readonly kind: "sqlite" | "memory";
  readonly location: string;
  /** Every job we still remember, newest first. */
  loadJobs(limit?: number): Job[];
  saveJob(job: Job): void;
  /** Lifetime stats keyed by the node's stable id, so a restart keeps earnings. */
  loadStats(): Map<string, PersistedProviderStats>;
  saveStats(nodeId: string, label: string, address: string, stats: ProviderStats): void;
  /** Drop jobs older than the retention window; returns how many went. */
  prune(olderThanMs: number): number;
  /**
   * Private-job history vaults (ciphertext only — see vaults.ts). Optional so
   * a store that predates them keeps compiling; one without them simply
   * forgets vaults on restart, like the memory store.
   */
  loadVaults?(): VaultRecord[];
  saveVault?(record: VaultRecord): void;
  close(): void;
}

/** Used when persistence is off, or unavailable. Every call is a no-op. */
export class MemoryPersistence implements Persistence {
  readonly kind = "memory" as const;
  readonly location = "(in memory — jobs are lost on restart)";
  loadJobs(): Job[] {
    return [];
  }
  saveJob(): void {}
  loadStats(): Map<string, PersistedProviderStats> {
    return new Map();
  }
  saveStats(): void {}
  prune(): number {
    return 0;
  }
  close(): void {}
}

interface JobRow {
  id: string;
  created_at: number;
  status: string;
  provider_id: string | null;
  body: string;
}

interface VaultRow {
  body: string;
}

interface StatsRow {
  node_id: string;
  label: string;
  /** Holds the payout address. Named for its Hedera-era contents; kept so old files still open. */
  account_id: string;
  body: string;
}

/**
 * Open the durable store, degrading to memory rather than refusing to boot.
 *
 * A broker that won't start because it can't open a database is strictly worse
 * than one that starts, works, and tells you it isn't persisting — especially
 * on a laptop mid-demo.
 */
export function openPersistence(file: string | null): Persistence {
  if (!file || file === "off" || file === ":memory:off") return new MemoryPersistence();
  try {
    return new SqlitePersistence(file);
  } catch (err) {
    // Loud, because the failure mode is silent by nature: everything works
    // until a restart, and then the history is simply gone.
    console.error("");
    console.error("  ⚠  PERSISTENCE UNAVAILABLE — jobs and earnings will be lost on restart");
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    console.error(`     wanted: ${file}`);
    console.error("");
    return new MemoryPersistence();
  }
}

class SqlitePersistence implements Persistence {
  readonly kind = "sqlite" as const;
  readonly location: string;
  private db: import("node:sqlite").DatabaseSync;

  constructor(file: string) {
    // Loaded lazily so a Node build without node:sqlite falls through to the
    // memory store instead of failing at import time. It has to go through
    // `createRequire` rather than a bare `require`: this module is ESM, where
    // `require` simply isn't defined — which is how the broker ended up
    // silently running in memory while every test passed.
    const { DatabaseSync } = createRequire(import.meta.url)(
      "node:sqlite",
    ) as typeof import("node:sqlite");

    const resolved = path.resolve(file);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.location = resolved;
    this.db = new DatabaseSync(resolved);

    // WAL so a reader (the metrics endpoint, a backup) never blocks a writer
    // on the request path.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id          TEXT PRIMARY KEY,
        created_at  INTEGER NOT NULL,
        status      TEXT NOT NULL,
        provider_id TEXT,
        body        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_created_at ON jobs (created_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_provider   ON jobs (provider_id);

      CREATE TABLE IF NOT EXISTS provider_stats (
        node_id    TEXT PRIMARY KEY,
        label      TEXT NOT NULL,
        account_id TEXT NOT NULL,
        body       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Private-job history vaults: ciphertext, nonce, version and the
      -- vault's public key. Nothing in here is readable without the buyer's
      -- passkey.
      CREATE TABLE IF NOT EXISTS vaults (
        id         TEXT PRIMARY KEY,
        version    INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        body       TEXT NOT NULL
      );
    `);
  }

  loadVaults(): VaultRecord[] {
    const rows = this.db.prepare("SELECT body FROM vaults").all() as unknown as VaultRow[];
    const out: VaultRecord[] = [];
    for (const row of rows) {
      try {
        const record = JSON.parse(row.body) as VaultRecord;
        if (typeof record.id === "string" && typeof record.version === "number") out.push(record);
      } catch {
        /* skip a corrupt row */
      }
    }
    return out;
  }

  saveVault(record: VaultRecord): void {
    this.db
      .prepare(
        `INSERT INTO vaults (id, version, updated_at, body)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           version = excluded.version,
           updated_at = excluded.updated_at,
           body = excluded.body`,
      )
      .run(record.id, record.version, record.updatedAt, JSON.stringify(record));
  }

  loadJobs(limit = 500): Job[] {
    // `rowid` breaks the tie. Jobs posted in the same millisecond are ordinary
    // under load, and `ORDER BY created_at DESC` alone leaves their relative
    // order up to SQLite — so a restart could silently reverse the feed.
    // rowid is monotonic in insertion order, which is exactly the tiebreak the
    // in-memory store uses.
    const rows = this.db
      .prepare(
        "SELECT id, created_at, status, provider_id, body FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(limit) as unknown as JobRow[];
    const jobs: Job[] = [];
    for (const row of rows) {
      try {
        const job = upgradeJob(JSON.parse(row.body));
        if (job) jobs.push(job);
      } catch {
        // One unreadable row must not lose the rest of the history.
      }
    }
    return jobs;
  }

  saveJob(job: Job): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, created_at, status, provider_id, body)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           created_at = excluded.created_at,
           status = excluded.status,
           provider_id = excluded.provider_id,
           body = excluded.body`,
      )
      .run(job.id, job.createdAt, job.status, job.providerId ?? null, JSON.stringify(job));
  }

  loadStats(): Map<string, PersistedProviderStats> {
    const rows = this.db
      .prepare("SELECT node_id, label, account_id, body FROM provider_stats")
      .all() as unknown as StatsRow[];
    const out = new Map<string, PersistedProviderStats>();
    for (const row of rows) {
      try {
        out.set(row.node_id, {
          nodeId: row.node_id,
          label: row.label,
          address: row.account_id,
          ...upgradeStats(JSON.parse(row.body) as Record<string, unknown>),
        });
      } catch {
        /* skip a corrupt row */
      }
    }
    return out;
  }

  saveStats(nodeId: string, label: string, address: string, stats: ProviderStats): void {
    this.db
      .prepare(
        `INSERT INTO provider_stats (node_id, label, account_id, body, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           label = excluded.label,
           account_id = excluded.account_id,
           body = excluded.body,
           updated_at = excluded.updated_at`,
      )
      .run(nodeId, label, address, JSON.stringify(stats), Date.now());
  }

  prune(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const before = (
      this.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as unknown as { n: number }
    ).n;
    this.db.prepare("DELETE FROM jobs WHERE created_at < ?").run(cutoff);
    const after = (
      this.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as unknown as { n: number }
    ).n;
    return before - after;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
