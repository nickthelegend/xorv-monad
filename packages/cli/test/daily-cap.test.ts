/**
 * The daily spend guard on a node selling a metered model. Testnet USDC is
 * free, so without it strangers could spend the operator's real model credit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { CAPACITY_REACHED, DailyCap, capLimitsFromEnv } from "../src/daily-cap.js";
import { ProviderNode } from "../src/node.js";
import type { NodeConfig } from "../src/config.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-cap-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const DAY1 = Date.parse("2026-10-13T10:00:00Z");
const DAY2 = Date.parse("2026-10-14T00:00:01Z");

describe("DailyCap", () => {
  it("counts jobs up to the cap, and the count survives a restart", () => {
    const cap = new DailyCap(home, { jobs: 2, tokens: null, off: false }, () => DAY1);
    expect(cap.claimJob()).toBe(true);
    expect(cap.claimJob()).toBe(true);
    expect(cap.claimJob()).toBe(false);
    const restarted = new DailyCap(home, { jobs: 2, tokens: null, off: false }, () => DAY1);
    expect(restarted.hasRoom()).toBe(false);
    expect(restarted.describe()).toBe("daily cap 2/2 jobs (UTC 2026-10-13)");
  });

  it("stops at the token cap and resets at 00:00 UTC", () => {
    let now = DAY1;
    const cap = new DailyCap(home, { jobs: null, tokens: 5_000, off: false }, () => now);
    expect(cap.claimJob()).toBe(true);
    cap.addTokens(5_000);
    expect(cap.hasRoom()).toBe(false);
    now = DAY2;
    expect(cap.usage()).toEqual({ day: "2026-10-14", jobs: 0, tokens: 0 });
    expect(cap.claimJob()).toBe(true);
  });

  it("is lifted by XORV_DAILY_CAP_OFF and absent when unset", () => {
    const lifted = new DailyCap(home, capLimitsFromEnv({ XORV_DAILY_JOB_CAP: "1", XORV_DAILY_CAP_OFF: "1" }), () => DAY1);
    expect([lifted.claimJob(), lifted.claimJob()]).toEqual([true, true]);
    expect(capLimitsFromEnv({})).toEqual({ jobs: null, tokens: null, off: false });
    expect(capLimitsFromEnv({ XORV_DAILY_JOB_CAP: "40", XORV_DAILY_TOKEN_CAP: "abc" })).toEqual({ jobs: 40, tokens: null, off: false });
  });
});

describe("a node out of today's budget", () => {
  it("refuses a dispatched job with an honest error, so the broker refunds it", async () => {
    const cap = new DailyCap(home, { jobs: 1, tokens: null, off: false }, () => DAY1);
    cap.claimJob();
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const port = (wss.address() as AddressInfo).port;
    const reply = new Promise<{ type: string; error?: string }>((resolve) => {
      wss.on("connection", (socket) => {
        socket.on("message", (raw) => {
          const m = JSON.parse(String(raw)) as { type: string; error?: string };
          if (m.type === "job.result" || m.type === "job.error" || m.type === "job.accepted") resolve(m);
        });
        socket.send(JSON.stringify({ type: "job.dispatch", job: { jobId: "job_capped", capabilityId: "echo", prompt: "hi", timeoutMs: 5_000, priceUsdMicros: 1_000 } }));
      });
    });
    const config: NodeConfig = {
      nodeId: "cap-test", label: "cap-test", network: "eip155:10143", brokerUrl: "http://127.0.0.1:9",
      address: "0x1111111111111111111111111111111111111111", privateKey: "", agentId: null,
      capabilities: [{ id: "echo", adapter: "echo", displayName: "Echo (test)", model: null, priceUsdMicros: 1_000, maxConcurrency: 1 }],
      tunnel: { enabled: false }, sandboxDir: path.join(home, "jobs"),
    };
    const node = new ProviderNode(config, cap);
    node.start(`ws://127.0.0.1:${port}`);
    try {
      expect(await reply).toEqual({ type: "job.error", jobId: "job_capped", error: CAPACITY_REACHED, durationMs: 0 });
    } finally {
      node.stop();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });
});
