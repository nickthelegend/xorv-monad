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

export interface PersistedProviderStats extends ProviderStats {
  nodeId: string;
  label: string;
  accountId: string;
}

export interface Persistence {
  readonly kind: "sqlite" | "memory";
  readonly location: string;
  /** Every job we still remember, newest first. */
  loadJobs(limit?: number): Job[];
  saveJob(job: Job): void;
  /** Lifetime stats keyed by the node's stable id, so a restart keeps earnings. */
  loadStats(): Map<string, PersistedProviderStats>;
  saveStats(nodeId: string, label: string, accountId: string, stats: ProviderStats): void;
  /** Drop jobs older than the retention window; returns how many went. */
  prune(olderThanMs: number): number;
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

interface StatsRow {
  node_id: string;
  label: string;
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
    `);
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
        jobs.push(JSON.parse(row.body) as Job);
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
          accountId: row.account_id,
          ...(JSON.parse(row.body) as ProviderStats),
        });
      } catch {
        /* skip a corrupt row */
      }
    }
    return out;
  }

  saveStats(nodeId: string, label: string, accountId: string, stats: ProviderStats): void {
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
      .run(nodeId, label, accountId, JSON.stringify(stats), Date.now());
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
