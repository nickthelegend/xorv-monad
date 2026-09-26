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
 */
export function clientIp(c: Context): string {
  if (process.env.XORV_TRUST_PROXY === "1") {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]!.trim();
    const real = c.req.header("x-real-ip");
    if (real) return real.trim();
  }
  // @hono/node-server exposes the socket here; fall back to a single shared
  // bucket rather than to no limit at all.
  const info = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  return info ?? "unknown";
}

/**
 * Reject a body that is too large before it is parsed.
 *
 * Prompts are capped separately by the quote handler; this is the outer bound
 * that stops someone streaming a gigabyte at an endpoint that was going to
 * reject it anyway.
 */
export function bodyLimit(maxBytes: number) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > maxBytes) {
      return c.json(
        { error: `request body too large (max ${Math.round(maxBytes / 1024)}KB)` },
        413,
      );
    }
    await next();
  };
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
