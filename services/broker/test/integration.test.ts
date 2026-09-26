/**
 * End-to-end, in one process, with no network and no credentials.
 *
 * A real HTTP server, the real Hono app, the real x402 resource server and the
 * real WebSocket hub. Only two things are stubbed, and only because they are
 * the parts that touch Hedera: the facilitator (which would sign and submit a
 * transfer) and the chain writer (which would publish to HCS). Everything
 * between a buyer's first request and a published receipt is the production
 * code path.
 *
 * The client side uses the genuine `@x402/*` client with a stub *scheme*, so
 * the 402 negotiation, header encoding and retry are all exercised for real —
 * only the signature is fake.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import WebSocket from "ws";
import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";

import { createApp } from "../src/app.js";
import type { BrokerConfig } from "../src/config.js";
import type { ChainLike, PublishResult } from "../src/chain.js";
import { Hub } from "../src/hub.js";
import { JobStore } from "../src/jobs.js";
import { Registry } from "../src/registry.js";

// ---------------------------------------------------------------------------
// Stubs — only the two things that would touch Hedera
// ---------------------------------------------------------------------------

class StubChain implements ChainLike {
  readonly network = "hedera:testnet";
  readonly operatorId = "0.0.9842030";
  readonly settlementClient = null as never;
  readonly published: Array<{ kind: string; data: unknown }> = [];
  private tally = { registry: 0, heartbeat: 0, receipts: 0 };

  describeTopics() {
    return {
      registry: { id: "0.0.1", url: "https://hashscan.io/testnet/topic/0.0.1" },
      heartbeat: { id: "0.0.2", url: "https://hashscan.io/testnet/topic/0.0.2" },
      receipts: { id: "0.0.3", url: "https://hashscan.io/testnet/topic/0.0.3" },
    };
  }
  counts() {
    return { ...this.tally };
  }
  lastPublishError(): string | null {
    return null;
  }
  private record(kind: keyof StubChain["tally"], data: unknown): PublishResult {
    this.tally[kind] += 1;
    this.published.push({ kind, data });
    return {
      topicId: "0.0.3",
      transactionId: `0.0.9842030@${1700000000 + this.published.length}.000000001`,
      hashscanUrl: "https://hashscan.io/testnet/transaction/stub",
    };
  }
  async publishRegistration(provider: { id: string }) {
    return this.record("registry", provider);
  }
  async publishHeartbeat(data: unknown) {
    return this.record("heartbeat", data);
  }
  async publishReceipt(data: unknown) {
    return this.record("receipts", data);
  }
  close(): void {}
}

/** A facilitator that always approves — the crypto is not what's under test here. */
function stubFacilitator(settled: PaymentRequirements[]): FacilitatorClient {
  return {
    async verify(_payload: PaymentPayload, requirements: PaymentRequirements) {
      return { isValid: true, payer: "0.0.9848440", ...{ requirements } };
    },
    async settle(_payload: PaymentPayload, requirements: PaymentRequirements) {
      settled.push(requirements);
      return {
        success: true,
        transaction: `0.0.9842030@175000000${settled.length}.111111111`,
        network: requirements.network,
        payer: "0.0.9848440",
      };
    },
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet" }],
        extensions: [],
        signers: {},
      };
    },
  } as unknown as FacilitatorClient;
}

/**
 * A scheme client that produces a payload without signing anything.
 *
 * It must echo `x402Version` back — the client composes the final payload from
 * this result and refuses to encode a header without a version.
 */
class StubScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  seen: PaymentRequirements[] = [];
  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
    this.seen.push(requirements);
    return { x402Version, payload: { transaction: "c3R1Yi10cmFuc2FjdGlvbg==" } };
  }
}

function testConfig(): BrokerConfig {
  return {
    network: "hedera:testnet",
    operatorId: "0.0.9842030",
    operatorKey: PrivateKey.generateECDSA(),
    topics: { registry: "0.0.1", heartbeat: "0.0.2", receipts: "0.0.3" },
    port: 0,
    publicUrl: "http://localhost",
    corsOrigins: [],
    feeBps: 0,
    facilitatorMode: "self",
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  base: string;
  chain: StubChain;
  registry: Registry;
  jobs: JobStore;
  settled: PaymentRequirements[];
  scheme: StubScheme;
  paidFetch: typeof fetch;
  httpClient: x402HTTPClient;
  stop(): Promise<void>;
}

async function boot(): Promise<Harness> {
  const config = testConfig();
  const chain = new StubChain();
  const registry = new Registry();
  const jobs = new JobStore();
  const settled: PaymentRequirements[] = [];

  let hub: Hub | null = null;
  const { app, hubHandlers, sweep } = createApp({
    config,
    chain,
    registry,
    jobs,
    getHub: () => hub,
    facilitator: stubFacilitator(settled),
  });
  void sweep;

  const server = serve({ fetch: app.fetch, port: 0 }) as unknown as Server;
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  hub = new Hub(server, registry, hubHandlers);

  const scheme = new StubScheme();
  const client = new x402Client().register("hedera:*", scheme);
  const paidFetch = wrapFetchWithPayment(fetch, client) as typeof fetch;

  return {
    base: `http://127.0.0.1:${port}`,
    chain,
    registry,
    jobs,
    settled,
    scheme,
    paidFetch,
    httpClient: new x402HTTPClient(client),
    async stop() {
      hub?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A provider node: registers over HTTP, then holds a control socket like the CLI does. */
async function connectProvider(
  h: Harness,
  opts: { label?: string; accountId?: string; price?: number; nodeId?: string } = {},
) {
  const res = await fetch(`${h.base}/api/providers/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: opts.label ?? "test-node",
      accountId: opts.accountId ?? "0.0.9848438",
      endpoint: "http://localhost:1",
      capabilities: [
        {
          id: "echo",
          adapter: "echo",
          displayName: "Echo (test)",
          model: null,
          priceUsdMicros: opts.price ?? 1_000,
          maxConcurrency: 4,
        },
      ],
      version: "0.1.0",
      region: null,
      nodeId: opts.nodeId ?? `node-${opts.label ?? "test"}`,
    }),
  });
  const body = (await res.json()) as { provider: { id: string }; token: string; wsUrl: string };

  const ws = new WebSocket(`${h.base.replace("http", "ws")}/ws/provider?token=${body.token}`);
  const dispatched: Array<{ jobId: string; prompt: string }> = [];
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as { type: string; job?: { jobId: string; prompt: string } };
    if (msg.type === "job.dispatch" && msg.job) dispatched.push(msg.job);
  });

  return {
    providerId: body.provider.id,
    token: body.token,
    ws,
    dispatched,
    /** Play a whole job the way the real node does: accept, stream, answer. */
    async completeNextJob(result = "the answer") {
      const job = await waitFor(() => dispatched[0], 4_000);
      ws.send(JSON.stringify({ type: "job.accepted", jobId: job.jobId }));
      ws.send(
        JSON.stringify({
          type: "job.event",
          jobId: job.jobId,
          event: { at: Date.now(), kind: "message", text: "working on it" },
        }),
      );
      ws.send(
        JSON.stringify({ type: "job.result", jobId: job.jobId, result, durationMs: 120 }),
      );
      return job;
    },
    async failNextJob(error = "boom") {
      const job = await waitFor(() => dispatched[0], 4_000);
      ws.send(JSON.stringify({ type: "job.error", jobId: job.jobId, error, durationMs: 50 }));
      return job;
    },
    close() {
      ws.close();
    },
  };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for condition");
}

async function quote(h: Harness, prompt = "hello", max = 50_000) {
  const res = await fetch(`${h.base}/api/quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, maxPriceUsdMicros: max }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let h: Harness;
beforeEach(async () => {
  h = await boot();
});
afterEach(async () => {
  await h.stop();
});

describe("registration", () => {
  it("registers a node, hands back a token, and publishes to HCS", async () => {
    const provider = await connectProvider(h);
    expect(provider.providerId).toMatch(/^prv_/);
    expect(h.chain.counts().registry).toBe(1);

    const listed = await (await fetch(`${h.base}/api/providers`)).json();
    expect(listed.providers).toHaveLength(1);
    expect(listed.providers[0].connected).toBe(true);
    provider.close();
  });

  it("never leaks the bearer token on the public provider list", async () => {
    const provider = await connectProvider(h);
    const text = await (await fetch(`${h.base}/api/providers`)).text();
    expect(text).not.toContain(provider.token);
    provider.close();
  });

  it("rejects a malformed registration", async () => {
    const res = await fetch(`${h.base}/api/providers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "", accountId: "nope", capabilities: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a socket with a bad token", async () => {
    const ws = new WebSocket(`${h.base.replace("http", "ws")}/ws/provider?token=forged`);
    await expect(
      new Promise((resolve, reject) => {
        ws.once("open", () => resolve("opened"));
        ws.once("error", reject);
      }),
    ).rejects.toBeTruthy();
  });
});

describe("quoting", () => {
  it("503s with a helpful message when nobody is online", async () => {
    const { status, body } = await quote(h);
    expect(status).toBe(503);
    expect(String(body.error)).toMatch(/no providers are online/);
  });

  it("pins a provider and freezes the amounts", async () => {
    const provider = await connectProvider(h);
    const { status, body } = await quote(h);
    expect(status).toBe(200);
    expect(body.quoteId).toMatch(/^qte_/);
    expect(body.provider.accountId).toBe("0.0.9848438");
    expect(body.accepts.length).toBeGreaterThanOrEqual(1);
    provider.close();
  });

  it("rejects an empty prompt and a non-positive budget", async () => {
    const provider = await connectProvider(h);
    expect((await quote(h, "")).status).toBe(400);
    expect((await quote(h, "hi", 0)).status).toBe(400);
    provider.close();
  });

  it("refuses to match above the buyer's ceiling", async () => {
    const provider = await connectProvider(h, { price: 20_000 });
    const { status } = await quote(h, "hi", 5_000);
    expect(status).toBe(503);
    provider.close();
  });

  it("picks the cheaper of two live providers", async () => {
    const dear = await connectProvider(h, { label: "dear", nodeId: "n1", accountId: "0.0.1", price: 9_000 });
    const cheap = await connectProvider(h, { label: "cheap", nodeId: "n2", accountId: "0.0.2", price: 2_000 });
    const { body } = await quote(h);
    expect(body.provider.label).toBe("cheap");
    dear.close();
    cheap.close();
  });
});

describe("the paid path", () => {
  it("answers 402 before payment, naming the provider as payTo", async () => {
    const provider = await connectProvider(h);
    const { body } = await quote(h);

    const res = await fetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(402);

    const header = res.headers.get("payment-required")!;
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(decoded.accepts.length).toBeGreaterThanOrEqual(1);
    // The whole point: the broker is not the payee.
    for (const accept of decoded.accepts) expect(accept.payTo).toBe("0.0.9848438");
    provider.close();
  });

  it("runs the full lifecycle: pay → dispatch → stream → result → receipt", async () => {
    const provider = await connectProvider(h);
    const { body } = await quote(h, "what is x402?");

    const res = await h.paidFetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const paid = (await res.json()) as { jobId: string };
    expect(paid.jobId).toMatch(/^job_/);

    // The client actually negotiated: it saw requirements and built a payload.
    expect(h.scheme.seen.length).toBeGreaterThan(0);
    expect(h.settled).toHaveLength(1);

    const job = await provider.completeNextJob("42");
    expect(job.prompt).toBe("what is x402?");

    const finished = await waitFor(async () => {
      const r = await fetch(`${h.base}/api/jobs/${paid.jobId}`);
      const b = (await r.json()) as { job: { status: string } };
      return b.job.status === "completed" ? b.job : undefined;
    });
    expect(finished).toBeTruthy();

    const full = (await (await fetch(`${h.base}/api/jobs/${paid.jobId}`)).json()) as {
      job: Record<string, never>;
    };
    expect(full.job.result).toBe("42");
    expect(full.job.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(full.job.payment.payTo).toBe("0.0.9848438");
    expect(full.job.payment.payer).toBe("0.0.9848440");
    expect(full.job.payment.transactionId).toBeTruthy();
    expect(full.job.events.length).toBeGreaterThan(0);

    // And the receipt reached the ledger, carrying the settlement id.
    await waitFor(() => (h.chain.counts().receipts > 0 ? true : undefined), 25_000);
    const receipt = h.chain.published.find((p) => p.kind === "receipts")!
      .data as Record<string, unknown>;
    expect(receipt.jobId).toBe(paid.jobId);
    expect(receipt.ok).toBe(true);
    expect(receipt.transactionId).toBeTruthy();
    expect(receipt.resultHash).toBe(full.job.resultHash);

    provider.close();
  }, 40_000);

  it("refuses to sell the same quote twice", async () => {
    const provider = await connectProvider(h);
    const { body } = await quote(h);

    const first = await h.paidFetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(first.status).toBe(200);

    const replay = await fetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(replay.status).toBe(409);
    provider.close();
  });

  it("404s an unknown or expired quote instead of quoting a price nobody can pay", async () => {
    const provider = await connectProvider(h);
    const res = await fetch(`${h.base}/api/jobs/qte_does_not_exist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    provider.close();
  });

  it("409s when the quoted provider went offline before payment", async () => {
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    // Simulate the node vanishing: drop its heartbeat far into the past.
    const record = h.registry.get(provider.providerId)!;
    record.lastHeartbeatAt = Date.now() - 120_000;

    const res = await fetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
    provider.close();
  });
});

describe("what a browser can read", () => {
  /**
   * x402 puts its terms in a response header, and a browser cannot read a
   * response header that CORS does not expose.
   *
   * Not theoretical: shipping without `payment-required` on the expose list
   * gave every wallet payment made from a real tab
   * "Failed to parse payment requirements: Invalid payment required response",
   * while every server-side client kept working — Node's fetch has no CORS, so
   * nothing upstream of a browser could see it. The 402 test above passes
   * either way; only this one fails.
   */
  it("exposes payment-required to the browser, not just the settle response", async () => {
    await connectProvider(h);
    const { body } = await quote(h);

    const res = await fetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://xorv-app.vercel.app" },
      body: "{}",
    });

    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBeTruthy();

    const exposed = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    // Without this the client never sees `accepts` and cannot build a transfer.
    expect(exposed).toContain("payment-required");
    // And this one carries the transaction id back after settlement.
    expect(exposed).toContain("x-payment-response");
  });

  /**
   * The preflight has to allow every header `@x402/fetch` actually puts on the
   * wire — which is not the set the spec implies.
   *
   * The one that bit us: on the payment retry the client does
   * `retryRequest.headers.set("Access-Control-Expose-Headers", …)`. That is a
   * *response* header name used as a *request* header, arguably an upstream
   * bug — but the browser dutifully lists it in the preflight, and a server
   * that does not allow it fails the retry with "Request header field
   * access-control-expose-headers is not allowed by Access-Control-Allow-Headers".
   *
   * A server-side client never sends a preflight, so nothing but a browser can
   * catch this.
   */
  it("passes a preflight carrying the headers the x402 client sends", async () => {
    const res = await fetch(`${h.base}/api/jobs/qte_whatever`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://xorv-app.vercel.app",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "content-type,x-payment,payment-signature,access-control-expose-headers",
      },
    });

    expect(res.status).toBeLessThan(400);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    for (const required of [
      "content-type",
      "x-payment",
      "payment-signature",
      "access-control-expose-headers",
    ]) {
      expect(allowed).toContain(required);
    }
  });
});

describe("failure handling", () => {
  it("reassigns a failed job to another provider at no extra charge", async () => {
    const a = await connectProvider(h, { label: "a", nodeId: "n1", accountId: "0.0.1", price: 1_000 });
    const b = await connectProvider(h, { label: "b", nodeId: "n2", accountId: "0.0.2", price: 1_000 });

    const { body } = await quote(h);
    const res = await h.paidFetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const paid = (await res.json()) as { jobId: string };

    // Whichever node drew the job fails it; the other must pick it up.
    const first = a.dispatched.length > 0 ? a : b;
    const second = first === a ? b : a;
    await first.failNextJob("adapter exploded");

    await waitFor(() => (second.dispatched.length > 0 ? true : undefined), 4_000);
    expect(second.dispatched[0]!.jobId).toBe(paid.jobId);
    // Still exactly one settlement — the buyer was not charged twice.
    expect(h.settled).toHaveLength(1);

    a.close();
    b.close();
  }, 20_000);

  it("fails the job when there is nobody left to retry with", async () => {
    const only = await connectProvider(h);
    const { body } = await quote(h);
    const res = await h.paidFetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const paid = (await res.json()) as { jobId: string };

    await only.failNextJob("no good");
    const failed = await waitFor(async () => {
      const b = (await (await fetch(`${h.base}/api/jobs/${paid.jobId}`)).json()) as {
        job: { status: string; error: string | null };
      };
      return b.job.status === "failed" ? b.job : undefined;
    });
    expect(failed.error).toContain("no good");
    only.close();
  }, 20_000);
});

describe("streaming", () => {
  it("streams job events over SSE and terminates on done", async () => {
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    const res = await h.paidFetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const paid = (await res.json()) as { jobId: string };

    const stream = await fetch(`${h.base}/api/jobs/${paid.jobId}/stream`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";

    void provider.completeNextJob("streamed answer");

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !seen.includes("event: done")) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});

    expect(seen).toContain("event: snapshot");
    expect(seen).toContain("event: done");
    expect(seen).toContain("streamed answer");
    provider.close();
  }, 20_000);

  it("emits done immediately for a job that already finished", async () => {
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    const res = await h.paidFetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const paid = (await res.json()) as { jobId: string };

    await provider.completeNextJob("fast");
    await waitFor(async () => {
      const b = (await (await fetch(`${h.base}/api/jobs/${paid.jobId}`)).json()) as {
        job: { status: string };
      };
      return b.job.status === "completed" ? true : undefined;
    });

    // Subscribing after the fact must not hang waiting for an event that fired.
    const stream = await fetch(`${h.base}/api/jobs/${paid.jobId}/stream`, {
      headers: { Accept: "text/event-stream" },
    });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !seen.includes("event: done")) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    expect(seen).toContain("event: done");
    provider.close();
  }, 20_000);
});

describe("heartbeats", () => {
  it("accepts an authenticated beat and rejects a forged one", async () => {
    const provider = await connectProvider(h);

    const ok = await fetch(`${h.base}/api/providers/${provider.providerId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.token}` },
      body: JSON.stringify({ activeJobs: 0, uptimeSeconds: 10, available: { echo: true } }),
    });
    expect(ok.status).toBe(200);

    const forged = await fetch(`${h.base}/api/providers/${provider.providerId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
      body: JSON.stringify({ activeJobs: 0, uptimeSeconds: 10, available: {} }),
    });
    expect(forged.status).toBe(401);
    provider.close();
  });

  it("won't let one provider heartbeat as another", async () => {
    const a = await connectProvider(h, { label: "a", nodeId: "n1", accountId: "0.0.1" });
    const b = await connectProvider(h, { label: "b", nodeId: "n2", accountId: "0.0.2" });
    const res = await fetch(`${h.base}/api/providers/${b.providerId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ activeJobs: 0, uptimeSeconds: 1, available: {} }),
    });
    expect(res.status).toBe(401);
    a.close();
    b.close();
  });
});

describe("public surface", () => {
  it("serves health and network state", async () => {
    expect((await fetch(`${h.base}/health`)).status).toBe(200);
    const net = (await (await fetch(`${h.base}/api/network`)).json()) as Record<string, never>;
    expect(net.network).toBe("hedera:testnet");
    expect(net.topics.receipts.id).toBe("0.0.3");
  });

  it("rejects a provider result callback from an unrelated node", async () => {
    const a = await connectProvider(h, { label: "a", nodeId: "n1", accountId: "0.0.1" });
    const b = await connectProvider(h, { label: "b", nodeId: "n2", accountId: "0.0.2" });
    const { body } = await quote(h);
    const res = await h.paidFetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const paid = (await res.json()) as { jobId: string };

    const owner = a.dispatched.length > 0 ? a : b;
    const stranger = owner === a ? b : a;

    const forged = await fetch(`${h.base}/api/jobs/${paid.jobId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${stranger.token}` },
      body: JSON.stringify({ result: "I did not run this", durationMs: 1 }),
    });
    expect(forged.status).toBe(404);
    a.close();
    b.close();
  }, 20_000);
});
