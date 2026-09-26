/**
 * The MCP server, driven over stdio exactly the way a client drives it.
 *
 * Spawning the real process rather than importing the module is the point: the
 * failure modes that matter here are protocol-level — a stray `console.log`
 * corrupting the JSON-RPC channel, a tool schema that doesn't serialise, a
 * server that never completes its handshake. None of those show up if you call
 * the handlers directly.
 *
 * No broker is needed: the read tools are expected to fail cleanly when there
 * isn't one, which is itself worth asserting.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "../src/index.ts");

interface Rpc {
  id?: number;
  result?: {
    tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { message: string };
}

class Client {
  private child: ChildProcess;
  private buffer = "";
  private replies: Rpc[] = [];
  /** Anything the server printed to stdout that wasn't JSON-RPC. */
  readonly garbage: string[] = [];

  constructor(env: Record<string, string> = {}) {
    this.child = spawn("npx", ["tsx", entry], {
      env: {
        ...process.env,
        // Point at a port nothing is listening on, so "broker unreachable" is
        // deterministic rather than depending on a dev server being up.
        XORV_BROKER_URL: "http://127.0.0.1:59999",
        XORV_NETWORK: "hedera:testnet",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.replies.push(JSON.parse(line) as Rpc);
        } catch {
          this.garbage.push(line);
        }
      }
    });
  }

  send(message: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  async waitFor(id: number, timeoutMs = 25_000): Promise<Rpc> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.replies.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no reply to request ${id} within ${timeoutMs}ms`);
  }

  async handshake(): Promise<void> {
    this.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest", version: "1" },
      },
    });
    await this.waitFor(1);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async call(id: number, name: string, args: Record<string, unknown> = {}): Promise<Rpc> {
    this.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    return this.waitFor(id);
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }
}

let client: Client | null = null;
afterEach(() => {
  client?.kill();
  client = null;
});

describe("handshake", () => {
  it("completes an MCP initialize", async () => {
    client = new Client();
    await client.handshake();
    // Getting here without throwing is the assertion.
    expect(true).toBe(true);
  }, 40_000);

  it("keeps stdout clean — anything but JSON-RPC corrupts the channel", async () => {
    client = new Client();
    await client.handshake();
    await client.call(2, "xorv_network_status");
    expect(client.garbage).toEqual([]);
  }, 40_000);
});

describe("tools", () => {
  it("advertises the five Xorv tools with descriptions and schemas", async () => {
    client = new Client();
    await client.handshake();
    client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const reply = await client.waitFor(2);

    const tools = reply.result?.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual([
      "xorv_get_job",
      "xorv_list_providers",
      "xorv_network_status",
      "xorv_quote",
      "xorv_run_job",
    ]);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(20);
      expect(tool.inputSchema).toBeTruthy();
    }
  }, 40_000);

  it("warns in the run_job description that it spends real money", async () => {
    client = new Client();
    await client.handshake();
    client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const reply = await client.waitFor(2);
    const runJob = reply.result?.tools?.find((t) => t.name === "xorv_run_job");
    // A model deciding whether to call this needs to know from the description
    // alone that it costs money.
    expect(runJob?.description).toMatch(/pay|spend/i);
    expect(runJob?.description).toMatch(/\$/);
  }, 40_000);
});

describe("behaviour without a broker", () => {
  it("reports the broker being unreachable as a tool error, not a crash", async () => {
    client = new Client();
    await client.handshake();
    const reply = await client.call(2, "xorv_list_providers");
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toMatch(/could not reach/i);
  }, 40_000);

  it("still answers a second call after one fails", async () => {
    client = new Client();
    await client.handshake();
    await client.call(2, "xorv_list_providers");
    const second = await client.call(3, "xorv_network_status");
    expect(second.result?.content?.[0]?.text).toBeTruthy();
  }, 40_000);
});

describe("spending guards", () => {
  it("refuses to buy when no payer key is configured", async () => {
    client = new Client({ XORV_PAYER_ID: "", XORV_PAYER_KEY: "" });
    await client.handshake();
    const reply = await client.call(2, "xorv_run_job", { prompt: "hello" });
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toMatch(/no payer configured/i);
  }, 40_000);

  it("advertises the configured ceiling in the tool description", async () => {
    client = new Client({ XORV_MAX_USD: "0.02" });
    await client.handshake();
    client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const reply = await client.waitFor(2);
    const runJob = reply.result?.tools?.find((t) => t.name === "xorv_run_job");
    expect(runJob?.description).toContain("$0.0200");
  }, 40_000);
});
