/**
 * How a node registers now that the node id alone no longer re-registers a
 * live session.
 *
 * The broker used to hand a node id's existing bearer token (and its payout
 * slot) to anyone who posted that id. It now wants the session's token for a
 * live record, so the node presents the one it holds — this process's, or the
 * one the last `xorv start` saved — and a node restarted without it waits out
 * the old session once instead of failing to start.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeConfig } from "../src/config.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-register-"));
  process.env.XORV_HOME = home;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.XORV_HOME;
});

function config(brokerUrl: string, token: string | null = null): NodeConfig {
  return {
    nodeId: "register-test-node",
    label: "register-test",
    network: "eip155:10143",
    brokerUrl,
    address: "0x1111111111111111111111111111111111111111",
    privateKey: "",
    agentId: null,
    capabilities: [
      { id: "echo", adapter: "echo", displayName: "Echo (test)", model: null, priceUsdMicros: 1_000, maxConcurrency: 1 },
    ],
    tunnel: { enabled: false },
    sandboxDir: path.join(home, "jobs"),
    token,
  };
}

/** A broker stand-in that answers each registration with the next canned reply. */
async function fakeBroker(replies: Array<{ status: number; body: unknown }>) {
  const seen: Array<{ authorization: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ authorization: req.headers.authorization });
      const reply = replies.shift() ?? { status: 500, body: { error: "no more replies" } };
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const OK = {
  status: 200,
  body: { provider: { id: "prv_x", agentId: null }, token: "fresh-token", wsUrl: "ws://x/ws/provider?token=fresh-token" },
};

describe("ProviderNode.register", () => {
  it("presents the saved session token, and reports the new one for saving", async () => {
    const broker = await fakeBroker([OK]);
    try {
      const { ProviderNode } = await import("../src/node.js");
      const node = new ProviderNode(config(broker.url, "saved-token"));
      const registered: string[] = [];
      node.on("registered", ({ token }) => registered.push(token));
      const result = await node.register("local");
      expect(broker.seen[0]!.authorization).toBe("Bearer saved-token");
      expect(result.token).toBe("fresh-token");
      expect(registered).toEqual(["fresh-token"]);
    } finally {
      await broker.close();
    }
  });

  it("sends no Authorization header when it holds no token", async () => {
    const broker = await fakeBroker([OK]);
    try {
      const { ProviderNode } = await import("../src/node.js");
      await new ProviderNode(config(broker.url)).register("local");
      expect(broker.seen[0]!.authorization).toBeUndefined();
    } finally {
      await broker.close();
    }
  });

  it("waits out a live session under its own node id once, then registers", async () => {
    const broker = await fakeBroker([
      { status: 409, body: { error: "live", code: "node_live", retryAfterMs: 1_000 } },
      OK,
    ]);
    try {
      const { ProviderNode } = await import("../src/node.js");
      const node = new ProviderNode(config(broker.url));
      const log: string[] = [];
      node.on("log", ({ text }) => log.push(text));
      const result = await node.register("local");
      expect(result.providerId).toBe("prv_x");
      expect(broker.seen).toHaveLength(2);
      expect(log.some((line) => /live session for this node id/.test(line))).toBe(true);
    } finally {
      await broker.close();
    }
  });

  it("gives up after one wait when the other session stays live", async () => {
    const live = { status: 409, body: { error: "still live", code: "node_live", retryAfterMs: 1_000 } };
    const broker = await fakeBroker([live, live]);
    try {
      const { ProviderNode } = await import("../src/node.js");
      await expect(new ProviderNode(config(broker.url)).register("local")).rejects.toThrow(/registration failed \(409\)/);
      expect(broker.seen).toHaveLength(2);
    } finally {
      await broker.close();
    }
  });
});
