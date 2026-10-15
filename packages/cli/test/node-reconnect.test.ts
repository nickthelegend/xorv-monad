/**
 * A node re-registering after a broker restart keeps exactly one control channel.
 *
 * Found on the hosted provider after a day of broker redeploys. Each restart made the node re-register
 * and open a socket with its new token. But the old socket's close handler still scheduled a reconnect
 * with the old URL, and so with the dead token. Every restart left one more loop retrying forever. The
 * broker kept the node "online" on its HTTP heartbeats, while its control channel never stayed up, so
 * no job matched it.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { NodeConfig } from "../src/config.js";
import { ProviderNode } from "../src/node.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-reconnect-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("re-registering after a broker restart", () => {
  it("drops the old socket for good and keeps one live channel on the new token", async () => {
    let current = "t1";
    let registrations = 0;
    const upgrades: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.url === "/api/providers/register") {
        registrations += 1;
        current = `t${registrations}`;
        const port = (server.address() as AddressInfo).port;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ provider: { id: "prv_r", agentId: null }, token: current, wsUrl: `ws://127.0.0.1:${port}/ws/provider?token=${current}` }));
        return;
      }
      // The broker "restarted": it no longer knows the first token.
      const auth = req.headers.authorization ?? "";
      res.writeHead(auth === `Bearer ${current}` && current !== "t1" ? 200 : 401);
      res.end("{}");
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const token = new URL(req.url ?? "/", "http://x").searchParams.get("token") ?? "";
      upgrades.push(token);
      if (token !== current) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, () => {});
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const config: NodeConfig = {
      nodeId: "reconnect-node", label: "reconnect", network: "eip155:10143", brokerUrl: base,
      address: "0x1111111111111111111111111111111111111111", privateKey: "", agentId: null,
      capabilities: [{ id: "echo", adapter: "echo", displayName: "Echo (test)", model: null, priceUsdMicros: 1_000, maxConcurrency: 1 }],
      tunnel: { enabled: false }, sandboxDir: path.join(home, "jobs"),
    };
    const node = new ProviderNode(config);
    try {
      const first = await node.register("local");
      node.start(first.wsUrl); // its first heartbeat gets a 401 and re-registers as t2
      await new Promise((r) => setTimeout(r, 3_500));
      const afterSwap = upgrades.slice(upgrades.indexOf("t2"));
      expect(registrations).toBe(2);
      expect(afterSwap.length).toBeGreaterThan(0);
      // Nothing dials the dead token once the new one exists, and the live channel holds.
      expect(afterSwap.filter((t) => t === "t1")).toEqual([]);
      expect(node.stats.connected).toBe(true);
    } finally {
      node.stop();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 10_000);
});
