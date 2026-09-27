/**
 * The Mongo layer over SQLite, against an in-memory stand-in for Mongo.
 *
 * What these pin: a restart never comes back with an older history than the
 * broker had. Boot merges the two stores record by record (the newer copy of
 * each job, provider and vault wins), what only Mongo had is written back to
 * disk, what Mongo missed is queued from disk, and uploads are conditional so
 * a late, older write can't roll a record back.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Job } from "@xorv/protocol";
import { openPersistence, type Persistence } from "../src/store.js";
import { LayeredPersistence, type MongoDriver, type MongoLike } from "../src/store-mongo.js";
import { VaultStore, type VaultRecord } from "../src/vaults.js";

type Doc = Record<string, unknown>;

/** Just enough of Mongo's query language for the layer: equality, $in, $lt, $exists, $or. */
function matches(doc: Doc, filter: Doc): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$or") {
      if (!(cond as Doc[]).some((f) => matches(doc, f))) return false;
      continue;
    }
    const value = doc[key];
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Doc;
      if ("$in" in c && !(c.$in as unknown[]).includes(value)) return false;
      if ("$lt" in c && !(typeof value === "number" && value < (c.$lt as number))) return false;
      if ("$exists" in c && (value !== undefined) !== c.$exists) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

class FakeServer {
  down = false;
  failWrites = false;
  readonly collections = new Map<string, Map<string, Doc>>();
  private readonly keys: Record<string, string> = { jobs: "id", providerStats: "nodeId", vaults: "id" };

  col(name: string) {
    const docs = this.collections.get(name) ?? new Map<string, Doc>();
    this.collections.set(name, docs);
    const key = this.keys[name] ?? "id";
    const server = this;
    return {
      find(filter: Doc, options?: { projection?: Record<string, number> }) {
        let rows = [...docs.values()].filter((d) => matches(d, filter)).map((d) => structuredClone(d));
        if (options?.projection) {
          const fields = Object.keys(options.projection);
          rows = rows.map((d) => Object.fromEntries(fields.filter((f) => f in d).map((f) => [f, d[f]])));
        }
        return {
          sort(spec: Record<string, number>) {
            const [field, dir] = Object.entries(spec)[0] ?? ["", 1];
            const sorted = field
              ? rows.sort((a, b) => ((a[field] as number) > (b[field] as number) ? dir : -dir))
              : rows;
            return { limit: (n: number) => ({ toArray: async () => sorted.slice(0, n) }) };
          },
        };
      },
      async updateOne(filter: Doc, update: { $set: Doc }, options?: { upsert?: boolean }) {
        if (server.down || server.failWrites) throw new Error("connection reset");
        const found = [...docs.values()].find((d) => matches(d, filter));
        if (found) {
          Object.assign(found, structuredClone(update.$set));
          return;
        }
        if (!options?.upsert) return;
        const doc = structuredClone(update.$set);
        const id = doc[key] as string;
        if (docs.has(id)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
        docs.set(id, doc);
      },
      async createIndex() {},
    };
  }

  driver(): MongoDriver {
    const server = this;
    class Client implements MongoLike {
      async connect() {
        if (server.down) throw new Error("server selection timed out");
      }
      db() {
        return { collection: (name: string) => server.col(name) };
      }
      async close() {}
    }
    return { MongoClient: Client };
  }

  doc(collection: string, id: string): Doc | undefined {
    return this.collections.get(collection)?.get(id);
  }
}

function job(id: string, over: Partial<Job> & { rev?: number; receiptTxHash?: string } = {}): Job {
  return {
    id,
    request: { prompt: `prompt ${id}`, maxPriceUsdMicros: 50_000 },
    status: "running",
    createdAt: 1_000,
    events: [],
    ...over,
  } as Job;
}

function vault(id: string, version: number): VaultRecord {
  return {
    id,
    ciphertext: `cipher-${version}-${"x".repeat(version)}`,
    iv: "AAAAAAAAAAAAAAAA",
    version,
    publicKey: `pk-${id}`,
    createdAt: 1,
    updatedAt: 10 + version,
  };
}

const VAULT_A = "a".repeat(64);
const VAULT_B = "b".repeat(64);

let dir: string;
let file: string;
let server: FakeServer;
const opened: Persistence[] = [];

function local(): Persistence {
  const p = openPersistence(file);
  opened.push(p);
  return p;
}

function layered(over: { local?: Persistence } = {}) {
  const p = new LayeredPersistence({ local: over.local ?? local(), uri: "mongodb://fake", driver: server.driver() });
  opened.push(p);
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-mongo-"));
  file = path.join(dir, "broker.db");
  server = new FakeServer();
});
afterEach(() => {
  for (const p of opened.splice(0)) {
    try {
      p.close();
    } catch {
      /* already closed */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("booting with Mongo", () => {
  it("keeps the newer copy of each job, instead of Mongo's wholesale", async () => {
    // SQLite is written first on every change; Mongo missed the last writes
    // (a blip, or a shutdown that closed the client under them). Mongo's copy
    // used to win whole, bringing a completed, receipted job back as running.
    const disk = local();
    disk.saveJob(job("job_done", { status: "completed", receiptTxHash: "0xabc", rev: 5 } as never));
    disk.close();
    server.col("jobs").updateOne({ id: "job_done" }, { $set: { id: "job_done", createdAt: 1_000, rev: 3, job: job("job_done", { rev: 3 } as never) } }, { upsert: true });
    server.col("jobs").updateOne({ id: "job_cloud" }, { $set: { id: "job_cloud", createdAt: 2_000, rev: 2, job: job("job_cloud", { createdAt: 2_000, rev: 2 } as never) } }, { upsert: true });

    const p = layered();
    expect((await p.connect()).ok).toBe(true);
    const restored = new Map(p.loadJobs().map((j) => [j.id, j]));
    expect(restored.get("job_done")).toMatchObject({ status: "completed", receiptTxHash: "0xabc" });
    // What only Mongo had comes back, and is written to disk too.
    expect(restored.get("job_cloud")).toBeDefined();
    expect(local().loadJobs().map((j) => j.id).sort()).toEqual(["job_cloud", "job_done"]);

    // And Mongo is brought up to the newer copy from disk.
    await p.retryPending();
    expect((server.doc("jobs", "job_done")!.job as Job).status).toBe("completed");
  });

  it("keeps the provider stats that have seen more jobs", async () => {
    const disk = local();
    disk.saveStats("node-a", "a", "0x1", { jobsCompleted: 5, jobsFailed: 1, earnedUsdcMicros: 5_000, avgDurationMs: 10 });
    disk.close();
    await server.col("providerStats").updateOne({ nodeId: "node-a" }, { $set: { nodeId: "node-a", label: "a", address: "0x1", jobsCompleted: 3, jobsFailed: 0, earnedUsdcMicros: 3_000, avgDurationMs: 10 } }, { upsert: true });
    await server.col("providerStats").updateOne({ nodeId: "node-b" }, { $set: { nodeId: "node-b", label: "b", address: "0x2", jobsCompleted: 1, jobsFailed: 0, earnedUsdcMicros: 1_000, avgDurationMs: 10 } }, { upsert: true });

    const p = layered();
    await p.connect();
    const stats = p.loadStats();
    expect(stats.get("node-a")).toMatchObject({ jobsCompleted: 5, earnedUsdcMicros: 5_000 });
    expect(stats.get("node-b")).toMatchObject({ jobsCompleted: 1 });
    expect(local().loadStats().get("node-b")).toMatchObject({ jobsCompleted: 1 });
    await p.retryPending();
    expect(server.doc("providerStats", "node-a")).toMatchObject({ jobsCompleted: 5 });
  });

  it("keeps the higher vault version, so a restart can't drop history written since", async () => {
    // Restoring Mongo's older version made the buyer's next write (v4 over
    // v3) silently drop the entries in the newer versions.
    const disk = local();
    disk.saveVault?.(vault(VAULT_A, 5));
    disk.close();
    await server.col("vaults").updateOne({ id: VAULT_A }, { $set: { id: VAULT_A, version: 3, updatedAt: 13, vault: vault(VAULT_A, 3) } }, { upsert: true });
    await server.col("vaults").updateOne({ id: VAULT_B }, { $set: { id: VAULT_B, version: 2, updatedAt: 12, vault: vault(VAULT_B, 2) } }, { upsert: true });

    const p = layered();
    await p.connect();
    const store = new VaultStore(p);
    expect(store.nextVersion(VAULT_A)).toBe(6);
    expect(store.get(VAULT_A)?.ciphertext).toBe(vault(VAULT_A, 5).ciphertext);
    expect(store.get(VAULT_B)?.version).toBe(2);
    await p.retryPending();
    expect(server.doc("vaults", VAULT_A)).toMatchObject({ version: 5 });
  });

  it("never lets an older vault write overwrite a newer one in Mongo", async () => {
    const p = layered();
    await p.connect();
    await server.col("vaults").updateOne({ id: VAULT_A }, { $set: { id: VAULT_A, version: 7, updatedAt: 17, vault: vault(VAULT_A, 7) } }, { upsert: true });
    p.saveVault(vault(VAULT_A, 6));
    await p.drain();
    expect(server.doc("vaults", VAULT_A)).toMatchObject({ version: 7 });
    expect(p.status()).toMatchObject({ connected: true, pendingVaults: 0 });
  });

  it("connects later when Mongo was down at boot, and uploads what it missed from disk", async () => {
    server.down = true;
    const p = layered();
    expect((await p.connect()).ok).toBe(false);
    p.saveJob(job("job_offline", { rev: 1 } as never));
    p.saveVault(vault(VAULT_A, 1));
    // Written before this run, never uploaded: the replay comes from disk, not memory.
    const earlier = local();
    earlier.saveJob(job("job_earlier", { rev: 4 } as never));

    server.down = false;
    const { connected } = await p.retryPending();
    expect(connected).toBe(true);
    expect(server.doc("jobs", "job_offline")).toBeDefined();
    expect(server.doc("jobs", "job_earlier")).toBeDefined();
    expect(server.doc("vaults", VAULT_A)).toMatchObject({ version: 1 });
  });

  it("lets pending writes land before the client closes on shutdown", async () => {
    const p = layered();
    await p.connect();
    server.failWrites = true;
    p.saveJob(job("job_last", { status: "completed", receiptTxHash: "0xdef", rev: 9 } as never));
    await new Promise((r) => setTimeout(r, 10));
    expect(p.status().pendingJobs).toBe(1);
    server.failWrites = false;
    await p.drain(1_000);
    expect((server.doc("jobs", "job_last")!.job as Job & { receiptTxHash?: string }).receiptTxHash).toBe("0xdef");
  });
});
