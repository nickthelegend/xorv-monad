/**
 * The broker's HTTP surface.
 *
 * The interesting part is `POST /api/jobs/:quoteId`. It is an ordinary x402
 * protected route, but its `payTo` resolves to the **provider's own
 * address** rather than to us. The broker introduces the two parties, witnesses
 * the result and publishes the receipt; it never holds anyone's money. That is
 * also why a quote is a first-class object — see jobs.ts.
 *
 * ## Why payment settles before the job runs
 *
 * An EIP-3009 authorization carries `validAfter` and `validBefore` timestamps,
 * and x402 advertises a 300-second window. The buyer signs an authorization the
 * facilitator must relay inside it, so if the broker waited for a five-minute
 * coding job to finish before submitting, the signed payment would have expired
 * and the provider would be unpaid for work already done. So Xorv verifies and
 * settles up front, and covers the other
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
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  HEARTBEAT_INTERVAL_MS,
  JOB_TIMEOUT_MS,
  assetSymbol,
  buildFacilitator,
  formatUsd,
  isAccountAddress,
  explorerAddress,
  explorerName,
  explorerBase,
  explorerTx,
  readLog,
  sha256,
  stablecoins as configuredStablecoins,
  usdMicrosToUnits,
  unitsToUsdMicros,
  type StablecoinInfo,
  type AdapterKind,
  type Capability,
  type DispatchedJob,
  type HeartbeatRequest,
  type Job,
  type JobEvent,
  QUOTE_TTL_SECONDS,
  type JobRequest,
  type LogJobReceipt,
  type PaymentRecord,
  type RegisterRequest,
  ESCROW_DEADLINE_SECONDS,
  ESCROW_SCHEME,
  EscrowServerScheme,
  escrowAddress as configuredEscrowAddress,
  escrowJobId,
  parseEscrowExtra,
  registerXorvPaymentSchemes,
} from "@xorv/protocol";
import { chainEscrow, type EscrowOps } from "./escrow.js";
import { ReputationBook, chainReputation, type ReputationSource } from "./reputation.js";
import type { BrokerConfig } from "./config.js";
import type { ChainLike } from "./chain.js";
import type { Hub } from "./hub.js";
import { JobStore, type Quote } from "./jobs.js";
import { Registry } from "./registry.js";
import { bodyLimit, rateLimit, requestLog } from "./guards.js";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { toClientEvmSigner } from "@x402/evm";
import {
  accountFor as demoAccountFor,
  choosePaymentAsset,
  onlyAssetPolicy,
  readClient as demoReadClient,
} from "@xorv/protocol";
import { erc20Abi } from "viem";

/** The most the demo account pays for one job, in micro-USD. Anyone can press the button. */
const DEMO_MAX_USD_MICROS = 250_000;
import { Metrics } from "./metrics.js";
import type { LogIndex } from "./log-index.js";

/**
 * Publish one heartbeat in this many on chain — see Chain.publishHeartbeat.
 *
 * 240 beats at the 15s interval is one on-chain liveness proof per provider per
 * hour. The Hedera version sampled 1 in 20 — one every five minutes — and that
 * number does not survive the move to an EVM chain, because every sample is a
 * contract write whose gas the broker pays.
 *
 * An audit append is ~43,500 gas. On an L2 that is a small fraction of a cent,
 * but at one every five minutes it is still 288 writes a day per provider —
 * paid in MON by the broker, which takes a 0% fee and earns nothing — and a
 * busy L1 blob market can multiply it. On Hedera an HCS message cost a
 * fraction of a cent and the arithmetic never mattered.
 *
 * Hourly still gives the log its actual job: a periodic, publicly checkable
 * proof that a node really was up. Sub-minute liveness is already carried by
 * the HTTP heartbeat and the control channel, neither of which touches a chain.
 */
const HEARTBEAT_PUBLISH_EVERY = 240;

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
   * path can be exercised without chain credentials or a real transfer.
   */
  facilitator?: FacilitatorClient;
  /**
   * Override the stablecoins the 402 offers.
   *
   * Production reads the network table (with `XORV_STABLECOIN` applied). Tests
   * pass a fixed list so the quote path stays deterministic. Nothing here
   * touches the network: each token's EIP-712 domain is configured rather than
   * read, because AUSD signs under "Agora Dollar", not its `name()`.
   */
  stablecoins?: StablecoinInfo[];
  metrics?: Metrics;
  /**
   * Override the escrow the broker settles jobs through. Production builds it
   * from `XORV_ESCROW_ADDRESS` and the operator key; tests pass `MemoryEscrow`.
   * `null` turns escrow off, and the broker pays providers directly (`exact`).
   */
  escrow?: EscrowOps | null;
  /** Override the reputation registry . `null` turns on-chain reputation off. */
  reputation?: ReputationSource | null;
  /**
   * The persisted audit-log index. When present, log reads are served from it
   * and never touch the RPC on the request path.
   */
  logIndex?: LogIndex;
}

export function createApp(deps: AppDeps) {
  const { config, chain, registry, jobs } = deps;
  const app = new Hono();
  const heartbeatCounters = new Map<string, number>();

  /**
   * The stablecoins every 402 offers, default (AUSD) first, fixed at boot.
   *
   * Fixed because the paid route's `accepts` array is built once below, one
   * row per token, and x402 asks for requirements twice per payment — both
   * answers must list the same tokens in the same order.
   */
  const tokens = deps.stablecoins ?? configuredStablecoins(config.network);
  if (tokens.length === 0) throw new Error(`no stablecoin configured for ${config.network}`);

  /**
   * How long a quote stays payable. The escrow deadline is fixed when the
   * quote is made, so a quote paid late would leave the job little or no time
   * before anyone may refund it (and XorvEscrow refuses to fund with under a
   * minute left). With the default 30-minute deadline this is the usual 5
   * minutes; with a short one it shrinks so a paid job always gets two.
   */
  function quoteTtlSeconds(): number {
    if (!escrow) return QUOTE_TTL_SECONDS;
    return Math.max(30, Math.min(QUOTE_TTL_SECONDS, config.escrowDeadlineSeconds - 120));
  }

  /** Quotes with a payment attempt running — see the /api/jobs/:quoteId guard. */
  const quotesInFlight = new Set<string>();
  /** Jobs whose receipt is already on chain — see publishReceiptWhenReady. */
  const publishedReceipts = new Set<string>();
  const metrics = deps.metrics ?? new Metrics();

  const built = deps.facilitator
    ? {
        facilitator: deps.facilitator,
        description: "injected (test)",
        feePayer: config.operatorAddress,
      }
    : buildFacilitator({
        mode: config.facilitatorMode,
        network: config.network,
        feePayerAddress: config.operatorAddress,
        feePayerKey: config.operatorKey,
        escrow: config.escrowAddress,
        onWrite: (phase) => chain.noteWrite?.(phase),
      });
  const { facilitator, description: facilitatorDescription, feePayer } = built;

  // No `defaultAssets` to configure, because every price this server quotes is
  // an explicit `{asset, amount, extra}` rather than a dollar figure the scheme
  // has to look up. That matters here specifically: the scheme's built-in asset
  // registry knows nothing about AUSD, so a Money-typed price would resolve to
  // the wrong token or to nothing at all.
  const x402Server = new x402ResourceServer(facilitator)
    .register("eip155:*" as Network, new ExactEvmScheme())
    .register("eip155:*" as Network, new EscrowServerScheme());

  /**
   * Where paid jobs' money waits, or null to pay providers directly.
   *
   * With escrow on, the 402 offers the `escrow` scheme first and `exact`
   * after it: Xorv's own clients take escrow, a stock x402 client that only
   * speaks `exact` can still pay.
   */
  const escrow: EscrowOps | null =
    deps.escrow !== undefined
      ? deps.escrow
      : config.escrowAddress
        ? chainEscrow(chain, config.escrowAddress)
        : null;

  /** On-chain reputation from XorvRegistry, or null without a registry. */
  const reputationSource: ReputationSource | null =
    deps.reputation !== undefined
      ? deps.reputation
      : config.registryAddress
        ? chainReputation(chain, config.registryAddress)
        : null;
  const reputation = reputationSource
    ? new ReputationBook(reputationSource, { log: (m) => console.error(`[broker] ${m}`) })
    : null;
  let sweeps = 0;

  /** Re-read the on-chain record of whoever an escrow settlement just touched. */
  function refreshReputation(...addresses: Array<string | null | undefined>): void {
    if (!reputation) return;
    const wanted = new Set(addresses.filter(Boolean).map((a) => a!.toLowerCase()));
    for (const provider of registry.list()) {
      if (wanted.has(provider.address.toLowerCase())) void reputation.refresh(provider);
    }
  }

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
  app.use("/api/demo/pay", rateLimit({ limit: 10, windowMs: 60_000 }));

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
    const paid = carriesPayment(c.req.header.bind(c.req));
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
    const allJobs = jobs.list({ limit: 1000 });
    // Money that actually reached a provider: a direct (exact) payment, or an
    // escrow that was released. A refunded escrow paid nobody, and one still
    // held hasn't paid anyone yet — counting either overstated the network.
    const settled = allJobs.filter(
      (j) => j.payment && (j.payment.escrow ? j.payment.escrow.state === "released" : true),
    );
    return c.json({
      network: config.network,
      facilitator: { mode: config.facilitatorMode, description: facilitatorDescription, feePayer },
      operator: {
        address: config.operatorAddress,
        url: explorerAddress(config.network, config.operatorAddress),
      },
      stablecoins: publicTokens(),
      explorerName: explorerName(config.network),
      // Where this broker's links point. A client builds its own explorer links
      // from this rather than from a network table that can't know a local
      // node's viewer (or a deployment's chosen explorer).
      explorer: explorerBase(config.network),
      log: chain.describeLog(),
      // The two contracts that make this more than a broker's promise.
      escrow: escrow
        ? {
            address: escrow.address,
            url: explorerAddress(config.network, escrow.address),
            deadlineSeconds: config.escrowDeadlineSeconds,
          }
        : null,
      registry: reputation
        ? { address: reputation.address, url: explorerAddress(config.network, reputation.address) }
        : null,
      // Entries the log index has read back from the chain — the audit log's
      // real totals. This process's own write counters reset on every restart,
      // so they are only the fallback when no index is running.
      logPublished: deps.logIndex?.counts() ?? chain.counts(),
      logLastError: chain.lastPublishError(),
      stats: {
        providersLive: live.length,
        providersConnected: deps.getHub()?.connectedCount() ?? 0,
        capacity: live.reduce((n, p) => n + p.capabilities.length, 0),
        jobsTotal: allJobs.length,
        jobsCompleted: allJobs.filter((j) => j.status === "completed").length,
        // Paid and released — the jobs "paid to providers" is summed over. The
        // pages labelled jobsCompleted "settled", which also counted a job that
        // finished without its payment landing.
        jobsSettled: settled.length,
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
        address: p.address,
        addressUrl: explorerAddress(config.network, p.address),
        endpoint: p.endpoint,
        status: p.status,
        connected: hub?.isConnected(p.id) ?? false,
        activeJobs: p.activeJobs,
        capabilities: p.capabilities,
        // Per capability, from the node's last heartbeat: false while it is at
        // capacity, paused, or its agent's login has expired. The matcher
        // skips those; the UI says so rather than listing them as buyable.
        available: p.available,
        lastHeartbeatAt: p.lastHeartbeatAt,
        registeredAt: p.registeredAt,
        uptimeSeconds: p.uptimeSeconds,
        version: p.version,
        region: p.region,
        stats: p.stats,
        onchain: p.onchain ?? null,
      })),
      registry: reputation
        ? { address: reputation.address, url: explorerAddress(config.network, reputation.address) }
        : null,
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

    // Registration is announced on chain, but a slow block must not hold up a
    // node that is ready to work.
    const registryResult = await chain.publishRegistration(provider).catch(() => null);
    if (registryResult) provider.registryTxHash = registryResult.transactionHash;
    // Sponsored into XorvRegistry in the background: the provider needs no MON,
    // and a slow block must not hold up a node that is ready to work.
    if (reputation) void reputation.onRegistered(provider, `${config.publicUrl}/api/providers/${provider.id}`);

    return c.json({
      provider: stripSecrets(provider),
      token: provider.token,
      wsUrl: `${config.publicUrl.replace(/^http/, "ws")}/ws/provider?token=${provider.token}`,
      registry: registryResult,
      network: config.network,
      stablecoins: publicTokens(),
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

  /**
   * Pay a quote from the deployment's demo account, for a visitor with no wallet.
   *
   * The job board used to hold this key itself, as a hosting secret. Here it
   * never leaves the machine the broker runs on, and the payment is still the
   * genuine article: the same x402 client any third party would use, against
   * this broker's own paid route, settling a real stablecoin transfer on
   * chain. Capped per job and rate limited, because anyone can press the button.
   *
   * The demo account pays in whichever offered stablecoin it can afford, in
   * the broker's order (AUSD first), exactly as `xorv run` would.
   */
  app.post("/api/demo/pay", async (c) => {
    const payerKey = process.env.XORV_DEMO_PAYER_KEY?.trim();
    if (!payerKey) {
      return c.json(
        { error: "No demo payer configured on this broker. Set XORV_DEMO_PAYER_KEY — see .env.example." },
        501,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as { quoteId?: string };
    const quoteId = body.quoteId?.trim();
    if (!quoteId) return c.json({ error: "quoteId is required" }, 400);
    const quote = jobs.getQuote(quoteId);
    if (!quote) {
      const paidJobId = jobs.paidJobIdForQuote(quoteId);
      if (paidJobId) return c.json({ error: "this quote has already been paid", jobId: paidJobId }, 409);
      return c.json({ error: "quote not found or expired — request a new one" }, 404);
    }
    // Paid already (Pay pressed again after going back): answer before building
    // a payment client, with the job the buyer is looking for.
    if (quote.jobId) return c.json({ error: "this quote has already been paid", jobId: quote.jobId }, 409);
    if (quote.priceUsdMicros > DEMO_MAX_USD_MICROS) {
      return c.json(
        {
          error: `the demo account pays for jobs up to $${(DEMO_MAX_USD_MICROS / 1_000_000).toFixed(2)} — sign in with a wallet for this one`,
        },
        403,
      );
    }

    try {
      const payer = demoAccountFor(payerKey);
      const reader = demoReadClient(config.network);
      const balances = await readTokenBalances(reader, payer.address).catch(() => ({}));
      const chosen = choosePaymentAsset(
        quote.options.map((o) => ({ asset: o.asset, amount: quote.amountUnits, symbol: o.symbol })),
        { balances },
      );
      const client = new x402Client();
      registerXorvPaymentSchemes(client, toClientEvmSigner(payer, reader));
      if (chosen) client.registerPolicy(onlyAssetPolicy(chosen.asset));
      const paidFetch = wrapFetchWithPayment(fetch, client);
      const res = await paidFetch(`http://127.0.0.1:${config.port}/api/jobs/${quoteId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
      if (!res.ok || !payload.jobId) {
        const error = payload.error ?? `payment failed (${res.status})`;
        // Already paid: the job id is what the buyer needs, so it goes back
        // with the 409 (the app then opens that job instead of showing an error).
        if (res.status === 409) return c.json({ error, ...(payload.jobId ? { jobId: payload.jobId } : {}) }, 409);
        if (res.status === 404) return c.json({ error }, 404);
        return c.json({ error }, 502);
      }
      const settlement = new x402HTTPClient(client).getPaymentSettleResponse((name) => res.headers.get(name));
      return c.json({
        jobId: payload.jobId,
        payer: payer.address,
        asset: chosen?.symbol ?? null,
        transaction: settlement?.transaction ?? null,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/quotes", async (c) => {
    const body = (await c.req.json()) as JobRequest;
    if (!body?.prompt?.trim()) return c.json({ error: "prompt is required" }, 400);
    if (body.prompt.length > 20_000) return c.json({ error: "prompt is too long (max 20k chars)" }, 400);

    const maxPrice = Number(body.maxPriceUsdMicros);
    if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
      return c.json({ error: "maxPriceUsdMicros must be a positive number" }, 400);
    }

    const match = registry.match({
      adapter: body.adapter ?? null,
      maxPriceUsdMicros: maxPrice,
      // A node whose socket just dropped still has a recent heartbeat; quoting
      // it sells a job that can't be delivered.
      exclude: unreachableProviders(),
    });
    if (!match) {
      const live = registry.live().length;
      return c.json(
        {
          error:
            live === 0
              ? "no providers are online right now — try again in a few minutes"
              : noMatchReason(
                  registry.live(),
                  body.adapter ?? null,
                  maxPrice,
                  inFlightByProvider(),
                  new Set(unreachableProviders()),
                ),
          providersLive: live,
        },
        // Nobody online is the network being unavailable. Providers online but
        // none within the buyer's ceiling or adapter is a request that can't be
        // met as asked — the buyer's to change, not a server failure.
        live === 0 ? 503 : 422,
      );
    }

    metrics.inc('xorv_quotes_total');
    const quote = jobs.createQuote({
      request: { ...body, prompt: body.prompt, maxPriceUsdMicros: maxPrice },
      providerId: match.provider.id,
      providerLabel: match.provider.label,
      providerAddress: match.provider.address,
      capabilityId: match.capability.id,
      capabilityName: match.capability.displayName,
      priceUsdMicros: match.capability.priceUsdMicros,
      amountUnits: usdMicrosToUnits(match.capability.priceUsdMicros),
      options: tokens.map((t) => ({ symbol: t.symbol, asset: t.address, eip712: { ...t.eip712 } })),
    }, quoteTtlSeconds());
    if (escrow) {
      // Frozen with the price: the buyer's signature commits to this job id
      // and deadline, so both 402 passes must produce exactly these.
      quote.escrow = {
        address: escrow.address,
        jobId: escrowJobId(quote.id),
        deadline: Math.floor(quote.createdAt / 1000) + config.escrowDeadlineSeconds,
      };
    }

    return c.json({
      quoteId: quote.id,
      payUrl: `${config.publicUrl}/api/jobs/${quote.id}`,
      priceUsdMicros: quote.priceUsdMicros,
      priceLabel: formatUsd(quote.priceUsdMicros),
      expiresAt: quote.expiresAt,
      provider: {
        id: match.provider.id,
        label: match.provider.label,
        address: match.provider.address,
        addressUrl: explorerAddress(config.network, match.provider.address),
        capability: match.capability.displayName,
        adapter: match.capability.adapter,
        model: match.capability.model ?? null,
        stats: match.provider.stats,
      },
      // One row per stablecoin, in the order the 402 will offer them (AUSD
      // first). The same amount on every row: all are 6-decimal dollars. A
      // buyer uses this to decide which one it can pay with before signing.
      accepts: quote.options.map((o) => ({
        symbol: o.symbol,
        asset: o.asset,
        amount: quote.amountUnits,
      })),
      escrow: quote.escrow
        ? {
            ...quote.escrow,
            addressUrl: explorerAddress(config.network, quote.escrow.address),
          }
        : null,
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
      // Every field is read from the quote rather than recomputed — see
      // Quote.amountUnits for why recomputing here silently breaks
      // correctly-signed payments.
      //
      // One row per configured stablecoin, AUSD first. A stock x402 client
      // pays the first row it supports; Xorv's own clients pick the first one
      // the buyer can afford, or the one named with `--token`.
      accepts: [
        // Escrow first: the money waits in XorvEscrow until the job delivers.
        ...(escrow
          ? tokens.map((token, index) => ({
              scheme: ESCROW_SCHEME,
              network: config.network as Network,
              payTo: escrow.address,
              price: (ctx: HTTPRequestContext) => {
                const quote = quoteFromContext(ctx);
                const option = quote?.options[index];
                return {
                  asset: option?.asset ?? token.address,
                  amount: quote?.amountUnits ?? "0",
                  extra: {
                    ...(option?.eip712 ?? token.eip712),
                    escrow: escrow.address,
                    jobId: quote?.escrow?.jobId ?? escrowJobId("expired"),
                    deadline: quote?.escrow?.deadline ?? 0,
                    provider: quote?.providerAddress,
                  },
                };
              },
              maxTimeoutSeconds: 300,
            }))
          : []),
        // Then `exact`, for stock x402 clients: straight to the provider.
        ...tokens.map((token, index) => ({
          scheme: "exact",
          network: config.network as Network,
          payTo: (ctx: HTTPRequestContext) => quoteFromContext(ctx)?.providerAddress ?? "",
          price: (ctx: HTTPRequestContext) => {
            const quote = quoteFromContext(ctx);
            const option = quote?.options[index];
            return {
              asset: option?.asset ?? token.address,
              amount: quote?.amountUnits ?? "0",
              // The EIP-712 domain travels with the price because x402 carries
              // it as `extra` on the requirement. See Quote.options.
              extra: { ...(option?.eip712 ?? token.eip712) },
            };
          },
          maxTimeoutSeconds: 300,
        })),
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
                accepts: quote.options.map((o) => o.symbol),
                escrow: quote.escrow ?? null,
                hint: `Sign an EIP-3009 authorization from an address holding ${quote.options.map((o) => o.symbol).join(" or ")} and retry with the PAYMENT-SIGNATURE header. You need no MON — the facilitator relays it and pays the gas.${quote.escrow ? " With the escrow scheme the money waits in XorvEscrow until the job delivers, and is refundable by anyone after the deadline." : ""}`,
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
    const quoteId = c.req.param("quoteId") ?? "";
    const quote = jobs.getQuote(quoteId);
    if (!quote) {
      const paidJobId = jobs.paidJobIdForQuote(quoteId);
      if (paidJobId) return c.json({ error: "this quote has already been paid", jobId: paidJobId }, 409);
      return c.json({ error: "quote not found or expired — request a new one" }, 404);
    }
    if (quote.jobId) {
      return c.json({ error: "this quote has already been paid", jobId: quote.jobId }, 409);
    }
    const provider = registry.get(quote.providerId);
    if (!provider || provider.status === "offline") {
      return c.json({ error: "the quoted provider went offline — request a new quote" }, 409);
    }
    if (!carriesPayment(c.req.header.bind(c.req))) return next();
    // One quote, one payment attempt at a time. x402 settles after the handler
    // runs, so concurrent attempts on one quote — a double-clicked Pay — all
    // passed verification (the authorization's nonce wasn't used yet), each
    // created and dispatched a job, and only one settlement could land: found
    // live, two jobs ran unpaid and the paid one was marked failed by a
    // sibling's reverted settle. The claim is taken synchronously, before any
    // await, and released when the attempt ends; a finished attempt leaves
    // quote.jobId set, so the next one gets "already paid" above.
    if (quotesInFlight.has(quoteId)) {
      return c.json(
        { error: "a payment for this quote is already in progress — wait for it to finish, or request a new quote" },
        409,
      );
    }
    quotesInFlight.add(quoteId);
    try {
      await next();
    } finally {
      quotesInFlight.delete(quoteId);
    }
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

  // A settlement is the one write that must never lose a race for the RPC's
  // rate budget, so background readers (the log index) wait while it runs.
  x402Server.onBeforeSettle(async () => {
    chain.noteWrite?.("start");
  });
  /**
   * The job a settlement (or a failed one) belongs to.
   *
   * Escrow payments name their job exactly: `extra.jobId` is derived from the
   * quote id. Direct payments only name the provider, so for those it is the
   * most recent unpaid job for that provider account — quote ids are
   * single-use and the job is created synchronously in the handler above, so
   * that is unambiguous.
   */
  function jobForSettlement(requirements: {
    scheme: string;
    payTo: string;
    extra?: Record<string, unknown>;
  }): Job | undefined {
    const recent = jobs.list({ limit: 100 });
    if (requirements.scheme === ESCROW_SCHEME) {
      const jobId = String(requirements.extra?.jobId ?? "").toLowerCase();
      return recent.find((j) => j.quoteId && escrowJobId(j.quoteId).toLowerCase() === jobId);
    }
    return recent.find((j) => !j.payment && j.providerAddress === requirements.payTo);
  }

  /**
   * A payment that failed to settle must not leave work running for free.
   *
   * x402 settles after the handler has returned, and the handler has already
   * dispatched the job. So a failed settlement — an authorization that
   * expired in flight, an RPC error, a reverted `fund` — would otherwise leave
   * a provider doing unpaid work and the buyer watching a job they never paid
   * for. Stop it and say why.
   */
  function stopUnpaidJob(
    requirements: Parameters<typeof jobForSettlement>[0],
    why: string,
  ): void {
    const job = jobForSettlement(requirements);
    if (!job || job.payment || job.status === "completed" || job.status === "failed") return;
    const reason = `payment did not settle: ${why}`;
    if (job.providerId) {
      deps.getHub()?.send(job.providerId, { type: "job.cancel", jobId: job.id, reason });
      registry.jobAbandoned(job.providerId);
    }
    jobs.addEvent(job.id, { at: Date.now(), kind: "status", text: reason });
    jobs.fail(job.id, reason);
    metrics.inc("xorv_settlements_failed_total");
  }

  // A thrown settlement error arrives here…
  x402Server.onSettleFailure(async (ctx) => {
    chain.noteWrite?.("end");
    stopUnpaidJob(
      ctx.requirements,
      (ctx as { error?: Error }).error?.message ?? "the facilitator rejected it",
    );
  });

  /**
   * Capture settlement onto the job.
   *
   * The resource server settles after the handler returns, so this hook is the
   * only place with both the on-chain transaction hash and the job it paid for.
   */
  x402Server.onAfterSettle(async (ctx) => {
    chain.noteWrite?.("end");
    const result = ctx.result;
    // …and a settlement that *returned* failure (a reverted `fund`, an expired
    // authorization) arrives here instead, so both paths stop the job.
    if (!result?.success || !result.transaction) {
      stopUnpaidJob(ctx.requirements, result?.errorMessage ?? result?.errorReason ?? "unknown reason");
      return;
    }
    const { payTo, asset, amount, scheme } = ctx.requirements;
    const candidate = jobForSettlement(ctx.requirements);
    if (!candidate || candidate.payment) return;

    const record: PaymentRecord = {
      asset: assetSymbol(config.network, asset),
      assetId: asset,
      amount,
      network: config.network,
      transactionHash: result.transaction,
      payer: result.payer ?? "unknown",
      payTo,
      settledAt: Date.now(),
      explorerUrl: explorerTx(config.network, result.transaction),
      scheme: scheme === ESCROW_SCHEME ? "escrow" : "exact",
    };
    if (scheme === ESCROW_SCHEME) {
      const extra = parseEscrowExtra(ctx.requirements.extra);
      record.escrow = {
        address: extra.escrow,
        jobId: extra.jobId,
        deadline: extra.deadline,
        state: "funded",
        provider: extra.provider ?? candidate.providerAddress ?? "",
        fundTx: result.transaction,
        explorerUrl: explorerAddress(config.network, extra.escrow),
      };
    }
    jobs.patch(candidate.id, { payment: record });
    if (record.escrow) {
      jobs.addEvent(candidate.id, {
        at: Date.now(),
        kind: "status",
        text: `${record.asset} held in escrow until the job delivers`,
      });
    }
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
   * With escrow, cancelling refunds the buyer: the money never left the
   * escrow, so there is nothing to chase. A direct (`exact`) payment already
   * reached the provider and is not refunded — the provider may have burned
   * real quota on it.
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
      // The buyer calling it off is not the provider failing — the escrow's
      // `cancel` carries no mark on chain, and the broker's record agrees.
      registry.jobAbandoned(job.providerId);
    }
    jobs.addEvent(job.id, { at: Date.now(), kind: "status", text: reason });
    jobs.fail(job.id, reason);
    metrics.inc("xorv_jobs_cancelled_total");
    // The payment already settled, so the audit trail still records it — as a
    // failed job. The provider's own late "failed" report is ignored (see
    // finishJobFailed), so this is the one place the receipt goes out.
    void publishReceiptWhenReady(job.id, jobs.runtimeMs(job), false);
    const refunding = Boolean(escrow) && job.payment?.scheme !== "exact";
    // `cancel`, not `refund`: the buyer calling it off must not cost the
    // provider a permanent mark in the on-chain registry.
    if (refunding) void settleEscrow(job.id, { kind: "cancel" });

    return c.json({ ok: true, jobId: job.id, status: "failed", refunded: refunding });
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

  /**
   * The public audit trail, read straight from the chain.
   *
   * Served by the broker for convenience only. Nothing here is privileged —
   * the same entries are readable by anyone from any public RPC endpoint, which is
   * the whole point of putting them on chain rather than in our database.
   */
  app.get("/api/receipts", async (c) => {
    const log = chain.describeLog();
    if (!log) return c.json({ receipts: [], log: null });
    if (deps.logIndex) {
      return c.json({
        log,
        receipts: deps.logIndex.entries({ kind: "job.receipt", limit: 50 }).map((e) => ({
          sequence: e.sequence,
          blockNumber: e.blockNumber,
          transactionHash: e.transactionHash,
          author: e.author,
          payload: e.payload,
        })),
        sync: deps.logIndex.sync(),
      });
    }
    try {
      const entries = await readLog(config.network, {
        kind: "job.receipt",
        limit: 50,
        address: log.address,
      });
      return c.json({
        log,
        receipts: entries.map((e) => ({
          sequence: e.sequence,
          blockNumber: e.blockNumber,
          transactionHash: e.transactionHash,
          author: e.author,
          payload: e.payload,
        })),
      });
    } catch (err) {
      return c.json({ receipts: [], log, error: (err as Error).message }, 502);
    }
  });

  app.get("/api/log/:kind", async (c) => {
    const kind = c.req.param("kind");
    const map = {
      registry: "provider.registered",
      heartbeat: "provider.heartbeat",
      receipts: "job.receipt",
    } as const;
    const mapped = map[kind as keyof typeof map];
    if (!mapped) return c.json({ error: `unknown log stream "${kind}"` }, 404);
    const log = chain.describeLog();
    if (!log) return c.json({ error: "no audit log contract configured" }, 404);
    if (deps.logIndex) {
      return c.json({ log, entries: deps.logIndex.entries({ kind: mapped, limit: 50 }), sync: deps.logIndex.sync() });
    }
    const entries = await readLog(config.network, {
      kind: mapped,
      limit: 50,
      address: log.address,
    });
    return c.json({ log, entries });
  });

  // -------------------------------------------------------------------------
  // Dispatch + completion
  // -------------------------------------------------------------------------

  /**
   * A paid job that never reached a node. It used to be marked failed and
   * left there, with the buyer's money held in escrow until the deadline —
   * found when a quote landed on a node that had just gone away. Refunded now,
   * without a mark: the node never took the job.
   */
  function failBeforeStart(job: Job, reason: string): void {
    jobs.fail(job.id, reason);
    if (escrow) void settleEscrow(job.id, { kind: "cancel" });
    void publishReceiptWhenReady(job.id, 0, false);
  }

  /** Jobs each provider is running right now, by capability id. */
  function inFlightByProvider(): Map<string, Map<string, number>> {
    const counts = new Map<string, Map<string, number>>();
    for (const job of jobs.list({ limit: 500 })) {
      if (!job.providerId || !job.capabilityId) continue;
      if (job.status !== "assigned" && job.status !== "running") continue;
      const byCapability = counts.get(job.providerId) ?? new Map<string, number>();
      byCapability.set(job.capabilityId, (byCapability.get(job.capabilityId) ?? 0) + 1);
      counts.set(job.providerId, byCapability);
    }
    return counts;
  }

  /** Providers heartbeating but without an open control channel: they can't be sent a job. */
  function unreachableProviders(): string[] {
    const hub = deps.getHub();
    if (!hub) return [];
    return registry.live().filter((p) => !hub.isConnected(p.id)).map((p) => p.id);
  }

  function dispatch(job: Job): void {
    const hub = deps.getHub();
    const provider = job.providerId ? registry.get(job.providerId) : undefined;
    if (!provider || !hub) {
      failBeforeStart(job, "no control channel to the provider");
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
      if (!reassign(job)) failBeforeStart(job, "provider disconnected before the job could start");
      return;
    }

    registry.jobStarted(provider.id);
    jobs.setStatus(job.id, "assigned");
  }

  /**
   * Hand an already-paid job to a different provider.
   *
   * The poster is not charged again. With escrow the money never moved, so
   * the escrow's payee is switched to the new provider and the failed one gets
   * an on-chain mark in the registry. Paid directly (`exact`), the money is
   * already with the first provider and the reassignment is on the network.
   */
  function reassign(job: Job): boolean {
    // Excluding the failed node matters: the matcher prefers the cheapest, and
    // a cheap node that just failed would otherwise be picked again — at which
    // point the job was refunded while a working node sat idle.
    const match = registry.match({
      adapter: job.request.adapter ?? null,
      maxPriceUsdMicros: job.request.maxPriceUsdMicros,
      exclude: [...(job.providerId ? [job.providerId] : []), ...unreachableProviders()],
    });
    if (!match) return false;
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
      // The payee moves with the job. Left stale, the receipt and the escrow
      // release both named the provider that failed.
      providerAddress: match.provider.address,
      capabilityId: match.capability.id,
      status: "assigned",
    });
    if (escrow) void settleEscrow(job.id, { kind: "reassign", provider: match.provider.address });
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
    // A terminal job stays terminal: a result racing a cancel must not turn a
    // cancelled job back into a completed one.
    const current = jobs.get(jobId);
    if (!current || current.status === "completed" || current.status === "failed") return;
    const hash = sha256(result);
    const job = jobs.complete(jobId, result, hash);
    if (!job) return;

    const earned = earnings(job);
    registry.jobFinished(providerId, { ok: true, durationMs, ...earned });
    metrics.inc('xorv_jobs_completed_total');
    metrics.observe('xorv_job_duration', durationMs);
    void publishReceiptWhenReady(job.id, durationMs, true);
    if (escrow) void settleEscrow(job.id, { kind: "release", resultHash: hash });
  }

  /**
   * Publish a job's on-chain receipt once there is actually something to attest to.
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
   *
   * An escrowed payment is only attested once the escrow has settled. The
   * receipt used to go out at funding time, naming the provider as payee —
   * so a job that was then refunded sat in the public log looking paid. Now
   * it waits for the release or refund and records which, with that
   * transaction. If the broker's own settlement doesn't land, the receipt is
   * left for `reconcileEscrow`, which publishes it when the chain settles.
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
    if (!job || job.receiptTxHash) return;
    if (publishedReceipts.has(jobId)) return;

    let settlement: LogJobReceipt["settlement"];
    if (job.payment?.escrow) {
      // Let a settlement queued by the same caller start, then wait it out.
      await new Promise((resolve) => setImmediate(resolve));
      await escrowQueue.get(jobId);
      job = jobs.get(jobId);
      const record = job?.payment?.escrow;
      if (!job || !record || record.state === "funded") return;
      const tx = record.state === "released" ? record.releaseTx : record.refundTx;
      if (!tx) return;
      settlement = {
        escrow: record.address,
        state: record.state,
        paidTo: record.state === "released" ? record.provider : job.payment!.payer,
        transactionHash: tx,
      };
    }
    if (publishedReceipts.has(jobId)) return;
    publishedReceipts.add(jobId);

    const receipt = await chain.publishReceipt({
      jobId: job.id,
      providerId: job.providerId ?? "",
      providerAddress: job.providerAddress ?? "",
      payer: job.payment?.payer ?? "unpaid",
      asset: job.payment?.assetId ?? "",
      amount: job.payment?.amount ?? "0",
      transactionHash: job.payment?.transactionHash ?? "",
      resultHash: job.resultHash ?? "",
      durationMs,
      ok,
      ...(settlement ? { settlement } : {}),
    });
    if (receipt) {
      jobs.patch(job.id, { receiptTxHash: receipt.transactionHash });
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
    // A provider reports "failed" after a buyer cancels — its adapter was killed.
    // Accepting that report overwrote the real reason ("cancelled by the buyer")
    // with the adapter's generic one, counted the failure against the provider a
    // second time, and even tried to reassign a job the buyer had stopped.
    if (job.status === "completed" || job.status === "failed") return;
    registry.jobFinished(providerId, { ok: false, durationMs });
    metrics.inc('xorv_jobs_failed_total');

    // One free retry elsewhere before the poster is told it failed.
    if (reassign(job)) return;

    jobs.fail(jobId, error);
    if (escrow) void settleEscrow(jobId, { kind: "refund" });
    await publishReceiptWhenReady(jobId, durationMs, false);
  }

  type EscrowAction =
    | { kind: "release"; resultHash: string }
    | { kind: "refund" }
    | { kind: "cancel" }
    | { kind: "reassign"; provider: string };

  /** Settlements in flight per job, so a reassign always lands before the release that follows it. */
  const escrowQueue = new Map<string, Promise<void>>();

  /**
   * Move a job's escrowed money: release, refund, or switch the payee.
   *
   * Waits for funding first. A job can finish before its payment is recorded
   * — the resource server settles after the handler returns — and the escrow
   * rejects any move on a job it doesn't hold yet.
   *
   * Actions on one job run strictly in order, because "reassign, then release"
   * is a real sequence: a release that overtook its reassign would pay the
   * provider that failed.
   *
   * A settlement that keeps failing is recorded on the job (`lastError`) and
   * left for the deadline: nothing is lost, because the buyer — or anyone —
   * can refund once it passes, and the buyer can release early themselves.
   */
  function settleEscrow(jobId: string, action: EscrowAction): Promise<void> {
    const previous = escrowQueue.get(jobId) ?? Promise.resolve();
    const next = previous.then(() => runEscrowAction(jobId, action)).catch(() => {});
    escrowQueue.set(jobId, next);
    void next.finally(() => {
      if (escrowQueue.get(jobId) === next) escrowQueue.delete(jobId);
    });
    return next;
  }

  async function runEscrowAction(jobId: string, action: EscrowAction): Promise<void> {
    if (!escrow) return;
    const waitUntil = Date.now() + config.escrowFundingWaitMs;
    let job = jobs.get(jobId);
    while (job && !job.payment && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      job = jobs.get(jobId);
    }
    const payment = job?.payment;
    if (!job || !payment?.escrow) return; // unpaid, or paid directly: nothing held
    if (payment.escrow.state !== "funded") return;

    const record = payment.escrow;
    const jobIdHex = record.jobId as `0x${string}`;
    const update = (patch: Partial<typeof record>) => {
      const fresh = jobs.get(jobId);
      if (!fresh?.payment?.escrow) return;
      jobs.patch(jobId, {
        payment: { ...fresh.payment, escrow: { ...fresh.payment.escrow, ...patch } },
      });
    };

    for (let attempt = 1; attempt <= config.escrowRetries; attempt++) {
      try {
        if (action.kind === "reassign") {
          if (record.provider.toLowerCase() === action.provider.toLowerCase()) return;
          const tx = await escrow.reassign(jobIdHex, action.provider);
          update({
            provider: action.provider,
            reassignTxs: [...(record.reassignTxs ?? []), tx],
            lastError: undefined,
          });
          refreshReputation(record.provider);
          jobs.addEvent(jobId, { at: Date.now(), kind: "status", text: "escrow payee moved to the new provider" });
          return;
        }
        if (action.kind === "release") {
          // The escrow pays whoever it has on record. If an earlier reassign
          // failed to land, fix that first rather than pay the wrong node.
          const current = jobs.get(jobId);
          const onChain = await escrow.read(jobIdHex);
          if (
            current?.providerAddress &&
            onChain.provider.toLowerCase() !== current.providerAddress.toLowerCase()
          ) {
            await escrow.reassign(jobIdHex, current.providerAddress);
          }
          const tx = await escrow.release(jobIdHex, action.resultHash);
          update({ state: "released", releaseTx: tx, resultHash: action.resultHash, lastError: undefined });
          jobs.addEvent(jobId, {
            at: Date.now(),
            kind: "status",
            text: `escrow released to the provider · ${explorerTx(config.network, tx)}`,
          });
          metrics.inc("xorv_escrow_released_total");
          refreshReputation(current?.providerAddress ?? record.provider);
          return;
        }
        const tx =
          action.kind === "cancel" ? await escrow.cancel(jobIdHex) : await escrow.refund(jobIdHex);
        update({ state: "refunded", refundTx: tx, lastError: undefined });
        jobs.addEvent(jobId, {
          at: Date.now(),
          kind: "status",
          text: `escrow refunded to the buyer · ${explorerTx(config.network, tx)}`,
        });
        metrics.inc("xorv_escrow_refunded_total");
        refreshReputation(record.provider);
        return;
      } catch (err) {
        const message = err instanceof Error ? (err as Error & { shortMessage?: string }).shortMessage ?? err.message : String(err);
        console.error(`[broker] escrow ${action.kind} for ${jobId} failed (attempt ${attempt}): ${message}`);
        update({ lastError: `${action.kind}: ${message}` });
        if (attempt < config.escrowRetries) {
          await new Promise((resolve) => setTimeout(resolve, config.escrowRetryDelayMs * attempt));
        }
      }
    }
  }

  /**
   * Bring every job the broker thinks is still funded in line with the chain.
   *
   * Two things can leave the broker's record behind the contract. Someone
   * else settled it — the buyer released early, or a keeper refunded after
   * the deadline, as the contract lets anyone do — and the broker must show
   * that, with the transaction, instead of "held in escrow" forever. Or
   * nobody did, because the broker itself was down when the job ended; once
   * the deadline has passed it refunds the buyer with `cancel`, which carries
   * no mark against the provider: the broker's outage is not their failure.
   */
  let reconciling = false;

  /**
   * Stop a running job whose money has already gone elsewhere. Marking it
   * failed alone left the node working on it, unpaid, holding its only slot —
   * found live when a buyer refunded a stalled job from the job page.
   */
  function abandon(job: Job, reason: string): void {
    if (job.providerId && (job.status === "assigned" || job.status === "running")) {
      deps.getHub()?.send(job.providerId, { type: "job.cancel", jobId: job.id, reason });
      registry.jobAbandoned(job.providerId);
    }
    jobs.addEvent(job.id, { at: Date.now(), kind: "status", text: reason });
    jobs.fail(job.id, reason);
  }

  async function reconcileEscrow(): Promise<void> {
    if (!escrow || reconciling) return;
    reconciling = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      for (const job of jobs.list({ limit: 500 })) {
        const record = job.payment?.escrow;
        if (!record || record.state !== "funded" || escrowQueue.has(job.id)) continue;
        const onChain = await escrow.read(record.jobId as `0x${string}`).catch(() => null);
        if (!onChain) continue;
        if (onChain.status === "released" || onChain.status === "refunded") {
          const found = await escrow.settlement(record.jobId as `0x${string}`, record.fundTx).catch(() => null);
          jobs.patch(job.id, {
            payment: {
              ...job.payment!,
              escrow: {
                ...record,
                state: onChain.status,
                ...(onChain.status === "released" ? { releaseTx: found?.tx } : { refundTx: found?.tx }),
              },
            },
          });
          jobs.addEvent(job.id, {
            at: Date.now(),
            kind: "status",
            text: `escrow ${onChain.status} on chain${found ? ` by ${found.by} · ${explorerTx(config.network, found.tx)}` : ""}`,
          });
          if (job.status !== "completed" && job.status !== "failed") {
            abandon(job, `the escrow was ${onChain.status} on chain before the job finished`);
          }
          // Receipts for escrowed jobs wait for the settlement; this is it.
          void publishReceiptWhenReady(job.id, jobs.runtimeMs(job), jobs.get(job.id)?.status === "completed");
          refreshReputation(record.provider);
        } else if (onChain.status === "funded" && now > record.deadline + 30) {
          if (job.status !== "completed" && job.status !== "failed") {
            abandon(job, "not settled before the escrow deadline — refunded to the buyer");
          }
          void settleEscrow(job.id, { kind: "cancel" });
          void publishReceiptWhenReady(job.id, jobs.runtimeMs(job), jobs.get(job.id)?.status === "completed");
        }
      }
    } finally {
      reconciling = false;
    }
  }

  function earnings(job: Job): { earnedMicros?: number } {
    if (!job.payment) return {};
    return { earnedMicros: unitsToUsdMicros(job.payment.amount) };
  }

  /** The configured stablecoins, as the network panel and registration show them. */
  function publicTokens() {
    return tokens.map((t) => ({
      symbol: t.symbol,
      address: t.address,
      decimals: t.decimals,
      url: explorerAddress(config.network, t.address),
    }));
  }

  /** The payer's balance in each offered stablecoin, keyed by lowercase address. */
  async function readTokenBalances(
    reader: ReturnType<typeof demoReadClient>,
    owner: string,
  ): Promise<Record<string, bigint>> {
    const entries = await Promise.all(
      tokens.map(async (t) => {
        const units = (await reader.readContract({
          address: t.address as `0x${string}`,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner as `0x${string}`],
        })) as bigint;
        return [t.address.toLowerCase(), units] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function authProvider(header: string | undefined) {
    const token = header?.replace(/^Bearer\s+/i, "").trim();
    return token ? registry.byAuthToken(token) : undefined;
  }

  /**
   * How long a node may be gone before its in-flight jobs are failed over.
   *
   * Short enough that a buyer whose provider process died hears about it in a
   * minute rather than at the ten-minute job ceiling; long enough that a node on
   * flaky wifi reconnects, or delivers over the HTTP fallback, before anyone
   * gives up on it.
   */
  const DISCONNECT_GRACE_MS = 60_000;
  const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
        clearTimeout(disconnectTimers.get(providerId));
        disconnectTimers.delete(providerId);
      },
      onDisconnect: (providerId: string) => {
        const provider = registry.get(providerId);
        console.log(`[broker] node disconnected: ${provider?.label ?? providerId}`);
        // Before this, a job whose provider died simply waited out the ten-minute
        // ceiling while its buyer — who had already paid — watched "Running".
        clearTimeout(disconnectTimers.get(providerId));
        const timer = setTimeout(() => {
          disconnectTimers.delete(providerId);
          if (deps.getHub()?.isConnected(providerId)) return;
          for (const job of jobs.list({ limit: 500, providerId })) {
            if (job.status !== "assigned" && job.status !== "running") continue;
            console.log(
              `[broker] ${job.id}: provider gone for ${DISCONNECT_GRACE_MS / 1000}s — failing it over`,
            );
            void finishJobFailed(job.id, providerId, "provider disconnected mid-job", jobs.runtimeMs(job));
          }
        }, DISCONNECT_GRACE_MS);
        timer.unref?.();
        disconnectTimers.set(providerId, timer);
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
      // Once a minute at the 15s sweep: pick up outcomes settled by anyone,
      // including a buyer's own release or a keeper's refund.
      const everyMinute = sweeps++ % 4 === 0;
      if (reputation && everyMinute) {
        for (const provider of registry.live()) void reputation.refresh(provider);
      }
      if (escrow && everyMinute) void reconcileEscrow();
    },
  };
}

/**
 * Why nothing matched, in the buyer's terms: nobody sells that model right
 * now, or somebody does but above the budget. "No match" alone sent buyers to
 * raise a budget when the model they picked simply wasn't on offer.
 */
/** Whether a request carries an x402 payment, in either version's header. */
function carriesPayment(header: (name: string) => string | undefined): boolean {
  return Boolean(header("PAYMENT-SIGNATURE") || header("X-PAYMENT"));
}

function noMatchReason(
  live: Array<{ id: string; capabilities: Capability[]; available: Record<string, boolean> }>,
  adapter: AdapterKind | null,
  maxPriceUsdMicros: number,
  inFlight: Map<string, Map<string, number>> = new Map(),
  unreachable: ReadonlySet<string> = new Set(),
): string {
  const selling = (p: (typeof live)[number]) =>
    p.capabilities.filter((c) => p.available[c.id] !== false && (!adapter || c.adapter === adapter));
  // Only nodes the broker can dispatch to count. One that has registered but
  // whose job channel isn't open yet — a node that just restarted — used to be
  // counted here while the matcher skipped it, so a buyer was told "nothing
  // under $0.50 — the cheapest is $0.20".
  const offered = live.filter((p) => !unreachable.has(p.id)).flatMap(selling);
  const reconnecting = live.filter((p) => unreachable.has(p.id)).flatMap(selling);
  const sellers = adapter ? `every provider selling ${adapter}` : "every provider";

  if (offered.length === 0) {
    if (reconnecting.length > 0) {
      return adapter
        ? `the provider selling ${adapter} is reconnecting to the network — try again in a few seconds`
        : "the providers are reconnecting to the network — try again in a few seconds";
    }
    // A node switches a capability off both when it can't run it (signed out,
    // paused) and when every slot is taken. The second is a wait, not a gap in
    // the network — found when a buyer was told nobody sold Codex while the
    // only Codex node was mid-job.
    const full = live.some((p) =>
      p.capabilities.some(
        (c) =>
          (!adapter || c.adapter === adapter) &&
          (inFlight.get(p.id)?.get(c.id) ?? 0) >= Math.max(1, c.maxConcurrency),
      ),
    );
    if (full) return `${sellers} is busy with another job — try again in a moment`;
    return adapter
      ? `no online provider is selling ${adapter} right now — pick another model or try again later`
      : "every online provider is busy right now — try again in a moment";
  }
  const cheapest = Math.min(...offered.map((c) => c.priceUsdMicros));
  if (cheapest <= maxPriceUsdMicros) {
    // Something within budget exists but the matcher still found no one: it is
    // taken or failing its checks right now. Never quote a price that fits.
    return `${sellers} is busy right now — try again in a moment`;
  }
  return `no online provider ${adapter ? `selling ${adapter} ` : ""}under ${formatUsd(maxPriceUsdMicros)} — the cheapest is ${formatUsd(cheapest)}`;
}

function validateRegistration(body: RegisterRequest): string | null {
  if (!body?.label?.trim()) return "label is required";
  if (!body.address || !isAccountAddress(body.address)) {
    return "address must be an EVM address like 0xff21…489B";
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
    providerAddress: job.providerAddress ?? null,
    priceUsdMicros: job.priceUsdMicros ?? null,
    priceLabel: job.priceUsdMicros ? formatUsd(job.priceUsdMicros) : null,
    payment: job.payment ?? null,
    result: job.result ?? null,
    resultHash: job.resultHash ?? null,
    error: job.error ?? null,
    receiptTxHash: job.receiptTxHash ?? null,
    eventCount: job.events.length,
    events: opts.events ? job.events : undefined,
  };
}

export type { AdapterKind, JobRequest };
