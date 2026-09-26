/**
 * The broker's HTTP surface.
 *
 * The interesting part is `POST /api/jobs/:quoteId`. It is an ordinary x402
 * protected route, but its `payTo` resolves to the **provider's own Hedera
 * account** rather than to us. The broker introduces the two parties, witnesses
 * the result and publishes the receipt; it never holds anyone's money. That is
 * also why a quote is a first-class object — see jobs.ts.
 *
 * ## Why payment settles before the job runs
 *
 * A Hedera transaction carries a valid-start and a validity window capped at
 * 180 seconds. The payer signs a real `TransferTransaction`, so if the broker
 * waited for a five-minute coding job to finish before submitting it, the
 * signed payment would have expired and the provider would be unpaid for work
 * already done. So Xorv verifies and settles up front, and covers the other
 * risk — a provider that takes the money and fails — by reassigning the job to
 * another provider at no extra charge (see `reassign`). The poster's downside
 * is bounded by the network, not by the individual node they happened to draw.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/server";
import type { HTTPRequestContext } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import {
  HBAR_ASSET_ID,
  HEARTBEAT_INTERVAL_MS,
  HbarRateCache,
  JOB_TIMEOUT_MS,
  assetKind,
  buildFacilitator,
  formatUsd,
  hashscanAccount,
  hashscanTx,
  paymentOptionsFor,
  readTopic,
  sha256,
  usdMicrosToTinybars,
  usdMicrosToUsdcUnits,
  usdcUnitsToUsdMicros,
  usdcTokenId,
  type AdapterKind,
  type Capability,
  type DispatchedJob,
  type HeartbeatRequest,
  type Job,
  type JobEvent,
  type JobRequest,
  type PaymentRecord,
  type RegisterRequest,
} from "@xorv/protocol";
import type { BrokerConfig } from "./config.js";
import type { ChainLike } from "./chain.js";
import type { Hub } from "./hub.js";
import { JobStore, type Quote } from "./jobs.js";
import { Registry } from "./registry.js";
import { bodyLimit, rateLimit, requestLog } from "./guards.js";
import { Metrics } from "./metrics.js";

/** Publish one heartbeat in this many to HCS — see Chain.publishHeartbeat. */
const HEARTBEAT_PUBLISH_EVERY = 20;

export interface AppDeps {
  config: BrokerConfig;
  chain: ChainLike;
  registry: Registry;
  jobs: JobStore;
  /** Set after the HTTP server exists, since the hub needs it to upgrade. */
  getHub: () => Hub | null;
  /**
   * Override the facilitator.
   *
   * Production builds one from config; tests pass a stub so the whole HTTP
   * path can be exercised without Hedera credentials or a real transfer.
   */
  facilitator?: FacilitatorClient;
  metrics?: Metrics;
}

export function createApp(deps: AppDeps) {
  const { config, chain, registry, jobs } = deps;
  const app = new Hono();
  const rates = new HbarRateCache(config.network);
  const heartbeatCounters = new Map<string, number>();
  /** Jobs whose HCS receipt is already on the topic — see publishReceiptWhenReady. */
  const publishedReceipts = new Set<string>();
  const metrics = deps.metrics ?? new Metrics();

  const built = deps.facilitator
    ? { facilitator: deps.facilitator, description: "injected (test)", feePayer: config.operatorId }
    : buildFacilitator({
        mode: config.facilitatorMode,
        network: config.network,
        // Deliberately not chain.client — see Chain.settlementClient.
        client: chain.settlementClient,
        feePayerId: config.operatorId,
        feePayerKey: config.operatorKey,
      });
  const { facilitator, description: facilitatorDescription, feePayer } = built;

  const x402Server = new x402ResourceServer(facilitator).register(
    "hedera:*" as Network,
    new ExactHederaScheme({
      defaultAssets: {
        [config.network]: { asset: usdcTokenId(config.network), decimals: 6 },
      },
    }),
  );

  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (config.corsOrigins.length === 0) return origin ?? "*";
        return config.corsOrigins.includes(origin) ? origin : config.corsOrigins[0] ?? null;
      },
      // The full set `@x402/fetch` actually puts on the wire, not the set the
      // spec implies. Two of these are non-obvious:
      //
      //   PAYMENT-SIGNATURE — the v2 spelling; the client sends either this or
      //   X-PAYMENT depending on the negotiated version.
      //
      //   Access-Control-Expose-Headers — the client sets this as a REQUEST
      //   header on the payment retry (dist/esm/index.mjs). That is a response
      //   header name and arguably an upstream bug, but a browser dutifully
      //   lists it in the preflight, and a server that does not allow it fails
      //   every retry with "not allowed by Access-Control-Allow-Headers".
      //   Server-side clients never send a preflight, so this only ever breaks
      //   browsers.
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-PAYMENT",
        "X-Payment",
        "PAYMENT-SIGNATURE",
        "Payment-Signature",
        "Access-Control-Expose-Headers",
      ],
      // Browsers can't read a response header unless it's exposed, and x402
      // carries its whole contract in two of them.
      //
      // `payment-required` is the one that matters and the one that was
      // missing: the 402 puts the `accepts` array — amounts, assets, payTo,
      // feePayer — in that header, not in the body. Server-side clients never
      // noticed, because Node's fetch has no CORS. A browser paying with its
      // own wallet got `null` for it and failed with "Failed to parse payment
      // requirements", which reads like a protocol bug and is really a
      // one-line CORS omission.
      //
      // Both casings of each, because header names are case-insensitive on the
      // wire but this list is matched literally by some proxies.
      exposeHeaders: [
        "X-PAYMENT-RESPONSE",
        "X-Payment-Response",
        // The client asks for this spelling by name; without it the settled
        // transaction id is unreadable even though the payment succeeded.
        "PAYMENT-RESPONSE",
        "Payment-Response",
        "PAYMENT-REQUIRED",
        "Payment-Required",
        "payment-required",
      ],
    }),
  );

  app.onError((err, c) => {
    console.error("[broker]", err);
    metrics.inc("xorv_errors_total", { path: c.req.path });
    return c.json({ error: err instanceof Error ? err.message : "internal error" }, 500);
  });

  app.use("*", requestLog());
  // 256KB is far above a 20k-char prompt and far below anything worth parsing.
  app.use("*", bodyLimit(256 * 1024));

  // Quoting is free, unauthenticated and reserves a provider — the obvious
  // thing to abuse. The paid route needs no limit of its own: it costs money.
  app.use("/api/quotes", rateLimit({ limit: 30, windowMs: 60_000 }));
  app.use("/api/providers/register", rateLimit({ limit: 10, windowMs: 60_000 }));

  app.get("/metrics", (c) =>
    c.text(
      metrics.render({
        registry,
        jobs,
        chain,
        connected: deps.getHub()?.connectedCount() ?? 0,
      }),
      200,
      { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
    ),
  );

  // Access log for the paid route only. The 402 dance is two requests that look
  // identical except for one header, and "did the client actually retry with a
  // payment?" is the first question worth answering when it goes wrong.
  app.use("/api/jobs/*", async (c, next) => {
    const paid = Boolean(c.req.header("X-PAYMENT") ?? c.req.header("x-payment"));
    await next();
    if (c.req.method === "POST") {
      console.log(
        `[broker] ${c.req.method} ${c.req.path} payment=${paid ? "yes" : "no"} → ${c.res.status}`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Public: network state
  // -------------------------------------------------------------------------

  app.get("/health", (c) => c.json({ ok: true, at: Date.now() }));

  app.get("/api/network", async (c) => {
    const live = registry.live();
    const rate = await rates.get().catch(() => null);
    const allJobs = jobs.list({ limit: 1000 });
    const settled = allJobs.filter((j) => j.payment);
    return c.json({
      network: config.network,
      facilitator: { mode: config.facilitatorMode, description: facilitatorDescription, feePayer },
      operator: { accountId: config.operatorId, url: hashscanAccount(config.network, config.operatorId) },
      usdc: usdcTokenId(config.network),
      topics: chain.describeTopics(),
      hcsPublished: chain.counts(),
      hcsLastError: chain.lastPublishError(),
      hbarRate: rate ? { centsPerHbar: rate.centsPerHbar } : null,
      stats: {
        providersLive: live.length,
        providersConnected: deps.getHub()?.connectedCount() ?? 0,
        capacity: live.reduce((n, p) => n + p.capabilities.length, 0),
        jobsTotal: allJobs.length,
        jobsCompleted: allJobs.filter((j) => j.status === "completed").length,
        paidUsdMicros: settled.reduce((sum, j) => sum + (j.priceUsdMicros ?? 0), 0),
      },
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    });
  });

  app.get("/api/providers", (c) => {
    const hub = deps.getHub();
    return c.json({
      providers: registry.list().map((p) => ({
        id: p.id,
        label: p.label,
        accountId: p.accountId,
        accountUrl: hashscanAccount(config.network, p.accountId),
        endpoint: p.endpoint,
        status: p.status,
        connected: hub?.isConnected(p.id) ?? false,
        activeJobs: p.activeJobs,
        capabilities: p.capabilities,
        lastHeartbeatAt: p.lastHeartbeatAt,
        registeredAt: p.registeredAt,
        uptimeSeconds: p.uptimeSeconds,
        version: p.version,
        region: p.region,
        stats: p.stats,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // Provider node API (bearer token from registration)
  // -------------------------------------------------------------------------

  app.post("/api/providers/register", async (c) => {
    const body = (await c.req.json()) as RegisterRequest;
    const invalid = validateRegistration(body);
    if (invalid) return c.json({ error: invalid }, 400);

    const provider = registry.register(body);

    // Registration is announced on HCS, but a slow consensus round-trip must
    // not hold up a node that is ready to work.
    const registryResult = await chain.publishRegistration(provider).catch(() => null);
    if (registryResult) provider.registryConsensusAt = registryResult.transactionId;

    return c.json({
      provider: stripSecrets(provider),
      token: provider.token,
      wsUrl: `${config.publicUrl.replace(/^http/, "ws")}/ws/provider?token=${provider.token}`,
      registry: registryResult,
      network: config.network,
      usdc: usdcTokenId(config.network),
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    });
  });

  app.post("/api/providers/:id/heartbeat", async (c) => {
    const provider = authProvider(c.req.header("authorization"));
    if (!provider || provider.id !== c.req.param("id")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = (await c.req.json()) as HeartbeatRequest;
    const updated = registry.heartbeat(provider.id, {
      activeJobs: body.activeJobs ?? 0,
      uptimeSeconds: body.uptimeSeconds ?? 0,
      available: body.available ?? {},
    });
    if (!updated) return c.json({ error: "unknown provider" }, 404);

    // Sampled, not every beat — see Chain.publishHeartbeat for why.
    const n = (heartbeatCounters.get(provider.id) ?? 0) + 1;
    heartbeatCounters.set(provider.id, n);
    if (n % HEARTBEAT_PUBLISH_EVERY === 1) {
      void chain.publishHeartbeat({
        providerId: provider.id,
        activeJobs: updated.activeJobs,
        capacity: updated.capabilities.length,
        uptimeSeconds: updated.uptimeSeconds,
      });
    }

    return c.json({
      ok: true,
      status: updated.status,
      pending: [],
      brokerEpoch: deps.getHub()?.epoch ?? 0,
    });
  });

  // HTTP fallbacks for nodes that can't hold a socket open.
  app.post("/api/jobs/:id/events", async (c) => {
    const provider = authProvider(c.req.header("authorization"));
    if (!provider) return c.json({ error: "unauthorized" }, 401);
    const job = jobs.get(c.req.param("id"));
    if (!job || job.providerId !== provider.id) return c.json({ error: "not found" }, 404);
    const event = (await c.req.json()) as JobEvent;
    jobs.addEvent(job.id, { ...event, at: event.at || Date.now() });
    return c.json({ ok: true });
  });

  app.post("/api/jobs/:id/result", async (c) => {
    const provider = authProvider(c.req.header("authorization"));
    if (!provider) return c.json({ error: "unauthorized" }, 401);
    const job = jobs.get(c.req.param("id"));
    if (!job || job.providerId !== provider.id) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json()) as { result?: string; error?: string; durationMs?: number };
    if (body.error) {
      void finishJobFailed(job.id, provider.id, body.error, body.durationMs ?? 0);
    } else {
      void finishJobOk(job.id, provider.id, body.result ?? "", body.durationMs ?? 0);
    }
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Quotes — free, and the thing a payment is pinned to
  // -------------------------------------------------------------------------

  app.post("/api/quotes", async (c) => {
    const body = (await c.req.json()) as JobRequest;
    if (!body?.prompt?.trim()) return c.json({ error: "prompt is required" }, 400);
    if (body.prompt.length > 20_000) return c.json({ error: "prompt is too long (max 20k chars)" }, 400);

    const maxPrice = Number(body.maxPriceUsdMicros);
    if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
      return c.json({ error: "maxPriceUsdMicros must be a positive number" }, 400);
    }

    const match = registry.match({ adapter: body.adapter ?? null, maxPriceUsdMicros: maxPrice });
    if (!match) {
      const live = registry.live().length;
      return c.json(
        {
          error:
            live === 0
              ? "no providers are online right now — start one with `xorv start`"
              : `no online provider matches that request under ${formatUsd(maxPrice)}`,
          providersLive: live,
        },
        503,
      );
    }

    // Fetch the rate before the quote exists, so the HBAR figure the quote
    // commits to is the same one the client is shown.
    const rate = await rates.get().catch(() => null);
    metrics.inc('xorv_quotes_total');
    const quote = jobs.createQuote({
      request: { ...body, prompt: body.prompt, maxPriceUsdMicros: maxPrice },
      providerId: match.provider.id,
      providerLabel: match.provider.label,
      providerAccountId: match.provider.accountId,
      capabilityId: match.capability.id,
      capabilityName: match.capability.displayName,
      priceUsdMicros: match.capability.priceUsdMicros,
      usdcAmount: usdMicrosToUsdcUnits(match.capability.priceUsdMicros),
      hbarAmount: rate ? usdMicrosToTinybars(match.capability.priceUsdMicros, rate) : null,
    });

    return c.json({
      quoteId: quote.id,
      payUrl: `${config.publicUrl}/api/jobs/${quote.id}`,
      priceUsdMicros: quote.priceUsdMicros,
      priceLabel: formatUsd(quote.priceUsdMicros),
      expiresAt: quote.expiresAt,
      provider: {
        id: match.provider.id,
        label: match.provider.label,
        accountId: match.provider.accountId,
        accountUrl: hashscanAccount(config.network, match.provider.accountId),
        capability: match.capability.displayName,
        adapter: match.capability.adapter,
        model: match.capability.model ?? null,
        stats: match.provider.stats,
      },
      accepts: [
        { asset: usdcTokenId(config.network), amount: quote.usdcAmount },
        ...(quote.hbarAmount ? [{ asset: HBAR_ASSET_ID, amount: quote.hbarAmount }] : []),
      ],
    });
  });

  // -------------------------------------------------------------------------
  // The paid route
  // -------------------------------------------------------------------------

  /** Pull the quote id out of the request path for the dynamic resolvers. */
  const quoteFromContext = (ctx: HTTPRequestContext): Quote | undefined => {
    const id = ctx.path.split("/").filter(Boolean).pop();
    return id ? jobs.getQuote(id) : undefined;
  };

  const routes: RoutesConfig = {
    "POST /api/jobs/:quoteId": {
      description: "Run one AI job on a live Xorv provider",
      serviceName: "Xorv",
      mimeType: "application/json",
      // Both resolvers read the amounts frozen on the quote — see Quote.usdcAmount
      // for why recomputing here silently breaks correctly-signed payments.
      accepts: [
        {
          scheme: "exact",
          network: config.network as Network,
          // Straight to the provider — the broker is never the payee.
          payTo: (ctx) => quoteFromContext(ctx)?.providerAccountId ?? "",
          price: (ctx) => ({
            asset: usdcTokenId(config.network),
            amount: quoteFromContext(ctx)?.usdcAmount ?? "0",
          }),
          maxTimeoutSeconds: 300,
        },
        {
          scheme: "exact",
          network: config.network as Network,
          payTo: (ctx) => quoteFromContext(ctx)?.providerAccountId ?? "",
          price: (ctx) => ({
            asset: HBAR_ASSET_ID,
            amount: quoteFromContext(ctx)?.hbarAmount ?? "0",
          }),
          maxTimeoutSeconds: 300,
        },
      ],
      unpaidResponseBody: (ctx) => {
        const quote = quoteFromContext(ctx);
        return {
          contentType: "application/json",
          body: quote
            ? {
                quoteId: quote.id,
                provider: { id: quote.providerId, label: quote.providerLabel },
                capability: quote.capabilityName,
                priceLabel: formatUsd(quote.priceUsdMicros),
                hint: "Sign the payment with a Hedera account holding USDC (or HBAR) and retry with the X-PAYMENT header.",
              }
            : { error: "quote not found or expired — request a new one from POST /api/quotes" },
        };
      },
    },
  };

  app.use("/api/jobs/:quoteId", async (c, next) => {
    // Guard before the payment middleware, so an expired quote is a clean 404
    // rather than a 402 quoting a price nobody can pay.
    if (c.req.method !== "POST") return next();
    const quote = jobs.getQuote(c.req.param("quoteId") ?? "");
    if (!quote) {
      return c.json({ error: "quote not found or expired — request a new one" }, 404);
    }
    if (quote.jobId) {
      return c.json({ error: "this quote has already been paid", jobId: quote.jobId }, 409);
    }
    const provider = registry.get(quote.providerId);
    if (!provider || provider.status === "offline") {
      return c.json({ error: "the quoted provider went offline — request a new quote" }, 409);
    }
    return next();
  });

  app.use("/api/jobs/:quoteId", paymentMiddleware(routes, x402Server));

  app.post("/api/jobs/:quoteId", async (c) => {
    const quote = jobs.getQuote(c.req.param("quoteId") ?? "");
    if (!quote) return c.json({ error: "quote expired during payment" }, 409);

    metrics.inc('xorv_payments_total');
    const job = jobs.createJob(quote);
    // The payment record is filled in from the settle response by the hook
    // below; dispatch does not wait on it.
    dispatch(job);

    return c.json({
      jobId: job.id,
      status: job.status,
      provider: { id: quote.providerId, label: quote.providerLabel },
      capability: quote.capabilityName,
      priceUsdMicros: quote.priceUsdMicros,
      priceLabel: formatUsd(quote.priceUsdMicros),
      streamUrl: `${config.publicUrl}/api/jobs/${job.id}/stream`,
      jobUrl: `${config.publicUrl}/api/jobs/${job.id}`,
    });
  });

  // A rejected payment is the single most confusing failure in this system —
  // the buyer signed something real and got a 402 back — so the reason code goes
  // to the log rather than only into an HTTP status.
  x402Server.onVerifyFailure(async (ctx) => {
    const result = (ctx as { result?: { invalidReason?: string; invalidMessage?: string } }).result;
    const error = (ctx as { error?: Error }).error;
    console.error(
      `[broker] payment verification failed: ${result?.invalidReason ?? error?.message ?? "unknown"}` +
        `${result?.invalidMessage ? ` — ${result.invalidMessage}` : ""}`,
    );
  });

  /**
   * Capture settlement onto the job.
   *
   * The resource server settles after the handler returns, so this hook is the
   * only place with both the on-chain transaction id and the job it paid for.
   */
  x402Server.onAfterSettle(async (ctx) => {
    const result = ctx.result;
    if (!result?.success || !result.transaction) return;
    const payTo = ctx.requirements.payTo;
    const asset = ctx.requirements.asset;
    const amount = ctx.requirements.amount;

    // Find the job this settlement belongs to: the most recent unpaid job for
    // that provider account. Quote ids are single-use and jobs are created
    // synchronously in the handler just above, so this is unambiguous.
    const candidate = jobs
      .list({ limit: 50 })
      .find((j) => !j.payment && j.providerAccountId === payTo);
    if (!candidate) return;

    const kind = assetKind(asset);
    const record: PaymentRecord = {
      asset: kind,
      assetId: asset,
      amount,
      network: config.network,
      transactionId: result.transaction,
      payer: result.payer ?? "unknown",
      payTo,
      settledAt: Date.now(),
      hashscanUrl: hashscanTx(config.network, result.transaction),
    };
    jobs.patch(candidate.id, { payment: record });
  });

  // -------------------------------------------------------------------------
  // Job reads
  // -------------------------------------------------------------------------

  app.get("/api/jobs", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const providerId = c.req.query("providerId") ?? undefined;
    return c.json({ jobs: jobs.list({ limit, providerId }).map((job) => publicJob(job)) });
  });

  app.get("/api/jobs/:id", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    return c.json({ job: publicJob(job, { events: true }) });
  });

  /**
   * Stop a running job.
   *
   * Knowing the job id is the authorisation — ids are 72 bits of randomness and
   * are only ever handed to the buyer who paid. That is a capability URL, and
   * it is the same trust model as the stream endpoint next to it.
   *
   * This does **not** refund. Settlement already happened (see the note at the
   * top of this file), and the provider may have already burned real quota. It
   * stops the work and frees their slot.
   */
  app.post("/api/jobs/:id/cancel", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    if (job.status === "completed" || job.status === "failed") {
      return c.json({ error: `job is already ${job.status}`, status: job.status }, 409);
    }

    const reason = "cancelled by the buyer";
    if (job.providerId) {
      deps.getHub()?.send(job.providerId, { type: "job.cancel", jobId: job.id, reason });
      registry.jobFinished(job.providerId, { ok: false, durationMs: jobs.runtimeMs(job) });
    }
    jobs.addEvent(job.id, { at: Date.now(), kind: "status", text: reason });
    jobs.fail(job.id, reason);
    metrics.inc("xorv_jobs_cancelled_total");

    return c.json({ ok: true, jobId: job.id, status: "failed", refunded: false });
  });

  /** Server-sent events: the poster watches their job run, token by token. */
  app.get("/api/jobs/:id/stream", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        const write = (event: string, data: unknown) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            /* client went away */
          }
        };

        write("snapshot", publicJob(job, { events: true }));

        // A fast job is routinely already finished by the time the client gets
        // here — settlement takes seconds, an echo job takes milliseconds. If
        // we only ever emitted `done` from a subsequent update, that client
        // would wait forever for an event that already happened.
        if (job.status === "completed" || job.status === "failed") {
          write("done", publicJob(job, { events: true }));
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }

        const unsubscribe = jobs.subscribeToJob(job.id, (updated, event) => {
          if (event) write("event", event);
          write("job", publicJob(updated));
          if (updated.status === "completed" || updated.status === "failed") {
            write("done", publicJob(updated, { events: true }));
            cleanup();
          }
        });

        // Comment frames keep proxies from closing an idle SSE connection.
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            cleanup();
          }
        }, 15_000);

        function cleanup(): void {
          clearInterval(keepalive);
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }

        c.req.raw.signal?.addEventListener("abort", cleanup);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  });

  /** The public audit trail, read straight from a Hedera mirror node. */
  app.get("/api/receipts", async (c) => {
    const topic = chain.describeTopics().receipts;
    if (!topic) return c.json({ receipts: [], topic: null });
    try {
      const messages = await readTopic(config.network, topic.id, { limit: 50 });
      return c.json({
        topic,
        receipts: messages.map((m) => ({
          consensusAt: m.consensusAt,
          sequence: m.sequence,
          payload: m.payload,
        })),
      });
    } catch (err) {
      return c.json({ receipts: [], topic, error: (err as Error).message }, 502);
    }
  });

  app.get("/api/topics/:kind", async (c) => {
    const kind = c.req.param("kind") as "registry" | "heartbeat" | "receipts";
    const topic = chain.describeTopics()[kind];
    if (!topic) return c.json({ error: `no ${kind} topic configured` }, 404);
    const messages = await readTopic(config.network, topic.id, { limit: 50 });
    return c.json({ topic, messages });
  });

  // -------------------------------------------------------------------------
  // Dispatch + completion
  // -------------------------------------------------------------------------

  function dispatch(job: Job): void {
    const hub = deps.getHub();
    const provider = job.providerId ? registry.get(job.providerId) : undefined;
    if (!provider || !hub) {
      jobs.fail(job.id, "no control channel to the provider");
      return;
    }

    const capability = provider.capabilities.find((cap) => cap.id === job.capabilityId);
    const payload: DispatchedJob = {
      jobId: job.id,
      capabilityId: job.capabilityId ?? capability?.id ?? "",
      prompt: job.request.prompt,
      timeoutMs: JOB_TIMEOUT_MS,
      priceUsdMicros: job.priceUsdMicros ?? 0,
    };

    if (!hub.send(provider.id, { type: "job.dispatch", job: payload })) {
      // The node's socket dropped between quote and payment. Try to find
      // someone else rather than failing a job that has already been paid for.
      if (!reassign(job)) jobs.fail(job.id, "provider disconnected before the job could start");
      return;
    }

    registry.jobStarted(provider.id);
    jobs.setStatus(job.id, "assigned");
  }

  /**
   * Hand an already-paid job to a different provider.
   *
   * The poster is not charged again — the money is already with the first
   * provider, and chasing it back is not worth the complexity. The original
   * provider takes the reputation hit instead, which is the incentive that
   * actually matters to them.
   */
  function reassign(job: Job): boolean {
    const match = registry.match({
      adapter: job.request.adapter ?? null,
      maxPriceUsdMicros: job.request.maxPriceUsdMicros,
    });
    if (!match || match.provider.id === job.providerId) return false;
    const hub = deps.getHub();
    if (!hub) return false;

    const sent = hub.send(match.provider.id, {
      type: "job.dispatch",
      job: {
        jobId: job.id,
        capabilityId: match.capability.id,
        prompt: job.request.prompt,
        timeoutMs: JOB_TIMEOUT_MS,
        priceUsdMicros: job.priceUsdMicros ?? 0,
      },
    });
    if (!sent) return false;

    jobs.patch(job.id, {
      providerId: match.provider.id,
      providerLabel: match.provider.label,
      capabilityId: match.capability.id,
      status: "assigned",
    });
    jobs.addEvent(job.id, {
      at: Date.now(),
      kind: "status",
      text: `reassigned to ${match.provider.label} at no extra charge`,
    });
    registry.jobStarted(match.provider.id);
    return true;
  }

  async function finishJobOk(
    jobId: string,
    providerId: string,
    result: string,
    durationMs: number,
  ): Promise<void> {
    const hash = sha256(result);
    const job = jobs.complete(jobId, result, hash);
    if (!job) return;

    const earned = earnings(job);
    registry.jobFinished(providerId, { ok: true, durationMs, ...earned });
    metrics.inc('xorv_jobs_completed_total');
    metrics.observe('xorv_job_duration', durationMs);
    void publishReceiptWhenReady(job.id, durationMs, true);
  }

  /**
   * Publish a job's HCS receipt once there is actually something to attest to.
   *
   * A job routinely finishes *before* its payment is recorded: the resource
   * server settles after the request handler returns, while echo-class work can
   * be done in under a second. Publishing on completion alone produced receipts
   * with an empty transaction id — a receipt that proves nothing. So both
   * triggers call in here, and the first one to find the job terminal *and*
   * paid does the write; the `published` set makes the second a no-op.
   *
   * The grace loop bounds the wait: if settlement never lands (a failed
   * payment, a facilitator error), the receipt still goes out marked unpaid
   * rather than being silently dropped.
   */
  async function publishReceiptWhenReady(
    jobId: string,
    durationMs: number,
    ok: boolean,
  ): Promise<void> {
    if (publishedReceipts.has(jobId)) return;

    const deadline = Date.now() + 20_000;
    let job = jobs.get(jobId);
    while (job && !job.payment && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      job = jobs.get(jobId);
    }
    if (!job) return;
    if (publishedReceipts.has(jobId)) return;
    publishedReceipts.add(jobId);

    const receipt = await chain.publishReceipt({
      jobId: job.id,
      providerId: job.providerId ?? "",
      providerAccountId: job.providerAccountId ?? "",
      payer: job.payment?.payer ?? "unpaid",
      asset: job.payment?.assetId ?? "",
      amount: job.payment?.amount ?? "0",
      transactionId: job.payment?.transactionId ?? "",
      resultHash: job.resultHash ?? "",
      durationMs,
      ok,
    });
    if (receipt) {
      jobs.patch(job.id, { receiptConsensusAt: receipt.transactionId });
    } else {
      // Publishing failed; let a later attempt retry rather than marking this
      // job as receipted forever.
      publishedReceipts.delete(jobId);
    }
  }

  async function finishJobFailed(
    jobId: string,
    providerId: string,
    error: string,
    durationMs: number,
  ): Promise<void> {
    const job = jobs.get(jobId);
    if (!job) return;
    registry.jobFinished(providerId, { ok: false, durationMs });
    metrics.inc('xorv_jobs_failed_total');

    // One free retry elsewhere before the poster is told it failed.
    if (job.status !== "completed" && reassign(job)) return;

    jobs.fail(jobId, error);
    await publishReceiptWhenReady(jobId, durationMs, false);
  }

  function earnings(job: Job): { usdcMicros?: number; tinybars?: number } {
    if (!job.payment) return {};
    if (job.payment.asset === "usdc") {
      return { usdcMicros: usdcUnitsToUsdMicros(job.payment.amount) };
    }
    return { tinybars: Number(job.payment.amount) };
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function authProvider(header: string | undefined) {
    const token = header?.replace(/^Bearer\s+/i, "").trim();
    return token ? registry.byAuthToken(token) : undefined;
  }

  return {
    app,
    hubHandlers: {
      onEvent: (_providerId: string, jobId: string, event: JobEvent) => {
        jobs.addEvent(jobId, { ...event, at: event.at || Date.now() });
      },
      onResult: (providerId: string, jobId: string, result: string, durationMs: number) => {
        void finishJobOk(jobId, providerId, result, durationMs);
      },
      onError: (providerId: string, jobId: string, error: string, durationMs: number) => {
        void finishJobFailed(jobId, providerId, error, durationMs);
      },
      onAccepted: (_providerId: string, jobId: string) => {
        jobs.setStatus(jobId, "running");
      },
      onConnect: (providerId: string) => {
        const provider = registry.get(providerId);
        console.log(`[broker] node connected: ${provider?.label ?? providerId}`);
      },
      onDisconnect: (providerId: string) => {
        const provider = registry.get(providerId);
        console.log(`[broker] node disconnected: ${provider?.label ?? providerId}`);
      },
    },
    /** Fail jobs that have run past the ceiling; called on a timer. */
    sweep(): void {
      for (const job of jobs.overdue()) {
        void finishJobFailed(job.id, job.providerId ?? "", "job timed out", jobs.runtimeMs(job));
      }
      for (const id of registry.reap()) {
        console.log(`[broker] reaped idle provider ${id}`);
      }
    },
  };
}

function validateRegistration(body: RegisterRequest): string | null {
  if (!body?.label?.trim()) return "label is required";
  if (!body.accountId || !/^\d+\.\d+\.\d+$/.test(body.accountId)) {
    return "accountId must be a Hedera account id like 0.0.12345";
  }
  if (!body.nodeId?.trim()) return "nodeId is required";
  if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) {
    return "at least one capability is required";
  }
  for (const cap of body.capabilities as Capability[]) {
    if (!cap.id || !cap.adapter) return "each capability needs an id and an adapter";
    if (!Number.isFinite(cap.priceUsdMicros) || cap.priceUsdMicros <= 0) {
      return `capability "${cap.id}" needs a positive priceUsdMicros`;
    }
  }
  return null;
}

/** Strip the bearer token before a provider record goes anywhere public. */
function stripSecrets<T extends { token?: string }>(record: T): Omit<T, "token"> {
  const { token: _token, ...rest } = record;
  return rest;
}

function publicJob(job: Job, opts: { events?: boolean } = {}) {
  return {
    id: job.id,
    title: job.request.title ?? null,
    prompt: job.request.prompt,
    adapter: job.request.adapter ?? null,
    status: job.status,
    createdAt: job.createdAt,
    assignedAt: job.assignedAt ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    providerId: job.providerId ?? null,
    providerLabel: job.providerLabel ?? null,
    providerAccountId: job.providerAccountId ?? null,
    priceUsdMicros: job.priceUsdMicros ?? null,
    priceLabel: job.priceUsdMicros ? formatUsd(job.priceUsdMicros) : null,
    payment: job.payment ?? null,
    result: job.result ?? null,
    resultHash: job.resultHash ?? null,
    error: job.error ?? null,
    receiptConsensusAt: job.receiptConsensusAt ?? null,
    eventCount: job.events.length,
    events: opts.events ? job.events : undefined,
  };
}

export type { AdapterKind, JobRequest };
