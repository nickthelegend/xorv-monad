/**
 * The broker end to end, over the direct-payment (`exact`) path. See
 * harness.ts for what is real and what is stubbed; escrow.test.ts covers the
 * escrow path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { boot, connectProvider, quote, waitFor, type Harness } from "./harness.js";

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
  it("registers a node, hands back a token, and publishes to the audit log", async () => {
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
      body: JSON.stringify({ label: "", address: "nope", capabilities: [] }),
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
    expect(body.provider.address).toBe("0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B");
    expect(body.accepts.map((a: { symbol: string }) => a.symbol)).toEqual(["USDG", "USDC"]);
    for (const a of body.accepts) expect(a.amount).toBe(String(body.priceUsdMicros));
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
    const { status, body } = await quote(h, "hi", 5_000);
    // Online but too dear is the buyer's request to change (422), not the network being down (503).
    expect(status).toBe(422);
    expect(String(body.error)).toMatch(/under \$0\.0050 — the cheapest is \$0\.0200/);
    provider.close();
  });

  it("says when the model asked for isn't on offer, rather than blaming the budget", async () => {
    const provider = await connectProvider(h); // sells echo only
    const res = await fetch(`${h.base}/api/quotes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi", maxPriceUsdMicros: 500_000, adapter: "codex" }),
    });
    expect(res.status).toBe(422);
    expect(String(((await res.json()) as { error: string }).error)).toMatch(/no online provider is selling codex right now/);
    provider.close();
  });

  it("says a node is reconnecting, not that nothing fits the budget, before its channel opens", async () => {
    // Found live after a restart: registered (so "online") but no job channel
    // yet, the node was skipped by the matcher and counted by the explanation —
    // "nothing under $0.50, the cheapest is $0.20".
    const reg = await fetch(`${h.base}/api/providers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "restarting-node",
        address: "0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B",
        endpoint: "http://localhost:1",
        capabilities: [
          { id: "echo", adapter: "echo", displayName: "Echo (test)", model: null, priceUsdMicros: 1_000, maxConcurrency: 1 },
        ],
        version: "0.1.0",
        region: null,
        nodeId: "node-restarting",
      }),
    });
    expect(reg.status).toBe(200);
    const res = await fetch(`${h.base}/api/quotes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi", maxPriceUsdMicros: 500_000, adapter: "echo" }),
    });
    expect(res.status).toBe(422);
    const error = String(((await res.json()) as { error: string }).error);
    expect(error).toMatch(/reconnecting/);
    expect(error).not.toMatch(/the cheapest is/);
  });

  it("says a model is busy, not missing, when its only node is mid-job", async () => {
    const provider = await connectProvider(h, { maxConcurrency: 1 });
    const { body } = await quote(h);
    await h.paidFetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await waitFor(() => provider.dispatched[0]);
    // What the real node reports while its one slot is taken.
    await fetch(`${h.base}/api/providers/${provider.providerId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.token}` },
      body: JSON.stringify({ activeJobs: 1, uptimeSeconds: 1, available: { echo: false } }),
    });
    const res = await fetch(`${h.base}/api/quotes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hi", maxPriceUsdMicros: 500_000, adapter: "echo" }),
    });
    expect(res.status).toBe(422);
    expect(String(((await res.json()) as { error: string }).error)).toMatch(/every provider selling echo is busy/);
    provider.close();
  });

  it("never quotes a capability the node registered as unavailable, not even before its first heartbeat", async () => {
    const provider = await connectProvider(h, { available: { echo: false } });
    const { status, body } = await quote(h);
    expect(status).toBe(422);
    expect(String(body.error)).toMatch(/busy right now/);
    provider.close();
  });

  it("picks the cheaper of two live providers", async () => {
    const dear = await connectProvider(h, { label: "dear", nodeId: "n1", address: "0x0000000000000000000000000000000000000001", price: 9_000 });
    const cheap = await connectProvider(h, { label: "cheap", nodeId: "n2", address: "0x0000000000000000000000000000000000000002", price: 2_000 });
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
    for (const accept of decoded.accepts) expect(accept.payTo).toBe("0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B");
    provider.close();
  });

  it("offers one requirement per stablecoin, USDG first, each with its own EIP-712 domain", async () => {
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    const res = await fetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const decoded = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString("utf8"));
    expect(decoded.accepts.map((a: { asset: string }) => a.asset)).toEqual([
      "0xFFC95faa3d63Cde504a05B567C600B78C0b41892",
      "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    ]);
    expect(decoded.accepts[0].extra).toMatchObject({ name: "Global Dollar", version: "1" });
    expect(decoded.accepts[1].extra).toMatchObject({ name: "USD Coin", version: "2" });
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
    expect(full.job.payment.payTo).toBe("0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B");
    expect(full.job.payment.payer).toBe("0x03294Ce27e218d1611B2ebc0b0ffdDb95F129F36");
    expect(full.job.payment.transactionHash).toBeTruthy();
    // A stock client pays the first option, and the record names it.
    expect(full.job.payment.asset).toBe("USDG");
    expect(full.job.events.length).toBeGreaterThan(0);

    // And the receipt reached the ledger, carrying the settlement id.
    await waitFor(() => (h.chain.counts().receipts > 0 ? true : undefined), 25_000);
    const receipt = h.chain.published.find((p) => p.kind === "receipts")!
      .data as Record<string, unknown>;
    expect(receipt.jobId).toBe(paid.jobId);
    expect(receipt.ok).toBe(true);
    expect(receipt.transactionHash).toBeTruthy();
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
    const a = await connectProvider(h, { label: "a", nodeId: "n1", address: "0x0000000000000000000000000000000000000001", price: 1_000 });
    const b = await connectProvider(h, { label: "b", nodeId: "n2", address: "0x0000000000000000000000000000000000000002", price: 1_000 });

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
    const a = await connectProvider(h, { label: "a", nodeId: "n1", address: "0x0000000000000000000000000000000000000001" });
    const b = await connectProvider(h, { label: "b", nodeId: "n2", address: "0x0000000000000000000000000000000000000002" });
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
    expect(net.network).toBe("eip155:421614");
    expect(net.log.address).toBe("0x383f5153db8bb18c7c25157fb3493645a465eEf3");
  });

  it("rejects a provider result callback from an unrelated node", async () => {
    const a = await connectProvider(h, { label: "a", nodeId: "n1", address: "0x0000000000000000000000000000000000000001" });
    const b = await connectProvider(h, { label: "b", nodeId: "n2", address: "0x0000000000000000000000000000000000000002" });
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

describe("cancelling a running job", () => {
  it("keeps the buyer's reason when the provider's own failure report arrives late", async () => {
    const provider = await connectProvider(h);
    const q = await quote(h);
    const paid = (await (
      await h.paidFetch(`${h.base}/api/jobs/${q.body.quoteId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).json()) as { jobId: string };
    const dispatched = await waitFor(() => provider.dispatched[0]);

    const cancel = await fetch(`${h.base}/api/jobs/${paid.jobId}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);

    // What a real node sends once its adapter has been killed by the cancel.
    provider.ws.send(
      JSON.stringify({ type: "job.error", jobId: dispatched.jobId, error: "job was cancelled or timed out", durationMs: 5 }),
    );
    await new Promise((r) => setTimeout(r, 200));

    const after = h.jobs.get(paid.jobId);
    expect(after?.status).toBe("failed");
    expect(after?.error).toBe("cancelled by the buyer");
    expect(after?.events?.some((e) => /reassigned/.test(e.text))).toBe(false);
    provider.close();
  }, 20_000);
});

describe("the demo payer", () => {
  const post = (body: unknown) =>
    fetch(`${h.base}/api/demo/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  afterEach(() => {
    delete process.env.XORV_DEMO_PAYER_KEY;
  });

  it("answers 501 when this broker has no demo account", async () => {
    delete process.env.XORV_DEMO_PAYER_KEY;
    const res = await post({ quoteId: "qte_anything" });
    expect(res.status).toBe(501);
  });

  it("checks the request and the quote before any money could move", async () => {
    process.env.XORV_DEMO_PAYER_KEY = `0x${"11".repeat(32)}`;
    expect((await post({})).status).toBe(400);
    const unknown = await post({ quoteId: "qte_doesnotexist" });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe(
      "quote not found or expired — request a new one",
    );
  });

  it("answers a quote that is already paid with 409 and the job, so the app can open it", async () => {
    process.env.XORV_DEMO_PAYER_KEY = `0x${"11".repeat(32)}`;
    const provider = await connectProvider(h);
    const q = await quote(h);
    const first = await h.paidFetch(`${h.base}/api/jobs/${q.body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const { jobId } = (await first.json()) as { jobId: string };
    const again = await post({ quoteId: q.body.quoteId });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "this quote has already been paid", jobId });
    provider.close();
  });

  it("refuses to pay for a job above the demo ceiling", async () => {
    process.env.XORV_DEMO_PAYER_KEY = `0x${"11".repeat(32)}`;
    const provider = await connectProvider(h, { price: 300_000 });
    const q = await quote(h, "expensive", 500_000);
    expect(q.status).toBe(200);
    const res = await post({ quoteId: q.body.quoteId });
    expect(res.status).toBe(403);
    provider.close();
  });
});
