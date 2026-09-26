/**
 * Private jobs on the provider node.
 *
 * A real `ProviderNode` running the real echo adapter, dialled by a local
 * WebSocket server standing in for the broker's control channel. What these
 * tests pin is what crosses that wire for a private job: the result arrives as
 * an envelope only the buyer's inbox key opens, and nothing streamed on the way
 * carries the prompt or the answer.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  deriveInboxKeys,
  isSealedResult,
  openResult,
  type DispatchedJob,
  type JobEvent,
} from "@xorv/protocol";
import type { NodeConfig } from "../src/config.js";

/** Wire messages as the node sends them; asserted on, not typed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = any;

const SECRET_WORD = "tangerine-7731";
const PROMPT = `Summarise my private notes about ${SECRET_WORD}`;
const INBOX = deriveInboxKeys(Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 9) & 0xff));

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-private-"));
  // config.ts and manage.ts read XORV_HOME at import time; the earnings ledger
  // and the pause flag must land in this scratch home, not the real one.
  process.env.XORV_HOME = home;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.XORV_HOME;
});

function config(): NodeConfig {
  return {
    nodeId: "private-test-node",
    label: "private-test",
    network: "eip155:10143",
    brokerUrl: "http://127.0.0.1:9",
    address: "0x1111111111111111111111111111111111111111",
    privateKey: "",
    agentId: null,
    capabilities: [
      { id: "echo", adapter: "echo", displayName: "Echo (test)", model: null, priceUsdMicros: 1_000, maxConcurrency: 1 },
    ],
    tunnel: { enabled: false },
    sandboxDir: path.join(home, "jobs"),
  };
}

/** Dispatch one job to a live node and collect everything it sends back until the job ends. */
async function dispatch(job: Partial<DispatchedJob>) {
  const { ProviderNode } = await import("../src/node.js");
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;

  const wire: Msg[] = [];
  const finished = new Promise<Msg>((resolve) => {
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as Msg;
        wire.push(message);
        if (message.type === "job.result" || message.type === "job.error") resolve(message);
      });
      const payload: DispatchedJob = {
        jobId: "job_private_1",
        capabilityId: "echo",
        prompt: PROMPT,
        timeoutMs: 20_000,
        priceUsdMicros: 1_000,
        ...job,
      };
      socket.send(JSON.stringify({ type: "job.dispatch", job: payload }));
    });
  });

  const node = new ProviderNode(config());
  const local: JobEvent[] = [];
  node.on("jobEvent", ({ event }) => local.push(event));
  node.start(`ws://127.0.0.1:${port}`);
  try {
    const final = await finished;
    return { final, wire, local, events: wire.filter((m) => m.type === "job.event").map((m) => m.event as JobEvent) };
  } finally {
    node.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

describe("a private dispatch", () => {
  it("reports an envelope that only the buyer's inbox key opens", async () => {
    const { final } = await dispatch({ encryptTo: INBOX.encryptTo });
    expect(final.type).toBe("job.result");
    expect(isSealedResult(final.result)).toBe(true);
    expect(final.result).not.toContain(SECRET_WORD);

    const plaintext = openResult(INBOX.secretKey, final.result, "job_private_1");
    expect(plaintext).toContain("Echo from a Xorv provider node");
    expect(plaintext).toContain(SECRET_WORD);

    const stranger = deriveInboxKeys(new Uint8Array(32).fill(3));
    expect(() => openResult(stranger.secretKey, final.result, "job_private_1")).toThrow(/not sealed to this key/);
  });

  it("streams only coarse status to the broker — no text, no reasoning, nothing from the prompt", async () => {
    const { events, local, wire } = await dispatch({ encryptTo: INBOX.encryptTo });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.kind).toBe("status");
      expect(event.text).not.toContain(SECRET_WORD);
      expect(event.text).not.toMatch(/Echo from|You asked|reading the prompt/);
    }
    expect(events.at(-1)?.text).toMatch(/sealed/);
    // Nothing on the wire at all — events, result, anything — carries the prompt.
    expect(JSON.stringify(wire)).not.toContain(SECRET_WORD);
    // The operator's own view is unchanged: they ran the job and see it.
    expect(local.some((event) => event.kind === "message" && event.text.includes(SECRET_WORD))).toBe(true);
  });

  it("refuses to run a private job whose key it cannot seal to", async () => {
    const { final, local, wire } = await dispatch({ encryptTo: "not-a-key" });
    expect(final.type).toBe("job.error");
    expect(final.error).toMatch(/invalid encryptTo/);
    expect(local).toHaveLength(0);
    expect(wire.some((m) => m.type === "job.accepted")).toBe(false);
  });
});

describe("a public dispatch", () => {
  it("is unchanged: plaintext result and the full event stream", async () => {
    const { final, events } = await dispatch({});
    expect(final.type).toBe("job.result");
    expect(isSealedResult(final.result)).toBe(false);
    expect(final.result).toContain(SECRET_WORD);
    expect(events.some((event) => event.kind === "message")).toBe(true);
  });
});

describe("privateFailure", () => {
  it("says what kind of failure it was and nothing the adapter said", async () => {
    const { privateFailure } = await import("../src/node.js");
    const aborted = new AbortController();
    aborted.abort();
    expect(privateFailure(aborted.signal)).toMatch(/cancelled or timed out/);
    expect(privateFailure(new AbortController().signal)).toMatch(/failed on the provider/);
  });
});
