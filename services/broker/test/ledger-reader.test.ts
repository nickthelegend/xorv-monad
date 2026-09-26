/**
 * Feeds: indexer first, RPC second, briefly cached — with no network.
 */

import { describe, expect, it, vi } from "vitest";
import type { LedgerEvent } from "@xorv/protocol";
import { createLedgerReader } from "../src/ledger-reader.js";

const LEDGER = "0x00000000000000000000000000000000000000Aa";
const buyer = "0x2222222222222222222222222222222222222222";
const payTo = "0x1111111111111111111111111111111111111111";

function rpcEvent(n: number): LedgerEvent {
  return {
    kind: "receipts",
    id: `${100 + n}:0`,
    blockNumber: 100 + n,
    txHash: `0x${String(n).padStart(64, "0")}`,
    at: 1_700_000_000_000 + n,
    data: {
      jobId: `0x${"aa".repeat(32)}`,
      agentId: null,
      buyer,
      payTo,
      amount: "1000",
      paymentTx: null,
      requestHash: `0x${"bb".repeat(32)}`,
      resultHash: `0x${"cc".repeat(32)}`,
      durationMs: 5,
      ok: true,
    },
  };
}

function indexerFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("createLedgerReader", () => {
  it("reads receipts from the indexer when one is configured", async () => {
    const fetch = indexerFetch({
      data: {
        Job: [
          {
            id: `0x${"aa".repeat(32)}`,
            agent_id: "7",
            buyer_id: buyer,
            payTo: payTo,
            amount: "250000",
            paymentTx: `0x${"dd".repeat(32)}`,
            requestHash: `0x${"bb".repeat(32)}`,
            resultHash: `0x${"cc".repeat(32)}`,
            durationMs: 1200,
            ok: true,
            blockNumber: 555,
            blockTimestamp: 1_700_000_000,
            txHash: `0x${"ee".repeat(32)}`,
            logIndex: 3,
          },
        ],
      },
    });
    const readRpc = vi.fn(async () => [rpcEvent(1)]);
    const reader = createLedgerReader({
      network: "eip155:10143",
      ledgerAddress: LEDGER,
      fromBlock: null,
      indexerUrl: "http://indexer.test/v1/graphql",
      fetch: fetch as unknown as typeof globalThis.fetch,
      readRpc,
    });
    const feed = await reader.events("receipts", 10);
    expect(feed.source).toBe("indexer");
    expect(readRpc).not.toHaveBeenCalled();
    const [event] = feed.events as Array<LedgerEvent<"receipts">>;
    expect(event!.id).toBe("555:3");
    expect(event!.at).toBe(1_700_000_000_000);
    expect(event!.data).toMatchObject({ agentId: "7", amount: "250000", buyer, payTo, ok: true });
    const sent = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent.variables).toEqual({ limit: 10 });
  });

  it("falls back to the RPC scan when the indexer fails, and says why", async () => {
    const reader = createLedgerReader({
      network: "eip155:10143",
      ledgerAddress: LEDGER,
      fromBlock: 10n,
      indexerUrl: "http://indexer.test/v1/graphql",
      fetch: indexerFetch({ errors: [{ message: "field 'Job' not found" }] }) as unknown as typeof globalThis.fetch,
      readRpc: async () => [rpcEvent(1), rpcEvent(2)],
    });
    const feed = await reader.events("receipts", 10);
    expect(feed.source).toBe("rpc");
    expect(feed.events).toHaveLength(2);
    expect(feed.indexerError).toMatch(/Job/);
  });

  it("reads heartbeats from RPC even with an indexer (it only keeps aggregates)", async () => {
    const fetch = indexerFetch({ data: {} });
    const readRpc = vi.fn(async () => [] as LedgerEvent[]);
    const reader = createLedgerReader({
      network: "eip155:10143",
      ledgerAddress: LEDGER,
      fromBlock: null,
      indexerUrl: "http://indexer.test/v1/graphql",
      fetch: fetch as unknown as typeof globalThis.fetch,
      readRpc,
    });
    expect((await reader.events("heartbeats", 5)).source).toBe("rpc");
    expect(fetch).not.toHaveBeenCalled();
    expect(readRpc).toHaveBeenCalledWith("heartbeats", 5);
  });

  it("caches a feed briefly, and does not cache a failure", async () => {
    let fail = true;
    const readRpc = vi.fn(async () => {
      if (fail) throw new Error("rpc down");
      return [rpcEvent(1)];
    });
    const reader = createLedgerReader({
      network: "eip155:10143",
      ledgerAddress: LEDGER,
      fromBlock: null,
      indexerUrl: null,
      readRpc,
    });
    await expect(reader.events("receipts", 5)).rejects.toThrow(/rpc down/);
    fail = false;
    await reader.events("receipts", 5);
    await reader.events("receipts", 5);
    expect(readRpc).toHaveBeenCalledTimes(2);
  });

  it("returns an empty feed with no ledger and no indexer, and no leaderboard", async () => {
    const reader = createLedgerReader({ network: "eip155:10143", ledgerAddress: null, fromBlock: null, indexerUrl: null });
    expect(await reader.events("receipts", 5)).toEqual({ source: "none", events: [] });
    expect(await reader.leaderboard(5)).toBeNull();
  });
});
