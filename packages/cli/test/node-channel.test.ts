/**
 * The control channel across a re-registration, over real WebSockets.
 *
 * This pins a bug seen live: after the broker restarted, the node re-registered
 * and opened a new channel, then the old socket's late `close` marked the node
 * disconnected and kept reconnecting with the dead token. The broker showed the
 * node online; the node's own status page said "reconnecting" indefinitely.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { ProviderNode } from "../src/node.js";
import type { NodeConfig } from "../src/config.js";

interface TestServer {
  url: string;
  connections: () => number;
  dropAll: () => void;
  close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  let connections = 0;
  const sockets = new Set<ServerSocket>();
  wss.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    connections: () => connections,
    dropAll: () => {
      for (const s of sockets) s.close();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.terminate();
        wss.close(() => resolve());
      }),
  };
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const config: NodeConfig = {
  nodeId: "channel-test-node",
  label: "channel-test",
  network: "eip155:10143",
  brokerUrl: "http://127.0.0.1:1",
  address: "0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B",
  privateKey: "",
  capabilities: [
    { id: "echo", adapter: "echo", displayName: "Echo", model: null, priceUsdMicros: 1_000, maxConcurrency: 1 },
  ],
  region: null,
  tunnel: { enabled: false, hostname: null },
  sandboxDir: "/tmp/xorv-channel-test",
  providerId: null,
  token: null,
};

describe("control channel", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!();
  });

  it("stays connected after switching channels, and never reconnects to the old URL", async () => {
    const oldBroker = await startServer();
    const newBroker = await startServer();
    cleanup.push(oldBroker.close, newBroker.close);

    const node = new ProviderNode(config);
    cleanup.push(() => node.stop());
    node.start(oldBroker.url);
    await until(() => node.stats.connected && oldBroker.connections() === 1);

    node.switchControlChannel(newBroker.url);
    await until(() => newBroker.connections() === 1 && node.stats.connected);

    // Give the old socket's close event every chance to land and misbehave.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(node.stats.connected).toBe(true);
    expect(oldBroker.connections()).toBe(1);
  });

  it("still recovers from a genuine drop on the current channel", async () => {
    const broker = await startServer();
    cleanup.push(broker.close);

    const node = new ProviderNode(config);
    cleanup.push(() => node.stop());
    node.start(broker.url);
    await until(() => node.stats.connected);

    broker.dropAll();
    await until(() => !node.stats.connected);
    await until(() => broker.connections() === 2 && node.stats.connected, 8_000);
    expect(node.stats.reconnects).toBeGreaterThanOrEqual(1);
  });
});
