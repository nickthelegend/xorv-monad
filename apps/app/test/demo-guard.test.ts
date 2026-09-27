import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET, jobIdHash, networkConfig, ratingTypedData, toJsonSafe } from "@xorv/protocol/web";
import {
  OnceSet,
  SlidingWindowLimiter,
  SpendCap,
  demoReceiptCookie,
  demoReceiptSecret,
  mintDemoReceipt,
  resetDemoGuards,
  verifyDemoReceipt,
} from "@/lib/server/demo-guard";
import { POST as pay } from "@/app/api/pay/route";
import { GET as canRate, POST as rate } from "@/app/api/rate/route";

/*
 * /api/pay and /api/rate act with the deployment's key for anyone who can
 * reach them. These pin the bounds: rate limits, a daily spend cap, one try
 * per quote, and — the part that closes rating farming and griefing — a demo
 * rating only for the browser the demo account just paid for, once.
 *
 * The broker is a stubbed global fetch; the demo key signs for real.
 */

const NETWORK = MONAD_TESTNET;
const cfg = networkConfig(NETWORK);
const BROKER = "http://broker.test";
const APP = "http://app.test";
const LEDGER = privateKeyToAccount(generatePrivateKey()).address;
const PROVIDER = privateKeyToAccount(generatePrivateKey()).address;
const KEY = generatePrivateKey();
const DEMO = privateKeyToAccount(KEY).address;

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

interface BrokerState {
  payments: number;
  ratings: number;
  /** Job id → who paid for it, as the broker's job record says. */
  payer: Map<string, string>;
}

function stubBroker(): BrokerState {
  const state: BrokerState = { payments: 0, ratings: 0, payer: new Map() };
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (url.pathname === "/api/network") return json({ ledger: { address: LEDGER } });
    const rating = /^\/api\/jobs\/([^/]+)\/rating$/.exec(url.pathname);
    if (rating) {
      const jobId = decodeURIComponent(rating[1]!);
      const typed = ratingTypedData({
        network: NETWORK,
        ledger: LEDGER,
        rating: {
          jobId: jobIdHash(jobId),
          value: Number(url.searchParams.get("value")),
          tag2: "echo",
          endpoint: "",
          feedbackURI: `${BROKER}/feedback/${jobId}.json`,
          feedbackHash: `0x${"11".repeat(32)}`,
          deadline: Math.floor(Date.now() / 1000) + 600,
        },
      });
      return json({ typedData: toJsonSafe(typed) });
    }
    if (/^\/api\/jobs\/[^/]+\/rate$/.test(url.pathname)) {
      state.ratings += 1;
      return json({ txHash: `0x${"ee".repeat(32)}` });
    }
    const job = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
    if (job && request.method === "GET") {
      const jobId = decodeURIComponent(job[1]!);
      const payer = state.payer.get(jobId);
      return payer ? json({ job: { id: jobId, status: "completed", payment: { payer } } }) : json({ error: "no such job" }, 404);
    }
    if (job && request.method === "POST") {
      const quoteId = decodeURIComponent(job[1]!);
      if (!request.headers.get("PAYMENT-SIGNATURE")) {
        const offer = {
          scheme: "exact",
          network: NETWORK,
          asset: cfg.usdc.address,
          amount: "10000",
          payTo: PROVIDER,
          maxTimeoutSeconds: 300,
          extra: { name: cfg.usdc.name, version: cfg.usdc.version },
        };
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, error: "Payment required", resource: { url: request.url }, accepts: [offer] }) },
        });
      }
      state.payments += 1;
      const jobId = `job_${quoteId}`;
      state.payer.set(jobId, DEMO);
      return json({ jobId, status: "paid" });
    }
    return json({ error: `unexpected ${request.method} ${url.pathname}` }, 500);
  };
  vi.stubGlobal("fetch", impl);
  return state;
}

function payRequest(quoteId: string, ip = "198.51.100.7"): Request {
  return new Request(`${APP}/api/pay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ quoteId, payTo: PROVIDER, usdcAmount: "10000", network: NETWORK }),
  });
}

function rateRequest(jobId: string, cookie: string | null, ip = "198.51.100.7"): Request {
  return new Request(`${APP}/api/rate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ jobId, value: 100 }),
  });
}

/** The `name=value` pair of the receipt cookie a response set. */
function receiptCookie(res: Response): string | null {
  const header = res.headers.get("set-cookie");
  if (!header) return null;
  return header.split(";")[0]!.trim();
}

beforeEach(() => {
  resetDemoGuards();
  for (const [name, value] of Object.entries({
    XORV_NETWORK: "",
    NEXT_PUBLIC_XORV_NETWORK: "",
    XORV_DEMO_PAYER_KEY: KEY,
    XORV_DEMO_MAX_USDC_UNITS: "",
    XORV_DEMO_DAILY_USDC_UNITS: "",
    XORV_DEMO_RECEIPT_SECRET: "",
    XORV_BROKER_URL: BROKER,
  })) {
    vi.stubEnv(name, value);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("demo receipts", () => {
  const secret = demoReceiptSecret(KEY, "");

  it("verifies only for the job, secret and window it was minted for", () => {
    const now = 1_800_000_000_000;
    const token = mintDemoReceipt(secret, "job_1", now);
    expect(verifyDemoReceipt(secret, "job_1", token, now + 60_000)).toEqual({ ok: true, paidAt: now });
    expect(verifyDemoReceipt(secret, "job_2", token, now)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyDemoReceipt(demoReceiptSecret(generatePrivateKey(), ""), "job_1", token, now)).toMatchObject({ ok: false });
    expect(verifyDemoReceipt(secret, "job_1", token, now + 31 * 60_000)).toEqual({ ok: false, reason: "expired" });
    // A forged later paidAt doesn't carry the signature with it.
    expect(verifyDemoReceipt(secret, "job_1", token.replace(String(now), String(now + 1)), now)).toMatchObject({ ok: false });
    expect(verifyDemoReceipt(secret, "job_1", null, now)).toEqual({ ok: false, reason: "missing" });
  });

  it("counters: sliding window, once-only claims, rolling spend cap", () => {
    let t = 0;
    const clock = () => t;
    const limiter = new SlidingWindowLimiter(2, 1_000, clock);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a")).toMatchObject({ ok: false });
    expect(limiter.take("b").ok).toBe(true);
    t = 1_000;
    expect(limiter.take("a").ok).toBe(true);

    const once = new OnceSet(1_000, clock);
    expect(once.claim("q")).toBe(true);
    expect(once.claim("q")).toBe(false);
    once.release("q");
    expect(once.claim("q")).toBe(true);

    const cap = new SpendCap(100n, 1_000, clock);
    const first = cap.reserve(60n);
    expect(first.ok).toBe(true);
    expect(cap.reserve(60n).ok).toBe(false);
    if (first.ok) first.release();
    expect(cap.reserve(60n).ok).toBe(true);
  });
});

describe("/api/pay + /api/rate", () => {
  it("the paying browser can rate its demo job once; nobody else can rate it at all", async () => {
    const broker = stubBroker();
    const paid = await pay(payRequest("qte_a"));
    expect(paid.status).toBe(200);
    const { jobId } = (await paid.json()) as { jobId: string };
    const cookie = receiptCookie(paid);
    expect(cookie).toMatch(new RegExp(`^${demoReceiptCookie(jobId)}=`));
    expect(paid.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(paid.headers.get("set-cookie")).toMatch(/Path=\/api\/rate/i);

    // A stranger who found the job in the public list: no receipt, no rating.
    const stranger = await rate(rateRequest(jobId, null, "203.0.113.9"));
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toMatchObject({ code: "demo_receipt_required" });
    const strangerCheck = await canRate(new Request(`${APP}/api/rate?jobId=${jobId}`));
    expect(await strangerCheck.json()).toMatchObject({ canRate: false });
    expect(broker.ratings).toBe(0);

    // The browser that paid.
    const check = await canRate(new Request(`${APP}/api/rate?jobId=${jobId}`, { headers: { cookie: cookie! } }));
    expect(await check.json()).toEqual({ canRate: true });
    const own = await rate(rateRequest(jobId, cookie));
    expect(own.status).toBe(200);
    expect(broker.ratings).toBe(1);

    // ...and never twice.
    const again = await rate(rateRequest(jobId, cookie));
    expect(again.status).toBe(409);
    expect(broker.ratings).toBe(1);
  });

  it("a receipt for one job doesn't rate another demo-paid job", async () => {
    const broker = stubBroker();
    const first = await pay(payRequest("qte_one"));
    const cookie = receiptCookie(first)!;
    broker.payer.set("job_someone_else", DEMO);
    const res = await rate(rateRequest("job_someone_else", cookie.replace(/^[^=]+/, demoReceiptCookie("job_someone_else"))));
    expect(res.status).toBe(403);
    expect(broker.ratings).toBe(0);
  });

  it("a demo rating closes 30 minutes after the payment", async () => {
    stubBroker();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
    const paid = await pay(payRequest("qte_late"));
    const { jobId } = (await paid.json()) as { jobId: string };
    vi.setSystemTime(new Date("2026-10-13T12:31:00Z"));
    const res = await rate(rateRequest(jobId, receiptCookie(paid)));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/30 minutes/);
  });

  it("pays each quote at most once", async () => {
    const broker = stubBroker();
    const [a, b] = await Promise.all([pay(payRequest("qte_dup")), pay(payRequest("qte_dup"))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(broker.payments).toBe(1);
  });

  it("rate-limits one client, and stops at the daily spend cap", async () => {
    const broker = stubBroker();
    for (let i = 0; i < 5; i += 1) expect((await pay(payRequest(`qte_ip_${i}`))).status).toBe(200);
    const limited = await pay(payRequest("qte_ip_5"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    // Another client is unaffected...
    expect((await pay(payRequest("qte_other", "192.0.2.1"))).status).toBe(200);
    expect(broker.payments).toBe(6);

    // ...and the day's budget: two 10000-unit jobs fit under 25000, a third does not.
    resetDemoGuards();
    vi.stubEnv("XORV_DEMO_DAILY_USDC_UNITS", "25000");
    expect((await pay(payRequest("qte_cap_1", "192.0.2.10"))).status).toBe(200);
    expect((await pay(payRequest("qte_cap_2", "192.0.2.11"))).status).toBe(200);
    const capped = await pay(payRequest("qte_cap_3", "192.0.2.12"));
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ kind: "daily_cap" });
    expect(broker.payments).toBe(8);
  });
});
