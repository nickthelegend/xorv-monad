/**
 * Test doubles: a scripted Xorv broker behind a fake `fetch`, and a fake
 * MetaMask wallet executor that signs the way MetaMask's JSON-RPC signer does.
 *
 * The broker is honest by default — its 402 asks for exactly the quote, it
 * verifies the EIP-3009 signature with viem before "settling", and it verifies
 * the rating signature against the job's payer — so a passing run proves the
 * plugin produced signatures a real facilitator would accept. Overrides make
 * it misbehave (swap the payee, bump the amount, fail the job) for the
 * refusal tests. No network anywhere.
 */

import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { authorizationTypes } from "@x402/evm";
import {
  MONAD_TESTNET,
  explorerAddress,
  explorerTx,
  jobIdHash,
  networkConfig,
  ratingTypedData,
  toJsonSafe,
  type JobEvent,
  type NetworkInfo,
  type PublicJob,
  type PublicProvider,
  type QuoteResponse,
} from "@xorv/protocol";
import { hashTypedData, verifyTypedData, type Hex, type TypedDataDomain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { LeaderboardRow, RatingRequest } from "../src/lib/broker.js";
import type { TypedDataRequest, WalletExecutor, WalletExecutorResult } from "../src/lib/executor.js";

// Well-known local-devnet keys (anvil/hardhat #0 and #1) — never funded on Monad.
export const PAYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
export const OTHER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
export const PROVIDER_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const ATTACKER_ADDRESS = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const LEDGER_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const BROKER_URL = "http://broker.test";
export const NETWORK = MONAD_TESTNET;
export const USDC = networkConfig(NETWORK).usdc;
export const SETTLE_TX = `0x${"ab".repeat(32)}` as Hex;
export const RECEIPT_TX = `0x${"cd".repeat(32)}` as Hex;
export const RATE_TX = `0x${"ef".repeat(32)}` as Hex;
export const QUOTE_ID = "qte_TestQuote01";
export const JOB_ID = "job_TestJob0001";

// ---------------------------------------------------------------------------
// Fake MetaMask
// ---------------------------------------------------------------------------

export interface FakeMetaMask {
  executor: WalletExecutor;
  requests: TypedDataRequest[];
}

/**
 * Signs like MetaMask's JSON-RPC signer (`eth-sig-util`): the request must
 * survive `JSON.stringify` (it crosses to the wallet service), and the domain
 * is hashed with `types.EIP712Domain` taken literally — a missing entry means
 * an empty domain type, exactly the trap `toWalletTypedData` avoids.
 */
export function fakeMetaMask(
  opts: { account?: typeof PAYER; result?: WalletExecutorResult; throws?: Error } = {},
): FakeMetaMask {
  const account = opts.account ?? PAYER;
  const requests: TypedDataRequest[] = [];
  const executor: WalletExecutor = async (request) => {
    requests.push(request);
    if (opts.throws) throw opts.throws;
    if (opts.result) return opts.result;
    const wire = JSON.parse(JSON.stringify(request)) as TypedDataRequest;
    const { domain, types, primaryType, message } = wire.typedData;
    const hash = hashTypedData({
      domain: domain as TypedDataDomain,
      types: { ...types, EIP712Domain: types.EIP712Domain ?? [] },
      primaryType,
      message,
    } as Parameters<typeof hashTypedData>[0]);
    const signature = await account.sign({ hash });
    return { kind: "signature", status: "SIGNED", signature };
  };
  return { executor, requests };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function provider(overrides: Partial<PublicProvider> = {}): PublicProvider {
  return {
    id: "prv_alice",
    label: "alice-mbp",
    address: PROVIDER_ADDRESS,
    addressUrl: explorerAddress(NETWORK, PROVIDER_ADDRESS),
    agentId: "42",
    agentUrl: `${networkConfig(NETWORK).explorerUrl}/nft/${networkConfig(NETWORK).erc8004.identity}/42`,
    endpoint: "https://alice.trycloudflare.com",
    status: "online",
    connected: true,
    activeJobs: 0,
    capabilities: [
      { id: "claude-code", adapter: "claude-code", displayName: "Claude Code", model: null, priceUsdMicros: 10_000, maxConcurrency: 1 },
      { id: "qwen", adapter: "qwen", displayName: "Qwen 3.8 Max", model: "qwen3.8-max", priceUsdMicros: 4_000, maxConcurrency: 2 },
    ],
    lastHeartbeatAt: Date.now(),
    registeredAt: Date.now() - 3_600_000,
    uptimeSeconds: 3600,
    version: "0.2.0",
    region: "eu-west",
    stats: { jobsCompleted: 9, jobsFailed: 1, earnedUsdcMicros: 90_000, avgDurationMs: 8_000 },
    registryTxHash: null,
    ...overrides,
  };
}

export function quote(overrides: Partial<QuoteResponse> = {}): QuoteResponse {
  const base: QuoteResponse = {
    quoteId: QUOTE_ID,
    payUrl: `https://somewhere-else.example/api/jobs/${QUOTE_ID}`,
    network: NETWORK,
    priceUsdMicros: 10_000,
    priceLabel: "$0.0100",
    usdcAmount: "10000",
    expiresAt: Date.now() + 300_000,
    provider: {
      id: "prv_alice",
      label: "alice-mbp",
      address: PROVIDER_ADDRESS,
      addressUrl: explorerAddress(NETWORK, PROVIDER_ADDRESS),
      agentId: "42",
      capability: "Claude Code",
      adapter: "claude-code",
      model: null,
      stats: { jobsCompleted: 9, jobsFailed: 1, earnedUsdcMicros: 90_000, avgDurationMs: 8_000 },
    },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        asset: USDC.address,
        amount: "10000",
        payTo: PROVIDER_ADDRESS,
        maxTimeoutSeconds: 300,
        extra: { name: USDC.name, version: USDC.version },
      },
    ],
    routing: null,
    screening: null,
  };
  return { ...base, ...overrides };
}

export function job(overrides: Partial<PublicJob> = {}): PublicJob {
  return {
    id: JOB_ID,
    title: null,
    prompt: "Write a haiku about Monad",
    adapter: "claude-code",
    status: "completed",
    createdAt: Date.now() - 5_000,
    assignedAt: Date.now() - 4_000,
    startedAt: Date.now() - 4_000,
    completedAt: Date.now(),
    providerId: "prv_alice",
    providerLabel: "alice-mbp",
    providerAddress: PROVIDER_ADDRESS,
    providerAgentId: "42",
    priceUsdMicros: 10_000,
    priceLabel: "$0.0100",
    payment: {
      asset: "usdc",
      assetAddress: USDC.address,
      amount: "10000",
      network: NETWORK,
      txHash: SETTLE_TX,
      payer: PAYER.address,
      payTo: PROVIDER_ADDRESS,
      settledAt: Date.now() - 4_500,
      explorerUrl: explorerTx(NETWORK, SETTLE_TX),
    },
    result: "Ten thousand lanes wide / blocks land before you blink / parallel sunrise",
    resultHash: `0x${"12".repeat(32)}`,
    error: null,
    receiptTxHash: RECEIPT_TX,
    routing: null,
    screening: null,
    verification: { by: "kimi", model: "kimi-k3", score: 91, pass: true, rationale: "on topic", feedbackTxHash: null },
    rating: null,
    eventCount: 2,
    events: [],
    ...overrides,
  };
}

export function networkInfo(overrides: Partial<NetworkInfo> = {}): NetworkInfo {
  const cfg = networkConfig(NETWORK);
  return {
    network: NETWORK,
    chainId: cfg.chainId,
    label: "testnet",
    explorerUrl: cfg.explorerUrl,
    usdc: { address: cfg.usdc.address, symbol: "USDC", decimals: 6 },
    facilitator: { mode: "self", description: "in-process", address: null },
    ledger: { address: LEDGER_ADDRESS, url: explorerAddress(NETWORK, LEDGER_ADDRESS) },
    erc8004: { identity: cfg.erc8004.identity, reputation: cfg.erc8004.reputation },
    indexer: null,
    published: { registrations: 1, heartbeats: 0, receipts: 3, ratings: 1 },
    lastPublishError: null,
    ai: { router: null, screener: null, verifier: null },
    feeBps: 0,
    epoch: 1,
    stats: { providersLive: 1, providersConnected: 1, capacity: 3, jobsTotal: 10, jobsCompleted: 9, paidUsdMicros: 90_000 },
    heartbeatIntervalMs: 15_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake broker
// ---------------------------------------------------------------------------

export interface BrokerScript {
  providers?: PublicProvider[];
  leaderboard?: LeaderboardRow[] | "missing";
  network?: NetworkInfo;
  quote?: QuoteResponse | { status: number; body: unknown };
  /** What the 402 asks for; defaults to exactly the quote. */
  paymentRequired?: (q: QuoteResponse) => PaymentRequired;
  /** Reject a presented payment with this x402 reason (e.g. insufficient balance). */
  rejectPayment?: string;
  job?: PublicJob;
  /** Stream frames to send; "fail" makes the stream route 500. */
  stream?: Array<{ event: string; data: unknown }> | "fail";
  /** Polled job states, returned in order (the last one repeats). */
  polls?: PublicJob[];
  rating?: (value: number) => RatingRequest;
}

export interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: string;
}

export interface FakeBroker {
  fetch: typeof globalThis.fetch;
  seen: Seen[];
  payments: PaymentPayload[];
  ratings: Array<{ value: number; deadline: number; signature: Hex }>;
}

export function paymentRequiredFor(q: QuoteResponse): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: `${BROKER_URL}/api/jobs/${q.quoteId}`, description: "Run one AI job on a live Xorv provider", mimeType: "application/json" },
    accepts: q.accepts.map((a) => ({
      scheme: a.scheme,
      network: a.network as `${string}:${string}`,
      asset: a.asset,
      amount: a.amount,
      payTo: a.payTo,
      maxTimeoutSeconds: a.maxTimeoutSeconds,
      extra: { ...a.extra },
    })),
  };
}

export function ratingRequestFor(value: number, opts: { signer?: string; deadline?: number } = {}): RatingRequest {
  const deadline = opts.deadline ?? Math.floor(Date.now() / 1000) + 3600;
  const feedbackURI = `${BROKER_URL}/feedback/${JOB_ID}.json`;
  const feedbackHash = `0x${"34".repeat(32)}`;
  const typedData = ratingTypedData({
    network: NETWORK,
    ledger: LEDGER_ADDRESS,
    rating: {
      jobId: jobIdHash(JOB_ID),
      value,
      tag2: "claude-code",
      endpoint: "https://alice.trycloudflare.com",
      feedbackURI,
      feedbackHash,
      deadline,
    },
  });
  return {
    jobId: JOB_ID,
    value,
    deadline,
    signer: opts.signer ?? PAYER.address,
    agentId: "42",
    feedbackURI,
    feedbackHash,
    typedData: toJsonSafe(typedData) as RatingRequest["typedData"],
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function fakeBroker(script: BrokerScript = {}): FakeBroker {
  const seen: Seen[] = [];
  const payments: PaymentPayload[] = [];
  const ratings: FakeBroker["ratings"] = [];
  let pollIndex = 0;

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const body = req.method === "GET" ? "" : await req.text();
    seen.push({ method: req.method, path: url.pathname + url.search, headers: req.headers, body });
    if (url.origin !== BROKER_URL) return json({ error: `unexpected host ${url.origin}` }, 599);
    const path = url.pathname;

    if (req.method === "GET" && path === "/api/network") return json(script.network ?? networkInfo());
    if (req.method === "GET" && path === "/api/providers") return json({ providers: script.providers ?? [provider()] });
    if (req.method === "GET" && path === "/api/leaderboard") {
      if (script.leaderboard === "missing") return json({ error: "not found" }, 404);
      return json({ source: "memory", providers: script.leaderboard ?? [] });
    }
    if (req.method === "POST" && path === "/api/quotes") {
      const q = script.quote ?? quote();
      if ("status" in q && "body" in q) return json(q.body, q.status);
      return json(q);
    }

    const pay = /^\/api\/jobs\/(qte_[^/]+)$/.exec(path);
    if (req.method === "POST" && pay) {
      const q = script.quote && !("status" in script.quote) ? script.quote : quote();
      const required = (script.paymentRequired ?? paymentRequiredFor)(q);
      const header = req.headers.get("PAYMENT-SIGNATURE");
      if (!header) {
        return json({ quoteId: q.quoteId }, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) });
      }
      const payload = decodePaymentSignatureHeader(header);
      payments.push(payload);
      const reason = script.rejectPayment ?? (await verifyPayment(payload));
      if (reason) {
        return json({}, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ ...required, error: reason }) });
      }
      const auth = payload.payload.authorization as { from: string };
      return json(
        {
          jobId: JOB_ID,
          status: "assigned",
          provider: { id: q.provider.id, label: q.provider.label, address: q.provider.address },
          capability: q.provider.capability,
          priceUsdMicros: q.priceUsdMicros,
          priceLabel: q.priceLabel,
          payment: null,
          streamUrl: `${BROKER_URL}/api/jobs/${JOB_ID}/stream`,
          jobUrl: `${BROKER_URL}/api/jobs/${JOB_ID}`,
        },
        200,
        {
          "PAYMENT-RESPONSE": encodePaymentResponseHeader({
            success: true,
            transaction: SETTLE_TX,
            network: NETWORK,
            payer: auth.from,
          }),
        },
      );
    }

    if (req.method === "GET" && path === `/api/jobs/${JOB_ID}/stream`) {
      if (script.stream === "fail") return json({ error: "boom" }, 500);
      const frames = script.stream ?? defaultStream(script.job ?? job());
      const text = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join(": keepalive\n\n");
      return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (req.method === "GET" && path === `/api/jobs/${JOB_ID}`) {
      if (script.polls && script.polls.length > 0) {
        const next = script.polls[Math.min(pollIndex, script.polls.length - 1)]!;
        pollIndex += 1;
        return json({ job: next });
      }
      return json({ job: script.job ?? job() });
    }
    if (req.method === "GET" && path === `/api/jobs/${JOB_ID}/rating`) {
      const value = Number(url.searchParams.get("value"));
      return json((script.rating ?? ((v: number) => ratingRequestFor(v)))(value));
    }
    if (req.method === "POST" && path === `/api/jobs/${JOB_ID}/rate`) {
      const sent = JSON.parse(body) as { value: number; deadline: number; signature: Hex };
      const request = (script.rating ?? ((v: number) => ratingRequestFor(v)))(sent.value);
      const typed = ratingTypedData({
        network: NETWORK,
        ledger: LEDGER_ADDRESS,
        rating: { ...(request.typedData.message as never), jobId: jobIdHash(JOB_ID), value: sent.value, deadline: sent.deadline },
      });
      const valid = await verifyTypedData({ ...typed, address: PAYER.address, signature: sent.signature });
      if (!valid) return json({ error: "the signature is not from this job's payer" }, 401);
      ratings.push(sent);
      return json({
        ok: true,
        jobId: JOB_ID,
        value: sent.value,
        txHash: RATE_TX,
        explorerUrl: explorerTx(NETWORK, RATE_TX),
        feedbackURI: request.feedbackURI,
        feedbackHash: request.feedbackHash,
      });
    }
    return json({ error: "not found" }, 404);
  };

  return { fetch: fetchImpl as typeof globalThis.fetch, seen, payments, ratings };
}

function defaultStream(final: PublicJob): Array<{ event: string; data: unknown }> {
  const running = { ...final, status: "running", result: null, events: [] };
  const event: JobEvent = { at: Date.now(), kind: "message", text: "Drafting the haiku…" };
  return [
    { event: "snapshot", data: running },
    { event: "event", data: event },
    { event: "job", data: running },
    { event: "done", data: final },
  ];
}

/** What a facilitator's `verify` checks, minus the chain: signature, payee, amount, window. */
async function verifyPayment(payload: PaymentPayload): Promise<string | null> {
  const req = payload.accepted;
  const auth = payload.payload.authorization as {
    from: Hex;
    to: Hex;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
  const signature = payload.payload.signature as Hex;
  const ok = await verifyTypedData({
    address: auth.from,
    domain: {
      name: String(req.extra?.name),
      version: String(req.extra?.version),
      chainId: networkConfig(req.network).chainId,
      verifyingContract: req.asset as Hex,
    },
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
    signature,
  });
  if (!ok) return "invalid_exact_evm_payload_signature";
  if (auth.to.toLowerCase() !== req.payTo.toLowerCase()) return "invalid_exact_evm_payload_recipient_mismatch";
  if (auth.value !== req.amount) return "invalid_exact_evm_payload_authorization_value";
  if (BigInt(auth.validBefore) < BigInt(Math.floor(Date.now() / 1000) + 6)) return "invalid_exact_evm_payload_authorization_valid_before";
  return null;
}
