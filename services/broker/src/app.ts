/**
 * The broker's HTTP surface.
 *
 * The interesting part is `POST /api/jobs/:quoteId`. It is an ordinary x402
 * protected route, but its `payTo` resolves to the **provider's own payout
 * address** rather than to us. The buyer signs an EIP-3009 USDC authorization,
 * the facilitator submits it, and the USDC moves buyer → provider in one
 * transfer. The broker introduces the two parties, witnesses the result and
 * records the receipt on XorvLedger; it never holds anyone's money. That is
 * also why a quote is a first-class object — see jobs.ts.
 *
 * ## Why payment settles before the job runs
 *
 * The route uses x402's `upfront` payment flow: the facilitator *settles* the
 * authorization before the handler runs, and the handler only ever sees a
 * payment that has already landed on Monad. The default flow settles after
 * the handler returns — which, for a job that is dispatched from the handler,
 * meant a provider could start working on a payment that then failed to settle
 * (the buyer spent the USDC in between, or signed two quotes against one
 * balance), and would never be paid for it. Settling first also means the
 * EIP-3009 authorization's validity window (five minutes) can never lapse
 * under a ten-minute job.
 *
 * The other risk — a provider that takes the money and fails — is covered by
 * reassigning the job to another provider at no extra charge (see
 * `reassign`). The poster's downside is bounded by the network, not by the
 * individual node they happened to draw.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer } from "@x402/core/server";
import type {
  FacilitatorClient,
  HTTPRequestContext,
  HTTPTransportContext,
  RoutesConfig,
} from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { isHex, verifyTypedData, type Hex } from "viem";
import {
  HEARTBEAT_INTERVAL_MS,
  JOB_TIMEOUT_MS,
  QUOTE_TTL_SECONDS,
  XORV_SCHEME,
  buildAgentRegistration,
  explorerAddress,
  explorerToken,
  explorerTx,
  formatUsd,
  getAgentWallet,
  isEvmAddress,
  jobIdHash,
  logPaymentRejections,
  networkConfig,
  normalizeAddress,
  sameAddress,
  serializeFeedbackFile,
  sha256,
  textHash,
  toJsonSafe,
  usdMicrosToUsdcUnits,
  usdcPaymentOption,
  usdcUnitsToUsdMicros,
  type AdapterKind,
  type Capability,
  type DispatchedJob,
  type HeartbeatRequest,
  type JobEvent,
  type JobRequest,
  type LedgerEventKind,
  type NetworkInfo,
  type PaymentRecord,
  type QuoteResponse,
  type RegisterRequest,
} from "@xorv/protocol";
import type { BrokerConfig } from "./config.js";
import { describeLedger, type ChainLike, type PublishResult } from "./chain.js";
import type { Hub } from "./hub.js";
import { JobStore, isTerminal, type Quote, type StoredJob } from "./jobs.js";
import { Registry, providerIdFor, type Match, type ProviderRecord, type VerifiedRegistration } from "./registry.js";
import { bodyLimit, rateLimit, requestLog } from "./guards.js";
import { Metrics } from "./metrics.js";
import { resolveFacilitator } from "./facilitator.js";
import { createLedgerReader, type LedgerReader } from "./ledger-reader.js";
import { hookDeadline, withHookTimeout, type AiHooks, type JobVerifier } from "./ai-hooks.js";
import { VERIFIED_TAG1, verificationFeedback, type FeedbackSink } from "./ai/feedback.js";
import { verifiable } from "./ai/verifier.js";
import type { RouteCandidate, RoutingRecord, ScreeningRecord, VerificationRecord } from "./ai/types.js";
import {
  RATING_TTL_SECONDS,
  feedbackFor,
  ratingMessage,
  ratingParts,
  ratingTag,
  type RatingEnv,
} from "./ratings.js";
import {
  leaderboardFromIndexer,
  leaderboardFromMemory,
  legacyReceipt,
  publicJob,
  publicProvider,
  stripSecrets,
} from "./public.js";

/** How long registration waits for its ledger write before answering without it. */
const REGISTRATION_WAIT_MS = 2_500;
/** How long registration waits on the Identity Registry to verify a claimed agent id. */
const AGENT_CHECK_TIMEOUT_MS = 4_000;
/** A paid job is handed to at most this many providers in total. */
const MAX_PROVIDERS_PER_JOB = 3;
/** Receipt writes are retried by the sweep up to this many times. */
const MAX_RECEIPT_ATTEMPTS = 3;
/** How long a rating relay waits for the job's receipt to land first. */
const RECEIPT_WAIT_MS = 15_000;
const LEDGER_KINDS: readonly LedgerEventKind[] = ["registrations", "heartbeats", "receipts", "ratings"];

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
   * Production resolves one from config; tests pass a stub so the whole HTTP
   * path — 402, payment header, settlement, dispatch — runs without a key, an
   * RPC or a real transfer.
   */
  facilitator?: FacilitatorClient;
  metrics?: Metrics;
  /** Override where feeds and the leaderboard are read from (tests stub it). */
  ledgerReader?: LedgerReader;
  /** ERC-8004 agent-wallet lookup; defaults to the Identity Registry over RPC. */
  agentWallet?: (agentId: string) => Promise<string | null>;
  /** The AI roles, when installed — see ai-hooks.ts and src/ai/. */
  ai?: AiHooks;
}

export function createApp(deps: AppDeps) {
  const { config, chain, registry, jobs } = deps;
  const app = new Hono();
  const metrics = deps.metrics ?? new Metrics();
  const net = networkConfig(config.network);
  const bootedAt = Date.now();
  const heartbeatCounters = new Map<string, number>();
  /** The last registration fingerprint published per provider — re-registering unchanged is free. */
  const publishedRegistrations = new Map<string, string>();
  /** Settlements that landed before their job existed (the upfront flow), keyed by quote id. */
  const settlements = new Map<string, { record: PaymentRecord; at: number }>();
  /** Receipt write state per job: in flight, and how many attempts it has had. */
  const receipts = new Map<string, { attempts: number; pending: Promise<PublishResult | null> | null }>();
  /** Rating relays in flight, so a double-submit can't burn a second transaction. */
  const ratingsInFlight = new Set<string>();
  /** On-chain job id → broker job id, so ledger feeds can link back to the job page. */
  const jobIdByHash = new Map<string, string>();
  for (const job of jobs.list({ limit: 10_000 })) jobIdByHash.set(jobIdHash(job.id), job.id);

  const reader =
    deps.ledgerReader ??
    createLedgerReader({
      network: config.network,
      ledgerAddress: chain.ledgerAddress,
      fromBlock: config.ledgerFromBlock,
      indexerUrl: config.indexerUrl,
    });

  const lookupAgentWallet =
    deps.agentWallet ?? ((agentId: string) => getAgentWallet(config.network, agentId));

  /** The service a buyer starts at; the "xorv-jobs" endpoint and every rating's ERC-8004 `endpoint`. */
  const jobsEndpoint = `${config.publicUrl}/api/quotes`;
  const ratingEnv = (): RatingEnv | null =>
    chain.ledgerAddress
      ? { network: config.network, ledger: chain.ledgerAddress, publicUrl: config.publicUrl, jobsEndpoint }
      : null;

  // -------------------------------------------------------------------------
  // x402
  // -------------------------------------------------------------------------

  const settlement = resolveFacilitator(config, { injected: deps.facilitator });
  if (settlement.notice) console.warn(`[broker] ${settlement.notice}`);
  if (settlement.unavailableReason) console.warn(`[broker] ${settlement.unavailableReason}`);

  const x402Server = settlement.facilitator
    ? new x402ResourceServer(settlement.facilitator).register(config.network as Network, new ExactEvmScheme())
    : null;

  if (x402Server) {
    // A rejected payment is the most confusing failure in this system — the
    // buyer signed something real and got a 402 back — so the reason goes to
    // the log at the point of decision. The in-process facilitator already
    // logs its own verdicts; for a hosted (or injected) one, this is the only
    // place the reason is visible. Note `isValid: false` arrives at
    // onAfterVerify, not onVerifyFailure — that only fires on a throw.
    if (settlement.mode !== "self" || deps.facilitator) {
      logPaymentRejections(x402Server, (line) => console.error(`[broker] ${line}`));
    }

    /**
     * Attach a settlement to the job it paid for — by quote id.
     *
     * The quote id is in the paid URL, so it is exact: two buyers paying the
     * same provider at the same moment can never swap payment records, which
     * "the most recent unpaid job for this payTo" (the old heuristic) could.
     * Under the upfront flow the job does not exist yet, so the record waits
     * in `settlements` for the handler; under a settle-after-handler flow the
     * job exists and the record is attached directly.
     */
    x402Server.onAfterSettle(async (ctx) => {
      const quoteId = quoteIdFromTransport(ctx.transportContext);
      if (!quoteId || !ctx.result.success || !ctx.result.transaction) return;
      const record = paymentRecord(
        ctx.requirements as PaymentRequirements,
        ctx.result as SettleResponse,
        ctx.paymentPayload as PaymentPayload,
      );
      const quote = jobs.getQuote(quoteId);
      if (quote?.jobId) {
        jobs.patch(quote.jobId, { payment: record });
      } else {
        settlements.set(quoteId, { record, at: Date.now() });
      }
    });
  }

  function paymentRecord(
    requirements: PaymentRequirements,
    result: SettleResponse,
    payload: PaymentPayload,
  ): PaymentRecord {
    // The facilitator reports the payer; the signed authorization names it too
    // (`authorization.from`), which covers a facilitator that leaves it out.
    const from = (payload.payload as { authorization?: { from?: string } } | undefined)?.authorization?.from;
    const payer = [result.payer, from].find((a): a is string => typeof a === "string" && isEvmAddress(a));
    return {
      asset: "usdc",
      assetAddress: safeAddress(requirements.asset),
      amount: result.amount ?? requirements.amount,
      network: requirements.network,
      txHash: result.transaction,
      payer: payer ? normalizeAddress(payer) : "unknown",
      payTo: safeAddress(requirements.payTo),
      settledAt: Date.now(),
      explorerUrl: explorerTx(config.network, result.transaction),
    };
  }

  // -------------------------------------------------------------------------
  // Middleware
  // -------------------------------------------------------------------------

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
      //   header on the payment retry. That is a response header name and
      //   arguably an upstream bug, but a browser dutifully lists it in the
      //   preflight, and a server that does not allow it fails every retry
      //   with "not allowed by Access-Control-Allow-Headers". Server-side
      //   clients never send a preflight, so this only ever breaks browsers —
      //   exactly the Privy embedded-wallet flow.
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-PAYMENT",
        "X-Payment",
        "PAYMENT-SIGNATURE",
        "Payment-Signature",
        "Access-Control-Expose-Headers",
        "X-Cancel-Token",
      ],
      // Browsers can't read a response header unless it's exposed, and x402
      // carries its whole contract in these. `payment-required` holds the 402's
      // `accepts` (amount, asset, payTo, EIP-712 domain); without it a browser
      // wallet fails with "Failed to parse payment requirements", which reads
      // like a protocol bug and is really a CORS omission. `payment-response`
      // carries the settlement tx hash back.
      //
      // Both casings, because header names are case-insensitive on the wire but
      // this list is matched literally by some proxies.
      exposeHeaders: [
        "X-PAYMENT-RESPONSE",
        "X-Payment-Response",
        "PAYMENT-RESPONSE",
        "Payment-Response",
        "PAYMENT-REQUIRED",
        "Payment-Required",
        "payment-required",
        "X-Request-Id",
      ],
    }),
  );

  app.onError((err, c) => {
    console.error("[broker]", err);
    metrics.inc("xorv_errors_total", { path: c.req.routePath || c.req.path });
    return c.json({ error: err instanceof Error ? err.message : "internal error" }, 500);
  });

  app.use("*", requestLog());
  // 256KB is far above a 20k-char prompt and far below anything worth parsing.
  app.use("*", bodyLimit(256 * 1024));

  // Quoting is free, unauthenticated and reserves a provider — the obvious
  // thing to abuse. The paid route needs no limit of its own: it costs money.
  app.use("/api/quotes", rateLimit({ limit: 30, windowMs: 60_000 }));
  app.use("/api/providers/register", rateLimit({ limit: 10, windowMs: 60_000 }));
  // Each rating relay costs the operator ~0.03 MON of gas.
  app.use("/api/jobs/:id/rate", rateLimit({ limit: 10, windowMs: 60_000 }));

  app.get("/metrics", (c) =>
    c.text(
      metrics.render({ registry, jobs, chain, connected: deps.getHub()?.connectedCount() ?? 0 }),
      200,
      { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
    ),
  );

  // Access log for the paid route. The 402 dance is two requests that look
  // identical except for one header, and "did the client actually retry with a
  // payment?" is the first question worth answering when it goes wrong.
  app.use("/api/jobs/*", async (c, next) => {
    const paid = hasPaymentHeader(c);
    await next();
    if (c.req.method === "POST" && c.req.path.split("/").length === 4) {
      console.log(`[broker] ${c.req.method} ${c.req.path} payment=${paid ? "yes" : "no"} → ${c.res.status}`);
    }
  });

  // -------------------------------------------------------------------------
  // Public: network state
  // -------------------------------------------------------------------------

  app.get("/health", (c) => c.json({ ok: true, at: Date.now() }));

  app.get("/api/network", (c) => {
    const live = registry.live();
    const allJobs = jobs.list({ limit: 1000 });
    const settled = allJobs.filter((j) => j.payment);
    const ledger = describeLedger(chain);
    const body: NetworkInfo & Record<string, unknown> = {
      network: config.network,
      chainId: net.chainId,
      label: net.label,
      explorerUrl: net.explorerUrl,
      usdc: {
        address: net.usdc.address,
        symbol: net.usdc.symbol,
        decimals: net.usdc.decimals,
        name: net.usdc.name,
        version: net.usdc.version,
        url: explorerToken(config.network, net.usdc.address),
      } as NetworkInfo["usdc"],
      facilitator: {
        mode: settlement.mode,
        description: settlement.description,
        address: settlement.address,
        url: settlement.url,
        available: settlement.facilitator !== null,
        error: settlement.unavailableReason,
      } as NetworkInfo["facilitator"],
      operator: config.operator
        ? { address: config.operator.address, url: explorerAddress(config.network, config.operator.address) }
        : null,
      ledger: ledger
        ? ({
            ...ledger,
            fromBlock: config.ledgerFromBlock === null ? null : config.ledgerFromBlock.toString(),
          } as NetworkInfo["ledger"])
        : null,
      erc8004: {
        identity: net.erc8004.identity,
        reputation: net.erc8004.reputation,
        validation: net.erc8004.validation,
      } as NetworkInfo["erc8004"],
      indexer: config.indexerUrl ? { url: config.indexerUrl } : null,
      published: chain.counts(),
      pendingReceipts: chain.pendingReceipts(),
      lastPublishError: chain.lastPublishError(),
      // Enabled roles as the protocol's AiRoleInfo (null when off — what the
      // CLI and the apps test for), and every role's full state, including
      // why it's off, under aiRoles.
      ai: {
        router: deps.ai?.router?.info ?? null,
        screener: deps.ai?.screener?.info ?? null,
        verifier: deps.ai?.verifier?.info ?? null,
      },
      aiRoles: deps.ai?.report?.() ?? null,
      feeBps: config.feeBps,
      epoch: deps.getHub()?.epoch ?? bootedAt,
      stats: {
        providersLive: live.length,
        providersConnected: deps.getHub()?.connectedCount() ?? 0,
        capacity: live.reduce((n, p) => n + p.capabilities.length, 0),
        jobsTotal: allJobs.length,
        jobsCompleted: allJobs.filter((j) => j.status === "completed").length,
        paidUsdMicros: settled.reduce((sum, j) => sum + (j.priceUsdMicros ?? 0), 0),
      },
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    };
    return c.json(body);
  });

  app.get("/api/providers", (c) => {
    const hub = deps.getHub();
    return c.json({
      providers: registry.list().map((p) => publicProvider(config.network, p, hub?.isConnected(p.id) ?? false)),
    });
  });

  /**
   * A provider's ERC-8004 registration file — what its agent URI resolves to.
   *
   * Served by the broker so a node can register its identity with a single
   * `IdentityRegistry.register(agentURI)` transaction and a URL that never
   * changes: the provider id is derived from the node id, so it survives both
   * node and broker restarts.
   */
  app.get("/agents/:file", (c) => {
    const file = c.req.param("file");
    if (!file.endsWith(".json")) return c.json({ error: "not found" }, 404);
    // Accept the provider id or the node id: `xorv identity register` mints the
    // agent before the node has ever been told its provider id, so the URI it
    // writes on-chain is keyed by node id. The provider id is a pure function
    // of the node id, so both spellings resolve to the same record.
    const name = file.slice(0, -".json".length);
    const provider = registry.find(name) ?? registry.find(providerIdFor(name));
    if (!provider) return c.json({ error: "unknown provider" }, 404);
    const adapters = [...new Set(provider.capabilities.map((cap) => cap.displayName || cap.adapter))];
    return c.json(
      buildAgentRegistration({
        network: config.network,
        agentId: provider.agentId,
        name: `${provider.label} · Xorv provider`,
        description:
          `Xorv provider node selling ${adapters.join(", ") || "AI agent"} capacity. ` +
          `Pay per job in USDC over x402 on Monad; every paid job is receipted on XorvLedger.`,
        services: [
          {
            name: "web",
            endpoint: config.appUrl
              ? `${config.appUrl}/providers/${provider.id}`
              : `${config.publicUrl}/api/providers`,
          },
          { name: "xorv-jobs", endpoint: jobsEndpoint, version: "1" },
        ],
        active: provider.status !== "offline",
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Provider node API (bearer token from registration)
  // -------------------------------------------------------------------------

  app.post("/api/providers/register", async (c) => {
    const body = (await readJson(c)) as RegisterRequest | null;
    const parsed = validateRegistration(body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const warnings: string[] = [];
    let agentId: string | null = null;
    if (parsed.agentId) {
      const check = await verifyAgent(parsed.agentId, parsed.registration.address);
      if (check.ok) agentId = parsed.agentId;
      else {
        warnings.push(check.warning);
        console.warn(`[broker] registration "${parsed.registration.label}": ${check.warning}`);
      }
    }

    const provider = registry.register({ ...parsed.registration, agentId });
    const registryResult = await publishRegistration(provider);

    return c.json({
      provider: stripSecrets(provider),
      token: provider.token,
      wsUrl: `${config.publicUrl.replace(/^http/, "ws")}/ws/provider?token=${provider.token}`,
      registry: registryResult
        ? {
            contract: registryResult.contract,
            txHash: registryResult.txHash,
            explorerUrl: registryResult.explorerUrl,
            agentId: provider.agentId,
          }
        : null,
      agent: { requested: parsed.agentId, verified: agentId !== null },
      agentURI: `${config.publicUrl}/agents/${provider.id}.json`,
      warnings,
      network: config.network,
      usdc: net.usdc.address,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    });
  });

  app.post("/api/providers/:id/heartbeat", async (c) => {
    const provider = authProvider(c.req.header("authorization"));
    if (!provider || provider.id !== c.req.param("id")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = ((await readJson(c)) ?? {}) as Partial<HeartbeatRequest>;
    const updated = registry.heartbeat(provider.id, {
      activeJobs: body.activeJobs ?? 0,
      uptimeSeconds: body.uptimeSeconds ?? 0,
      available: body.available ?? {},
    });
    if (!updated) return c.json({ error: "unknown provider" }, 404);

    // Sampled, not every beat — see LedgerWriter.heartbeat for why.
    const every = config.heartbeatPublishEvery;
    const n = (heartbeatCounters.get(provider.id) ?? 0) + 1;
    heartbeatCounters.set(provider.id, n);
    if (every > 0 && (n - 1) % every === 0) {
      void chain.heartbeat({
        providerId: provider.id,
        activeJobs: updated.activeJobs,
        capacity: updated.capabilities.reduce((sum, cap) => sum + Math.max(1, cap.maxConcurrency), 0),
        uptimeSeconds: updated.uptimeSeconds,
      });
    }

    return c.json({
      ok: true,
      status: updated.status,
      pending: [],
      brokerEpoch: deps.getHub()?.epoch ?? bootedAt,
    });
  });

  // HTTP fallbacks for nodes that can't hold a socket open.
  app.post("/api/jobs/:id/events", async (c) => {
    const provider = authProvider(c.req.header("authorization"));
    if (!provider) return c.json({ error: "unauthorized" }, 401);
    const job = jobs.get(c.req.param("id"));
    if (!job || job.providerId !== provider.id) return c.json({ error: "not found" }, 404);
    const event = (await readJson(c)) as JobEvent | null;
    if (!event?.kind) return c.json({ error: "invalid event" }, 400);
    jobs.addEvent(job.id, { ...event, at: event.at || Date.now() });
    return c.json({ ok: true });
  });

  app.post("/api/jobs/:id/result", async (c) => {
    const provider = authProvider(c.req.header("authorization"));
    if (!provider) return c.json({ error: "unauthorized" }, 401);
    const job = jobs.get(c.req.param("id"));
    if (!job || job.providerId !== provider.id) return c.json({ error: "not found" }, 404);
    const body = ((await readJson(c)) ?? {}) as { result?: string; error?: string; durationMs?: number };
    if (body.error) {
      finishJobFailed(job.id, provider.id, body.error, body.durationMs ?? 0);
    } else {
      finishJobOk(job.id, provider.id, body.result ?? "", body.durationMs ?? 0);
    }
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Quotes — free, and the thing a payment is pinned to
  // -------------------------------------------------------------------------

  app.post("/api/quotes", async (c) => {
    const body = (await readJson(c)) as (Omit<JobRequest, "adapter"> & { adapter?: string | null }) | null;
    if (!body?.prompt?.trim()) return c.json({ error: "prompt is required" }, 400);
    if (body.prompt.length > 20_000) return c.json({ error: "prompt is too long (max 20k chars)" }, 400);

    const maxPrice = Number(body.maxPriceUsdMicros);
    if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
      return c.json({ error: "maxPriceUsdMicros must be a positive number" }, 400);
    }
    const request: JobRequest = {
      ...body,
      prompt: body.prompt,
      // "auto" (or nothing) is how a buyer says "you choose" — the router's cue.
      adapter: adapterChoice(body.adapter),
      maxPriceUsdMicros: maxPrice,
    };

    // 1. The safety screen, before any provider could see the prompt and
    //    before anyone has paid. The quote freezes this exact request, so what
    //    was screened is what runs.
    const screener = deps.ai?.screener;
    let screening: ScreeningRecord | null = null;
    if (screener) {
      screening = await withHookTimeout("prompt screen", () => screener.screen(request), hookDeadline(screener));
      if (screening) {
        metrics.inc("xorv_ai_screen_total", { verdict: screening.unavailable ? "unscreened" : screening.verdict });
        metrics.observe("xorv_ai_latency_ms", screening.ms, { role: "screener" });
      }
      const unscreened = !screening || (screening.unavailable === true && screening.verdict === "block");
      if (unscreened && screener.failMode === "closed") {
        return c.json(
          {
            error:
              "the safety screen is unavailable, and this broker only quotes screened prompts " +
              "(XORV_SCREENER_FAIL=closed) — try again in a moment",
            screening,
          },
          503,
        );
      }
      if (screening?.verdict === "block") {
        return c.json({ error: `the safety screen refused this prompt: ${screening.reason}`, screening }, 422);
      }
    }

    // 2. Everything that could take the job right now, in matcher order.
    const candidates = registry.candidates({ adapter: request.adapter ?? null, maxPriceUsdMicros: maxPrice });
    if (candidates.length === 0) {
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

    // 3. The router, when the buyer left the adapter open and there is a real
    //    choice to make. Its pick is checked against the live candidates (all
    //    under the ceiling); the matcher then picks the node for that adapter.
    const router = deps.ai?.router;
    let routing: RoutingRecord | null = null;
    if (router && !request.adapter && new Set(candidates.map((m) => m.capability.adapter)).size > 1) {
      routing = await withHookTimeout(
        "job router",
        () => router.route(request, routeCandidates(candidates)),
        hookDeadline(router),
      );
    }
    let match: Match = candidates[0]!;
    if (routing?.adapter) {
      const picked = routing.adapter;
      const routed = candidates.find((m) => m.capability.adapter === picked);
      if (routed) {
        match = routed;
      } else {
        routing = {
          ...routing,
          adapter: null,
          fallback: "invalid",
          reason: `${picked} is not a live option within the ceiling — matched on price instead`,
        };
      }
    }
    if (routing) {
      metrics.inc("xorv_ai_route_total", { outcome: routing.fallback ? `fallback_${routing.fallback}` : "routed" });
      metrics.observe("xorv_ai_latency_ms", routing.ms, { role: "router" });
    }

    metrics.inc("xorv_quotes_total");
    const quote = jobs.createQuote({
      request,
      providerId: match.provider.id,
      providerLabel: match.provider.label,
      providerAddress: normalizeAddress(match.provider.address),
      providerAgentId: match.provider.agentId,
      capabilityId: match.capability.id,
      capabilityName: match.capability.displayName,
      capabilityAdapter: match.capability.adapter,
      priceUsdMicros: match.capability.priceUsdMicros,
      usdcAmount: usdMicrosToUsdcUnits(match.capability.priceUsdMicros),
      routing,
      screening,
    });

    const response: QuoteResponse = {
      quoteId: quote.id,
      payUrl: `${config.publicUrl}/api/jobs/${quote.id}`,
      network: config.network,
      priceUsdMicros: quote.priceUsdMicros,
      priceLabel: formatUsd(quote.priceUsdMicros),
      usdcAmount: quote.usdcAmount,
      expiresAt: quote.expiresAt,
      provider: {
        id: match.provider.id,
        label: match.provider.label,
        address: quote.providerAddress,
        addressUrl: explorerAddress(config.network, quote.providerAddress),
        agentId: quote.providerAgentId,
        capability: match.capability.displayName,
        adapter: match.capability.adapter,
        model: match.capability.model ?? null,
        stats: match.provider.stats,
      },
      // Exactly what the 402 will ask for, so a buyer can check it before
      // signing (protocol `quoteMatchPolicy`).
      accepts: [
        {
          scheme: XORV_SCHEME,
          network: config.network,
          asset: net.usdc.address,
          amount: quote.usdcAmount,
          payTo: quote.providerAddress,
          maxTimeoutSeconds: QUOTE_TTL_SECONDS,
          extra: { name: net.usdc.name, version: net.usdc.version },
        },
      ],
      routing,
      screening,
    };
    return c.json(response);
  });

  // -------------------------------------------------------------------------
  // The paid route
  // -------------------------------------------------------------------------

  /** Pull the quote id out of the request path for the dynamic resolvers. */
  const quoteFromContext = (ctx: HTTPRequestContext): Quote | undefined => {
    const id = lastSegment(ctx.path);
    return id ? jobs.getQuote(id) : undefined;
  };

  const routes: RoutesConfig = {
    "POST /api/jobs/:quoteId": {
      description: "Run one AI job on a live Xorv provider",
      serviceName: "Xorv",
      mimeType: "application/json",
      accepts: {
        // Both resolvers read the amounts frozen on the quote — see
        // Quote.usdcAmount for why recomputing here silently breaks
        // correctly-signed payments. Straight to the provider: the broker is
        // never the payee.
        ...usdcPaymentOption({
          network: config.network,
          payTo: (ctx) => quoteFromContext(ctx)?.providerAddress ?? "",
          amount: (ctx) => quoteFromContext(ctx)?.usdcAmount ?? "0",
          maxTimeoutSeconds: QUOTE_TTL_SECONDS,
        }),
        // Settle before the handler runs — see the note at the top of the file.
        extra: { paymentFlow: "upfront" },
      },
      unpaidResponseBody: (ctx) => {
        const quote = quoteFromContext(ctx);
        return {
          contentType: "application/json",
          body: quote
            ? {
                quoteId: quote.id,
                provider: { id: quote.providerId, label: quote.providerLabel, address: quote.providerAddress },
                capability: quote.capabilityName,
                priceLabel: formatUsd(quote.priceUsdMicros),
                usdcAmount: quote.usdcAmount,
                hint:
                  `Sign an EIP-3009 USDC authorization on ${net.name} (x402 "exact") for the PAYMENT-REQUIRED ` +
                  "terms and retry with the PAYMENT-SIGNATURE header. You need USDC only — the facilitator pays the gas.",
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
    if (!x402Server) {
      return c.json({ error: settlement.unavailableReason ?? "payments are unavailable" }, 503);
    }
    if (!hasPaymentHeader(c)) return next();

    // One settlement per quote at a time — see Quote.paying.
    if (quote.paying) {
      return c.json({ error: "a payment for this quote is already being settled" }, 409);
    }
    quote.paying = true;
    try {
      await next();
    } finally {
      // Settlement failed (or never happened): the quote is still for sale.
      if (!quote.jobId) {
        quote.paying = false;
        settlements.delete(quote.id);
      }
    }
  });

  if (x402Server) app.use("/api/jobs/:quoteId", paymentMiddleware(routes, x402Server));

  app.post("/api/jobs/:quoteId", async (c) => {
    // Upfront settlement already landed by the time this runs. `paying` keeps
    // the quote resolvable even if its TTL ran out mid-settlement.
    const quote = jobs.getQuote(c.req.param("quoteId") ?? "");
    if (!quote) return c.json({ error: "quote expired during payment" }, 409);

    const settled = settlements.get(quote.id);
    settlements.delete(quote.id);
    if (!settled) {
      // Only reachable if the payment flow were ever switched back to
      // settle-after-handler; then onAfterSettle attaches it to the job.
      console.warn(`[broker] quote ${quote.id}: handler ran before settlement was recorded`);
    }

    // Handed only to the buyer, in this response: the capability to cancel.
    const cancelToken = randomBytes(24).toString("base64url");
    const job = jobs.createJob(quote, { payment: settled?.record ?? null, cancelTokenHash: sha256(cancelToken) });
    jobIdByHash.set(jobIdHash(job.id), job.id);
    metrics.inc("xorv_payments_total");
    dispatch(job);

    return c.json({
      jobId: job.id,
      status: jobs.get(job.id)?.status ?? job.status,
      provider: { id: quote.providerId, label: quote.providerLabel, address: quote.providerAddress },
      capability: quote.capabilityName,
      priceUsdMicros: quote.priceUsdMicros,
      priceLabel: formatUsd(quote.priceUsdMicros),
      payment: job.payment ?? null,
      cancelToken,
      cancelUrl: `${config.publicUrl}/api/jobs/${job.id}/cancel`,
      streamUrl: `${config.publicUrl}/api/jobs/${job.id}/stream`,
      jobUrl: `${config.publicUrl}/api/jobs/${job.id}`,
    });
  });

  // -------------------------------------------------------------------------
  // Job reads
  // -------------------------------------------------------------------------

  app.get("/api/jobs", (c) => {
    const limit = clampInt(c.req.query("limit"), 1, 500, 50);
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
   * Only the buyer who paid can: the payment response carried a one-time
   * cancel token, and this route checks it (as `Authorization: Bearer <token>`,
   * an `X-Cancel-Token` header or `{ "cancelToken" }` in the body). Knowing the
   * job id is not enough — every job id is listed publicly on `/api/jobs`.
   *
   * This does **not** refund. Settlement already happened (see the note at the
   * top of this file), and the provider may have already burned real quota. It
   * stops the work and frees their slot.
   */
  app.post("/api/jobs/:id/cancel", async (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const body = ((await readJson(c)) ?? {}) as { cancelToken?: string };
    const token =
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ||
      c.req.header("x-cancel-token")?.trim() ||
      body.cancelToken?.trim() ||
      "";
    if (!job.cancelTokenHash || !token || !sameHash(sha256(token), job.cancelTokenHash)) {
      return c.json(
        { error: "only the buyer who paid can cancel this job — send the cancelToken from the payment response" },
        403,
      );
    }
    if (isTerminal(job.status)) {
      return c.json({ error: `job is already ${job.status}`, status: job.status }, 409);
    }

    const reason = "cancelled by the buyer";
    if (job.providerId) {
      deps.getHub()?.send(job.providerId, { type: "job.cancel", jobId: job.id, reason });
      // The buyer changed their mind; that says nothing about the provider.
      registry.jobReleased(job.providerId);
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
        // here — an echo job takes milliseconds. If we only ever emitted `done`
        // from a subsequent update, that client would wait forever for an
        // event that already happened.
        if (isTerminal(job.status)) {
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
          if (isTerminal(updated.status)) {
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

  // -------------------------------------------------------------------------
  // Ratings — gasless for the buyer, relayed through XorvLedger into ERC-8004
  // -------------------------------------------------------------------------

  /** Why a job can't be rated (with the status to answer), or what it's rated against. */
  function ratingTarget(
    job: StoredJob,
  ): { error: string; status: 409 | 503 } | { env: RatingEnv; agentId: string; payer: string } {
    const env = ratingEnv();
    if (!env) return { error: "no XorvLedger is configured, so ratings cannot be recorded", status: 503 };
    if (!job.payment || !isEvmAddress(job.payment.payer)) {
      return { error: "this job has no recorded payer, so there is nobody to sign its rating", status: 409 };
    }
    if (!isTerminal(job.status)) return { error: "rate the job once it has finished", status: 409 };
    if (job.rating) return { error: "this job has already been rated", status: 409 };
    const agentId = receiptAgentId(job);
    if (!agentId) {
      return {
        error:
          "ratings go to the provider's ERC-8004 agent identity, and the provider paid for this job has none " +
          "(or the job was reassigned to a different provider), so there is nothing to rate",
        status: 409,
      };
    }
    return { env, agentId, payer: job.payment.payer };
  }

  app.get("/api/jobs/:id/rating", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const value = Number(c.req.query("value"));
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      return c.json({ error: "value must be an integer from 0 to 100" }, 400);
    }
    const target = ratingTarget(job);
    if ("error" in target) return c.json({ error: target.error }, target.status);

    const deadline = Math.floor(Date.now() / 1000) + RATING_TTL_SECONDS;
    const parts = ratingParts(target.env, job, target.agentId, value, deadline);
    return c.json({
      jobId: job.id,
      value,
      deadline,
      signer: target.payer,
      agentId: target.agentId,
      feedbackURI: parts.feedbackURI,
      feedbackHash: parts.feedbackHash,
      typedData: toJsonSafe(parts.typedData),
      submit: { method: "POST", url: `${config.publicUrl}/api/jobs/${job.id}/rate`, body: ["value", "deadline", "signature"] },
    });
  });

  app.post("/api/jobs/:id/rate", async (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const body = ((await readJson(c)) ?? {}) as { value?: unknown; deadline?: unknown; signature?: unknown };
    const value = Number(body.value);
    const deadline = Number(body.deadline);
    const signature = typeof body.signature === "string" ? body.signature : "";
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      return c.json({ error: "value must be an integer from 0 to 100" }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(deadline) || deadline <= now || deadline > now + RATING_TTL_SECONDS + 300) {
      return c.json({ error: "deadline must be a unix time within the next hour (use the one from GET …/rating)" }, 400);
    }
    if (!isHex(signature) || signature.length < 132) {
      return c.json({ error: "signature must be the 0x-hex EIP-712 signature of the rating" }, 400);
    }
    const target = ratingTarget(job);
    if ("error" in target) return c.json({ error: target.error }, target.status);
    if (chain.mode() !== "write") {
      return c.json({ error: "the broker is read-only (no XORV_OPERATOR_KEY), so it cannot relay ratings" }, 503);
    }

    // Check the signature here, before spending gas on a relay the contract
    // would refuse. Plain ECDSA first (every EOA, Privy embedded wallets);
    // then ERC-1271 / ERC-6492 over RPC for smart accounts.
    const parts = ratingParts(target.env, job, target.agentId, value, deadline);
    const typedData = parts.typedData;
    let valid = await verifyTypedData({ ...typedData, address: target.payer as Hex, signature: signature as Hex }).catch(
      () => false,
    );
    if (!valid) {
      valid = await chain.verifyTypedDataOnChain({
        address: target.payer,
        typedData: typedData as unknown as Record<string, unknown>,
        signature: signature as Hex,
      });
    }
    if (!valid) {
      return c.json({ error: "the signature is not from this job's payer — only the buyer who paid can rate it" }, 401);
    }

    if (ratingsInFlight.has(job.id)) return c.json({ error: "a rating for this job is already being relayed" }, 409);
    ratingsInFlight.add(job.id);
    try {
      // XorvLedger only accepts a rating for a job it has a receipt for.
      if (!job.receiptTxHash) await ensureReceipt(job);
      if (!jobs.get(job.id)?.receiptTxHash) {
        return c.json({ error: "the job's receipt is not on-chain yet — retry in a few seconds" }, 409);
      }
      const result = await chain.rateJob(ratingMessage(parts.rating), signature as Hex);
      jobs.patch(job.id, {
        rating: {
          value,
          txHash: result.txHash,
          feedbackURI: parts.feedbackURI,
          deadline,
          feedbackHash: parts.feedbackHash,
        },
      });
      metrics.inc("xorv_ratings_total");
      return c.json({
        ok: true,
        jobId: job.id,
        value,
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
        feedbackURI: parts.feedbackURI,
        feedbackHash: parts.feedbackHash,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    } finally {
      ratingsInFlight.delete(job.id);
    }
  });

  /**
   * The ERC-8004 feedback file a rating points at.
   *
   * Served as canonical JSON, byte-for-byte what was hashed, so anyone can
   * check `keccak256(body) == feedbackHash` against the on-chain event. Before
   * the job is rated, `?value=&deadline=` previews the file a rating would
   * commit to — what a careful buyer checks before signing.
   */
  app.get("/feedback/:file", (c) => {
    const file = c.req.param("file");
    if (!file.endsWith(".json")) return c.json({ error: "not found" }, 404);
    const job = jobs.get(file.slice(0, -".json".length));
    const env = ratingEnv();
    if (!job || !env) return c.json({ error: "not found" }, 404);
    const agentId = receiptAgentId(job);
    if (!agentId || !job.payment || !isTerminal(job.status)) {
      return c.json({ error: "no feedback file for this job" }, 404);
    }
    let value: number;
    let deadline: number;
    if (job.rating) {
      value = job.rating.value;
      deadline = job.rating.deadline;
    } else {
      value = Number(c.req.query("value"));
      deadline = Number(c.req.query("deadline"));
      if (!Number.isInteger(value) || value < 0 || value > 100 || !Number.isInteger(deadline) || deadline <= 0) {
        return c.json({ error: "not rated yet — pass ?value=&deadline= to preview the file a rating would commit to" }, 404);
      }
    }
    const feedback = feedbackFor(env, job, agentId, value, deadline);
    const bytes = serializeFeedbackFile(feedback);
    return c.body(bytes, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Feedback-Hash": textHash(bytes),
      "Cache-Control": job.rating ? "public, max-age=31536000, immutable" : "no-store",
    });
  });

  /**
   * The ERC-8004 feedback file behind a Kimi verification — what the
   * verifier's `giveFeedback` points at. Canonical JSON, byte-for-byte what
   * was hashed: `keccak256(body)` is the `feedbackHash` in the registry's
   * `NewFeedback` event. It carries the model, score, rationale, the job's
   * request and result hashes and the x402 proof of payment.
   */
  app.get("/verifications/:file", (c) => {
    const file = c.req.param("file");
    if (!file.endsWith(".json")) return c.json({ error: "not found" }, 404);
    const job = jobs.get(file.slice(0, -".json".length));
    if (!job) return c.json({ error: "not found" }, 404);
    const verification = job.verification;
    if (!verification) return c.json({ error: "this job has not been verified" }, 404);
    if (!verification.feedbackHash || !verification.agentId || !verification.verifier) {
      return c.json(
        { error: "this job's verification was not written to ERC-8004, so it has no feedback file", verification },
        404,
      );
    }
    const parts = verificationFeedback(verificationEnv(), job, verification, {
      agentId: verification.agentId,
      verifier: verification.verifier,
    });
    if (parts.feedbackHash !== verification.feedbackHash) {
      // Only reachable if a fact the file is built from changed after it was
      // committed (XORV_PUBLIC_URL or the ledger moved). Serve it, loudly.
      console.error(
        `[broker] /verifications/${job.id}.json hashes to ${parts.feedbackHash}, not the committed ${verification.feedbackHash}`,
      );
    }
    return c.body(parts.bytes, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Feedback-Hash": parts.feedbackHash,
      "Cache-Control": verification.feedbackTxHash ? "public, max-age=31536000, immutable" : "no-store",
    });
  });

  // -------------------------------------------------------------------------
  // The public record — XorvLedger feeds, indexer-first
  // -------------------------------------------------------------------------

  app.get("/api/ledger", async (c) => {
    const kind = (c.req.query("kind") ?? "receipts") as LedgerEventKind;
    if (!LEDGER_KINDS.includes(kind)) {
      return c.json({ error: `kind must be one of ${LEDGER_KINDS.join(", ")}` }, 400);
    }
    const limit = clampInt(c.req.query("limit"), 1, 100, 20);
    const ledger = describeLedger(chain);
    if (!ledger && !config.indexerUrl) return c.json({ kind, ledger: null, source: "none", events: [] });
    try {
      const feed = await reader.events(kind, limit);
      return c.json({
        kind,
        ledger,
        source: feed.source,
        ...(feed.indexerError ? { indexerError: feed.indexerError } : {}),
        events: feed.events.map((event) => ({
          ...event,
          explorerUrl: explorerTx(config.network, event.txHash),
          brokerJobId:
            "jobId" in event.data ? (jobIdByHash.get(String(event.data.jobId).toLowerCase()) ?? null) : undefined,
        })),
      });
    } catch (err) {
      return c.json({ kind, ledger, events: [], error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  /**
   * The receipts feed in its long-standing shape, for the landing page — see
   * `legacyReceipt` in public.ts for which keys are kept and why.
   */
  app.get("/api/receipts", async (c) => {
    const ledger = describeLedger(chain);
    if (!ledger && !config.indexerUrl) return c.json({ ledger: null, topic: null, source: "none", receipts: [] });
    try {
      const feed = await reader.events("receipts", 50);
      return c.json({
        ledger,
        topic: ledger,
        source: feed.source,
        receipts: feed.events.map((event) =>
          legacyReceipt(
            config.network,
            event as Parameters<typeof legacyReceipt>[1],
            jobIdByHash.get(String((event.data as { jobId: string }).jobId).toLowerCase()) ?? null,
          ),
        ),
      });
    } catch (err) {
      return c.json({ ledger, topic: ledger, receipts: [], error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get("/api/leaderboard", async (c) => {
    const limit = clampInt(c.req.query("limit"), 1, 100, 25);
    let indexerError: string | undefined;
    try {
      const rows = await reader.leaderboard(limit);
      if (rows) {
        return c.json({ source: "indexer", providers: leaderboardFromIndexer(config.network, rows, registry.list()) });
      }
    } catch (err) {
      indexerError = err instanceof Error ? err.message : String(err);
    }
    return c.json({
      source: "memory",
      ...(indexerError ? { indexerError } : {}),
      providers: leaderboardFromMemory(config.network, registry.list(), jobs.list({ limit: 5_000 }), limit),
    });
  });

  // -------------------------------------------------------------------------
  // Registration helpers
  // -------------------------------------------------------------------------

  /**
   * Check a claimed ERC-8004 agent id against the Identity Registry.
   *
   * The claim is only worth recording if the agent's wallet *is* the payout
   * address — XorvLedger enforces exactly that on every receipt, and a
   * reputation score attached to someone else's agent would be a lie. A
   * lookup that fails or times out doesn't block the node from working: it
   * registers without an identity and is told why.
   */
  async function verifyAgent(agentId: string, address: string): Promise<{ ok: true } | { ok: false; warning: string }> {
    let wallet: string | null;
    try {
      wallet = await withTimeout(lookupAgentWallet(agentId), AGENT_CHECK_TIMEOUT_MS, "agent lookup timed out");
    } catch (err) {
      return {
        ok: false,
        warning:
          `could not verify ERC-8004 agent #${agentId} (${err instanceof Error ? err.message : String(err)}); ` +
          "registered without an agent identity — re-register to retry",
      };
    }
    if (!wallet) {
      return {
        ok: false,
        warning: `ERC-8004 agent #${agentId} has no agent wallet set; registered without an agent identity`,
      };
    }
    if (!sameAddress(wallet, address)) {
      return {
        ok: false,
        warning:
          `ERC-8004 agent #${agentId} is paid at ${wallet}, not at this node's payout address ${address}; ` +
          "registered without an agent identity",
      };
    }
    return { ok: true };
  }

  /**
   * Announce a registration on XorvLedger without holding the node up.
   *
   * The write starts immediately and finishes in the background; the response
   * waits for it only briefly (a Monad round-trip is about a second), so a
   * slow or dead RPC costs a node a couple of seconds at most, never its
   * registration. An unchanged re-registration (a reconnect) writes nothing.
   */
  async function publishRegistration(provider: ProviderRecord): Promise<PublishResult | null> {
    if (chain.mode() !== "write") return null;
    const fingerprint = JSON.stringify([
      provider.address,
      provider.agentId,
      provider.label,
      provider.capabilities.map((cap) => [cap.adapter, cap.priceUsdMicros]),
    ]);
    if (provider.registryTxHash && publishedRegistrations.get(provider.id) === fingerprint) {
      return {
        contract: chain.ledgerAddress ?? "",
        txHash: provider.registryTxHash,
        explorerUrl: explorerTx(config.network, provider.registryTxHash),
        blockNumber: null,
      };
    }
    const pending = chain.registerProvider(provider).then((result) => {
      if (result) {
        registry.setRegistryTx(provider.id, result.txHash);
        publishedRegistrations.set(provider.id, fingerprint);
      }
      return result;
    });
    return Promise.race([pending, sleep(REGISTRATION_WAIT_MS).then(() => null)]);
  }

  // -------------------------------------------------------------------------
  // Dispatch + completion
  // -------------------------------------------------------------------------

  function dispatch(job: StoredJob): void {
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
      // The node's socket dropped between quote and payment. Try someone else
      // rather than failing a job that has already been paid for.
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
   * actually matters to them. A job never returns to a provider that already
   * had it, and is handed out at most MAX_PROVIDERS_PER_JOB times in total.
   */
  function reassign(job: StoredJob): boolean {
    const tried = job.attemptedProviders ?? (job.providerId ? [job.providerId] : []);
    if (tried.length >= MAX_PROVIDERS_PER_JOB) return false;
    const hub = deps.getHub();
    if (!hub) return false;
    const match = registry.match({
      adapter: job.request.adapter ?? job.routing?.adapter ?? null,
      maxPriceUsdMicros: job.request.maxPriceUsdMicros,
      exclude: tried,
    });
    if (!match) return false;

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

    jobs.addEvent(job.id, {
      at: Date.now(),
      kind: "status",
      text: `reassigned to ${match.provider.label} at no extra charge`,
    });
    jobs.reassign(job.id, {
      providerId: match.provider.id,
      providerLabel: match.provider.label,
      capabilityId: match.capability.id,
      capabilityAdapter: match.capability.adapter,
    });
    registry.jobStarted(match.provider.id);
    return true;
  }

  function finishJobOk(jobId: string, providerId: string, result: string, durationMs: number): void {
    const job = jobs.get(jobId);
    // A result for a job that is already over (cancelled, timed out), or from a
    // provider the job was taken away from, changes nothing.
    if (!job || isTerminal(job.status) || job.providerId !== providerId) return;
    const done = jobs.complete(jobId, result, textHash(result));
    if (!done) return;

    // Earnings follow the money: the USDC went to the quoted provider at
    // settlement, even if a reassignment means someone else finished the job.
    const micros = done.payment ? usdcUnitsToUsdMicros(done.payment.amount) : 0;
    const payee = done.quotedProviderId ?? providerId;
    registry.jobFinished(providerId, { ok: true, durationMs, usdcMicros: payee === providerId ? micros : 0 });
    if (payee !== providerId) registry.creditEarnings(payee, micros);
    metrics.inc("xorv_jobs_completed_total");
    metrics.observe("xorv_job_duration", durationMs);

    // Kimi scores the result after the buyer already has it. Private jobs
    // are skipped: their result is sealed to the buyer, not readable here.
    const verifier = deps.ai?.verifier;
    if (verifier && verifiable(done)) void verifyJob(verifier, done);
  }

  function finishJobFailed(jobId: string, providerId: string, error: string, durationMs: number): void {
    const job = jobs.get(jobId);
    // Same rule as finishJobOk. Without it a cancelled job whose adapter then
    // errored would be reassigned — resurrected — and counted twice.
    if (!job || isTerminal(job.status) || job.providerId !== providerId) return;
    registry.jobFinished(providerId, { ok: false, durationMs });
    metrics.inc("xorv_jobs_failed_total");

    // A free retry elsewhere before the poster is told it failed.
    if (reassign(job)) return;
    jobs.fail(jobId, error);
  }

  // -------------------------------------------------------------------------
  // AI roles — router inputs, verification and its ERC-8004 feedback
  // -------------------------------------------------------------------------

  /**
   * The live candidates as the router sees them: price and model, plus the
   * provider's track record — success rate, mean buyer rating, mean Kimi
   * score — and whether it holds an ERC-8004 identity.
   */
  function routeCandidates(matches: Match[]): RouteCandidate[] {
    const quality = new Map<string, { rating: number[]; verified: number[] }>();
    const ids = new Set(matches.map((m) => m.provider.id));
    for (const job of jobs.list({ limit: 2_000 })) {
      if (!job.providerId || !ids.has(job.providerId)) continue;
      const q = quality.get(job.providerId) ?? { rating: [], verified: [] };
      if (job.rating) q.rating.push(job.rating.value);
      if (job.verification) q.verified.push(job.verification.score);
      quality.set(job.providerId, q);
    }
    const mean = (xs: number[] | undefined) => (xs && xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return matches.map(({ provider, capability }) => {
      const { jobsCompleted, jobsFailed } = provider.stats;
      const total = jobsCompleted + jobsFailed;
      const q = quality.get(provider.id);
      return {
        adapter: capability.adapter,
        displayName: capability.displayName,
        model: capability.model ?? null,
        priceUsdMicros: capability.priceUsdMicros,
        successRate: total === 0 ? null : jobsCompleted / total,
        jobs: total,
        avgRating: mean(q?.rating),
        avgVerified: mean(q?.verified),
        hasAgent: provider.agentId !== null,
      };
    });
  }

  /** Score a finished job, store the verdict, then write it to ERC-8004. Never throws. */
  async function verifyJob(verifier: JobVerifier, job: StoredJob): Promise<void> {
    const verification = await withHookTimeout("result verifier", () => verifier.verify(job), hookDeadline(verifier));
    if (!verification) {
      metrics.inc("xorv_ai_verify_total", { outcome: "skipped" });
      return;
    }
    metrics.inc("xorv_ai_verify_total", { outcome: verification.pass ? "pass" : "fail" });
    metrics.observe("xorv_ai_latency_ms", verification.ms, { role: "verifier" });
    jobs.patch(job.id, { verification });
    await publishVerification(verifier.feedback ?? null, job.id);
  }

  const verificationEnv = () => ({
    network: config.network,
    publicUrl: config.publicUrl,
    jobsEndpoint,
    ledger: chain.ledgerAddress,
  });

  /**
   * Who a job's verification feedback would go to, or why it can't go at all.
   *
   * Same attribution rule as receipts and ratings (`receiptAgentId`): only
   * the quoted provider's own agent, and only when that provider did the
   * work. A payer on record is needed for the file's proof of payment. And
   * ERC-8004 refuses feedback from an agent's own wallet, so a verifier that
   * *is* the provider's payout address is caught here rather than on-chain.
   */
  function verificationTarget(job: StoredJob, sink: FeedbackSink): { agentId: string } | { skip: string } {
    const agentId = receiptAgentId(job);
    if (!agentId) return { skip: "the provider has no verified ERC-8004 identity for this job" };
    if (!job.payment || !isEvmAddress(job.payment.payer)) return { skip: "the job has no recorded payer" };
    if (sameAddress(sink.address, job.payment.payTo)) {
      return { skip: "the verifier EOA is the provider's own wallet, and ERC-8004 refuses self-feedback" };
    }
    return { agentId };
  }

  /**
   * Write a verified score to the Reputation Registry — best-effort, after
   * the job is over, and never able to change the job itself. The feedback
   * file's hash is stored on the job *before* the transaction goes out, so
   * `/verifications/<id>.json` already serves the committed file by the time
   * the registry's `NewFeedback` event points at it.
   */
  async function publishVerification(sink: FeedbackSink | null, jobId: string): Promise<void> {
    const job = jobs.get(jobId);
    const verification = job?.verification;
    if (!job || !verification || !sink) return;
    const target = verificationTarget(job, sink);
    if ("skip" in target) {
      console.log(`[broker] verification of ${jobId} stays off-chain: ${target.skip}`);
      return;
    }
    let staged: VerificationRecord;
    try {
      const parts = verificationFeedback(verificationEnv(), job, verification, {
        agentId: target.agentId,
        verifier: sink.address,
      });
      staged = {
        ...verification,
        agentId: target.agentId,
        verifier: sink.address,
        feedbackURI: parts.feedbackURI,
        feedbackHash: parts.feedbackHash,
        feedbackTxHash: null,
        feedbackError: null,
      };
    } catch (err) {
      console.error(`[broker] verification feedback for ${jobId}: ${err instanceof Error ? err.message : err}`);
      return;
    }
    jobs.patch(jobId, { verification: staged });
    try {
      const result = await sink.giveFeedback({
        agentId: target.agentId,
        value: verification.score,
        tag1: VERIFIED_TAG1,
        tag2: ratingTag(job),
        endpoint: jobsEndpoint,
        feedbackURI: staged.feedbackURI as string,
        feedbackHash: staged.feedbackHash as Hex,
      });
      jobs.patch(jobId, { verification: { ...staged, feedbackTxHash: result.txHash } });
      metrics.inc("xorv_ai_feedback_total", { outcome: "ok" });
    } catch (err) {
      jobs.patch(jobId, {
        verification: { ...staged, feedbackError: err instanceof Error ? err.message : String(err) },
      });
      metrics.inc("xorv_ai_feedback_total", { outcome: "failed" });
    }
  }

  // -------------------------------------------------------------------------
  // Receipts
  // -------------------------------------------------------------------------

  /**
   * The agent a receipt (and so a rating) is attributed to.
   *
   * XorvLedger requires the agent's wallet to be the address that was paid, so
   * a receipt can only name the *quoted* provider's agent. When a job was
   * reassigned, the provider paid is not the one that did the work, and
   * crediting either identity with the outcome would misattribute it — so
   * such receipts are recorded without an agent (and can't be rated).
   */
  function receiptAgentId(job: StoredJob): string | null {
    if (!job.providerAgentId) return null;
    const quoted = job.quotedProviderId ?? job.providerId;
    return job.providerId === quoted ? job.providerAgentId : null;
  }

  /**
   * Queue a job's XorvLedger receipt, once there is something to attest to:
   * the job is terminal *and* its payment is recorded. A receipt without a
   * settlement tx proves nothing, so an unpaid job gets none.
   *
   * Called from a job-store subscription, so every path that finishes a job
   * (result, failure, timeout, cancel) and every path that records a payment
   * lands here without having to remember to.
   */
  function enqueueReceipt(job: StoredJob): Promise<PublishResult | null> | null {
    if (chain.mode() !== "write" || job.receiptTxHash || !job.payment || !isTerminal(job.status)) return null;
    const state = receipts.get(job.id) ?? { attempts: 0, pending: null };
    if (state.pending) return state.pending;
    if (state.attempts >= MAX_RECEIPT_ATTEMPTS) return null;
    state.attempts += 1;

    const started = job.startedAt ?? job.assignedAt ?? job.createdAt;
    const pending = chain
      .recordJob({
        jobId: job.id,
        agentId: receiptAgentId(job),
        // A facilitator that didn't report the payer leaves "unknown"; the
        // receipt then records the zero address rather than failing to build.
        buyer: isEvmAddress(job.payment.payer) ? job.payment.payer : null,
        payTo: job.payment.payTo,
        amount: job.payment.amount,
        paymentTx: job.payment.txHash,
        prompt: job.request.prompt,
        result: job.result ?? "",
        durationMs: Math.max(0, (job.completedAt ?? Date.now()) - started),
        ok: job.status === "completed",
      })
      .then((result) => {
        state.pending = null;
        if (result) jobs.patch(job.id, { receiptTxHash: result.txHash });
        return result;
      });
    state.pending = pending;
    receipts.set(job.id, state);
    return pending;
  }

  /** Make sure a job's receipt is on its way, push it out now, and wait (bounded). */
  async function ensureReceipt(job: StoredJob): Promise<void> {
    const pending = enqueueReceipt(job) ?? receipts.get(job.id)?.pending ?? null;
    if (!pending) return;
    void chain.flush();
    await Promise.race([pending, sleep(RECEIPT_WAIT_MS)]);
  }

  jobs.subscribe((job) => {
    if (isTerminal(job.status) && job.payment && !job.receiptTxHash) enqueueReceipt(job);
  });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function authProvider(header: string | undefined) {
    const token = header?.replace(/^Bearer\s+/i, "").trim();
    return token ? registry.byAuthToken(token) : undefined;
  }

  return {
    app,
    /** How payments settle — for the boot banner. */
    settlement,
    hubHandlers: {
      onEvent: (providerId: string, jobId: string, event: JobEvent) => {
        const job = jobs.get(jobId);
        if (!job || job.providerId !== providerId || isTerminal(job.status)) return;
        jobs.addEvent(jobId, { ...event, at: event.at || Date.now() });
      },
      onResult: (providerId: string, jobId: string, result: string, durationMs: number) => {
        finishJobOk(jobId, providerId, result, durationMs);
      },
      onError: (providerId: string, jobId: string, error: string, durationMs: number) => {
        finishJobFailed(jobId, providerId, error, durationMs);
      },
      onAccepted: (providerId: string, jobId: string) => {
        const job = jobs.get(jobId);
        if (!job || job.providerId !== providerId || isTerminal(job.status)) return;
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
    /** Timers' work: fail overdue jobs, reap silent providers, retry receipts. */
    sweep(): void {
      for (const job of jobs.overdue()) {
        const providerId = job.providerId ?? "";
        // Tell the node to stop: its result would be ignored now anyway.
        if (providerId) deps.getHub()?.send(providerId, { type: "job.cancel", jobId: job.id, reason: "job timed out" });
        finishJobFailed(job.id, providerId, "job timed out", jobs.runtimeMs(job));
      }
      for (const id of registry.reap()) {
        console.log(`[broker] reaped idle provider ${id}`);
      }
      // Receipts whose write failed (or that were restored from disk before
      // their batch landed) get another go, a bounded number of times.
      if (chain.mode() === "write") {
        for (const job of jobs.list({ limit: 1_000 })) {
          if (isTerminal(job.status) && job.payment && !job.receiptTxHash) enqueueReceipt(job);
        }
      }
      // A settlement whose request never reached the handler is not coming back for.
      const staleBefore = Date.now() - QUOTE_TTL_SECONDS * 2_000;
      for (const [quoteId, entry] of settlements) if (entry.at < staleBefore) settlements.delete(quoteId);
    },
  };
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

type ParsedRegistration =
  | { error: string }
  | { registration: Omit<VerifiedRegistration, "agentId">; agentId: string | null };

/**
 * Validate a registration and normalize its address.
 *
 * The payout address is stored checksummed, so every later comparison (the
 * settle hook, receipts, the agent-wallet check) works on one spelling. An
 * agent id is a decimal string (a uint256 can outgrow a JSON number).
 */
export function validateRegistration(body: RegisterRequest | null): ParsedRegistration {
  if (!body || typeof body !== "object") return { error: "expected a JSON registration body" };
  if (typeof body.label !== "string" || !body.label.trim()) return { error: "label is required" };
  const rawAddress = typeof body.address === "string" ? body.address : "";
  if (!rawAddress) {
    return { error: "address is required — the 0x address this node is paid at (Monad, USDC)" };
  }
  let address: string;
  try {
    address = normalizeAddress(rawAddress);
  } catch (err) {
    return { error: `address: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (/^0x0{40}$/i.test(address)) return { error: "address cannot be the zero address" };
  let agentId: string | null = null;
  if (body.agentId !== undefined && body.agentId !== null && String(body.agentId).trim() !== "") {
    const raw = String(body.agentId).trim();
    if (!/^\d{1,78}$/.test(raw)) return { error: "agentId must be a decimal ERC-8004 agent id" };
    agentId = BigInt(raw).toString();
  }
  if (typeof body.nodeId !== "string" || !body.nodeId.trim()) return { error: "nodeId is required" };
  if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) {
    return { error: "at least one capability is required" };
  }
  for (const cap of body.capabilities as Capability[]) {
    if (!cap?.id || !cap.adapter) return { error: "each capability needs an id and an adapter" };
    if (!Number.isFinite(cap.priceUsdMicros) || cap.priceUsdMicros <= 0) {
      return { error: `capability "${cap.id}" needs a positive priceUsdMicros` };
    }
  }
  return {
    registration: {
      label: body.label.trim(),
      address,
      endpoint: typeof body.endpoint === "string" ? body.endpoint : "",
      capabilities: body.capabilities,
      version: typeof body.version === "string" ? body.version : "unknown",
      region: body.region ?? null,
      nodeId: body.nodeId,
    },
    agentId,
  };
}

/**
 * The adapter a quote request asked for, or null for "you choose": missing,
 * empty and "auto" all mean the buyer left it to the network.
 */
export function adapterChoice(raw: unknown): AdapterKind | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.toLowerCase() === "auto") return null;
  return value as AdapterKind;
}

function hasPaymentHeader(c: Context): boolean {
  return Boolean(c.req.header("payment-signature") ?? c.req.header("x-payment"));
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function lastSegment(path: string): string | undefined {
  return path.split("/").filter(Boolean).pop();
}

function quoteIdFromTransport(transport: unknown): string | undefined {
  const path = (transport as HTTPTransportContext | undefined)?.request?.path;
  return path ? lastSegment(path) : undefined;
}

function safeAddress(value: string): string {
  return isEvmAddress(value) ? normalizeAddress(value) : value;
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export type { AdapterKind, JobRequest };
