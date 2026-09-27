/**
 * Request guards for a broker that is open to the internet.
 *
 * Everything here exists because the quote endpoint is free, unauthenticated
 * and does real work (it runs the matcher and reserves a provider for five
 * minutes). Without limits, one script can hold the entire network's capacity
 * hostage without spending a cent — the payment wall is at `POST /api/jobs`,
 * not here.
 */

import type { Context, Next } from "hono";
import { bodyLimit as honoBodyLimit } from "hono/body-limit";

export interface RateLimitOptions {
  /** Requests allowed per window, per key. */
  limit: number;
  windowMs: number;
  /** How to bucket callers; defaults to client IP. */
  keyOf?: (c: Context) => string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * A fixed-window limiter, in memory.
 *
 * Deliberately not a token bucket or a Redis-backed sliding window: this is one
 * process, the goal is to stop trivial abuse rather than to be exact at the
 * boundary, and a limiter that itself needs infrastructure is a limiter that
 * gets switched off. If Xorv ever runs more than one broker, this is the piece
 * that moves to shared state — and the interface won't change.
 */
export function rateLimit(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  const keyOf = options.keyOf ?? clientIp;

  // Buckets are only created on request, so a periodic sweep is enough to keep
  // the map from growing with every unique caller that ever showed up.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt < now) buckets.delete(key);
    }
  }, options.windowMs * 2);
  sweeper.unref?.();

  return async (c: Context, next: Next): Promise<Response | void> => {
    const key = keyOf(c);
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, options.limit - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);

    c.header("X-RateLimit-Limit", String(options.limit));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(resetSeconds));

    if (bucket.count > options.limit) {
      c.header("Retry-After", String(resetSeconds));
      return c.json(
        {
          error: `rate limit exceeded — ${options.limit} requests per ${Math.round(options.windowMs / 1000)}s`,
          retryAfterSeconds: resetSeconds,
        },
        429,
      );
    }

    await next();
  };
}

/**
 * Best-effort client address.
 *
 * Proxy headers are trusted only when `XORV_TRUST_PROXY` says to. Trusting
 * `X-Forwarded-For` by default would make the limiter useless the moment
 * anyone sets that header themselves — which is to say, immediately.
 *
 * Even then, only the entries the operator's own proxies appended are
 * believed. Proxies append the address they saw to whatever X-Forwarded-For
 * the client sent, so the leftmost entry is the client's to write: keying on
 * it gave every request a fresh bucket for the price of a random header.
 * `XORV_TRUSTED_HOPS` (default 1) is how many proxies sit in front of the
 * broker; the client address is that many entries from the right.
 */
export function clientIp(c: Context): string {
  if (process.env.XORV_TRUST_PROXY === "1") {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) {
      const parts = forwarded
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length > 0) return parts[Math.max(0, parts.length - trustedHops())]!;
    }
    const real = c.req.header("x-real-ip");
    if (real) return real.trim();
  }
  // @hono/node-server exposes the socket here; fall back to a single shared
  // bucket rather than to no limit at all.
  const info = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  return info ?? "unknown";
}

/** How many reverse proxies append to X-Forwarded-For in front of the broker (`XORV_TRUSTED_HOPS`, default 1). */
export function trustedHops(): number {
  const raw = Number(process.env.XORV_TRUSTED_HOPS ?? "1");
  return Number.isInteger(raw) && raw >= 1 && raw <= 10 ? raw : 1;
}

/**
 * Reject a body that is too large before it is parsed.
 *
 * Prompts are capped separately by the quote handler; this is the outer bound
 * that stops someone streaming a gigabyte at an endpoint that was going to
 * reject it anyway. A declared Content-Length is checked up front; a body
 * without one (`Transfer-Encoding: chunked`) is counted as it streams in and
 * refused the moment it passes the limit. Checking only the header let a
 * chunked body through at any size, and every handler buffers its body whole.
 */
export function bodyLimit(maxBytes: number) {
  return honoBodyLimit({
    maxSize: maxBytes,
    onError: (c) => c.json({ error: `request body too large (max ${Math.round(maxBytes / 1024)}KB)` }, 413),
  });
}

/**
 * Give every request an id, and log how it went.
 *
 * One line per request with a stable id, so a report of "my job 402'd" can be
 * traced through verify, settle and dispatch without turning on a debugger.
 */
export function requestLog() {
  let counter = 0;
  return async (c: Context, next: Next): Promise<void> => {
    const id = `req_${(++counter).toString(36)}`;
    const started = Date.now();
    c.header("X-Request-Id", id);
    await next();
    const ms = Date.now() - started;
    // Reads are noise; only log the endpoints that change something or cost money.
    const interesting =
      c.req.method !== "GET" || c.res.status >= 400 || c.req.path.includes("/stream");
    if (interesting) {
      console.log(
        `[broker] ${id} ${c.req.method} ${c.req.path} → ${c.res.status} ${ms}ms`,
      );
    }
  };
}
