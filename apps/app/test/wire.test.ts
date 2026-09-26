import { describe, expect, it } from "vitest";
import { normalizeLeaderboard, normalizeLedgerFeed } from "@/lib/wire";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("normalizeLeaderboard", () => {
  it("reads the broker's in-memory shape", () => {
    const board = normalizeLeaderboard({
      source: "memory",
      providers: [
        { id: "prv_1", label: "alice", address: A, agentId: "7", stats: { jobsCompleted: 3, jobsFailed: 1, earnedUsdcMicros: 30000 } },
      ],
    });
    expect(board.source).toBe("memory");
    expect(board.rows).toEqual([
      {
        providerId: "prv_1",
        label: "alice",
        address: A,
        agentId: "7",
        jobs: 4,
        jobsOk: 3,
        successRate: 0.75,
        earnedUsdcUnits: "30000",
        ratings: 0,
        avgRating: null,
      },
    ]);
  });

  it("reads an indexer-shaped row with string amounts, percentages and rating sums", () => {
    const board = normalizeLeaderboard({
      leaderboard: [{ payTo: B, agentId: 12, jobCount: "10", okCount: "9", successRate: 90, totalEarned: "123456", ratingCount: 2, ratingSum: "170" }],
      indexer: { url: "https://indexer" },
    });
    expect(board.source).toBe("indexer");
    expect(board.rows[0]).toMatchObject({
      address: B,
      agentId: "12",
      jobs: 10,
      jobsOk: 9,
      successRate: 0.9,
      earnedUsdcUnits: "123456",
      ratings: 2,
      avgRating: 85,
    });
  });

  it("sorts by earnings and drops rows that identify nobody", () => {
    const board = normalizeLeaderboard([
      { address: A, earnedUsdcUnits: "5" },
      { label: "ghost" },
      { address: B, earnedUsdcUnits: "500" },
      "junk",
    ]);
    expect(board.rows.map((r) => r.address)).toEqual([B, A]);
  });

  it("survives an empty or garbage body", () => {
    expect(normalizeLeaderboard(null)).toEqual({ source: "memory", rows: [] });
    expect(normalizeLeaderboard({ rows: "nope" }).rows).toEqual([]);
  });
});

describe("normalizeLedgerFeed", () => {
  it("keeps well-formed events and drops the rest", () => {
    const feed = normalizeLedgerFeed(
      {
        source: "envio",
        events: [
          { kind: "receipts", id: "10:0", blockNumber: 10, txHash: "0xaa", at: 1000, data: { jobId: "0x01", amount: "10000" } },
          { id: "11:0", blockNumber: 11, data: { jobId: "0x02" } },
          { id: "12:0", txHash: "0xbb" },
          null,
        ],
      },
      "receipts",
    );
    expect(feed.source).toBe("envio");
    expect(feed.events).toHaveLength(1);
    expect(feed.events[0]).toMatchObject({ kind: "receipts", id: "10:0", txHash: "0xaa", at: 1000 });
  });

  it("accepts a bare array", () => {
    expect(normalizeLedgerFeed([{ txHash: "0x1", blockNumber: "5", data: {} }], "ratings").events[0]).toMatchObject({
      kind: "ratings",
      blockNumber: 5,
    });
  });
});
