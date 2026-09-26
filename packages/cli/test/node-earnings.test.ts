/**
 * What a provider node writes to its earnings ledger.
 *
 * Found by the e2e harness: every row was the quoted price with no settlement
 * transaction, so a provider could not tie an earning to the payment on-chain,
 * and a node that finished a job reassigned to it — paid upfront to the
 * provider that failed it — credited itself money that never reached it. The
 * broker now tells the node which settlement paid for the job, and whom.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { DispatchedJob } from "@xorv/protocol";
import type { NodeConfig } from "../src/config.js";

const PAYOUT = "0x1111111111111111111111111111111111111111";
const SOMEONE_ELSE = "0x2222222222222222222222222222222222222222";
const SETTLEMENT = `0x${"ab".repeat(32)}`;

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-earnings-"));
  // config.ts reads XORV_HOME at import time: the ledger must land in this scratch home.
  process.env.XORV_HOME = home;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.XORV_HOME;
});

describe("receivedFor", () => {
  it("is the settled amount, with its transaction, when the settlement paid this node", async () => {
    const { receivedFor } = await import("../src/node.js");
    // The payout address in any case, as the broker may checksum it.
    const paid = receivedFor(
      { priceUsdMicros: 40_000, payment: { txHash: SETTLEMENT, amount: "40000", payTo: PAYOUT.toUpperCase().replace("0X", "0x") } },
      PAYOUT,
    );
    expect(paid).toEqual({ usdMicros: 40_000, transactionId: SETTLEMENT, paidTo: expect.any(String) });
  });

  it("is nothing when the settlement paid another provider (a reassigned job)", async () => {
    const { receivedFor } = await import("../src/node.js");
    expect(receivedFor({ priceUsdMicros: 40_000, payment: { txHash: SETTLEMENT, amount: "40000", payTo: SOMEONE_ELSE } }, PAYOUT)).toEqual({
      usdMicros: 0,
      transactionId: null,
      paidTo: SOMEONE_ELSE,
    });
  });

  it("falls back to the quoted price when the broker does not say", async () => {
    const { receivedFor } = await import("../src/node.js");
    expect(receivedFor({ priceUsdMicros: 1_000 }, PAYOUT)).toEqual({ usdMicros: 1_000, transactionId: null, paidTo: null });
  });
});

function config(): NodeConfig {
  return {
    nodeId: "earnings-test-node",
    label: "earnings-test",
    network: "eip155:10143",
    brokerUrl: "http://127.0.0.1:9",
    address: PAYOUT,
    privateKey: "",
    agentId: null,
    capabilities: [
      { id: "echo", adapter: "echo", displayName: "Echo (test)", model: null, priceUsdMicros: 1_000, maxConcurrency: 1 },
    ],
    tunnel: { enabled: false },
    sandboxDir: path.join(home, "jobs"),
  };
}

/** Dispatch one job to a live node, wait for its result, and return the ledger row and the node's log. */
async function runJob(job: Partial<DispatchedJob>) {
  const { ProviderNode } = await import("../src/node.js");
  const { readEarnings } = await import("../src/config.js");
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;

  const finished = new Promise<void>((resolve) => {
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const type = (JSON.parse(String(raw)) as { type: string }).type;
        if (type === "job.result" || type === "job.error") resolve();
      });
      const payload: DispatchedJob = {
        jobId: "job_earning_1",
        capabilityId: "echo",
        prompt: "say hello",
        timeoutMs: 20_000,
        priceUsdMicros: 1_000,
        ...job,
      };
      socket.send(JSON.stringify({ type: "job.dispatch", job: payload }));
    });
  });

  const node = new ProviderNode(config());
  const log: string[] = [];
  node.on("log", ({ text }) => log.push(text));
  node.start(`ws://127.0.0.1:${port}`);
  try {
    await finished;
    // The row is appended right after the result is sent; give it a moment to land.
    for (let i = 0; i < 50 && readEarnings(10).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    return { rows: readEarnings(10), log, stats: { ...node.stats } };
  } finally {
    node.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

describe("the earnings ledger", () => {
  it("records the settled amount and the settlement transaction", async () => {
    const { rows, stats } = await runJob({ payment: { txHash: SETTLEMENT, amount: "1000", payTo: PAYOUT } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId: "job_earning_1", ok: true, amount: "1000", usdMicros: 1_000, transactionId: SETTLEMENT });
    expect(stats.earnedUsdMicros).toBe(1_000);
  });

  it("credits nothing for a job it finished after the buyer paid someone else", async () => {
    const { rows, log, stats } = await runJob({ payment: { txHash: SETTLEMENT, amount: "1000", payTo: SOMEONE_ELSE } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId: "job_earning_1", ok: true, amount: "0", usdMicros: 0 });
    expect(rows[0]!.transactionId).toBeUndefined();
    expect(stats.earnedUsdMicros).toBe(0);
    expect(log.some((line) => /done in .* — unpaid: reassigned here after the buyer paid 0x2222/.test(line))).toBe(true);
  });
});
