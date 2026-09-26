/**
 * Guards, tested through a real Hono app rather than by calling the middleware
 * directly — the thing worth checking is that a request actually gets refused,
 * not that a function returns an object.
 */

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { bodyLimit, clientIp, rateLimit, requestLog } from "../src/guards.js";
import { Metrics } from "../src/metrics.js";
import { Registry } from "../src/registry.js";
import { JobStore } from "../src/jobs.js";
import type { ChainLike } from "../src/chain.js";

function appWith(...middleware: Parameters<Hono["use"]>[1][]) {
  const app = new Hono();
  for (const m of middleware) app.use("*", m);
  app.get("/", (c) => c.json({ ok: true }));
  app.post("/", (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimit", () => {
  it("allows up to the limit and refuses the next one with 429", async () => {
    const app = appWith(rateLimit({ limit: 3, windowMs: 60_000, keyOf: () => "same" }));
    for (let i = 0; i < 3; i += 1) {
      expect((await app.request("/")).status).toBe(200);
    }
    const blocked = await app.request("/");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: expect.stringContaining("rate limit") });
  });

  it("advertises the limit, what's left, and when it resets", async () => {
    const app = appWith(rateLimit({ limit: 5, windowMs: 60_000, keyOf: () => "k" }));
    const res = await app.request("/");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("4");
    expect(Number(res.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(0);
  });

  it("sends Retry-After when it refuses", async () => {
    const app = appWith(rateLimit({ limit: 1, windowMs: 60_000, keyOf: () => "k" }));
    await app.request("/");
    const blocked = await app.request("/");
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("buckets callers separately, so one abuser doesn't block everyone", async () => {
    let caller = "a";
    const app = appWith(rateLimit({ limit: 1, windowMs: 60_000, keyOf: () => caller }));
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/")).status).toBe(429);
    caller = "b";
    expect((await app.request("/")).status).toBe(200);
  });

  it("lets a caller back in once the window rolls over", async () => {
    vi.useFakeTimers();
    const app = appWith(rateLimit({ limit: 1, windowMs: 1_000, keyOf: () => "k" }));
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/")).status).toBe(429);
    vi.advanceTimersByTime(1_100);
    expect((await app.request("/")).status).toBe(200);
    vi.useRealTimers();
  });
});

describe("clientIp", () => {
  it("ignores proxy headers unless explicitly told to trust them", () => {
    delete process.env.XORV_TRUST_PROXY;
    const c = {
      req: { header: (n: string) => (n === "x-forwarded-for" ? "1.2.3.4" : undefined) },
      env: undefined,
    } as never;
    // Trusting this by default would make the limiter useless — anyone can set
    // the header themselves.
    expect(clientIp(c)).toBe("unknown");
  });

  it("uses X-Forwarded-For when the operator opts in", () => {
    process.env.XORV_TRUST_PROXY = "1";
    const c = {
      req: { header: (n: string) => (n === "x-forwarded-for" ? "1.2.3.4, 5.6.7.8" : undefined) },
      env: undefined,
    } as never;
    expect(clientIp(c)).toBe("1.2.3.4");
    delete process.env.XORV_TRUST_PROXY;
  });
});

describe("bodyLimit", () => {
  it("rejects an oversized declared body with 413", async () => {
    const app = appWith(bodyLimit(100));
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-length": "5000" },
      body: "x",
    });
    expect(res.status).toBe(413);
  });

  it("lets a normal request through", async () => {
    const app = appWith(bodyLimit(1_000));
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-length": "10" },
      body: "x",
    });
    expect(res.status).toBe(200);
  });
});

describe("requestLog", () => {
  it("stamps every response with a request id", async () => {
    const app = appWith(requestLog());
    const res = await app.request("/");
    expect(res.headers.get("X-Request-Id")).toMatch(/^req_/);
  });

  it("gives consecutive requests distinct ids", async () => {
    const app = appWith(requestLog());
    const a = (await app.request("/")).headers.get("X-Request-Id");
    const b = (await app.request("/")).headers.get("X-Request-Id");
    expect(a).not.toBe(b);
  });
});

describe("Metrics", () => {
  const chain: ChainLike = {
    network: "hedera:testnet",
    operatorId: "0.0.1",
    settlementClient: null as never,
    describeTopics: () => ({ registry: null, heartbeat: null, receipts: null }),
    counts: () => ({ registry: 2, heartbeat: 7, receipts: 5 }),
    lastPublishError: () => null,
    publishRegistration: async () => null,
    publishHeartbeat: async () => null,
    publishReceipt: async () => null,
    close: () => {},
  };

  function render(m: Metrics) {
    return m.render({ registry: new Registry(), jobs: new JobStore(), chain, connected: 3 });
  }

  it("emits valid exposition format with HELP and TYPE for every series", () => {
    const m = new Metrics();
    m.inc("xorv_quotes_total");
    const out = render(m);
    for (const line of out.trim().split("\n")) {
      expect(line).toMatch(/^(#|[a-z_]+(\{.*\})? -?[\d.]+$)/);
    }
    expect(out).toContain("# TYPE xorv_uptime_seconds gauge");
    expect(out).toContain("xorv_providers_connected 3");
  });

  it("counts and labels", () => {
    const m = new Metrics();
    m.inc("xorv_errors_total", { path: "/api/quotes" });
    m.inc("xorv_errors_total", { path: "/api/quotes" });
    m.inc("xorv_errors_total", { path: "/other" });
    const out = render(m);
    expect(out).toContain('xorv_errors_total{path="/api/quotes"} 2');
    expect(out).toContain('xorv_errors_total{path="/other"} 1');
  });

  it("summarises durations as quantiles in seconds", () => {
    const m = new Metrics();
    for (const ms of [100, 200, 300, 400, 500]) m.observe("xorv_job_duration", ms);
    const out = render(m);
    expect(out).toContain("# TYPE xorv_job_duration_seconds summary");
    expect(out).toContain('xorv_job_duration_seconds{quantile="0.5"}');
    expect(out).toContain("xorv_job_duration_seconds_count 5");
  });

  it("escapes label values so a hostile path can't break the format", () => {
    const m = new Metrics();
    m.inc("xorv_errors_total", { path: 'a"b\\c\nd' });
    expect(render(m)).toContain('xorv_errors_total{path="a\\"b\\\\c\\nd"} 1');
  });

  it("bounds retained histogram samples", () => {
    const m = new Metrics();
    for (let i = 0; i < 5_000; i += 1) m.observe("xorv_job_duration", i);
    expect(render(m)).toContain("xorv_job_duration_seconds_count 1000");
  });

  it("reports HCS message counts per topic", () => {
    const out = render(new Metrics());
    expect(out).toContain('xorv_hcs_messages_total{topic="receipts"} 5');
  });
});
