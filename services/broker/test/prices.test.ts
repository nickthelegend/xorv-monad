import { describe, expect, it, vi } from "vitest";
import type { FeedReading, FeedSpec } from "@xorv/protocol";
import { createPriceFeeds } from "../src/prices.js";

const reading = (spec: FeedSpec, price: number): FeedReading => ({ pair: spec.pair, network: spec.network, feed: spec.address, price, updatedAt: 1, stale: false, readAt: 1 });

describe("the broker's Chainlink feeds", () => {
  it("reads each feed once a minute, not once per quote", async () => {
    const read = vi.fn(async (spec: FeedSpec) => reading(spec, 1));
    const prices = createPriceFeeds({ read });
    await Promise.all([prices.usdcUsd(), prices.usdcUsd(), prices.quoteBlocker()]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps the last reading when the feed can't be reached, and never blocks quoting on an outage", async () => {
    let fail = false;
    const prices = createPriceFeeds({ cacheMs: 0, read: async (spec) => { if (fail) throw new Error("rpc down"); return reading(spec, 0.9999); } });
    expect((await prices.usdcUsd())?.price).toBe(0.9999);
    fail = true;
    expect((await prices.usdcUsd())?.price).toBe(0.9999);
    expect(prices.snapshot().lastError).toMatch(/USDC\/USD: rpc down/);
    const never = createPriceFeeds({ read: async () => { throw new Error("rpc down"); } });
    expect(await never.quoteBlocker()).toBeNull();
  });
});
