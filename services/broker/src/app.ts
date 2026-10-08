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
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type {
  FacilitatorClient,
  HTTPRequestContext,
  HTTPTransportContext,
  RoutesConfig,
} from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { erc20Abi, isAddress, isHex, parseEventLogs, verifyTypedData, type Hex } from "viem";
import {
  HEARTBEAT_INTERVAL_MS,
  JOB_TIMEOUT_MS,
  QUOTE_TTL_SECONDS,
  XORV_SCHEME,
  ESCROW_SCHEME,
  EscrowServerScheme,
  escrowJobId,
  escrowPaymentOption,
  buildAgentRegistration,
  explorerAddress,
  explorerToken,
  explorerTx,
  formatUsd,
  getAgentWallet,
  IDENTITY_ABI,
  isEvmAddress,
  isValidEncryptTo,
  isVaultId,
  jobIdHash,
  logPaymentRejections,
  isLocalRpc,
  networkConfig,
  sendModeOf,
  readTxStatus,
  reserveStanding,
  MONAD_RESERVE_WEI,
  formatMon,
  normalizeAddress,
  parseSealedResult,
  publicClientFor,
  sameAddress,
  serializeFeedbackFile,
  sha256,
  textHash,
  toJsonSafe,
  usdMicrosToUsdcUnits,
  usdcPaymentOption,
  usdcUnitsToUsdMicros,
  verifyVaultWrite,
  VAULT_MAX_CIPHERTEXT_BYTES,
  type AdapterKind,
  type Capability,
  type DispatchedJob,
  type HeartbeatRequest,
  type JobEvent,
  type JobRequest,
  type LedgerEventKind,
  type NetworkInfo,
  type ChainTiming,
  type TxStatus,
  type ReserveStanding,
  type AgentSessionTag,
  type PaymentRecord,
  type QuoteResponse,
  type RegisterRequest,
  type ReputationSummary,
  type VaultWrite,
} from "@xorv/protocol";
import type { BrokerConfig } from "./config.js";
import { describeLedger, type ChainLike, type PublishResult } from "./chain.js";
import type { Hub } from "./hub.js";
import { JobStore, isTerminal, receiptLanded, type Quote, type StoredJob } from "./jobs.js";
import {
  Registry,
  RegistrationRefused,
  type Match,
  type ProviderRecord,
  type RegisterOutcome,
  type VerifiedRegistration,
} from "./registry.js";
import { bodyLimit, rateLimit, requestLog } from "./guards.js";
import { Metrics } from "./metrics.js";
import { resolveFacilitator } from "./facilitator.js";
import { chainEscrow, type EscrowOps } from "./escrow.js";
import { IdentityBook, chainIdentity, type IdentitySource } from "./identity.js";
import { createLedgerReader, type LedgerReader } from "./ledger-reader.js";
import { hookDeadline, withHookTimeout, type AiHooks, type JobVerifier } from "./ai-hooks.js";
import { VERIFIED_TAG1, verificationFeedback, type FeedbackSink } from "./ai/feedback.js";
import { verifiable } from "./ai/verifier.js";
import type { RouteCandidate, RoutingRecord, ScreeningRecord, VerificationRecord } from "./ai/types.js";
import { ReputationBook } from "./ai/reputation-book.js";
import { createRouterData } from "./ai/router-data.js";
import { VaultStore } from "./vaults.js";
import { createNansenTrust, publicRelatedCheck, refusalMessage, type NansenTrust } from "./trust/index.js";
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
/** Where a settlement the facilitator gave up waiting on stands. */
export type SettlementStatus = "confirmed" | "failed" | "pending";
/** How long a broadcast settlement may stay unconfirmed before the quote is released. */
const PENDING_SETTLEMENT_GIVE_UP_MS = 15 * 60_000;
/** New vaults one client address may create per hour. */
const NEW_VAULTS_PER_HOUR = 10;
/** How long an `isAuthorizedOrOwner` answer is reused. */
const AUTHORIZATION_CACHE_MS = 60_000;
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
  /**
   * Identity Registry `isAuthorizedOrOwner(spender, agentId)`: whether the
   * agent's owner made `spender` its owner, approved address or operator.
   * Defaults to a read over RPC; tests stub it.
   */
  agentAuthorizes?: (agentId: string, spender: string) => Promise<boolean>;
  /**
   * Where a broadcast-but-unconfirmed settlement stands: its USDC transfer
   * landed as expected, it failed (reverted, or moved something else), or it
   * is still pending. Defaults to reading the receipt over RPC; tests stub it.
   */
  settlementStatus?: (
    txHash: string,
    expect: { asset: string; from: string; to: string; amount: string },
  ) => Promise<SettlementStatus>;
  /**
   * A confirmed transaction's block, gas used, gas paid and gas payer, for the
   * job's speed receipt. Defaults to reading the receipt over RPC; tests stub it.
   */
  txFacts?: (txHash: string) => Promise<TxFacts | null>;
  /**
   * When the chain's `finalized` head reached `blockNumber` with `blockHash`
   * (ms since epoch), or null if it didn't within the wait. Defaults to
   * polling the RPC's `finalized` tag; tests stub it.
   */
  finalizedAt?: (blockNumber: number, blockHash: string) => Promise<number | null>;
  /** An account's MON balance, for the reserve check on the broker's gas payers. Defaults to the RPC; tests stub it. */
  monBalance?: (address: string) => Promise<bigint>;
  /** Where a transaction stands (txpool, or its consensus state from the block tags). Defaults to the RPC; tests stub it. */
  txStatus?: (txHash: string) => Promise<TxStatus>;
  /** The AI roles, when installed — see ai-hooks.ts and src/ai/. */
  ai?: AiHooks;
  /**
   * ERC-8004 Reputation Registry `getSummary(agentId, clients, tag1)`, for the
   * router's erc8004_reputation tool. Defaults to a read over RPC; tests stub it.
   */
  reputationSummary?: (agentId: string, clients: string[], tag1: string) => Promise<ReputationSummary>;
  /** Private-job history vaults; defaults to an in-memory store. */
  vaults?: VaultStore;
  /**
   * Nansen trust signals (src/trust/). Defaults to one built from
   * `config.nansen` — off unless XORV_NANSEN_MODE says otherwise. Tests pass
   * a fixture-backed one.
   */
  trust?: NansenTrust;
  /** XorvEscrow operations. Defaults to the chain when XORV_ESCROW_ADDRESS is set; `null` pays providers directly. */
  escrow?: EscrowOps | null;
  /** The escrow's Cleanverse identity gate. Defaults to reading it off the escrow; `null` turns it off. */
  identity?: IdentitySource | null;
}

export function createApp(deps: AppDeps) {
  const { config, chain, registry, jobs } = deps;
  const vaults = deps.vaults ?? new VaultStore();
  const trust =
    deps.trust ?? createNansenTrust(config.nansen, { log: (line) => console.log(`[broker] ${line}`) });
  // The matcher breaks price ties on reliability nudged by wallet trust…
  registry.setTrustScorer((address) => trust.matchScore(address));
  // …and by reputation: buyer ratings and verifier scores from the Envio
  // indexer when one is configured, from this broker's own jobs otherwise.
  const reputation = new ReputationBook({
    indexer: config.indexerUrl ? { url: config.indexerUrl } : null,
    jobs: () => jobs.list({ limit: 2_000 }),
    log: (line) => console.warn(line),
  });
  registry.setReputationScorer((provider) => reputation.score(provider.id));
  // And only offers providers that can actually be handed the job.
  registry.setEligibility((id) => deps.getHub()?.isConnected(id) ?? false);
  const app = new Hono();
  const metrics = deps.metrics ?? new Metrics();
  const net = networkConfig(config.network);
  const bootedAt = Date.now();
  const heartbeatCounters = new Map<string, number>();
  /** The last registration fingerprint published per provider — re-registering unchanged is free. */
  const publishedRegistrations = new Map<string, string>();
  /** Settlements that landed before their job existed (the upfront flow), keyed by quote id. */
  const settlements = new Map<string, { record: PaymentRecord; at: number }>();
  /**
   * Jobs whose buyer is cancelling them. The escrow refund takes a block or two,
   * and a provider that finishes meanwhile must not turn a refunded job into a
   * "completed" one: its result and errors are ignored until the cancel lands.
   */
  const cancelling = new Set<string>();
  /**
   * The broker's gas payers against Monad's 10 MON reserve: the facilitator
   * (settlements, escrow writes) and the operator (receipts, rating relays).
   * Refreshed at most once a minute; a payer below the reserve is logged
   * loudly, because its in-flight gas is then no longer covered.
   */
  const gasPayers = new Map<string, { roles: string[]; standing: ReserveStanding | null; checkedAt: number }>();
  let gasCheckedAt = 0;
  async function refreshGasPayers(): Promise<void> {
    if (Date.now() - gasCheckedAt < 60_000) return;
    gasCheckedAt = Date.now();
    const wanted = new Map<string, string[]>();
    const add = (address: string | null | undefined, role: string) => {
      if (!address) return;
      const key = normalizeAddress(address);
      wanted.set(key, [...(wanted.get(key) ?? []), role]);
    };
    add(settlement.address, escrow ? "facilitator · escrow attester" : "facilitator");
    add(config.operator?.address, "operator");
    for (const [address, roles] of wanted) {
      try {
        const balance = await (deps.monBalance ?? ((a: string) => publicClientFor(config.network).getBalance({ address: a as Hex })))(address);
        const standing = reserveStanding(balance);
        const was = gasPayers.get(address)?.standing;
        if (!standing.aboveReserve && (was === undefined || was === null || was.aboveReserve)) {
          console.warn(
            `[broker] ⚠ ${roles.join(", ")} ${address} holds ${formatMon(balance)}, below Monad's 10 MON reserve: its in-flight gas is no longer covered. Top it up.`,
          );
        }
        gasPayers.set(address, { roles, standing, checkedAt: Date.now() });
      } catch {
        gasPayers.set(address, { roles, standing: gasPayers.get(address)?.standing ?? null, checkedAt: Date.now() });
      }
    }
  }

  /** Whether this broker's chain is a Monad network or a local one (a fork), for every timing it reports. */
  const chainKind: "monad" | "local" = isLocalRpc(networkConfig(config.network).rpcUrl) ? "local" : "monad";
  /** When each quote's settlement was submitted, for its speed receipt. */
  const settleStarted = new Map<string, number>();
  /**
   * Settlements broadcast but not confirmed when the facilitator stopped
   * waiting (x402 "settlement_pending"), keyed by quote id. The transfer can
   * still land, so the quote stays locked and the sweep keeps checking: once
   * it lands the job is created and dispatched under that quote.
   */
  const pendingSettlements = new Map<string, { record: PaymentRecord; since: number; checking: boolean }>();
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

  /**
   * What the router's tools read: ERC-8004 on Monad, XorvLedger receipts
   * (indexer first, RPC fallback), Envio provider aggregates and the public
   * Nansen trust view. Built once; its reads are cached for a few seconds.
   */
  const routerData = createRouterData({
    network: config.network,
    ledgerAddress: chain.ledgerAddress,
    verifierAddress: () => deps.ai?.verifier?.feedback?.address ?? null,
    reader,
    indexer: config.indexerUrl ? { url: config.indexerUrl } : null,
    trust,
    agentWallet: lookupAgentWallet,
    reputationSummary: deps.reputationSummary,
  });

  const lookupAuthorizes =
    deps.agentAuthorizes ??
    ((agentId: string, spender: string) =>
      publicClientFor(config.network).readContract({
        address: net.erc8004.identity,
        abi: IDENTITY_ABI,
        functionName: "isAuthorizedOrOwner",
        args: [spender as Hex, BigInt(agentId)],
      }) as Promise<boolean>);
  /** Recent `isAuthorizedOrOwner` answers, so offering a rating isn't an RPC call every time. */
  const authorizations = new Map<string, { value: boolean; at: number }>();

  /**
   * True when the agent's owner has made `spender` (XorvLedger, or the
   * verifier EOA) an approved address or operator of the agent NFT. The
   * Reputation Registry refuses feedback from any such address as
   * self-feedback, so a provider can freeze its score by approving the
   * ledger: every rating would revert. Checked before a rating is offered or
   * relayed so the buyer is told why, instead of paying for a Nansen check
   * and getting an opaque revert. A failed lookup is not proof of anything,
   * and answers false (the chain still has the last word).
   */
  async function agentAuthorizes(agentId: string, spender: string, opts: { fresh?: boolean } = {}): Promise<boolean> {
    const key = `${agentId}:${spender.toLowerCase()}`;
    const cached = authorizations.get(key);
    if (!opts.fresh && cached && Date.now() - cached.at < AUTHORIZATION_CACHE_MS) return cached.value;
    try {
      const value = await withTimeout(
        lookupAuthorizes(agentId, spender),
        AGENT_CHECK_TIMEOUT_MS,
        "authorization lookup timed out",
      );
      authorizations.set(key, { value, at: Date.now() });
      return value;
    } catch (err) {
      console.warn(`[broker] isAuthorizedOrOwner(${spender}, #${agentId}): ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** Why no rating can reach this agent, when the ledger is one of its operators. */
  function ledgerAuthorizedRefusal(agentId: string) {
    return {
      error:
        `ERC-8004 agent #${agentId} has approved XorvLedger as an operator of its identity, and the Reputation ` +
        "Registry refuses feedback from an agent's own operators (self-feedback), so no rating can reach it. " +
        "The provider has to revoke that approval before its jobs can be rated.",
      code: "ledger_authorized",
    } as const;
  }

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

  /**
   * Where paid jobs' money waits, or null to pay providers directly.
   *
   * With an escrow the 402 offers the `escrow` scheme first and `exact` after
   * it: a buyer who reads the quote's escrow pays into XorvEscrow, where the
   * money is released to the provider on delivery and refunded if the job
   * fails; a stock x402 client that only speaks `exact` can still pay. It needs
   * the self-hosted facilitator, whose key is the escrow's attester.
   */
  const escrow: EscrowOps | null =
    deps.escrow !== undefined
      ? deps.escrow
      : config.escrowAddress && settlement.mode === "self" && settlement.facilitator && config.facilitatorAccount
        ? chainEscrow(config.network, config.escrowAddress, config.facilitatorAccount)
        : null;
  if (config.escrowAddress && !escrow && deps.escrow === undefined) {
    console.warn(
      "[broker] XORV_ESCROW_ADDRESS is set, but escrow needs XORV_FACILITATOR=self with a funded key " +
        "(the escrow's attester); providers are paid directly until it has one",
    );
  }
  const escrowDeadlineSeconds = config.escrowDeadlineSeconds ?? 1_800;
  // The gas payers are known now; check them against Monad's reserve once at boot (then from the sweep).
  void refreshGasPayers();

  /** Cleanverse CVI standing, when the escrow has an identity gate. */
  const identitySource: IdentitySource | null =
    deps.identity !== undefined ? deps.identity : escrow ? chainIdentity(config.network, escrow.address) : null;
  const identity = identitySource
    ? new IdentityBook(identitySource, { log: (m) => console.warn(`[broker] ${m}`) })
    : null;
  if (identity) void identity.load().then(() => identity.refresh(registry.live().map((p) => p.address)));
  /** Providers the gate is known to refuse: never quoted, never handed a job. */
  const unverifiedProviders = (): string[] =>
    identity ? registry.live().filter((p) => identity.blocked(p.address)).map((p) => p.id) : [];

  const x402Server = settlement.facilitator
    ? new x402ResourceServer(settlement.facilitator).register(config.network as Network, new ExactEvmScheme())
    : null;
  if (x402Server && escrow) x402Server.register(config.network as Network, new EscrowServerScheme());

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
    // A payment from the payee to itself moves nothing, but it would still
    // buy a "paid" job, a receipt, earnings and rating eligibility at the
    // settlement's gas cost. The paid-route guard refuses it before this; this
    // is the backstop for a payload that guard could not read.
    x402Server.onBeforeSettle(async (ctx) => {
      const startedQuote = quoteIdFromTransport(ctx.transportContext);
      if (startedQuote) settleStarted.set(startedQuote, Date.now());
      const from = authorizationFrom(ctx.paymentPayload as PaymentPayload);
      // Escrow pays the contract; the payee that matters is the provider it releases to.
      const payee =
        ctx.requirements.scheme === ESCROW_SCHEME
          ? String((ctx.requirements.extra as { provider?: unknown } | undefined)?.provider ?? "")
          : ctx.requirements.payTo;
      if (from && sameAddress(from, payee)) {
        return { abort: true, reason: "self_payment", message: "the payer is the provider being paid" };
      }
    });

    /**
     * A settlement the facilitator broadcast but could not confirm in time
     * (a slow or rate-limited RPC). It used to count as failed: the quote went
     * back on sale and clients told the buyer nothing was charged, while the
     * transfer went on to land. Now the broker looks once more: landed means
     * the payment recovers and the job runs; still pending means the quote
     * stays locked and the sweep keeps watching (see `settlePending`).
     */
    x402Server.onSettleFailure(async (ctx) => {
      const failure = ctx.error as { errorReason?: string; transaction?: string; payer?: string };
      if (failure.errorReason !== "settlement_pending" || !failure.transaction) return;
      const quoteId = quoteIdFromTransport(ctx.transportContext);
      const quote = quoteId ? jobs.getQuote(quoteId) : undefined;
      if (!quote || quote.jobId) return;
      const record = paymentRecord(
        ctx.requirements as PaymentRequirements,
        {
          success: true,
          transaction: failure.transaction,
          network: ctx.requirements.network,
          payer: failure.payer,
        } as SettleResponse,
        ctx.paymentPayload as PaymentPayload,
      );
      const status = await checkSettlement(record);
      if (status === "confirmed") {
        settlements.set(quote.id, { record, at: Date.now() });
        const result: SettleResponse = {
          success: true,
          transaction: record.txHash,
          network: record.network as Network,
          payer: record.payer,
        };
        return { recovered: true as const, result };
      }
      if (status === "pending") {
        quote.pendingSettlement = { txHash: record.txHash, since: Date.now() };
        pendingSettlements.set(quote.id, { record, since: Date.now(), checking: false });
        console.warn(`[broker] quote ${quote.id}: settlement ${record.txHash} broadcast but unconfirmed — watching it`);
      }
      return;
    });

    x402Server.onAfterSettle(async (ctx) => {
      const quoteId = quoteIdFromTransport(ctx.transportContext);
      if (!quoteId || !ctx.result.success || !ctx.result.transaction) return;
      const record = paymentRecord(
        ctx.requirements as PaymentRequirements,
        ctx.result as SettleResponse,
        ctx.paymentPayload as PaymentPayload,
      );
      const started = settleStarted.get(quoteId);
      settleStarted.delete(quoteId);
      const quote = jobs.getQuote(quoteId);
      if (quote?.jobId) {
        jobs.patch(quote.jobId, { payment: record });
      } else {
        settlements.set(quoteId, { record, at: Date.now() });
      }
      // The speed receipt: how long the settlement took on this broker's clock, then its
      // block and gas from the receipt. Off the request path; a failed read just leaves it out.
      void chainTiming(record.txHash, started ?? null, Date.now()).then((timing) => {
        if (!timing) return;
        record.timing = timing;
        const jobId = jobs.getQuote(quoteId)?.jobId;
        const job = jobId ? jobs.get(jobId) : undefined;
        if (job?.payment && sameHash(job.payment.txHash, record.txHash)) jobs.patch(job.id, { payment: { ...job.payment, timing } });
      });
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
    const base = {
      asset: "usdc" as const,
      assetAddress: safeAddress(requirements.asset),
      amount: result.amount ?? requirements.amount,
      network: requirements.network,
      txHash: result.transaction,
      payer: payer ? normalizeAddress(payer) : "unknown",
      settledAt: Date.now(),
      explorerUrl: explorerTx(config.network, result.transaction),
    };
    if (requirements.scheme === ESCROW_SCHEME) {
      // The money is in XorvEscrow. `payTo` stays the provider it will be
      // released to, so ratings, receipts and the self-payment guard keep
      // meaning "who gets paid"; `txHash` is the funding.
      const extra = (requirements.extra ?? {}) as { escrow?: string; jobId?: string; deadline?: number; provider?: string };
      const provider = safeAddress(extra.provider ?? "");
      const address = safeAddress(extra.escrow ?? requirements.payTo);
      return {
        ...base,
        payTo: provider,
        scheme: "escrow",
        escrow: {
          address,
          jobId: String(extra.jobId ?? ""),
          deadline: Number(extra.deadline ?? 0),
          state: "funded",
          provider,
          explorerUrl: explorerAddress(config.network, address),
        },
      };
    }
    return { ...base, payTo: safeAddress(requirements.payTo), scheme: "exact" };
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
  // Anyone can mint a vault key, so vault writes are storage anyone can ask
  // for; reads are free.
  const vaultWriteLimit = rateLimit({ limit: 20, windowMs: 60_000 });
  // Creating a vault is what fills the store for good (vaults are never
  // evicted), so a caller gets far fewer new vaults than writes.
  const newVaultLimit = rateLimit({ limit: NEW_VAULTS_PER_HOUR, windowMs: 3_600_000 });
  app.use("/api/vaults/:id", async (c, next) => {
    if (c.req.method !== "PUT") return next();
    if (!vaults.has(c.req.param("id") ?? "")) {
      const refused = await newVaultLimit(c, async () => {});
      if (refused) return refused;
    }
    return vaultWriteLimit(c, next);
  });

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
      // XorvEscrow, when jobs are paid into escrow; its Cleanverse gate, when it has one.
      escrow: escrow
        ? {
            address: escrow.address,
            url: explorerAddress(config.network, escrow.address),
            deadlineSeconds: escrowDeadlineSeconds,
            keeper: config.refundKeeperAddress ?? null,
            identityGate: identity?.gate() ?? null,
          }
        : null,
      // Monad's reserve rule, for the accounts that pay this broker's gas.
      gas: {
        reserveWei: MONAD_RESERVE_WEI.toString(),
        chain: chainKind,
        payers: [...gasPayers.entries()].map(([address, p]) => ({
          address,
          roles: p.roles,
          url: explorerAddress(config.network, address),
          ...(p.standing ?? { balanceWei: null, aboveReserve: null }),
        })),
      },
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
      // What the broker bought from Nansen today, over x402 on Monad mainnet.
      nansen: trust.status(),
      feeBps: config.feeBps,
      epoch: deps.getHub()?.epoch ?? bootedAt,
      stats: {
        providersLive: live.length,
        providersConnected: deps.getHub()?.connectedCount() ?? 0,
        capacity: live.reduce((n, p) => n + p.capabilities.length, 0),
        jobsTotal: allJobs.length,
        jobsCompleted: allJobs.filter((j) => j.status === "completed").length,
        // Paid means it reached a provider: a direct payment, or an escrow that released.
        // Money still held, or refunded to the buyer, is reported on its own.
        paidUsdMicros: sumPrice(settled.filter((j) => !j.payment?.escrow || j.payment.escrow.state === "released")),
        heldUsdMicros: sumPrice(settled.filter((j) => j.payment?.escrow?.state === "funded")),
        refundedUsdMicros: sumPrice(settled.filter((j) => j.payment?.escrow?.state === "refunded")),
        ...speedStats(settled),
        timingChain: chainKind,
      },
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    };
    return c.json(body);
  });

  // Read-only gate standing for provider and buyer badges. No absent gate
  // or failed read may be presented as identity verification.
  app.get("/api/identity/:address", async (c) => {
    const address = c.req.param("address");
    if (!isAddress(address)) return c.json({ error: "invalid_address" }, 400);
    if (!identitySource) return c.json({ gate: null, verified: null, checkedAt: null });
    try {
      const gate = await identitySource.gate();
      if (!gate) return c.json({ gate: null, verified: null, checkedAt: null });
      const [verified] = await identitySource.verified([address]);
      if (typeof verified !== "boolean") return c.json({ error: "identity_unavailable" }, 503);
      return c.json({ gate, verified, checkedAt: Date.now() });
    } catch {
      return c.json({ error: "identity_unavailable" }, 503);
    }
  });

  app.get("/api/providers", (c) => {
    const hub = deps.getHub();
    return c.json({
      providers: registry
        .list()
        .map((p) => ({
          ...publicProvider(config.network, p, hub?.isConnected(p.id) ?? false, trust.publicSignal(p.address)),
          // Cleanverse CVI standing, when the escrow has an identity gate; null otherwise.
          identity: identity?.get(p.address) ?? null,
        })),
    });
  });

  /** One provider — live, or recently departed (then `status: "offline"`). */
  app.get("/api/providers/:id", (c) => {
    const provider = registry.find(c.req.param("id"));
    if (!provider) return c.json({ error: "unknown provider" }, 404);
    const connected = deps.getHub()?.isConnected(provider.id) ?? false;
    return c.json({
      provider: {
        ...publicProvider(config.network, provider, connected, trust.publicSignal(provider.address)),
        identity: identity?.get(provider.address) ?? null,
      },
    });
  });

  /**
   * A provider's ERC-8004 registration file — what its agent URI resolves to.
   *
   * Served by the broker so a node can register its identity with a single
   * `IdentityRegistry.register(agentURI)` transaction and a URL that never
   * changes: the provider id is derived from the node id, so it survives both
   * node and broker restarts.
   *
   * Keyed by provider id only. `xorv identity register` computes the id
   * locally (`providerIdFor` in @xorv/protocol) before the node has ever
   * registered. Resolving the node id here too was what invited a CLI to
   * write the node id — the secret that reclaims a node's slot — into a
   * public, permanent agent URI.
   */
  app.get("/agents/:file", (c) => {
    const file = c.req.param("file");
    if (!file.endsWith(".json")) return c.json({ error: "not found" }, 404);
    const name = file.slice(0, -".json".length);
    const provider = registry.find(name);
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

    // Re-registering a node id that has a live session takes that session's
    // bearer token; the node id alone only reclaims a slot nobody is holding
    // (after a broker restart, or once the old session went offline).
    const presented = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() || null;
    let outcome: RegisterOutcome;
    try {
      outcome = registry.registerNode({ ...parsed.registration, agentId }, { token: presented });
      if (identity) void identity.refresh([parsed.registration.address]);
    } catch (err) {
      if (err instanceof RegistrationRefused) {
        console.warn(`[broker] registration "${parsed.registration.label}" refused: node id has a live session`);
        return c.json({ error: err.message, code: err.code, retryAfterMs: err.retryAfterMs }, 409);
      }
      throw err;
    }
    const provider = outcome.provider;
    // A fresh token was minted, so whoever held the old one — and any socket
    // it opened — no longer speaks for this node.
    if (!outcome.authenticated) deps.getHub()?.disconnect(provider.id, "this node re-registered with a new token");
    // The payout wallet's Nansen signal is bought once the node opens its
    // control channel (hubHandlers.onConnect), not here: a registration is
    // free and unauthenticated, and every fresh address costs real USDC.
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
      finishJobFailed(job.id, provider.id, providerError(job, body.error), body.durationMs ?? 0);
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
    // A private job names the buyer's passkey-derived inbox key. It is
    // checked here, before a provider is reserved, because a key nobody can
    // seal to would only fail on the provider after the buyer had paid.
    const { encryptTo } = body;
    if (encryptTo !== undefined && encryptTo !== null && !isValidEncryptTo(encryptTo)) {
      return c.json(
        { error: "encryptTo must be a 32-byte X25519 public key in unpadded base64url (a private job's inbox key)" },
        400,
      );
    }
    if (!jobs.hasQuoteRoom()) {
      return c.json({ error: "this broker is holding too many open quotes — try again in a minute" }, 503);
    }
    // Only the fields a job request has. Spreading the body kept whatever
    // else the caller sent (up to the body limit) in every quote and job.
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : null;
    const deadlineAt = typeof body.deadlineAt === "number" && Number.isFinite(body.deadlineAt) ? body.deadlineAt : null;
    const agent = agentTag(body.agent);
    const request: JobRequest = {
      prompt: body.prompt,
      // "auto" (or nothing) is how a buyer says "you choose" — the router's cue.
      adapter: adapterChoice(body.adapter),
      maxPriceUsdMicros: maxPrice,
      ...(title ? { title } : {}),
      ...(deadlineAt !== null ? { deadlineAt } : {}),
      ...(encryptTo ? { encryptTo } : {}),
      ...(agent ? { agent } : {}),
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
    const candidates = registry.candidates({
      adapter: request.adapter ?? null,
      maxPriceUsdMicros: maxPrice,
      // The escrow's identity gate would refuse to fund a job for these.
      exclude: unverifiedProviders(),
    });
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
    //    choice to make: Qwen reads the candidates' on-chain reputation,
    //    receipts, indexer stats and wallet trust with its tools and picks a
    //    provider. The pick is checked against the live candidates (all under
    //    the ceiling) here too; without one the matcher chooses — cheapest,
    //    then reputation and reliability.
    const router = deps.ai?.router;
    let routing: RoutingRecord | null = null;
    if (router && !request.adapter && candidates.length > 1) {
      routing = await withHookTimeout(
        "job router",
        () => router.route(request, routeCandidates(candidates), routerData),
        hookDeadline(router),
      );
    }
    let match: Match = candidates[0]!;
    if (routing?.providerId) {
      const { providerId, adapter } = routing;
      const routed = candidates.find(
        (m) => m.provider.id === providerId && (!adapter || m.capability.adapter === adapter),
      );
      if (routed) {
        match = routed;
      } else {
        routing = {
          ...routing,
          providerId: null,
          providerLabel: null,
          agentId: null,
          adapter: null,
          difficulty: null,
          fallback: "invalid",
          reason: "the router's pick is no longer a live option within the ceiling — matched on price instead",
        };
      }
    } else if (routing?.adapter) {
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
    if (escrow) {
      // Frozen with the price: the buyer's signature binds to this job id and deadline.
      quote.escrow = {
        address: escrow.address,
        jobId: escrowJobId(quote.id),
        deadline: Math.floor(Date.now() / 1000) + escrowDeadlineSeconds,
      };
    }

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
        ...(quote.escrow
          ? [
              {
                scheme: ESCROW_SCHEME as "escrow",
                network: config.network,
                asset: net.usdc.address,
                amount: quote.usdcAmount,
                payTo: quote.escrow.address,
                maxTimeoutSeconds: QUOTE_TTL_SECONDS,
                extra: {
                  name: net.usdc.name,
                  version: net.usdc.version,
                  escrow: quote.escrow.address,
                  jobId: quote.escrow.jobId,
                  deadline: quote.escrow.deadline,
                  provider: quote.providerAddress,
                },
              },
            ]
          : []),
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
      escrow: quote.escrow
        ? { ...quote.escrow, explorerUrl: explorerAddress(config.network, quote.escrow.address) }
        : null,
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
      accepts: [
        // Escrow first when there is one: the money waits in XorvEscrow until
        // the job delivers. Its terms are the ones frozen on the quote.
        ...(escrow
          ? [
              {
                ...escrowPaymentOption({
                  network: config.network,
                  escrow: escrow.address,
                  amount: (ctx) => quoteFromContext(ctx)?.usdcAmount ?? "0",
                  terms: (ctx) => {
                    const quote = quoteFromContext(ctx);
                    return quote?.escrow
                      ? { jobId: quote.escrow.jobId, deadline: quote.escrow.deadline, provider: quote.providerAddress }
                      : null;
                  },
                  maxTimeoutSeconds: QUOTE_TTL_SECONDS,
                }),
                extra: { paymentFlow: "upfront" },
              },
            ]
          : []),
        {
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
      ],
      // A failed settlement answers 402. When the transfer was broadcast and
      // may still land, say so plainly: "nothing was charged" would be wrong,
      // and paying again would pay twice.
      settlementFailedResponseBody: (ctx, result) => {
        const quote = quoteFromContext(ctx);
        if (result.errorReason === "settlement_pending" && result.transaction && quote?.pendingSettlement) {
          return {
            contentType: "application/json",
            body: {
              error:
                "the payment was broadcast but is not confirmed yet, and it may still land — do not pay again. " +
                "The job starts by itself once it confirms; follow the quote to find it.",
              code: "settlement_pending",
              pending: true,
              txHash: result.transaction,
              quoteId: quote.id,
              quoteUrl: `${config.publicUrl}/api/quotes/${quote.id}`,
            },
          };
        }
        return {
          contentType: "application/json",
          body: { error: `the payment did not settle: ${result.errorReason ?? "unknown reason"}`, code: result.errorReason ?? null },
        };
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
    // Checked before the payment middleware, so the buyer is never charged
    // for a provider that could not be handed the job.
    if (!deps.getHub()?.isConnected(provider.id)) {
      return c.json(
        { error: "the quoted provider has no control channel open, so it can't take the job — request a new quote" },
        409,
      );
    }
    if (!x402Server) {
      return c.json({ error: settlement.unavailableReason ?? "payments are unavailable" }, 503);
    }
    if (quote.pendingSettlement) {
      return c.json(
        {
          error: "a payment for this quote was broadcast and is still confirming — do not pay again",
          code: "settlement_pending",
          txHash: quote.pendingSettlement.txHash,
          quoteUrl: `${config.publicUrl}/api/quotes/${quote.id}`,
        },
        409,
      );
    }
    if (!hasPaymentHeader(c)) return next();
    // Refused before anything settles: see onBeforeSettle.
    if (sameAddress(payerFromHeader(c), quote.providerAddress)) {
      return c.json(SELF_PAYMENT_REFUSAL, 403);
    }

    // One settlement per quote at a time — see Quote.paying.
    if (quote.paying) {
      return c.json({ error: "a payment for this quote is already being settled" }, 409);
    }
    quote.paying = true;
    try {
      await next();
    } finally {
      // Settlement failed (or never happened): the quote is still for sale.
      // Unless it was broadcast and is still confirming: then it stays locked.
      if (!quote.jobId && !quote.pendingSettlement) {
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
    if (settled && sameAddress(settled.record.payer, settled.record.payTo)) {
      // Nothing moved (payer and payee are one wallet), so nothing is owed:
      // no job, no receipt, no earnings.
      return c.json(SELF_PAYMENT_REFUSAL, 403);
    }
    if (!settled) {
      // Only reachable if the payment flow were ever switched back to
      // settle-after-handler; then onAfterSettle attaches it to the job.
      console.warn(`[broker] quote ${quote.id}: handler ran before settlement was recorded`);
    }

    // Handed only to the buyer, in this response: the capability to cancel.
    const cancelToken = randomBytes(24).toString("base64url");
    const job = openJob(quote, settled?.record ?? null, sha256(cancelToken));

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

  /** Turn a paid quote into a job and hand it to its provider. */
  function openJob(quote: Quote, payment: PaymentRecord | null, cancelTokenHash: string | null): StoredJob {
    const job = jobs.createJob(quote, { payment, cancelTokenHash });
    jobIdByHash.set(jobIdHash(job.id), job.id);
    metrics.inc("xorv_payments_total");
    dispatch(job);
    return job;
  }

  /**
   * Where a quote stands, for a buyer whose payment answered
   * "settlement_pending": still confirming, paid (with its job), or open.
   * Only the buyer holds a quote id, and nothing here names the prompt.
   */
  app.get("/api/quotes/:id", (c) => {
    const quote = jobs.getQuote(c.req.param("id"));
    if (!quote) return c.json({ error: "quote not found or expired" }, 404);
    const status = quote.jobId ? "paid" : quote.pendingSettlement ? "settling" : "open";
    return c.json({
      quoteId: quote.id,
      status,
      jobId: quote.jobId ?? null,
      jobUrl: quote.jobId ? `${config.publicUrl}/api/jobs/${quote.jobId}` : null,
      txHash: quote.pendingSettlement?.txHash ?? null,
      expiresAt: quote.expiresAt,
    });
  });

  /** Whether a settlement's USDC transfer landed, failed, or is still pending. */
  async function checkSettlement(record: PaymentRecord): Promise<SettlementStatus> {
    try {
      return await (deps.settlementStatus ?? readSettlementStatus)(record.txHash, {
        asset: record.assetAddress,
        from: record.payer,
        // An escrowed payment's transfer goes into the contract, not to the provider.
        to: record.escrow?.address ?? record.payTo,
        amount: record.amount,
      });
    } catch (err) {
      console.warn(`[broker] settlement ${record.txHash}: ${err instanceof Error ? err.message : err}`);
      return "pending";
    }
  }

  /** The default `settlementStatus`: the receipt, and the USDC Transfer in it. */
  async function readSettlementStatus(
    txHash: string,
    expect: { asset: string; from: string; to: string; amount: string },
  ): Promise<SettlementStatus> {
    const client = publicClientFor(config.network);
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null);
    if (!receipt) return "pending";
    if (receipt.status !== "success") return "failed";
    const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs });
    const paid = transfers.some(
      (log) =>
        sameAddress(log.address, expect.asset) &&
        sameAddress(log.args.from, expect.from) &&
        sameAddress(log.args.to, expect.to) &&
        log.args.value === BigInt(expect.amount),
    );
    return paid ? "confirmed" : "failed";
  }

  /**
   * The sweep's pass over settlements still confirming: landed → the job is
   * created and dispatched under its quote; failed → the quote is for sale
   * again (nothing moved); unconfirmed for too long → released, loudly.
   */
  async function settlePending(): Promise<void> {
    for (const [quoteId, entry] of pendingSettlements) {
      if (entry.checking) continue;
      entry.checking = true;
      const status = await checkSettlement(entry.record);
      entry.checking = false;
      const quote = jobs.getQuote(quoteId);
      if (!quote || quote.jobId) {
        pendingSettlements.delete(quoteId);
        continue;
      }
      if (status === "confirmed") {
        pendingSettlements.delete(quoteId);
        quote.pendingSettlement = undefined;
        const job = openJob(quote, entry.record, null);
        console.log(`[broker] quote ${quoteId}: settlement ${entry.record.txHash} confirmed late — job ${job.id} dispatched`);
        continue;
      }
      const stale = Date.now() - entry.since > PENDING_SETTLEMENT_GIVE_UP_MS;
      if (status === "failed" || stale) {
        pendingSettlements.delete(quoteId);
        quote.pendingSettlement = undefined;
        quote.paying = false;
        console.warn(
          `[broker] quote ${quoteId}: settlement ${entry.record.txHash} ${status === "failed" ? "failed" : "never confirmed"} — quote released`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Job reads
  // -------------------------------------------------------------------------

  app.get("/api/jobs", (c) => {
    const limit = clampInt(c.req.query("limit"), 1, 500, 50);
    const providerId = c.req.query("providerId") ?? undefined;
    return c.json({ jobs: jobs.list({ limit, providerId }).map((job) => publicJob(job)) });
  });

  /**
   * Where one transaction stands on this broker's chain: pending in Monad's
   * txpool, or mined and Proposed, Voted or Finalized (from the latest, safe
   * and finalized heads). Read-only; cached for half a second per hash so a
   * page polling it can't multiply RPC load. `chain` says whether the answer
   * is Monad's or a local fork's.
   */
  const txStatusCache = new Map<string, { at: number; value: Promise<TxStatus> }>();
  app.get("/api/tx/:hash", async (c) => {
    const hash = c.req.param("hash").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) return c.json({ error: "not a transaction hash" }, 400);
    const cached = txStatusCache.get(hash);
    let value: Promise<TxStatus>;
    if (cached && Date.now() - cached.at < 500) {
      value = cached.value;
    } else {
      value = (deps.txStatus ?? ((h: string) => readTxStatus(publicClientFor(config.network), h as Hex)))(hash);
      txStatusCache.set(hash, { at: Date.now(), value });
      if (txStatusCache.size > 1000) txStatusCache.delete(txStatusCache.keys().next().value!);
    }
    try {
      return c.json({ ...(await value), chain: chainKind });
    } catch (err) {
      txStatusCache.delete(hash);
      return c.json({ error: `could not read the chain: ${err instanceof Error ? err.message.split("\n")[0] : err}` }, 502);
    }
  });

  /**
   * Agent sessions: the jobs one buying agent (an MCP server process) bought,
   * grouped by the session tag it sent with its quotes, with its spend against
   * the budget it declared. The tag is self-reported; the money is not: every
   * figure is a sum of payment records that hold their on-chain transactions.
   */
  const sessionsOf = () => {
    const sessions = new Map<string, StoredJob[]>();
    for (const job of jobs.list({ limit: 1_000 })) {
      const tag = job.request.agent;
      if (!tag) continue;
      sessions.set(tag.session, [...(sessions.get(tag.session) ?? []), job]);
    }
    return sessions;
  };
  const summarizeSession = (session: string, list: StoredJob[]) => {
    const tag = list[0]!.request.agent!;
    const paid = list.filter((j) => j.payment);
    const sum = (f: (j: StoredJob) => boolean) => sumPrice(paid.filter(f));
    const payers = [...new Set(paid.map((j) => j.payment!.payer))];
    return {
      session,
      name: tag.name,
      client: tag.client,
      budgetUsdMicros: tag.budgetUsdMicros,
      payers,
      jobs: list.length,
      completed: list.filter((j) => j.status === "completed").length,
      spentUsdMicros: sum((j) => !j.payment!.escrow || j.payment!.escrow.state === "released"),
      heldUsdMicros: sum((j) => j.payment!.escrow?.state === "funded"),
      refundedUsdMicros: sum((j) => j.payment!.escrow?.state === "refunded"),
      firstAt: Math.min(...list.map((j) => j.createdAt)),
      lastAt: Math.max(...list.map((j) => j.createdAt)),
    };
  };
  app.get("/api/agents", (c) => {
    const sessions = [...sessionsOf()].map(([id, list]) => summarizeSession(id, list)).sort((a, b) => b.lastAt - a.lastAt);
    return c.json({ sessions: sessions.slice(0, 50) });
  });
  app.get("/api/agents/:session", (c) => {
    const list = sessionsOf().get(c.req.param("session"));
    if (!list) return c.json({ error: "no jobs from this agent session" }, 404);
    return c.json({ ...summarizeSession(c.req.param("session"), list), jobList: list.sort((a, b) => b.createdAt - a.createdAt).map((j) => publicJob(j)) });
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
   * A direct (`exact`) payment is **not** refunded: it settled before the job
   * ran (see the note at the top of this file), and the provider may have
   * already burned real quota. An escrowed payment never left XorvEscrow, so
   * cancelling refunds it in full, with no mark on the provider. Either way it
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
    if (isTerminal(job.status) || cancelling.has(job.id)) {
      return c.json({ error: `job is already ${cancelling.has(job.id) ? "being cancelled" : job.status}`, status: job.status }, 409);
    }

    const reason = "cancelled by the buyer";
    cancelling.add(job.id);
    // Stop the work now, not after the refund confirms.
    if (job.providerId) deps.getHub()?.send(job.providerId, { type: "job.cancel", jobId: job.id, reason });
    // Escrowed: the money never left the contract, so stopping refunds it, with
    // no mark on the provider (cancel, not refund). Done before the job is
    // failed so the settlement subscription doesn't treat it as a provider failure.
    let refunded = false;
    let refundTx: string | null = null;
    const held = job.payment?.escrow;
    if (escrow && job.payment && held?.state === "funded") {
      try {
        const started = Date.now();
        refundTx = await escrow.cancel(held.jobId as Hex);
        refunded = true;
        timeEscrowSettlement(job.id, refundTx, started, Date.now());
        jobs.patch(job.id, {
          payment: { ...job.payment, escrow: { ...held, state: "refunded", refundTx, settledAt: Date.now(), lastError: undefined } },
        });
      } catch (err) {
        // Not refunded now: failing the job below hands it to the settlement path, which refunds.
        console.warn(`[broker] escrow cancel for ${job.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    // The buyer changed their mind; that says nothing about the provider.
    if (job.providerId) registry.jobReleased(job.providerId);
    jobs.addEvent(job.id, { at: Date.now(), kind: "status", text: reason });
    jobs.fail(job.id, reason);
    cancelling.delete(job.id);
    metrics.inc("xorv_jobs_cancelled_total");

    return c.json({
      ok: true,
      jobId: job.id,
      status: "failed",
      refunded: refunded || Boolean(held),
      ...(refundTx ? { refundTx, refundUrl: explorerTx(config.network, refundTx) } : {}),
    });
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
  // Private-job vaults — ciphertext the broker stores and cannot read
  // -------------------------------------------------------------------------

  /**
   * A buyer's encrypted private-job history.
   *
   * Unauthenticated on purpose: the id is the hash of a key derived from the
   * buyer's passkey, and what comes back is AES-GCM ciphertext under another
   * key from the same passkey. A fresh browser that unlocks the passkey
   * derives the id and asks for it — no account, no session, no cookie.
   */
  app.get("/api/vaults/:id", (c) => {
    const id = c.req.param("id");
    if (!isVaultId(id)) return c.json({ error: "a vault id is 64 lowercase hex characters" }, 400);
    const record = vaults.get(id);
    if (!record) return c.json({ error: "no vault with this id yet", id, version: 0 }, 404);
    return c.json({
      id: record.id,
      ciphertext: record.ciphertext,
      iv: record.iv,
      version: record.version,
      updatedAt: record.updatedAt,
    });
  });

  /**
   * Replace a vault's ciphertext.
   *
   * The write must be signed by the vault-auth key whose hash is the id (so
   * only the passkey that owns a vault can change it), and must be exactly the
   * next version (so an old signed write can't be replayed to roll it back, and
   * two devices writing at once get a 409 carrying the version to merge onto).
   */
  app.put("/api/vaults/:id", async (c) => {
    const id = c.req.param("id");
    if (!isVaultId(id)) return c.json({ error: "a vault id is 64 lowercase hex characters" }, 400);
    const body = (await readJson(c)) as Partial<VaultWrite> | null;
    // Size first: cheaper than a signature check, and the answer doesn't depend on it.
    if (typeof body?.ciphertext === "string" && Math.floor((body.ciphertext.length * 3) / 4) > VAULT_MAX_CIPHERTEXT_BYTES) {
      return c.json(
        { error: `vault ciphertext is larger than ${Math.round(VAULT_MAX_CIPHERTEXT_BYTES / 1024)} KiB` },
        413,
      );
    }
    const check = verifyVaultWrite(id, body);
    if (!check.ok) return c.json({ error: check.reason }, check.forbidden ? 403 : 400);

    const write = body as VaultWrite;
    const stored = vaults.put(id, {
      ciphertext: write.ciphertext,
      iv: write.iv,
      version: write.version,
      publicKey: write.publicKey,
    });
    if (!stored.ok) {
      if (stored.reason === "full") return c.json({ error: "this broker is not accepting new vaults" }, 507);
      return c.json(
        {
          error: `stale write: this vault is at version ${stored.current}, so the next write must be version ${stored.current + 1}`,
          version: stored.current,
        },
        409,
      );
    }
    metrics.inc("xorv_vault_writes_total");
    return c.json({ ok: true, id, version: stored.record.version, updatedAt: stored.record.updatedAt });
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
    // A job its own provider paid for (payer == payTo) says nothing about the
    // provider. No lookup needed, so this holds whatever the Nansen guard says.
    if (sameAddress(job.payment.payer, job.payment.payTo)) {
      return { error: "this job was paid for by the provider's own payout address, so it can't be rated", status: 409 };
    }
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

  app.get("/api/jobs/:id/rating", async (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const value = Number(c.req.query("value"));
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      return c.json({ error: "value must be an integer from 0 to 100" }, 400);
    }
    const target = ratingTarget(job);
    if ("error" in target) return c.json({ error: target.error }, target.status);
    if (await agentAuthorizes(target.agentId, target.env.ledger)) {
      return c.json(ledgerAuthorizedRefusal(target.agentId), 409);
    }

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
      // XorvLedger only accepts a rating for a job it has a receipt for. The
      // receipt comes first: it can land without the agent (the agent's
      // wallet moved since the quote), and then there is nothing to rate, so
      // no Nansen lookup is spent on it.
      if (!receiptLanded(job)) await ensureReceipt(job);
      const landed = jobs.get(job.id);
      if (!landed || !receiptLanded(landed)) {
        return c.json({ error: "the job's receipt is not on-chain yet — retry in a few seconds" }, 409);
      }
      const recorded = ratingTarget(landed);
      if ("error" in recorded) return c.json({ error: recorded.error }, recorded.status);
      // A fresh read: this is about to spend a Nansen lookup and gas.
      if (await agentAuthorizes(recorded.agentId, recorded.env.ledger, { fresh: true })) {
        metrics.inc("xorv_rating_refusals_total", { reason: "ledger_authorized" });
        return c.json(ledgerAuthorizedRefusal(recorded.agentId), 409);
      }
      // The wash-rating guard. Only reached with a valid payer signature, so
      // nobody but the buyer can make the broker spend on a lookup. A provider
      // rating itself from a second wallet — one it funded, or one funded by
      // the same (non-exchange) wallet, or one Nansen links to it — is refused
      // before anything reaches ERC-8004. A lookup that fails or times out is
      // recorded as degraded and does not block an honest buyer.
      if (trust.ratingGuard && job.payment) {
        const check = await trust.checkRelated(target.payer, job.payment.payTo);
        jobs.patch(job.id, { trustCheck: check });
        // An outage never blocks an honest buyer, but a spent budget is
        // something a caller can bring about; relaying unchecked then would
        // switch the guard off. Defer instead.
        if (check.budgetSpent && !check.related) {
          metrics.inc("xorv_rating_refusals_total", { reason: "trust_budget_spent" });
          return c.json(
            {
              error:
                "the wash-rating check can't run right now: today's Nansen budget is spent. " +
                "Retry after 00:00 UTC (fetch fresh typed data from GET …/rating then)",
              code: "trust_budget_spent",
            },
            503,
          );
        }
        if (check.related) {
          metrics.inc("xorv_rating_refusals_total", { reason: "related_wallets" });
          console.warn(`[broker] rating for ${job.id} refused: ${check.reasons.map((r) => r.kind).join(", ")}`);
          return c.json(
            { error: refusalMessage(check), code: "related_wallets", trustCheck: publicRelatedCheck(check) },
            403,
          );
        }
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
      const message = err instanceof Error ? err.message : String(err);
      // A receipt recorded without its agent before the broker tracked that
      // (an older job): remember it, so the rating stops being offered.
      // The approval landed between the check and the relay (or the check
      // could not be made): same reason, in words.
      if (/Self-feedback not allowed/i.test(message)) {
        authorizations.set(`${target.agentId}:${target.env.ledger.toLowerCase()}`, { value: true, at: Date.now() });
        return c.json(ledgerAuthorizedRefusal(target.agentId), 409);
      }
      if (/\bNoAgent\b/.test(message)) {
        jobs.patch(job.id, { receiptWithoutAgent: true });
        return c.json({ error: "this job's receipt is on the ledger without an agent identity, so it can't be rated" }, 409);
      }
      return c.json({ error: message }, 502);
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
        return c.json({
          source: "indexer",
          providers: leaderboardFromIndexer(config.network, rows, registry.list()).map(withTrust),
        });
      }
    } catch (err) {
      indexerError = err instanceof Error ? err.message : String(err);
    }
    return c.json({
      source: "memory",
      ...(indexerError ? { indexerError } : {}),
      providers: leaderboardFromMemory(config.network, registry.list(), jobs.list({ limit: 5_000 }), limit).map(withTrust),
    });
  });

  /** A leaderboard row with its payout wallet's public Nansen signal, when known. */
  function withTrust<T extends { address: string }>(row: T): T & { trust: ReturnType<NansenTrust["publicSignal"]> } {
    return { ...row, trust: trust.publicSignal(row.address) };
  }

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
      ...dispatchedPayment(job),
      // The node seals the result to this before reporting it.
      ...(job.request.encryptTo ? { encryptTo: job.request.encryptTo } : {}),
    };

    if (!hub.send(provider.id, { type: "job.dispatch", job: payload })) {
      // The node's socket dropped between quote and payment. It was paid and
      // did not take the job: that counts against it, and it is not credited
      // with the earnings if someone else finishes. Try someone else rather
      // than failing a job that has already been paid for.
      registry.recordFailure(provider.id);
      metrics.inc("xorv_jobs_failed_total");
      jobs.patch(job.id, { quotedUndelivered: true });
      if (!reassign(job)) jobs.fail(job.id, "provider disconnected before the job could start");
      return;
    }

    registry.jobStarted(provider.id);
    jobs.setStatus(job.id, "assigned");
  }

  /** The settlement a node is told about with its dispatch (see `DispatchedJob.payment`). */
  function dispatchedPayment(job: StoredJob): Pick<DispatchedJob, "payment"> {
    if (!job.payment) return {};
    return { payment: { txHash: job.payment.txHash, amount: job.payment.amount, payTo: job.payment.payTo } };
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
      exclude: [...tried, ...unverifiedProviders()],
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
        // Still the first provider's settlement: this node sees it was not the one paid.
        ...dispatchedPayment(job),
        ...(job.request.encryptTo ? { encryptTo: job.request.encryptTo } : {}),
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
    // Escrowed: point the money at the new provider. The buyer's funds never
    // move; only the eventual payee changes. If this write fails, the release
    // path re-points it before paying (see settleEscrow).
    if (escrow && job.payment?.escrow?.state === "funded") void repointEscrow(job.id, match.provider.address);
    return true;
  }

  function finishJobOk(jobId: string, providerId: string, result: string, durationMs: number): void {
    const job = jobs.get(jobId);
    // A result for a job that is already over (cancelled, timed out), or from a
    // provider the job was taken away from, changes nothing.
    if (!job || isTerminal(job.status) || job.providerId !== providerId) return;
    if (job.request.encryptTo) {
      // A private job's result must arrive sealed. Plaintext is exactly what
      // the buyer paid to keep off this broker, so it is dropped unstored and
      // the job gets a free retry elsewhere, like any other provider failure.
      // A sealed one is re-serialized from its allowlisted fields, so nothing
      // extra a provider tacked on is stored, served or hashed.
      let sealed: string;
      try {
        sealed = JSON.stringify(parseSealedResult(result));
      } catch {
        finishJobFailed(jobId, providerId, "the provider returned an unsealed result for a private job; it was discarded", durationMs);
        return;
      }
      result = sealed;
    }
    // For a private job this hashes the envelope: the receipt commits to the
    // ciphertext, which anyone can check and only the buyer can open.
    const done = jobs.complete(jobId, result, textHash(result));
    if (!done) return;

    // Earnings follow the money: the USDC went to the quoted provider at
    // settlement, even if a reassignment means someone else finished the job.
    const micros = done.payment ? usdcUnitsToUsdMicros(done.payment.amount) : 0;
    // Escrowed money follows the job to whoever finished it; direct money stayed with the quoted provider.
    const payee = done.payment?.escrow ? providerId : (done.quotedProviderId ?? providerId);
    registry.jobFinished(providerId, { ok: true, durationMs, usdcMicros: payee === providerId ? micros : 0 });
    if (payee !== providerId && !done.quotedUndelivered) registry.creditEarnings(payee, micros);
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
   * The live candidates as the router's list_candidates tool shows them, in
   * matcher order: the provider and its offer, liveness, and the track record
   * the broker already holds — success rate, and mean buyer rating and Kimi
   * score (indexed when the Envio indexer is configured, else from memory).
   */
  function routeCandidates(matches: Match[]): RouteCandidate[] {
    const now = Date.now();
    return matches.map(({ provider, capability }) => {
      const { jobsCompleted, jobsFailed } = provider.stats;
      const total = jobsCompleted + jobsFailed;
      const rep = reputation.entry(provider.id);
      return {
        providerId: provider.id,
        label: provider.label,
        address: provider.address,
        agentId: provider.agentId,
        capabilityId: capability.id,
        adapter: capability.adapter,
        displayName: capability.displayName,
        model: capability.model ?? null,
        priceUsdMicros: capability.priceUsdMicros,
        liveness: provider.status === "busy" ? "busy" : "online",
        heartbeatAgeS: Math.max(0, Math.round((now - provider.lastHeartbeatAt) / 1000)),
        successRate: total === 0 ? null : jobsCompleted / total,
        jobs: total,
        avgRating: rep?.avgRating ?? null,
        avgVerified: rep?.avgVerified ?? null,
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
    // The agent's owner approved the verifier EOA on its identity NFT: the
    // registry would refuse the write as self-feedback. Say so on the job
    // rather than spend gas on a revert.
    if (await agentAuthorizes(target.agentId, sink.address)) {
      const reason =
        `ERC-8004 agent #${target.agentId} has approved this broker's verifier (${sink.address}) as an operator, ` +
        "and the Reputation Registry refuses feedback from an agent's own operators";
      console.warn(`[broker] verification of ${jobId} stays off-chain: ${reason}`);
      jobs.patch(jobId, { verification: { ...verification, agentId: target.agentId, feedbackError: reason } });
      metrics.inc("xorv_ai_feedback_total", { outcome: "refused" });
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
    if (!job.providerAgentId || job.receiptWithoutAgent) return null;
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
    if (chain.mode() !== "write" || receiptLanded(job) || !job.payment || !isTerminal(job.status)) return null;
    // An escrowed job is attested once its money has gone somewhere.
    if (job.payment.escrow?.state === "funded") return null;
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
        // Escrowed and delivered: the release is the transfer that paid the provider.
        paymentTx: job.payment.escrow?.releaseTx ?? job.payment.txHash,
        prompt: job.request.prompt,
        result: job.result ?? "",
        durationMs: Math.max(0, (job.completedAt ?? Date.now()) - started),
        ok: job.status === "completed",
      })
      .then((result) => {
        state.pending = null;
        // A receipt found already recorded (a retry that reverted as a
        // duplicate) counts too, with its original tx when it was found.
        if (result) {
          jobs.patch(job.id, {
            ...(result.txHash ? { receiptTxHash: result.txHash } : {}),
            receiptRecorded: true,
            ...(result.withoutAgent ? { receiptWithoutAgent: true } : {}),
          });
        }
        return result;
      });
    state.pending = pending;
    receipts.set(job.id, state);
    return pending;
  }

  /**
   * Make sure a job's receipt is on its way, push it out now, and wait
   * (bounded). A buyer asking to rate earns the receipt one more attempt past
   * the sweep's cap: the attempt that finds it already recorded on-chain is
   * what makes an old job ratable again.
   */
  async function ensureReceipt(job: StoredJob): Promise<void> {
    const state = receipts.get(job.id);
    if (state && !state.pending && state.attempts >= MAX_RECEIPT_ATTEMPTS) state.attempts = MAX_RECEIPT_ATTEMPTS - 1;
    const pending = enqueueReceipt(job) ?? receipts.get(job.id)?.pending ?? null;
    if (!pending) return;
    void chain.flush();
    await Promise.race([pending, sleep(RECEIPT_WAIT_MS)]);
  }

  jobs.subscribe((job) => {
    // Escrow first: the receipt waits for the money to move.
    if (isTerminal(job.status) && job.payment?.escrow?.state === "funded") void settleEscrow(job.id);
    if (isTerminal(job.status) && job.payment && !receiptLanded(job)) enqueueReceipt(job);
  });

  // -------------------------------------------------------------------------
  // Escrow settlement
  // -------------------------------------------------------------------------

  /** Jobs whose escrow write is in flight, so a burst of job updates sends one. */
  const settling = new Set<string>();

  function patchEscrow(jobId: string, update: Partial<NonNullable<NonNullable<StoredJob["payment"]>["escrow"]>>): void {
    const job = jobs.get(jobId);
    if (!job?.payment?.escrow) return;
    jobs.patch(jobId, { payment: { ...job.payment, escrow: { ...job.payment.escrow, ...update } } });
  }

  /**
   * Escrowed jobs still running whose money someone else settled: after the
   * deadline anyone may refund the buyer, and the Chainlink CRE refund keeper
   * does exactly that when the broker didn't. The job can't be paid any more,
   * so it stops: the provider is told, and the job fails with the reason and
   * the refund recorded as the keeper's. Each job is read at most every 15 s.
   */
  const escrowWatchedAt = new Map<string, number>();
  async function watchHeldEscrows(): Promise<void> {
    if (!escrow) return;
    for (const job of jobs.list({ limit: 1_000 })) {
      const held = job.payment?.escrow;
      if (!held || held.state !== "funded" || isTerminal(job.status) || cancelling.has(job.id) || settling.has(job.id)) continue;
      if (Date.now() - (escrowWatchedAt.get(job.id) ?? 0) < 15_000) continue;
      escrowWatchedAt.set(job.id, Date.now());
      const onChain = await escrow.read(held.jobId as Hex).catch(() => null);
      if (!onChain || onChain.status === "funded" || onChain.status === "none") continue;
      const settled = await escrow.settlement(held.jobId as Hex, job.payment?.txHash).catch(() => null);
      const byKeeper = Boolean(settled?.via && config.refundKeeperAddress && sameAddress(settled.via, config.refundKeeperAddress));
      patchEscrow(job.id, {
        state: onChain.status,
        ...(onChain.status === "released" ? { releaseTx: settled?.tx } : { refundTx: settled?.tx }),
        settledBy: settled?.by,
        settledVia: settled?.via ?? undefined,
        settledAt: Date.now(),
        lastError: undefined,
      });
      escrowWatchedAt.delete(job.id);
      if (onChain.status === "refunded") {
        const reason = byKeeper
          ? "refunded on chain by the Chainlink CRE refund keeper after the escrow's deadline"
          : "refunded on chain after the escrow's deadline";
        if (job.providerId) {
          deps.getHub()?.send(job.providerId, { type: "job.cancel", jobId: job.id, reason });
          registry.jobReleased(job.providerId);
        }
        jobs.addEvent(job.id, { at: Date.now(), kind: "status", text: reason });
        jobs.fail(job.id, reason);
        console.log(`[broker] job ${job.id}: ${reason} (${settled?.tx ?? "tx unknown"})`);
      }
    }
  }

  /** Read a release's or refund's block and gas, and attach them with its measured times. */
  function timeEscrowSettlement(jobId: string, tx: string, startedAt: number, receiptAt: number): void {
    void chainTiming(tx, startedAt, receiptAt).then((settleTiming) => {
      if (settleTiming) patchEscrow(jobId, { settleTiming });
    });
  }

  /**
   * A transaction's speed receipt, with two honest timers: executed (submission
   * to receipt) and final (submission until the `finalized` head holds its
   * block). Both on this broker's clock, both labelled with the chain they were
   * measured on: a local fork's timings are never Monad's.
   */
  async function chainTiming(txHash: string, startedAt: number | null, receiptAt: number): Promise<ChainTiming | null> {
    try {
      const facts = await (deps.txFacts ?? readTxFacts)(txHash);
      if (!facts) return null;
      // A local chain has no consensus: its `finalized` tag means nothing (anvil's trails by dozens
      // of blocks), so finality is reported as not applicable rather than timed.
      const finalAt =
        chainKind === "local" ? null : await (deps.finalizedAt ?? readFinalizedAt)(facts.blockNumber, facts.blockHash).catch(() => null);
      const { blockHash: _blockHash, ...rest } = facts;
      return {
        ...rest,
        confirmMs: startedAt === null ? null : receiptAt - startedAt,
        finalMs: startedAt === null || finalAt === null ? null : Math.max(finalAt, receiptAt) - startedAt,
        sendMode: sendModeOf(txHash) ?? "async",
        chain: chainKind,
      };
    } catch (err) {
      console.warn(`[broker] speed receipt for ${txHash}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      return null;
    }
  }

  async function readTxFacts(txHash: string): Promise<TxFacts | null> {
    const receipt = await publicClientFor(config.network).getTransactionReceipt({ hash: txHash as Hex });
    return {
      blockNumber: Number(receipt.blockNumber),
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed.toString(),
      gasPaidWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
      gasPayer: normalizeAddress(receipt.from),
    };
  }

  /** Poll the `finalized` tag until it reaches `blockNumber`, then check that block's hash is ours. */
  async function readFinalizedAt(blockNumber: number, blockHash: string): Promise<number | null> {
    const client = publicClientFor(config.network);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const head = await client.getBlock({ blockTag: "finalized" }).catch(() => null);
      if (head && Number(head.number) >= blockNumber) {
        const at = Date.now();
        const block = Number(head.number) === blockNumber ? head : await client.getBlock({ blockNumber: BigInt(blockNumber) }).catch(() => null);
        // A different hash at that height: the transaction landed in another proposal; don't time this one.
        return block && sameHash(block.hash ?? "", blockHash) ? at : null;
      }
      await sleep(100);
    }
    return null;
  }

  /** Point a funded escrow at the provider now running the job. */
  async function repointEscrow(jobId: string, provider: string): Promise<boolean> {
    const held = jobs.get(jobId)?.payment?.escrow;
    if (!escrow || !held || held.state !== "funded" || sameAddress(held.provider, provider)) return true;
    try {
      const tx = await escrow.reassign(held.jobId as Hex, provider);
      patchEscrow(jobId, { provider: normalizeAddress(provider), reassignTxs: [...(held.reassignTxs ?? []), tx], lastError: undefined });
      return true;
    } catch (err) {
      patchEscrow(jobId, { lastError: `reassign: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` });
      return false;
    }
  }

  /**
   * Move a finished job's escrowed money: release to the provider that
   * delivered (with the result's hash), or refund the buyer when it failed.
   * Runs from the job-store subscription, so every way a job ends (result,
   * failure, timeout) lands here; a cancel refunds in its own route. A write
   * that fails is retried by the sweep. One that reverts because someone else
   * already settled the job (the buyer's own release, a Chainlink CRE keeper's
   * refund after the deadline) is recorded as theirs.
   */
  async function settleEscrow(jobId: string): Promise<void> {
    const job = jobs.get(jobId);
    const held = job?.payment?.escrow;
    if (!escrow || !job || !held || held.state !== "funded" || !isTerminal(job.status) || settling.has(jobId) || cancelling.has(jobId)) return;
    settling.add(jobId);
    try {
      if (job.status === "completed" && job.resultHash) {
        const finisher = job.providerId ? registry.get(job.providerId)?.address : undefined;
        if (finisher && !(await repointEscrow(jobId, finisher))) return;
        const started = Date.now();
        const tx = await escrow.release(held.jobId as Hex, job.resultHash);
        patchEscrow(jobId, { state: "released", releaseTx: tx, resultHash: job.resultHash, settledAt: Date.now(), lastError: undefined });
        timeEscrowSettlement(jobId, tx, started, Date.now());
      } else {
        const started = Date.now();
        const tx = await escrow.refund(held.jobId as Hex);
        patchEscrow(jobId, { state: "refunded", refundTx: tx, settledAt: Date.now(), lastError: undefined });
        timeEscrowSettlement(jobId, tx, started, Date.now());
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      // Already settled by someone else? Then record what happened instead of retrying forever.
      const onChain = await escrow.read(held.jobId as Hex).catch(() => null);
      if (onChain && onChain.status !== "funded" && onChain.status !== "none") {
        const settled = await escrow.settlement(held.jobId as Hex, job.payment?.txHash).catch(() => null);
        patchEscrow(jobId, {
          state: onChain.status,
          settledAt: Date.now(),
          ...(onChain.status === "released" ? { releaseTx: settled?.tx } : { refundTx: settled?.tx }),
          settledBy: settled?.by,
          settledVia: settled?.via ?? undefined,
          lastError: undefined,
        });
      } else {
        patchEscrow(jobId, { lastError: message });
        console.warn(`[broker] escrow settlement for ${jobId} failed (will retry): ${message}`);
      }
    } finally {
      settling.delete(jobId);
    }
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /**
   * A provider's failure text, as the broker will store and serve it. For a
   * private job only the node's own coarse vocabulary ("private job …")
   * passes: anything else could be an older node's adapter error quoting the
   * prompt or a partial answer.
   */
  function providerError(job: StoredJob | undefined, error: string): string {
    if (!job?.request.encryptTo) return error;
    return error.startsWith("private job") ? error.slice(0, 200) : "private job failed on the provider";
  }

  function authProvider(header: string | undefined) {
    const token = header?.replace(/^Bearer\s+/i, "").trim();
    return token ? registry.byAuthToken(token) : undefined;
  }

  return {
    app,
    /** How payments settle — for the boot banner. */
    settlement,
    /** Nansen trust signals — for the boot banner. */
    trust,
    hubHandlers: {
      onEvent: (providerId: string, jobId: string, event: JobEvent) => {
        const job = jobs.get(jobId);
        if (!job || job.providerId !== providerId || isTerminal(job.status)) return;
        jobs.addEvent(jobId, { ...event, at: event.at || Date.now() });
      },
      onResult: (providerId: string, jobId: string, result: string, durationMs: number) => {
        if (cancelling.has(jobId)) return;
        finishJobOk(jobId, providerId, result, durationMs);
      },
      onError: (providerId: string, jobId: string, error: string, durationMs: number) => {
        if (cancelling.has(jobId)) return;
        finishJobFailed(jobId, providerId, providerError(jobs.get(jobId), error), durationMs);
      },
      onAccepted: (providerId: string, jobId: string) => {
        const job = jobs.get(jobId);
        if (!job || job.providerId !== providerId || isTerminal(job.status)) return;
        jobs.setStatus(jobId, "running");
      },
      onConnect: (providerId: string) => {
        const provider = registry.get(providerId);
        console.log(`[broker] node connected: ${provider?.label ?? providerId}`);
        // Look up the payout wallet on Nansen in the background, now that the
        // node can actually take jobs. The signal shows up once it lands.
        if (provider) trust.watch(provider.address);
      },
      onDisconnect: (providerId: string) => {
        const provider = registry.get(providerId);
        console.log(`[broker] node disconnected: ${provider?.label ?? providerId}`);
      },
    },
    /** Timers' work: fail overdue jobs, reap silent providers, retry receipts. */
    sweep(): void {
      void refreshGasPayers();
      void watchHeldEscrows();
      for (const job of jobs.overdue()) {
        const providerId = job.providerId ?? "";
        // Tell the node to stop: its result would be ignored now anyway.
        if (providerId) deps.getHub()?.send(providerId, { type: "job.cancel", jobId: job.id, reason: "job timed out" });
        finishJobFailed(job.id, providerId, "job timed out", jobs.runtimeMs(job));
      }
      for (const id of registry.reap()) {
        console.log(`[broker] reaped idle provider ${id}`);
      }
      // Keep live providers' Nansen signals fresh (a no-op until one is stale).
      // Only providers holding a control channel: a registration that never
      // connected is not worth paying Nansen for.
      trust.refreshStale(
        registry
          .live()
          .filter((p) => deps.getHub()?.isConnected(p.id))
          .map((p) => p.address),
      );
      // Receipts whose write failed (or that were restored from disk before
      // their batch landed) get another go, a bounded number of times.
      if (chain.mode() === "write") {
        for (const job of jobs.list({ limit: 1_000 })) {
          if (isTerminal(job.status) && job.payment && !receiptLanded(job)) enqueueReceipt(job);
        }
      }
      // Escrowed jobs whose release or refund didn't land yet.
      if (escrow) {
        for (const job of jobs.list({ limit: 1_000 })) {
          if (isTerminal(job.status) && job.payment?.escrow?.state === "funded") void settleEscrow(job.id);
        }
      }
      // A freeze or revocation by Cleanverse takes a provider out of matching within a sweep or two.
      if (identity) void identity.load().then(() => identity.refresh(registry.live().map((p) => p.address)));
      // Settlements broadcast but not confirmed when the facilitator gave up.
      void settlePending();
      // Quotes nobody paid for, past their TTL.
      jobs.pruneQuotes();
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
    // A whole number of micro-USD, at least 1: a fraction like 0.4 rounds to
    // a 0-unit USDC payment, and x402 would settle a free "paid" job, receipt
    // and rating eligibility included, at the broker's gas cost.
    if (!Number.isInteger(cap.priceUsdMicros) || cap.priceUsdMicros < 1) {
      return { error: `capability "${cap.id}" needs a priceUsdMicros that is a whole number of at least 1` };
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

/** The answer to a buyer paying the quoted provider from the provider's own payout address. */
const SELF_PAYMENT_REFUSAL = {
  error:
    "the paying wallet is the provider's own payout address — a provider can't buy its own jobs " +
    "(it would mint a paid receipt and rating eligibility for nothing)",
  code: "self_payment",
} as const;

/** `authorization.from` of an EIP-3009 payload, when it has one. */
function authorizationFrom(payload: PaymentPayload | null | undefined): string | null {
  const from = (payload?.payload as { authorization?: { from?: unknown } } | undefined)?.authorization?.from;
  return typeof from === "string" && isEvmAddress(from) ? from : null;
}

/** The payer named by the request's x402 payment header, or null when it can't be read. */
function payerFromHeader(c: Context): string | null {
  const header = c.req.header("payment-signature") ?? c.req.header("x-payment");
  if (!header) return null;
  try {
    return authorizationFrom(decodePaymentSignatureHeader(header));
  } catch {
    return null;
  }
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

/** An agent's self-declared session tag, validated, or null for anything malformed. */
function agentTag(raw: unknown): AgentSessionTag | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.session !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(r.session)) return null;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 60) : "agent";
  const budget = r.budgetUsdMicros === null ? null : Number(r.budgetUsdMicros);
  if (budget !== null && (!Number.isSafeInteger(budget) || budget <= 0)) return null;
  return { session: r.session, name, budgetUsdMicros: budget, client: "mcp" };
}

/** What the broker reads back from a confirmed transaction's receipt. */
type TxFacts = Omit<ChainTiming, "confirmMs" | "finalMs" | "sendMode" | "chain"> & { blockHash: string };

/** Medians of the measured settlement and release times, over the 50 most recent paid jobs. */
function speedStats(jobs: readonly { createdAt: number; payment?: PaymentRecord | null }[]): {
  settleMedianMs: number | null;
  releaseMedianMs: number | null;
  timingSamples: number;
} {
  const recent = [...jobs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  const settle = recent.map((j) => j.payment?.timing?.confirmMs).filter((ms): ms is number => typeof ms === "number");
  const release = recent.map((j) => j.payment?.escrow?.settleTiming?.confirmMs).filter((ms): ms is number => typeof ms === "number");
  return { settleMedianMs: median(settle), releaseMedianMs: median(release), timingSamples: settle.length };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Total quoted price of these jobs, in USD micros. */
function sumPrice(jobs: readonly { priceUsdMicros?: number | null }[]): number {
  return jobs.reduce((sum, j) => sum + (j.priceUsdMicros ?? 0), 0);
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
