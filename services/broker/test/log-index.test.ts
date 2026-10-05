/**
 * The audit-log index: scheduling, cursor, dedupe and backoff.
 *
 * The chain is scripted here — a head that moves and windows that return known
 * entries or a rate-limit error — so the index's own logic is exercised
 * deterministically. The RPC readers it uses by default are the protocol
 * package's real ones.
 */

import { describe, expect, it } from "vitest";
import type { LogEntry } from "@xorv/protocol";
import { LogIndex } from "../src/log-index.js";
import { MemoryPersistence } from "../src/store.js";

const ADDRESS = "0x383f5153db8bb18c7c25157fb3493645a465eef3";
const WINDOW = 9_000n;

function entry(block: number, sequence: number, kind: LogEntry["kind"] = "job.receipt", tx?: string): LogEntry {
  return {
    kind,
    subject: "0x01",
    author: "0xeEE4CA97A7Af69B42d9cafD3955735C1130eB51E",
    sequence,
    payload: { v: 1, kind, data: { jobId: `job_${sequence}` } },
    blockNumber: block,
    transactionHash: tx ?? `0x${sequence.toString(16).padStart(64, "0")}`,
  };
}

describe("LogIndex", () => {
  it("scans forward in windows from the deployment block and persists the cursor", async () => {
    const store = new MemoryPersistence();
    const windows: Array<[bigint, bigint]> = [];
    const index = new LogIndex({
      network: "eip155:10143",
      windowBlocks: WINDOW,
      address: ADDRESS,
      fromBlock: 1_000n,
      store,
      head: async () => 20_000n,
      readRange: async (from, to) => {
        windows.push([from, to]);
        return from === 1_000n ? [entry(1_500, 1)] : [];
      },
    });

    expect(await index.tick()).toBe("scanned");
    expect(windows[0]).toEqual([1_000n, 1_000n + WINDOW - 1n]);
    expect(store.loadLogCursor(ADDRESS)).toBe(1_000n + WINDOW - 1n);

    expect(await index.tick()).toBe("scanned");
    expect(await index.tick()).toBe("scanned");
    expect(windows.at(-1)).toEqual([19_000n, 20_000n]);
    expect(await index.tick()).toBe("caught-up");
    expect(index.sync()).toMatchObject({ scannedTo: "20000", head: "20000", caughtUp: true, entries: 1 });
  });

  it("backs off on an RPC error without advancing, then carries on", async () => {
    let refuse = true;
    const index = new LogIndex({
      network: "eip155:10143",
      windowBlocks: WINDOW,
      address: ADDRESS,
      fromBlock: 1n,
      store: new MemoryPersistence(),
      head: async () => 100n,
      readRange: async () => {
        if (refuse) throw Object.assign(new Error("Request exceeds defined limit."), { details: "rate limit exceeded" });
        return [entry(50, 1)];
      },
    });
    expect(await index.tick()).toBe("backoff");
    expect(index.sync()).toMatchObject({ scannedTo: "0", lastError: "rate limit exceeded", entries: 0 });
    refuse = false;
    expect(await index.tick()).toBe("scanned");
    expect(index.sync()).toMatchObject({ scannedTo: "100", lastError: null, entries: 1 });
  });

  it("resumes from the saved cursor and entries after a restart", async () => {
    const store = new MemoryPersistence();
    const first = new LogIndex({
      network: "eip155:10143",
      windowBlocks: WINDOW,
      address: ADDRESS,
      fromBlock: 1n,
      store,
      head: async () => 50_000n,
      readRange: async (from) => (from === 1n ? [entry(10, 1)] : []),
    });
    await first.tick();

    const seen: bigint[] = [];
    const second = new LogIndex({
      network: "eip155:10143",
      windowBlocks: WINDOW,
      address: ADDRESS,
      fromBlock: 1n,
      store,
      head: async () => 50_000n,
      readRange: async (from) => {
        seen.push(from);
        return [];
      },
    });
    expect(second.entries()).toHaveLength(1);
    await second.tick();
    expect(seen[0]).toBe(WINDOW + 1n);
  });

  it("seeds from known transactions immediately, once each", async () => {
    let lookups = 0;
    const index = new LogIndex({
      network: "eip155:10143",
      windowBlocks: WINDOW,
      address: ADDRESS,
      fromBlock: 1n,
      store: new MemoryPersistence(),
      readTransactions: async (hashes) => {
        lookups += hashes.length;
        return hashes.map((h, i) => entry(5_000_000 + i, 100 + i, "job.receipt", h));
      },
    });
    expect(await index.seed(["0xAA", "0xbb", "0xaa", ""])).toBe(2);
    expect(await index.seed(["0xaa", "0xBB"])).toBe(0);
    expect(lookups).toBe(2);
    expect(index.entries({ kind: "job.receipt" })).toHaveLength(2);
  });

  it("picks up newly published receipts on every tick, even mid-backfill", async () => {
    const published: string[] = [];
    const index = new LogIndex({
      network: "eip155:10143",
      windowBlocks: WINDOW,
      address: ADDRESS,
      fromBlock: 1n,
      store: new MemoryPersistence(),
      head: async () => 10_000_000n,
      readRange: async () => [],
      knownTransactions: () => published,
      readTransactions: async (hashes) => hashes.map((h) => entry(9_999_999, 7, "job.receipt", h)),
    });
    await index.tick();
    expect(index.entries()).toHaveLength(0);
    published.push("0x" + "ab".repeat(32));
    await index.tick();
    expect(index.entries()).toHaveLength(1);
    expect(index.sync().caughtUp).toBe(false);
  });

  it("never lets a failing seed stop the forward scan", async () => {
    const ranges: bigint[] = [];
    const index = new LogIndex({
      network: "eip155:10143",
      windowBlocks: WINDOW,
      address: ADDRESS,
      fromBlock: 1n,
      store: new MemoryPersistence(),
      head: async () => 100n,
      knownTransactions: () => ["0x" + "cd".repeat(32)],
      readTransactions: async () => {
        throw new Error("rate limit exceeded");
      },
      readRange: async (from) => {
        ranges.push(from);
        return [entry(40, 1)];
      },
    });
    expect(await index.tick()).toBe("scanned");
    expect(ranges).toEqual([1n]);
    expect(index.entries()).toHaveLength(1);
  });

  it("makes no RPC call at all while the broker is writing to the chain", async () => {
    let writing = true;
    const calls: string[] = [];
    const index = new LogIndex({
      network: "eip155:10143",
      windowBlocks: WINDOW,
      address: ADDRESS,
      fromBlock: 1n,
      store: new MemoryPersistence(),
      yieldTo: () => writing,
      knownTransactions: () => ["0x" + "ef".repeat(32)],
      readTransactions: async () => {
        calls.push("seed");
        return [];
      },
      head: async () => {
        calls.push("head");
        return 100n;
      },
      readRange: async () => {
        calls.push("range");
        return [];
      },
    });
    expect(await index.tick()).toBe("yielded");
    expect(await index.tick()).toBe("yielded");
    expect(calls).toEqual([]);
    writing = false;
    expect(await index.tick()).toBe("scanned");
    expect(calls).toEqual(["seed", "head", "range"]);
  });

  it("orders newest first and filters by kind", async () => {
    const index = new LogIndex({
      network: "eip155:10143",
      windowBlocks: WINDOW,
      address: ADDRESS,
      fromBlock: 1n,
      store: new MemoryPersistence(),
      head: async () => 100n,
      readRange: async () => [
        entry(10, 1, "provider.registered"),
        entry(20, 2, "job.receipt"),
        entry(20, 3, "job.receipt"),
        entry(30, 4, "provider.heartbeat"),
      ],
    });
    await index.tick();
    expect(index.entries().map((e) => e.sequence)).toEqual([4, 3, 2, 1]);
    expect(index.entries({ kind: "job.receipt" }).map((e) => e.sequence)).toEqual([3, 2]);
    expect(index.counts()).toEqual({ registry: 1, heartbeat: 1, receipts: 2 });
  });

  it("follows the head when no deployment block is known", async () => {
    let head = 500n;
    const ranges: Array<[bigint, bigint]> = [];
    const index = new LogIndex({
      network: "eip155:10143",
      windowBlocks: WINDOW,
      address: ADDRESS,
      fromBlock: 0n,
      store: new MemoryPersistence(),
      head: async () => head,
      readRange: async (from, to) => {
        ranges.push([from, to]);
        return [];
      },
    });
    expect(await index.tick()).toBe("caught-up");
    head = 520n;
    expect(await index.tick()).toBe("scanned");
    expect(ranges).toEqual([[501n, 520n]]);
  });
});

describe("LogIndex window size", () => {
  it("defaults to the protocol's configurable window", async () => {
    process.env.XORV_LOG_WINDOW_BLOCKS = "2500";
    const windows: Array<[bigint, bigint]> = [];
    const index = new LogIndex({
      network: "eip155:10143",
      address: ADDRESS,
      fromBlock: 1n,
      store: new MemoryPersistence(),
      head: async () => 100_000n,
      readRange: async (from, to) => {
        windows.push([from, to]);
        return [];
      },
    });
    delete process.env.XORV_LOG_WINDOW_BLOCKS;
    await index.tick();
    expect(windows[0]).toEqual([1n, 2_500n]);
  });
});
