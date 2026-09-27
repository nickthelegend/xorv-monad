/**
 * Abuse bounds for the demo account's two unauthenticated routes — server-only.
 *
 * `/api/pay` spends the deployment's test USDC for whoever asks, and
 * `/api/rate` signs ERC-8004 ratings with the same key. Both have to stay
 * usable by a judge with no wallet, so neither can demand a login. What they
 * can do is make the key worth very little to anyone else:
 *
 *  - **Rate limits**, per client IP and across the deployment, on both routes.
 *  - **A rolling 24-hour spend cap** on the demo float
 *    (`XORV_DEMO_DAILY_USDC_UNITS`, default $5), on top of the per-job cap.
 *  - **One payment attempt per quote**: a quote id the route has already tried
 *    to pay is refused, so parallel or repeated requests can't double-spend.
 *  - **A demo receipt** bound to the browser that paid: a successful demo
 *    payment sets an HttpOnly cookie holding an HMAC over the job id and the
 *    time it was paid. `/api/rate` signs only with a valid, fresh one (within
 *    {@link DEMO_RATING_WINDOW_MS}) — so nobody can rate a job someone *else*
 *    paid through the demo account, or farm ratings for a job this deployment
 *    didn't just pay for — and only once per job.
 *
 * The receipt is stateless (verified with a secret, not looked up), so it
 * works across serverless instances. The counters are in memory, per
 * instance: a best-effort bound on a testnet float, not an accounting system.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** How long after a demo payment its browser may rate the job. */
export const DEMO_RATING_WINDOW_MS = 30 * 60_000;

/** Default rolling 24 h ceiling on demo spending: $5 in USDC units. */
export const DEFAULT_DEMO_DAILY_USDC_UNITS = "5000000";

const DAY_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export type Clock = () => number;

/** At most `limit` hits per key in any `windowMs`. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: Clock = Date.now,
  ) {}

  /** Count a hit, or say how long until one is allowed. */
  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: Math.max(1, this.windowMs - (now - recent[0]!)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(now);
    return { ok: true };
  }

  private prune(now: number): void {
    for (const [key, list] of this.hits) {
      if (list.every((at) => now - at >= this.windowMs)) this.hits.delete(key);
    }
  }
}

/** Keys that may be claimed once each, remembered for `ttlMs`. */
export class OnceSet {
  private readonly claimed = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: Clock = Date.now,
  ) {}

  /** True the first time for `key` (within the TTL), false after. */
  claim(key: string): boolean {
    const now = this.now();
    const at = this.claimed.get(key);
    if (at !== undefined && now - at < this.ttlMs) return false;
    this.claimed.set(key, now);
    if (this.claimed.size > 10_000) {
      for (const [k, t] of this.claimed) if (now - t >= this.ttlMs) this.claimed.delete(k);
    }
    return true;
  }

  /** Give a claim back (the attempt provably did nothing). */
  release(key: string): void {
    this.claimed.delete(key);
  }
}

/** A rolling-window spend cap, in USDC units. */
export class SpendCap {
  private readonly spends: Array<{ at: number; units: bigint }> = [];

  constructor(
    private readonly capUnits: bigint,
    private readonly windowMs: number = DAY_MS,
    private readonly now: Clock = Date.now,
  ) {}

  private spent(now: number): bigint {
    while (this.spends.length && now - this.spends[0]!.at >= this.windowMs) this.spends.shift();
    return this.spends.reduce((sum, s) => sum + s.units, 0n);
  }

  /** Reserve `units`, or refuse if that would pass the cap. Returns a release handle. */
  reserve(units: bigint): { ok: true; release: () => void } | { ok: false; spent: bigint; cap: bigint } {
    const now = this.now();
    const spent = this.spent(now);
    if (spent + units > this.capUnits) return { ok: false, spent, cap: this.capUnits };
    const entry = { at: now, units };
    this.spends.push(entry);
    return {
      ok: true,
      release: () => {
        const i = this.spends.indexOf(entry);
        if (i >= 0) this.spends.splice(i, 1);
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

/**
 * The client's IP as the platform reports it (Vercel and most proxies set
 * `x-forwarded-for`, first entry = the client). Falls back to one shared
 * bucket, which errs towards limiting too much rather than not at all.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

// ---------------------------------------------------------------------------
// Demo receipts
// ---------------------------------------------------------------------------

const JOB_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** A job id safe to put in a cookie name. */
export function isCookieSafeJobId(jobId: string): boolean {
  return JOB_ID.test(jobId);
}

/** Cookie holding the receipt for one job. Scoped to `/api/rate` by the route. */
export function demoReceiptCookie(jobId: string): string {
  return `xorv_demo_${jobId}`;
}

/**
 * The HMAC secret for receipts: `XORV_DEMO_RECEIPT_SECRET` when set, else
 * derived one-way from the demo key, so a deployment needs nothing new.
 */
export function demoReceiptSecret(payerKey: string, explicit = process.env.XORV_DEMO_RECEIPT_SECRET?.trim()): Buffer {
  const seed = explicit || `derived:${payerKey}`;
  return createHash("sha256").update(`xorv-demo-receipt-secret:v1\n${seed}`).digest();
}

function mac(secret: Buffer, jobId: string, paidAt: number): string {
  return createHmac("sha256", secret).update(`xorv-demo-receipt:v1\n${jobId}\n${paidAt}`).digest("base64url");
}

/** `<paidAt>.<hmac>` — proof this deployment paid `jobId` for the holder at `paidAt`. */
export function mintDemoReceipt(secret: Buffer, jobId: string, paidAt: number): string {
  return `${paidAt}.${mac(secret, jobId, paidAt)}`;
}

export type DemoReceiptCheck =
  | { ok: true; paidAt: number }
  | { ok: false; reason: "missing" | "invalid" | "expired" };

export function verifyDemoReceipt(
  secret: Buffer,
  jobId: string,
  token: string | null | undefined,
  now: number = Date.now(),
  maxAgeMs: number = DEMO_RATING_WINDOW_MS,
): DemoReceiptCheck {
  if (!token) return { ok: false, reason: "missing" };
  const match = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return { ok: false, reason: "invalid" };
  const paidAt = Number(match[1]);
  const expected = Buffer.from(mac(secret, jobId, paidAt));
  const given = Buffer.from(match[2]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "invalid" };
  if (paidAt > now + 60_000 || now - paidAt > maxAgeMs) return { ok: false, reason: "expired" };
  return { ok: true, paidAt };
}

/** Read one cookie from a request's `Cookie` header. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// ---------------------------------------------------------------------------
// The deployment's guards (one set per server instance)
// ---------------------------------------------------------------------------

export interface DemoGuards {
  payPerIp: SlidingWindowLimiter;
  payGlobal: SlidingWindowLimiter;
  ratePerIp: SlidingWindowLimiter;
  rateGlobal: SlidingWindowLimiter;
  quotes: OnceSet;
  rated: OnceSet;
  spend: SpendCap;
}

/** The daily cap from `XORV_DEMO_DAILY_USDC_UNITS`, or null when it is malformed. */
export function dailyCapUnits(raw = process.env.XORV_DEMO_DAILY_USDC_UNITS?.trim()): bigint | null {
  const value = raw || DEFAULT_DEMO_DAILY_USDC_UNITS;
  if (!/^\d+$/.test(value) || BigInt(value) === 0n) return null;
  return BigInt(value);
}

export function createDemoGuards(opts: { dailyCapUnits: bigint; now?: Clock }): DemoGuards {
  const now = opts.now ?? Date.now;
  const TEN_MIN = 10 * 60_000;
  return {
    // A judge pays for a handful of jobs; a script paying for hundreds is the thing to stop.
    payPerIp: new SlidingWindowLimiter(5, TEN_MIN, now),
    payGlobal: new SlidingWindowLimiter(40, TEN_MIN, now),
    ratePerIp: new SlidingWindowLimiter(10, TEN_MIN, now),
    rateGlobal: new SlidingWindowLimiter(60, TEN_MIN, now),
    quotes: new OnceSet(DAY_MS, now),
    rated: new OnceSet(DAY_MS, now),
    spend: new SpendCap(opts.dailyCapUnits, DAY_MS, now),
  };
}

let guards: { cap: bigint; value: DemoGuards } | null = null;

/** This instance's guards, rebuilt only if the configured daily cap changes. */
export function demoGuards(cap: bigint): DemoGuards {
  if (!guards || guards.cap !== cap) guards = { cap, value: createDemoGuards({ dailyCapUnits: cap }) };
  return guards.value;
}

/** Tests only: forget every counter. */
export function resetDemoGuards(): void {
  guards = null;
}
