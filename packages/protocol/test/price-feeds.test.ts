import { describe, expect, it } from "vitest";
import { CHAINLINK_FEEDS, monToUsd, pegCheck, readFeed } from "../src/price-feeds.js";

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const client = (answer: bigint, updatedSecs: number) => ({
  readContract: async () => [1n, answer, 0n, BigInt(updatedSecs), 1n] as const,
});

describe("Chainlink Data Feeds", () => {
  it("reads a feed's answer in dollars, and when it was updated", async () => {
    const r = await readFeed(client(99_984_573n, NOW / 1000 - 3_600) as never, CHAINLINK_FEEDS.usdcUsd, NOW);
    expect(r).toMatchObject({ pair: "USDC/USD", price: 0.99984573, stale: false, feed: CHAINLINK_FEEDS.usdcUsd.address });
    expect(r.updatedAt).toBe(NOW - 3_600_000);
  });

  it("marks a reading past its 24 h heartbeat stale, and refuses a non-positive answer", async () => {
    expect((await readFeed(client(100_000_000n, NOW / 1000 - 30 * 3_600) as never, CHAINLINK_FEEDS.usdcUsd, NOW)).stale).toBe(true);
    await expect(readFeed(client(0n, NOW / 1000) as never, CHAINLINK_FEEDS.usdcUsd, NOW)).rejects.toThrow(/non-positive/);
  });

  it("blocks quoting only on a fresh reading more than 2% off $1", async () => {
    const at = (price: number, stale = false) => ({ pair: "USDC/USD", network: "", feed: "", price, updatedAt: NOW, stale, readAt: NOW });
    expect(pegCheck(at(0.9998)).ok).toBe(true);
    expect(pegCheck(at(0.97))).toMatchObject({ ok: false, reason: expect.stringMatching(/off its peg: Chainlink USDC\/USD reads \$0\.9700/) });
    expect(pegCheck(at(0.97, true)).ok).toBe(true);
  });

  it("prices gas in dollars", () => {
    expect(monToUsd(34_875_000_000_000_000n, { price: 0.02524 })).toBeCloseTo(0.00088, 5);
  });
});
