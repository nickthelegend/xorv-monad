/**
 * The MCP server, driven over stdio exactly the way a client drives it.
 *
 * Spawning the real process rather than importing the module is the point: the
 * failure modes that matter here are protocol-level — a stray `console.log`
 * corrupting the JSON-RPC channel, a tool schema that doesn't serialise, a
 * server that never completes its handshake. None of those show up if you call
 * the handlers directly.
 *
 * Most tests need no broker: the read tools are expected to fail cleanly when
 * there isn't one, which is itself worth asserting. The paying tests run a
 * local mock broker (test/helpers/mock-broker.ts) that verifies the x402
 * payment and rating signatures, so the whole path — env parsing, signer,
 * quote policy, EIP-3009 signing, polling, output — is exercised in the real
 * process with no chain and no network.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUYER_ADDRESS, BUYER_KEY } from "./helpers/fixtures.js";
import { RATE_TX, RECEIPT_TX, SETTLE_TX, startMockBroker, type MockBroker } from "./helpers/mock-broker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "../src/index.ts");

/**
 * tsx's CLI, run by this very node binary.
 *
 * `spawn("npx", …)` works on POSIX but fails on Windows with ENOENT: npx is a
 * `.cmd` shim there, and `spawn` without a shell only runs real executables.
 * Launching `process.execPath` on tsx's resolved entry sidesteps shims and
 * shells on every platform — and skips npx's own startup cost per test.
 */
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

/** The parent's environment minus anything that would pick a payer or a broker. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("XORV_") || key.startsWith("PRIVY_")) continue;
    env[key] = value;
  }
  return env;
}

interface Rpc {
  id?: number;
  result?: {
    tools?: Array<{ name: string; description?: string; inputSchema?: unknown; annotations?: Record<string, unknown> }>;
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
  stderr = "";

  constructor(env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [tsxCli, entry], {
      env: {
        ...cleanEnv(),
        // Point at a port nothing is listening on, so "broker unreachable" is
        // deterministic rather than depending on a dev server being up.
        XORV_BROKER_URL: "http://127.0.0.1:59999",
        XORV_NETWORK: "eip155:10143",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
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
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
  }

  send(message: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  // 45s rather than 25s: the first reply includes tsx compiling the server from
  // cold, which under a loaded machine (the whole workspace testing in
  // parallel, or a slow CI runner) was measured to exceed 25s. Still inside the
  // 60s testTimeout, so a genuinely hung server fails with this message.
  async waitFor(id: number, timeoutMs = 45_000): Promise<Rpc> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.replies.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no reply to request ${id} within ${timeoutMs}ms; stderr:\n${this.stderr}`);
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

  async tools(id = 2): Promise<NonNullable<NonNullable<Rpc["result"]>["tools"]>> {
    this.send({ jsonrpc: "2.0", id, method: "tools/list" });
    return (await this.waitFor(id)).result?.tools ?? [];
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }
}

function textOf(reply: Rpc): string {
  return reply.result?.content?.[0]?.text ?? "";
}

let client: Client | null = null;
let broker: MockBroker | null = null;
afterEach(async () => {
  client?.kill();
  client = null;
  await broker?.close();
  broker = null;
});

describe("handshake", () => {
  it("completes an MCP initialize", async () => {
    client = new Client();
    await client.handshake();
    // Getting here without throwing is the assertion.
    expect(true).toBe(true);
  }, 40_000);

  it("keeps stdout clean — anything but JSON-RPC corrupts the channel", async () => {
    client = new Client({ XORV_PRIVATE_KEY: BUYER_KEY });
    await client.handshake();
    await client.call(2, "xorv_network_status");
    expect(client.garbage).toEqual([]);
    // The startup log goes to stderr, and never contains the key.
    expect(client.stderr).toContain("[xorv-mcp] ready");
    expect(client.stderr).not.toContain(BUYER_KEY.slice(2, 20));
  }, 40_000);
});

describe("tools", () => {
  it("advertises the Xorv tools with descriptions and schemas", async () => {
    client = new Client();
    await client.handshake();
    const tools = await client.tools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "xorv_get_job",
      "xorv_list_providers",
      "xorv_network_status",
      "xorv_quote",
      "xorv_rate_job",
      "xorv_run_job",
      "xorv_wallet",
    ]);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(20);
      expect(tool.inputSchema).toBeTruthy();
    }
    // Hints a client can use to decide what needs confirmation.
    expect(tools.find((t) => t.name === "xorv_run_job")?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(tools.find((t) => t.name === "xorv_quote")?.annotations).toMatchObject({ readOnlyHint: true });
  }, 40_000);

  it("warns in the run_job description that it spends real money", async () => {
    client = new Client();
    await client.handshake();
    const runJob = (await client.tools()).find((t) => t.name === "xorv_run_job");
    // A model deciding whether to call this needs to know from the description
    // alone that it costs money.
    expect(runJob?.description).toMatch(/pay|spend/i);
    expect(runJob?.description).toMatch(/\$/);
    expect(runJob?.description).toMatch(/USDC transfer on Monad/);
    // No HBAR option any more.
    expect(JSON.stringify(runJob?.inputSchema)).not.toMatch(/pay_with|hbar/i);
  }, 40_000);
});

describe("behaviour without a broker", () => {
  it("reports the broker being unreachable as a tool error, not a crash", async () => {
    client = new Client();
    await client.handshake();
    const reply = await client.call(2, "xorv_list_providers");
    expect(reply.result?.isError).toBe(true);
    expect(textOf(reply)).toMatch(/could not reach/i);
  }, 40_000);

  it("still answers a second call after one fails", async () => {
    client = new Client();
    await client.handshake();
    await client.call(2, "xorv_list_providers");
    const second = await client.call(3, "xorv_network_status");
    expect(textOf(second)).toBeTruthy();
  }, 40_000);
});

describe("configuration", () => {
  it("boots with a leftover Hedera network and says how to fix it on every call", async () => {
    client = new Client({ XORV_NETWORK: "hedera:testnet" });
    await client.handshake();
    const reply = await client.call(2, "xorv_list_providers");
    expect(reply.result?.isError).toBe(true);
    expect(textOf(reply)).toMatch(/misconfigured/);
    expect(textOf(reply)).toMatch(/eip155:10143/);
  }, 40_000);
});

describe("spending guards", () => {
  it("refuses to buy when no payer is configured", async () => {
    client = new Client({ XORV_PRIVATE_KEY: "", XORV_PAYER_KEY: "" });
    await client.handshake();
    const reply = await client.call(2, "xorv_run_job", { prompt: "hello" });
    expect(reply.result?.isError).toBe(true);
    expect(textOf(reply)).toMatch(/no payer configured/i);
  }, 40_000);

  it("refuses to rate, or show a wallet, without a payer", async () => {
    client = new Client();
    await client.handshake();
    const rate = await client.call(2, "xorv_rate_job", { job_id: "job_x", value: 80 });
    expect(rate.result?.isError).toBe(true);
    expect(textOf(rate)).toMatch(/no payer configured/i);
    const wallet = await client.call(3, "xorv_wallet");
    expect(wallet.result?.isError).toBe(true);
  }, 40_000);

  it("reports a Hedera key as unusable instead of paying with something surprising", async () => {
    client = new Client({ XORV_PRIVATE_KEY: `302e020100300506032b657004220420${"aa".repeat(32)}` });
    await client.handshake();
    const reply = await client.call(2, "xorv_run_job", { prompt: "hello" });
    expect(reply.result?.isError).toBe(true);
    expect(textOf(reply)).toMatch(/unusable.*ED25519/s);
  }, 40_000);

  it("advertises the configured ceiling and session budget in the tool description", async () => {
    client = new Client({ XORV_MAX_PRICE: "0.02", XORV_SESSION_BUDGET_USD: "0.10" });
    await client.handshake();
    const runJob = (await client.tools()).find((t) => t.name === "xorv_run_job");
    expect(runJob?.description).toContain("$0.0200");
    expect(runJob?.description).toContain("$0.1000 across this session");
  }, 40_000);

  it("still honours 0.1's XORV_MAX_USD", async () => {
    client = new Client({ XORV_MAX_USD: "0.03" });
    await client.handshake();
    const runJob = (await client.tools()).find((t) => t.name === "xorv_run_job");
    expect(runJob?.description).toContain("$0.0300");
  }, 40_000);
});

describe("buying and rating against a mock broker", () => {
  it("pays over x402, returns the result with explorer links, then rates the job", async () => {
    broker = await startMockBroker();
    client = new Client({ XORV_BROKER_URL: broker.url, XORV_PRIVATE_KEY: BUYER_KEY });
    await client.handshake();

    const run = await client.call(2, "xorv_run_job", { prompt: "what is 2+2?" });
    const out = textOf(run);
    expect(run.result?.isError, out).toBeFalsy();
    expect(out.startsWith("4")).toBe(true);
    expect(out).toContain(`https://testnet.monadvision.com/tx/${SETTLE_TX}`);
    expect(out).toContain(`https://testnet.monadvision.com/tx/${RECEIPT_TX}`);
    expect(out).toContain(BUYER_ADDRESS);
    expect(out).toMatch(/xorv_rate_job/);
    expect(out).toMatch(/\$0\.0100 of \$0\.5000 session budget spent/);
    expect(broker.payments).toEqual([expect.objectContaining({ from: BUYER_ADDRESS, value: "10000", valid: true })]);

    const rate = await client.call(3, "xorv_rate_job", { job_id: "job_test1", value: 90 });
    expect(rate.result?.isError, textOf(rate)).toBeFalsy();
    expect(textOf(rate)).toContain(`https://testnet.monadvision.com/tx/${RATE_TX}`);
    expect(broker.ratings).toEqual([expect.objectContaining({ value: 90, valid: true })]);

    const job = await client.call(4, "xorv_get_job", { job_id: "job_test1" });
    expect(textOf(job)).toContain(`Payment: https://testnet.monadvision.com/tx/${SETTLE_TX}`);
    expect(textOf(job)).toMatch(/Verified by kimi/);
    expect(client.garbage).toEqual([]);
  }, 60_000);

  it("refuses a quote over the ceiling without paying", async () => {
    broker = await startMockBroker({ priceUsdMicros: 40_000 });
    client = new Client({ XORV_BROKER_URL: broker.url, XORV_PRIVATE_KEY: BUYER_KEY, XORV_MAX_PRICE: "0.02" });
    await client.handshake();
    const run = await client.call(2, "xorv_run_job", { prompt: "expensive" });
    expect(run.result?.isError).toBe(true);
    expect(broker.quotes[0]).toMatchObject({ maxPriceUsdMicros: 20_000 });
    expect(broker.payments).toEqual([]);
  }, 40_000);

  it("shows network status, providers and quotes with Monad details", async () => {
    broker = await startMockBroker();
    client = new Client({ XORV_BROKER_URL: broker.url });
    await client.handshake();
    const status = textOf(await client.call(2, "xorv_network_status"));
    expect(status).toMatch(/Network: eip155:10143/);
    expect(status).toMatch(/XorvLedger: 0x/);
    expect(status).toMatch(/router qwen/);
    const providers = textOf(await client.call(3, "xorv_list_providers"));
    expect(providers).toMatch(/pays to 0x00000000000000000000000000000000000000A1/);
    expect(providers).toMatch(/ERC-8004 agent #7/);
    const quote = textOf(await client.call(4, "xorv_quote", { prompt: "hi" }));
    expect(quote).toMatch(/Payment goes directly to 0x/);
    expect(quote).toMatch(/USDC on Monad Testnet/);
    expect(broker.payments).toEqual([]);
  }, 40_000);
});
