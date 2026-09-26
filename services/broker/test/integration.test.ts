/**
 * End-to-end, in one process, with no network and no credentials.
 *
 * A real HTTP server, the real Hono app, the real x402 resource server (with
 * the EVM exact scheme and the upfront payment flow) and the real WebSocket
 * hub. Only the parts that would touch Monad are stubbed: the facilitator
 * (which would submit `transferWithAuthorization`), the ledger writer (which
 * would send XorvLedger transactions), the ERC-8004 agent-wallet lookup and
 * the ledger feed reader.
 *
 * The buyer side is the genuine article: the protocol's `buyerX402Client` —
 * `ExactEvmScheme` over a real viem account — wrapped by `@x402/fetch`. So the
 * 402 negotiation, the EIP-3009 authorization and its EIP-712 signature are
 * all real, and the stub facilitator checks that signature the way the real
 * one does. Ratings are signed with real viem signatures too.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import WebSocket from "ws";
import { getAddress, keccak256, stringToBytes, verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import {
  buyerX402Client,
  jobIdHash,
  providerIdHash,
  ratingMessage,
  textHash,
  type LedgerEvent,
  type LedgerEventKind,
  type RatingMessage,
} from "@xorv/protocol";

import { createApp } from "../src/app.js";
import type { BrokerConfig } from "../src/config.js";
import type { ChainLike, HeartbeatSample, LedgerMode, PublishResult, ReceiptInput } from "../src/chain.js";
import type { LedgerReader } from "../src/ledger-reader.js";
import { Hub } from "../src/hub.js";
import { JobStore } from "../src/jobs.js";
import { Registry } from "../src/registry.js";

/** Response bodies are asserted on, not typed: the tests are what pin their shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const NETWORK = "eip155:10143";
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const LEDGER = getAddress("0x00000000000000000000000000000000000000aa");
/** Distinct payout addresses, written lowercase the way a wallet often hands them over. */
const PAYEE_A = "0xaaaa00000000000000000000000000000000000a";
const PAYEE_B = "0xbbbb00000000000000000000000000000000000b";

// ---------------------------------------------------------------------------
// Stubs — only the things that would touch Monad
// ---------------------------------------------------------------------------

class StubChain implements ChainLike {
  readonly network = NETWORK;
  constructor(readonly ledgerAddress: string | null = LEDGER) {}
  readonly writerAddress = "0x0000000000000000000000000000000000000Bb1";
  readonly registrations: Array<{ id: string; address: string; agentId: string | null }> = [];
  readonly heartbeats: HeartbeatSample[] = [];
  readonly receipts: ReceiptInput[] = [];
  readonly ratings: Array<{ rating: RatingMessage; signature: Hex }> = [];
  /** Fail this many receipt writes before letting them land (an RPC outage). */
  failReceipts = 0;
  private tx = 0;

  mode(): LedgerMode {
    return this.ledgerAddress ? "write" : "off";
  }
  counts() {
    return {
      registrations: this.registrations.length,
      heartbeats: this.heartbeats.length,
      receipts: this.receipts.length,
      ratings: this.ratings.length,
    } satisfies Record<LedgerEventKind, number>;
  }
  pendingReceipts(): number {
    return 0;
  }
  lastPublishError(): string | null {
    return null;
  }
  private result(): PublishResult {
    this.tx += 1;
    const txHash = `0x${this.tx.toString(16).padStart(64, "0")}`;
    return { contract: LEDGER, txHash, explorerUrl: `https://testnet.monadscan.com/tx/${txHash}`, blockNumber: "1" };
  }
  async registerProvider(provider: { id: string; address: string; agentId: string | null }) {
    this.registrations.push({ id: provider.id, address: provider.address, agentId: provider.agentId });
    return this.result();
  }
  async heartbeat(sample: HeartbeatSample) {
    this.heartbeats.push(sample);
    return this.result();
  }
  async recordJob(input: ReceiptInput) {
    if (this.failReceipts > 0) {
      this.failReceipts -= 1;
      return null;
    }
    this.receipts.push(input);
    return this.result();
  }
  async rateJob(rating: RatingMessage, signature: Hex) {
    this.ratings.push({ rating, signature });
    return this.result();
  }
  async verifyTypedDataOnChain() {
    return false;
  }
  async flush() {}
  async close() {}
}

const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

interface FacilitatorControl {
  settled: PaymentRequirements[];
  /** Runs at the moment of settlement — before any job exists, under upfront. */
  onSettle?: (requirements: PaymentRequirements) => void | Promise<void>;
  /** Fail the next settlement the way an unfunded buyer does. */
  failNext?: boolean;
}

/**
 * A facilitator that checks the EIP-3009 authorization like the real one —
 * payee, amount, EIP-712 domain, signature — and "settles" it with a fake tx.
 */
function stubFacilitator(control: FacilitatorControl): FacilitatorClient {
  async function check(payload: PaymentPayload, requirements: PaymentRequirements) {
    const { authorization, signature } = payload.payload as {
      authorization: { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex };
      signature: Hex;
    };
    const extra = requirements.extra as { name?: string; version?: string };
    if (authorization.to.toLowerCase() !== requirements.payTo.toLowerCase()) return "payee mismatch";
    if (authorization.value !== requirements.amount) return "amount mismatch";
    const ok = await verifyTypedData({
      address: authorization.from,
      domain: { name: extra.name, version: extra.version, chainId: 10143, verifyingContract: requirements.asset as Hex },
      types: TRANSFER_WITH_AUTHORIZATION,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature,
    });
    return ok ? null : "invalid signature";
  }

  return {
    async verify(payload: PaymentPayload, requirements: PaymentRequirements) {
      const problem = await check(payload, requirements);
      const from = (payload.payload as { authorization: { from: string } }).authorization.from;
      return problem ? { isValid: false, invalidReason: problem, payer: from } : { isValid: true, payer: from };
    },
    async settle(payload: PaymentPayload, requirements: PaymentRequirements) {
      await control.onSettle?.(requirements);
      const from = (payload.payload as { authorization: { from: string } }).authorization.from;
      const problem = control.failNext ? "invalid_exact_evm_insufficient_balance" : await check(payload, requirements);
      control.failNext = false;
      if (problem) {
        return { success: false, errorReason: problem, transaction: "", network: requirements.network, payer: from };
      }
      control.settled.push(requirements);
      return {
        success: true,
        transaction: `0x${"5e".repeat(31)}${control.settled.length.toString(16).padStart(2, "0")}`,
        network: requirements.network,
        payer: from,
      };
    },
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
    },
  } as unknown as FacilitatorClient;
}

class StubReader implements LedgerReader {
  events_: LedgerEvent[] = [];
  async events(kind: LedgerEventKind, limit: number) {
    return { source: "rpc" as const, events: this.events_.filter((e) => e.kind === kind).slice(0, limit) };
  }
  async leaderboard() {
    return null;
  }
}

function testConfig(over: Partial<BrokerConfig> = {}): BrokerConfig {
  const operator = privateKeyToAccount(generatePrivateKey());
  return {
    network: NETWORK,
    operator,
    facilitatorAccount: operator,
    facilitatorMode: "self",
    ledgerAddress: LEDGER,
    ledgerFromBlock: null,
    heartbeatPublishEvery: 20,
    receiptBatchMs: 10,
    receiptBatchMax: 20,
    port: 0,
    publicUrl: "http://broker.test",
    appUrl: "https://app.test",
    indexerUrl: null,
    corsOrigins: [],
    feeBps: 0,
    dbFile: null,
    mongoUri: null,
    mongoDb: "test",
    ai: { router: "off", screener: "off", verifier: "off" },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  base: string;
  chain: StubChain;
  registry: Registry;
  jobs: JobStore;
  reader: StubReader;
  control: FacilitatorControl;
  buyer: PrivateKeyAccount;
  paidFetch: typeof fetch;
  payAs(account: PrivateKeyAccount): typeof fetch;
  agentWallets: Map<string, string>;
  sweep(): void;
  stop(): Promise<void>;
}

async function boot(opts: { config?: Partial<BrokerConfig>; injectFacilitator?: boolean } = {}): Promise<Harness> {
  const config = testConfig(opts.config);
  const chain = new StubChain(config.ledgerAddress);
  const registry = new Registry();
  const jobs = new JobStore();
  const reader = new StubReader();
  const control: FacilitatorControl = { settled: [] };
  const agentWallets = new Map<string, string>();

  let hub: Hub | null = null;
  const { app, hubHandlers, sweep } = createApp({
    config,
    chain,
    registry,
    jobs,
    getHub: () => hub,
    facilitator: opts.injectFacilitator === false ? undefined : stubFacilitator(control),
    ledgerReader: reader,
    agentWallet: async (agentId) => {
      if (agentId === "999") throw new Error("rpc unreachable");
      return agentWallets.get(agentId) ?? null;
    },
  });

  const server = serve({ fetch: app.fetch, port: 0 }) as unknown as Server;
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  hub = new Hub(server, registry, hubHandlers);

  const payAs = (account: PrivateKeyAccount) =>
    wrapFetchWithPayment(
      fetch,
      buyerX402Client({ signer: account, network: NETWORK, maxUsdcUnits: "10000000" }),
    ) as typeof fetch;
  const buyer = privateKeyToAccount(generatePrivateKey());

  return {
    base: `http://127.0.0.1:${port}`,
    chain,
    registry,
    jobs,
    reader,
    control,
    buyer,
    paidFetch: payAs(buyer),
    payAs,
    agentWallets,
    sweep,
    async stop() {
      hub?.close();
      // Drop keep-alive sockets too: the next test's server can be handed the
      // same port, and a pooled socket to this one would then fail its first
      // request.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A provider node: registers over HTTP, then holds a control socket like the CLI does. */
async function connectProvider(
  h: Harness,
  opts: { label?: string; address?: string; agentId?: string; price?: number; nodeId?: string } = {},
) {
  const res = await fetch(`${h.base}/api/providers/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: opts.label ?? "test-node",
      address: opts.address ?? PAYEE_A,
      agentId: opts.agentId,
      endpoint: "http://localhost:1",
      capabilities: [
        {
          id: "echo",
          adapter: "echo",
          displayName: "Echo (test)",
          model: null,
          priceUsdMicros: opts.price ?? 1_000,
          maxConcurrency: 4,
        },
      ],
      version: "0.2.0",
      region: null,
      nodeId: opts.nodeId ?? `node-${opts.label ?? "test"}`,
    }),
  });
  const body = (await res.json()) as {
    provider: { id: string; address: string; agentId: string | null };
    token: string;
    wsUrl: string;
    registry: { txHash: string } | null;
    warnings: string[];
    agentURI: string;
  };

  const ws = new WebSocket(`${h.base.replace("http", "ws")}/ws/provider?token=${body.token}`);
  const dispatched: Array<{ jobId: string; prompt: string }> = [];
  const cancelled: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as { type: string; job?: { jobId: string; prompt: string }; jobId?: string };
    if (msg.type === "job.dispatch" && msg.job) dispatched.push(msg.job);
    if (msg.type === "job.cancel" && msg.jobId) cancelled.push(msg.jobId);
  });

  return {
    providerId: body.provider.id,
    address: body.provider.address,
    agentId: body.provider.agentId,
    registration: body,
    token: body.token,
    ws,
    dispatched,
    cancelled,
    /** Play a whole job the way the real node does: accept, stream, answer. */
    async completeNextJob(result = "the answer") {
      const job = await waitFor(() => dispatched[0], 4_000);
      ws.send(JSON.stringify({ type: "job.accepted", jobId: job.jobId }));
      ws.send(
        JSON.stringify({
          type: "job.event",
          jobId: job.jobId,
          event: { at: Date.now(), kind: "message", text: "working on it" },
        }),
      );
      ws.send(JSON.stringify({ type: "job.result", jobId: job.jobId, result, durationMs: 120 }));
      return job;
    },
    async failNextJob(error = "boom", index = 0) {
      const job = await waitFor(() => dispatched[index], 4_000);
      ws.send(JSON.stringify({ type: "job.error", jobId: job.jobId, error, durationMs: 50 }));
      return job;
    },
    close() {
      ws.close();
    },
  };
}

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined && value !== null) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for condition");
}

async function quote(h: Harness, prompt = "hello", max = 50_000) {
  const res = await fetch(`${h.base}/api/quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, maxPriceUsdMicros: max }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

async function pay(h: Harness, quoteId: string, payFetch: typeof fetch = h.paidFetch) {
  const res = await payFetch(`${h.base}/api/jobs/${quoteId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return { res, body: (await res.json()) as Json };
}

async function getJob(h: Harness, jobId: string) {
  return ((await (await fetch(`${h.base}/api/jobs/${jobId}`)).json()) as { job: Json }).job;
}

async function waitForStatus(h: Harness, jobId: string, status: string) {
  return waitFor(async () => {
    const job = await getJob(h, jobId);
    return job.status === status ? job : undefined;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let h: Harness;
beforeEach(async () => {
  h = await boot();
});
afterEach(async () => {
  await h.stop();
});

describe("registration", () => {
  it("registers a node, checksums its address and announces it on the ledger", async () => {
    const provider = await connectProvider(h);
    expect(provider.providerId).toMatch(/^prv_/);
    // Stored checksummed, though it arrived lowercase.
    expect(provider.address).toBe(getAddress(PAYEE_A));
    expect(provider.address).not.toBe(PAYEE_A);
    expect(h.chain.registrations).toHaveLength(1);
    expect(provider.registration.registry?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(provider.registration.agentURI).toBe(`http://broker.test/agents/${provider.providerId}.json`);

    const listed = await (await fetch(`${h.base}/api/providers`)).json();
    expect(listed.providers).toHaveLength(1);
    expect(listed.providers[0].connected).toBe(true);
    expect(listed.providers[0].addressUrl).toContain("testnet.monadscan.com/address/");
    provider.close();
  });

  it("keeps a verified ERC-8004 agent id, and drops an unverifiable one with a warning", async () => {
    h.agentWallets.set("7", PAYEE_A);
    h.agentWallets.set("8", PAYEE_B);
    const verified = await connectProvider(h, { agentId: "7", nodeId: "n1" });
    expect(verified.agentId).toBe("7");
    expect(h.chain.registrations[0]!.agentId).toBe("7");

    const mismatched = await connectProvider(h, { agentId: "8", nodeId: "n2" });
    expect(mismatched.agentId).toBeNull();
    expect(mismatched.registration.warnings.join(" ")).toMatch(/not at this node's payout address/);

    const unreachable = await connectProvider(h, { agentId: "999", nodeId: "n3" });
    expect(unreachable.agentId).toBeNull();
    expect(unreachable.registration.warnings.join(" ")).toMatch(/could not verify/);
    verified.close();
    mismatched.close();
    unreachable.close();
  });

  it("does not re-publish an unchanged re-registration", async () => {
    const first = await connectProvider(h, { nodeId: "same" });
    const again = await connectProvider(h, { nodeId: "same" });
    expect(again.providerId).toBe(first.providerId);
    expect(h.chain.registrations).toHaveLength(1);
    expect(again.registration.registry?.txHash).toBe(first.registration.registry?.txHash);
    first.close();
    again.close();
  });

  it("never leaks the bearer token on the public provider list", async () => {
    const provider = await connectProvider(h);
    const text = await (await fetch(`${h.base}/api/providers`)).text();
    expect(text).not.toContain(provider.token);
    provider.close();
  });

  it("rejects a malformed registration, a Hedera account id included", async () => {
    for (const address of ["nope", "0.0.12345", ""]) {
      const res = await fetch(`${h.base}/api/providers/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "x", address, nodeId: "n", capabilities: [] }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("refuses a socket with a bad token", async () => {
    const ws = new WebSocket(`${h.base.replace("http", "ws")}/ws/provider?token=forged`);
    await expect(
      new Promise((resolve, reject) => {
        ws.once("open", () => resolve("opened"));
        ws.once("error", reject);
      }),
    ).rejects.toBeTruthy();
  });
});

describe("quoting", () => {
  it("503s with a helpful message when nobody is online", async () => {
    const { status, body } = await quote(h);
    expect(status).toBe(503);
    expect(String(body.error)).toMatch(/no providers are online/);
  });

  it("pins a provider and freezes exactly what the 402 will ask for", async () => {
    const provider = await connectProvider(h);
    const { status, body } = await quote(h);
    expect(status).toBe(200);
    expect(body.quoteId).toMatch(/^qte_/);
    expect(body.network).toBe(NETWORK);
    expect(body.usdcAmount).toBe("1000");
    expect(body.provider.address).toBe(provider.address);
    expect(body.accepts).toEqual([
      {
        scheme: "exact",
        network: NETWORK,
        asset: USDC,
        amount: "1000",
        payTo: provider.address,
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      },
    ]);
    provider.close();
  });

  it("rejects an empty prompt and a non-positive budget", async () => {
    const provider = await connectProvider(h);
    expect((await quote(h, "")).status).toBe(400);
    expect((await quote(h, "hi", 0)).status).toBe(400);
    provider.close();
  });

  it("refuses to match above the buyer's ceiling", async () => {
    const provider = await connectProvider(h, { price: 20_000 });
    const { status } = await quote(h, "hi", 5_000);
    expect(status).toBe(503);
    provider.close();
  });

  it("picks the cheaper of two live providers", async () => {
    const dear = await connectProvider(h, { label: "dear", nodeId: "n1", address: PAYEE_A, price: 9_000 });
    const cheap = await connectProvider(h, { label: "cheap", nodeId: "n2", address: PAYEE_B, price: 2_000 });
    const { body } = await quote(h);
    expect(body.provider.label).toBe("cheap");
    dear.close();
    cheap.close();
  });
});

describe("the paid path", () => {
  it("answers 402 with an EIP-3009 USDC requirement paying the provider, settled up front", async () => {
    const provider = await connectProvider(h);
    const { body } = await quote(h);

    const res = await fetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(402);

    const header = res.headers.get("payment-required")!;
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(decoded.accepts).toHaveLength(1);
    const [accept] = decoded.accepts;
    expect(accept).toMatchObject({
      scheme: "exact",
      network: NETWORK,
      asset: USDC,
      amount: "1000",
      maxTimeoutSeconds: 300,
      // The EIP-712 domain the buyer signs against — without it every wallet
      // refuses to sign — and the flow that settles before the job runs.
      extra: { name: "USDC", version: "2", paymentFlow: "upfront" },
    });
    // The whole point: the broker is not the payee.
    expect(accept.payTo).toBe(provider.address);
    provider.close();
  });

  it("runs the full lifecycle: quote → 402 → pay → dispatch → result → receipt", async () => {
    const provider = await connectProvider(h);
    const { body: q } = await quote(h, "what is x402?");

    const { res, body: paid } = await pay(h, q.quoteId);
    expect(res.status).toBe(200);
    expect(paid.jobId).toMatch(/^job_/);
    expect(paid.cancelToken).toBeTruthy();
    expect(h.control.settled).toHaveLength(1);

    // The settlement travels back in PAYMENT-RESPONSE, readable by the client…
    const settle = new x402HTTPClient(buyerX402Client({ signer: h.buyer, network: NETWORK, maxUsdcUnits: "1" }))
      .getPaymentSettleResponse((name) => res.headers.get(name));
    expect(settle.success).toBe(true);
    expect(settle.transaction).toMatch(/^0x5e/);
    // …and is already on the job when the handler answers.
    expect(paid.payment.txHash).toBe(settle.transaction);
    expect(paid.payment.payer).toBe(h.buyer.address);

    const job = await provider.completeNextJob("42");
    expect(job.prompt).toBe("what is x402?");

    const done = await waitForStatus(h, paid.jobId, "completed");
    expect(done.result).toBe("42");
    expect(done.resultHash).toBe(keccak256(stringToBytes("42")));
    expect(done.payment.payTo).toBe(provider.address);
    expect(done.payment.payer).toBe(h.buyer.address);
    expect(done.payment.asset).toBe("usdc");
    expect(done.payment.assetAddress).toBe(USDC);
    expect(done.payment.explorerUrl).toBe(`https://testnet.monadscan.com/tx/${settle.transaction}`);
    expect(done.events.length).toBeGreaterThan(0);

    // The receipt was queued once the job was terminal and paid, carrying the
    // settlement and the hashes — and its tx hash landed on the job.
    const receipt = await waitFor(() => h.chain.receipts[0]);
    expect(receipt).toMatchObject({
      jobId: paid.jobId,
      agentId: null,
      buyer: h.buyer.address,
      payTo: provider.address,
      amount: "1000",
      paymentTx: settle.transaction,
      prompt: "what is x402?",
      result: "42",
      ok: true,
    });
    const receipted = await waitFor(async () => {
      const j = await getJob(h, paid.jobId);
      return j.receiptTxHash ? j : undefined;
    });
    expect(receipted.receiptTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.chain.receipts).toHaveLength(1);
    provider.close();
  });

  it("settles before the job exists, so a failed settlement never reaches a provider", async () => {
    const provider = await connectProvider(h);
    const { body: q } = await quote(h);

    const seenAtSettle: Array<{ jobs: number; dispatched: number }> = [];
    h.control.onSettle = () => {
      seenAtSettle.push({ jobs: h.jobs.list().length, dispatched: provider.dispatched.length });
    };

    // An unfunded buyer: settlement fails, the handler never runs.
    h.control.failNext = true;
    const failed = await pay(h, q.quoteId);
    expect(failed.res.status).toBe(402);
    expect(h.jobs.list()).toHaveLength(0);
    expect(provider.dispatched).toHaveLength(0);

    // The quote was not burned: the same buyer, now funded, can still buy it.
    const ok = await pay(h, q.quoteId);
    expect(ok.res.status).toBe(200);
    await waitFor(() => provider.dispatched[0]);
    expect(seenAtSettle).toEqual([
      { jobs: 0, dispatched: 0 },
      { jobs: 0, dispatched: 0 },
    ]);
    expect(h.control.settled).toHaveLength(1);
    provider.close();
  });

  it("attaches each settlement to its own job by quote id, even for simultaneous buyers", async () => {
    const provider = await connectProvider(h);
    const alice = privateKeyToAccount(generatePrivateKey());
    const bob = privateKeyToAccount(generatePrivateKey());
    const { body: qa } = await quote(h, "alice's job");
    const { body: qb } = await quote(h, "bob's job");

    // Alice's settlement lands *after* Bob's, although she paid first — the
    // interleaving that "the latest unpaid job for this payTo" got wrong.
    let first = true;
    h.control.onSettle = async () => {
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 150));
      }
    };
    const [a, b] = await Promise.all([pay(h, qa.quoteId, h.payAs(alice)), pay(h, qb.quoteId, h.payAs(bob))]);
    expect(a.res.status).toBe(200);
    expect(b.res.status).toBe(200);

    const jobA = await getJob(h, a.body.jobId);
    const jobB = await getJob(h, b.body.jobId);
    expect(jobA.prompt).toBe("alice's job");
    expect(jobA.payment.payer).toBe(alice.address);
    expect(jobB.prompt).toBe("bob's job");
    expect(jobB.payment.payer).toBe(bob.address);
    expect(jobA.payment.txHash).not.toBe(jobB.payment.txHash);
    provider.close();
  });

  it("refuses to sell the same quote twice", async () => {
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    expect((await pay(h, body.quoteId)).res.status).toBe(200);

    const replay = await fetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(replay.status).toBe(409);
    // A second signed payment is refused before it can settle.
    expect((await pay(h, body.quoteId, h.payAs(privateKeyToAccount(generatePrivateKey())))).res.status).toBe(409);
    expect(h.control.settled).toHaveLength(1);
    provider.close();
  });

  it("404s an unknown or expired quote instead of quoting a price nobody can pay", async () => {
    const provider = await connectProvider(h);
    const res = await fetch(`${h.base}/api/jobs/qte_does_not_exist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    provider.close();
  });

  it("409s when the quoted provider went offline before payment", async () => {
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    const record = h.registry.get(provider.providerId)!;
    record.lastHeartbeatAt = Date.now() - 120_000;

    const res = await fetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
    provider.close();
  });
});

describe("what a browser can read", () => {
  /**
   * x402 puts its terms in a response header, and a browser cannot read a
   * response header that CORS does not expose. Shipping without
   * `payment-required` on the expose list broke every wallet payment made from
   * a real tab while every server-side client kept working — Node's fetch has
   * no CORS. The Privy embedded-wallet flow depends on this.
   */
  it("exposes payment-required and the settle response to the browser", async () => {
    await connectProvider(h);
    const { body } = await quote(h);

    const res = await fetch(`${h.base}/api/jobs/${body.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://xorv-app.vercel.app" },
      body: "{}",
    });

    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBeTruthy();

    const exposed = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    expect(exposed).toContain("payment-required");
    expect(exposed).toContain("payment-response");
    expect(exposed).toContain("x-payment-response");
  });

  /**
   * The preflight has to allow every header `@x402/fetch` actually puts on the
   * wire — including `Access-Control-Expose-Headers`, which it sends as a
   * *request* header on the payment retry. Only a browser can catch this.
   */
  it("passes a preflight carrying the headers the x402 client sends", async () => {
    const res = await fetch(`${h.base}/api/jobs/qte_whatever`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://xorv-app.vercel.app",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-payment,payment-signature,access-control-expose-headers",
      },
    });

    expect(res.status).toBeLessThan(400);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    for (const required of ["content-type", "x-payment", "payment-signature", "access-control-expose-headers"]) {
      expect(allowed).toContain(required);
    }
  });
});

describe("failure handling", () => {
  it("reassigns a failed job at no extra charge, and credits the money to whoever was paid", async () => {
    const a = await connectProvider(h, { label: "a", nodeId: "n1", address: PAYEE_A, price: 1_000 });
    const b = await connectProvider(h, { label: "b", nodeId: "n2", address: PAYEE_B, price: 1_000 });

    const { body: q } = await quote(h);
    const { body: paid } = await pay(h, q.quoteId);

    const first = a.dispatched.length > 0 ? a : b;
    const second = first === a ? b : a;
    await first.failNextJob("adapter exploded");

    await waitFor(() => second.dispatched[0]);
    expect(second.dispatched[0]!.jobId).toBe(paid.jobId);
    // Still exactly one settlement — the buyer was not charged twice.
    expect(h.control.settled).toHaveLength(1);

    const moved = await getJob(h, paid.jobId);
    expect(moved.providerId).toBe(second.providerId);
    expect(moved.startedAt).toBeNull();
    // The payee is frozen: the money went to the first provider.
    expect(moved.providerAddress).toBe(first.address);

    await second.completeNextJob("rescued");
    await waitForStatus(h, paid.jobId, "completed");
    const statsOf = (p: { providerId: string }) => h.registry.get(p.providerId)!.stats;
    expect(statsOf(first)).toMatchObject({ jobsFailed: 1, earnedUsdcMicros: 1_000 });
    expect(statsOf(second)).toMatchObject({ jobsCompleted: 1, earnedUsdcMicros: 0 });

    // A reassigned job's receipt names no agent: the identity paid is not the
    // one that did the work.
    const receipt = await waitFor(() => h.chain.receipts[0]);
    expect(receipt.payTo).toBe(first.address);
    expect(receipt.agentId).toBeNull();
    a.close();
    b.close();
  }, 20_000);

  it("never bounces a job back to a provider that already failed it", async () => {
    const a = await connectProvider(h, { label: "a", nodeId: "n1", address: PAYEE_A });
    const b = await connectProvider(h, { label: "b", nodeId: "n2", address: PAYEE_B });
    const { body: q } = await quote(h);
    const { body: paid } = await pay(h, q.quoteId);

    const first = a.dispatched.length > 0 ? a : b;
    const second = first === a ? b : a;
    await first.failNextJob("first failure");
    await waitFor(() => second.dispatched[0]);
    await second.failNextJob("second failure");

    const failed = await waitForStatus(h, paid.jobId, "failed");
    expect(failed.error).toBe("second failure");
    expect(first.dispatched).toHaveLength(1);
    // A late error from the first provider changes nothing now.
    first.ws.send(JSON.stringify({ type: "job.error", jobId: paid.jobId, error: "late", durationMs: 1 }));
    await new Promise((r) => setTimeout(r, 100));
    expect((await getJob(h, paid.jobId)).error).toBe("second failure");
    a.close();
    b.close();
  }, 20_000);

  it("times out an overdue job onto a fresh provider, with a fresh clock, and doesn't bounce it back", async () => {
    const a = await connectProvider(h, { label: "a", nodeId: "n1", address: PAYEE_A });
    const b = await connectProvider(h, { label: "b", nodeId: "n2", address: PAYEE_B });
    const { body: q } = await quote(h);
    const { body: paid } = await pay(h, q.quoteId);
    const first = a.dispatched.length > 0 ? a : b;
    const second = first === a ? b : a;
    await waitFor(() => first.dispatched[0]);

    // Eleven minutes on the first provider: past the ten-minute ceiling.
    const longAgo = Date.now() - 11 * 60_000;
    h.jobs.patch(paid.jobId, { assignedAt: longAgo, startedAt: longAgo });
    h.sweep();
    await waitFor(() => second.dispatched[0]);
    await waitFor(() => first.cancelled[0]);
    const moved = await getJob(h, paid.jobId);
    expect(moved.providerId).toBe(second.providerId);
    expect(Date.now() - moved.assignedAt).toBeLessThan(5_000);

    // The next sweep finds nothing overdue: the new provider has its full timeout.
    h.sweep();
    await new Promise((r) => setTimeout(r, 100));
    expect((await getJob(h, paid.jobId)).providerId).toBe(second.providerId);
    expect(first.dispatched).toHaveLength(1);
    a.close();
    b.close();
  }, 20_000);

  it("retries a receipt whose write failed", async () => {
    const provider = await connectProvider(h);
    h.chain.failReceipts = 1;
    const { body: q } = await quote(h);
    const { body: paid } = await pay(h, q.quoteId);
    await provider.completeNextJob("done");
    await waitForStatus(h, paid.jobId, "completed");
    await new Promise((r) => setTimeout(r, 50));
    expect(h.chain.receipts).toHaveLength(0);

    h.sweep();
    const receipted = await waitFor(async () => {
      const j = await getJob(h, paid.jobId);
      return j.receiptTxHash ? j : undefined;
    });
    expect(receipted.receiptTxHash).toMatch(/^0x/);
    expect(h.chain.receipts).toHaveLength(1);
    provider.close();
  }, 20_000);

  it("fails the job when there is nobody left to retry with, and still receipts the payment", async () => {
    const only = await connectProvider(h);
    const { body: q } = await quote(h);
    const { body: paid } = await pay(h, q.quoteId);

    await only.failNextJob("no good");
    const failed = await waitForStatus(h, paid.jobId, "failed");
    expect(failed.error).toContain("no good");
    const receipt = await waitFor(() => h.chain.receipts[0]);
    expect(receipt).toMatchObject({ jobId: paid.jobId, ok: false, result: "" });
    only.close();
  }, 20_000);
});

describe("cancelling", () => {
  it("lets only the paying buyer cancel, and a cancelled job stays cancelled", async () => {
    const a = await connectProvider(h, { label: "a", nodeId: "n1", address: PAYEE_A });
    const b = await connectProvider(h, { label: "b", nodeId: "n2", address: PAYEE_B });
    const { body: q } = await quote(h);
    const { body: paid } = await pay(h, q.quoteId);
    const owner = a.dispatched.length > 0 ? a : b;
    const other = owner === a ? b : a;
    await waitFor(() => owner.dispatched[0]);

    const cancelUrl = `${h.base}/api/jobs/${paid.jobId}/cancel`;
    // Knowing the (public) job id is not enough.
    expect((await fetch(cancelUrl, { method: "POST" })).status).toBe(403);
    expect(
      (await fetch(cancelUrl, { method: "POST", headers: { Authorization: "Bearer guessed" } })).status,
    ).toBe(403);

    const res = await fetch(cancelUrl, { method: "POST", headers: { Authorization: `Bearer ${paid.cancelToken}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, refunded: false });
    await waitFor(() => owner.cancelled[0]);

    // The node's adapter throws on abort and reports an error; that must not
    // resurrect the job onto the other provider.
    owner.ws.send(JSON.stringify({ type: "job.error", jobId: paid.jobId, error: "aborted", durationMs: 5 }));
    await new Promise((r) => setTimeout(r, 150));
    const after = await getJob(h, paid.jobId);
    expect(after.status).toBe("failed");
    expect(after.error).toBe("cancelled by the buyer");
    expect(other.dispatched).toHaveLength(0);
    // The buyer's decision is not the provider's failure.
    expect(h.registry.get(owner.providerId)!.stats.jobsFailed).toBe(0);
    expect((await fetch(cancelUrl, { method: "POST", headers: { "X-Cancel-Token": paid.cancelToken } })).status).toBe(409);
    a.close();
    b.close();
  }, 20_000);
});

describe("streaming", () => {
  it("streams job events over SSE and terminates on done", async () => {
    const provider = await connectProvider(h);
    const { body: q } = await quote(h);
    const { body: paid } = await pay(h, q.quoteId);

    const stream = await fetch(`${h.base}/api/jobs/${paid.jobId}/stream`, { headers: { Accept: "text/event-stream" } });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    void provider.completeNextJob("streamed answer");

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !seen.includes("event: done")) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});

    expect(seen).toContain("event: snapshot");
    expect(seen).toContain("event: done");
    expect(seen).toContain("streamed answer");
    provider.close();
  }, 20_000);

  it("emits done immediately for a job that already finished", async () => {
    const provider = await connectProvider(h);
    const { body: q } = await quote(h);
    const { body: paid } = await pay(h, q.quoteId);
    await provider.completeNextJob("fast");
    await waitForStatus(h, paid.jobId, "completed");

    const stream = await fetch(`${h.base}/api/jobs/${paid.jobId}/stream`, { headers: { Accept: "text/event-stream" } });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !seen.includes("event: done")) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    expect(seen).toContain("event: done");
    provider.close();
  }, 20_000);
});

describe("heartbeats", () => {
  it("accepts an authenticated beat, publishes a sample to the ledger, and rejects a forged one", async () => {
    const provider = await connectProvider(h);
    const beat = (token: string) =>
      fetch(`${h.base}/api/providers/${provider.providerId}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ activeJobs: 0, uptimeSeconds: 10, available: { echo: true } }),
      });
    expect((await beat(provider.token)).status).toBe(200);
    expect((await beat(provider.token)).status).toBe(200);
    await waitFor(() => h.chain.heartbeats[0]);
    // One in twenty: the first beat is sampled, the second is not.
    expect(h.chain.heartbeats).toHaveLength(1);
    expect(h.chain.heartbeats[0]).toMatchObject({ providerId: provider.providerId, capacity: 4 });
    expect((await beat("nope")).status).toBe(401);
    provider.close();
  });

  it("won't let one provider heartbeat as another", async () => {
    const a = await connectProvider(h, { label: "a", nodeId: "n1", address: PAYEE_A });
    const b = await connectProvider(h, { label: "b", nodeId: "n2", address: PAYEE_B });
    const res = await fetch(`${h.base}/api/providers/${b.providerId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ activeJobs: 0, uptimeSeconds: 1, available: {} }),
    });
    expect(res.status).toBe(401);
    a.close();
    b.close();
  });

  it("rejects a provider result callback from an unrelated node", async () => {
    const a = await connectProvider(h, { label: "a", nodeId: "n1", address: PAYEE_A });
    const b = await connectProvider(h, { label: "b", nodeId: "n2", address: PAYEE_B });
    const { body: q } = await quote(h);
    const { body: paid } = await pay(h, q.quoteId);

    const owner = a.dispatched.length > 0 ? a : b;
    const stranger = owner === a ? b : a;
    const forged = await fetch(`${h.base}/api/jobs/${paid.jobId}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${stranger.token}` },
      body: JSON.stringify({ result: "I did not run this", durationMs: 1 }),
    });
    expect(forged.status).toBe(404);
    a.close();
    b.close();
  }, 20_000);
});

describe("ratings", () => {
  /** A job paid by `h.buyer`, completed by a provider with a verified agent, receipt landed. */
  async function ratedJobSetup(opts: { agent?: boolean } = {}) {
    if (opts.agent !== false) h.agentWallets.set("7", PAYEE_A);
    const provider = await connectProvider(h, { agentId: opts.agent === false ? undefined : "7" });
    const { body: q } = await quote(h, "rate me");
    const { body: paid } = await pay(h, q.quoteId);
    await provider.completeNextJob("rated answer");
    await waitFor(async () => {
      const j = await getJob(h, paid.jobId);
      return j.receiptTxHash ? j : undefined;
    });
    return { provider, jobId: paid.jobId as string };
  }

  async function typedDataFor(jobId: string, value: number) {
    const res = await fetch(`${h.base}/api/jobs/${jobId}/rating?value=${value}`);
    return { res, body: (await res.json()) as Json };
  }

  /** What a wallet does with the JSON typed data: sign it (bigints restored). */
  async function sign(account: PrivateKeyAccount, typedData: Json) {
    const td = typedData as unknown as {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      message: Parameters<typeof ratingMessage>[0];
    };
    return account.signTypedData({
      domain: td.domain,
      types: td.types,
      primaryType: "Rating",
      message: ratingMessage(td.message),
    } as never);
  }

  it("hands out typed data, verifies the payer's signature, relays it and stores the rating", async () => {
    const { provider, jobId } = await ratedJobSetup();
    const { res, body } = await typedDataFor(jobId, 90);
    expect(body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(body.signer).toBe(h.buyer.address);
    expect(body.agentId).toBe("7");
    const td = body.typedData as unknown as {
      domain: { name: string; version: string; chainId: number; verifyingContract: string };
      primaryType: string;
      message: Record<string, string>;
    };
    expect(td.domain).toEqual({ name: "XorvLedger", version: "1", chainId: 10143, verifyingContract: LEDGER });
    expect(td.primaryType).toBe("Rating");
    expect(td.message).toMatchObject({
      jobId: jobIdHash(jobId),
      value: "90",
      tag2: "echo",
      endpoint: "http://broker.test/api/quotes",
      feedbackURI: `http://broker.test/feedback/${jobId}.json`,
      feedbackHash: body.feedbackHash,
    });

    const signature = await sign(h.buyer, body.typedData);
    const rated = await fetch(`${h.base}/api/jobs/${jobId}/rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: 90, deadline: body.deadline, signature }),
    });
    expect(rated.status).toBe(200);
    const result = (await rated.json()) as Record<string, string>;
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Relayed exactly as signed.
    expect(h.chain.ratings).toHaveLength(1);
    const relayed = h.chain.ratings[0]!;
    expect(relayed.signature).toBe(signature);
    expect(relayed.rating).toMatchObject({ jobId: jobIdHash(jobId), value: 90n, feedbackHash: body.feedbackHash });

    const job = await getJob(h, jobId);
    expect(job.rating).toEqual({ value: 90, txHash: result.txHash, feedbackURI: `http://broker.test/feedback/${jobId}.json` });

    // Rated once, never twice.
    expect((await typedDataFor(jobId, 10)).res.status).toBe(409);
    provider.close();
  }, 20_000);

  it("serves the feedback file whose keccak256 is the committed feedbackHash", async () => {
    const { provider, jobId } = await ratedJobSetup();
    const { body } = await typedDataFor(jobId, 77);
    const signature = await sign(h.buyer, body.typedData);
    await fetch(`${h.base}/api/jobs/${jobId}/rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: 77, deadline: body.deadline, signature }),
    });

    const res = await fetch(`${h.base}/feedback/${jobId}.json`);
    expect(res.status).toBe(200);
    const bytes = await res.text();
    expect(textHash(bytes)).toBe(body.feedbackHash);
    expect(textHash(bytes)).toBe(h.chain.ratings[0]!.rating.feedbackHash);
    const file = JSON.parse(bytes);
    expect(file).toMatchObject({
      agentRegistry: "eip155:10143:0x8004A818BFB912233c491871b3d84c89A494BD9e",
      agentId: 7,
      clientAddress: `eip155:10143:${LEDGER}`,
      value: 77,
      tag1: "starred",
      tag2: "echo",
      proofOfPayment: {
        fromAddress: h.buyer.address,
        toAddress: provider.address,
        chainId: "10143",
        amount: "1000",
        currency: "USDC",
        protocol: "x402",
      },
    });
    expect(file.proofOfPayment.txHash).toMatch(/^0x5e/);
    expect(file.xorv).toMatchObject({ jobId, jobIdHash: jobIdHash(jobId), resultHash: textHash("rated answer") });
    provider.close();
  }, 20_000);

  it("rejects a rating signed by anyone but the payer", async () => {
    const { provider, jobId } = await ratedJobSetup();
    const { body } = await typedDataFor(jobId, 5);
    const stranger = privateKeyToAccount(generatePrivateKey());
    const res = await fetch(`${h.base}/api/jobs/${jobId}/rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: 5, deadline: body.deadline, signature: await sign(stranger, body.typedData) }),
    });
    expect(res.status).toBe(401);
    // A valid signature over a different value is not this rating either.
    const mismatch = await fetch(`${h.base}/api/jobs/${jobId}/rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: 100, deadline: body.deadline, signature: await sign(h.buyer, body.typedData) }),
    });
    expect(mismatch.status).toBe(401);
    expect(h.chain.ratings).toHaveLength(0);
    provider.close();
  }, 20_000);

  it("explains why a job without an agent identity can't be rated", async () => {
    const { provider, jobId } = await ratedJobSetup({ agent: false });
    const { res, body } = await typedDataFor(jobId, 50);
    expect(res.status).toBe(409);
    expect(String(body.error)).toMatch(/ERC-8004/);
    expect((await typedDataFor(jobId, 101)).res.status).toBe(400);
    provider.close();
  }, 20_000);
});

describe("public surface", () => {
  it("serves health and network state in the NetworkInfo shape", async () => {
    expect((await fetch(`${h.base}/health`)).status).toBe(200);
    const net = (await (await fetch(`${h.base}/api/network`)).json()) as Json;
    expect(net).toMatchObject({
      network: NETWORK,
      chainId: 10143,
      label: "testnet",
      explorerUrl: "https://testnet.monadscan.com",
      usdc: { address: USDC, symbol: "USDC", decimals: 6 },
      facilitator: { mode: "self", available: true },
      ledger: { address: LEDGER, mode: "write" },
      erc8004: {
        identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
        reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      },
      indexer: null,
      published: { registrations: 0, heartbeats: 0, receipts: 0, ratings: 0 },
      lastPublishError: null,
      ai: { router: null, screener: null, verifier: null },
      feeBps: 0,
      heartbeatIntervalMs: 15_000,
    });
    expect(typeof net.epoch).toBe("number");
    expect(net.stats).toMatchObject({ providersLive: 0, jobsTotal: 0 });
  });

  it("serves each provider's ERC-8004 registration file", async () => {
    h.agentWallets.set("7", PAYEE_A);
    const provider = await connectProvider(h, { agentId: "7" });
    const res = await fetch(`${h.base}/agents/${provider.providerId}.json`);
    expect(res.status).toBe(200);
    const file = (await res.json()) as Json;
    expect(file).toMatchObject({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      x402Support: true,
      active: true,
      supportedTrust: ["reputation"],
      registrations: [{ agentId: 7, agentRegistry: "eip155:10143:0x8004A818BFB912233c491871b3d84c89A494BD9e" }],
    });
    expect(file.services).toEqual([
      { name: "web", endpoint: `https://app.test/providers/${provider.providerId}` },
      { name: "xorv-jobs", endpoint: "http://broker.test/api/quotes", version: "1" },
    ]);
    expect((await fetch(`${h.base}/agents/prv_unknown.json`)).status).toBe(404);
    provider.close();
  });

  it("resolves the registration file by node id too, which is what the CLI mints", async () => {
    h.agentWallets.set("8", PAYEE_A);
    const provider = await connectProvider(h, { agentId: "8", nodeId: "node-cli-minted" });
    const byNode = await fetch(`${h.base}/agents/node-cli-minted.json`);
    expect(byNode.status).toBe(200);
    const byProvider = await fetch(`${h.base}/agents/${provider.providerId}.json`);
    expect(await byNode.json()).toEqual(await byProvider.json());
    provider.close();
  });

  it("serves ledger feeds from the reader, linked back to broker job ids", async () => {
    const provider = await connectProvider(h);
    const { body: q } = await quote(h);
    const { body: paid } = await pay(h, q.quoteId);
    const tx = `0x${"77".repeat(32)}`;
    h.reader.events_ = [
      {
        kind: "receipts",
        id: "900:1",
        blockNumber: 900,
        txHash: tx,
        at: 1_700_000_000_000,
        data: {
          jobId: jobIdHash(paid.jobId),
          agentId: null,
          buyer: h.buyer.address,
          payTo: provider.address,
          amount: "1000",
          paymentTx: `0x${"5e".repeat(32)}`,
          requestHash: textHash("hello"),
          resultHash: textHash(""),
          durationMs: 3,
          ok: true,
        },
      },
      {
        kind: "registrations",
        id: "800:0",
        blockNumber: 800,
        txHash: tx,
        at: 1_700_000_000_000,
        data: { providerId: providerIdHash(provider.providerId), payTo: provider.address, agentId: null, label: "n", capabilities: "echo:1000" },
      },
    ];

    const ledger = (await (await fetch(`${h.base}/api/ledger?kind=receipts&limit=5`)).json()) as Json;
    expect(ledger).toMatchObject({ kind: "receipts", source: "rpc", ledger: { address: LEDGER } });
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]).toMatchObject({
      id: "900:1",
      brokerJobId: paid.jobId,
      explorerUrl: `https://testnet.monadscan.com/tx/${tx}`,
    });
    expect((await fetch(`${h.base}/api/ledger?kind=registrations`)).status).toBe(200);
    expect((await fetch(`${h.base}/api/ledger?kind=bogus`)).status).toBe(400);

    // The landing page's long-standing shape still reads.
    const receipts = (await (await fetch(`${h.base}/api/receipts`)).json()) as Json;
    expect(receipts.receipts[0]).toMatchObject({
      sequence: "900:1",
      brokerJobId: paid.jobId,
      payload: {
        kind: "job.receipt",
        data: {
          payer: h.buyer.address,
          providerAccountId: provider.address,
          amount: "1000",
          asset: USDC,
          transactionId: `0x${"5e".repeat(32)}`,
        },
      },
    });
    provider.close();
  });

  it("ranks providers from what the broker has seen when there is no indexer", async () => {
    const provider = await connectProvider(h);
    const { body: q } = await quote(h);
    const { body: paid } = await pay(h, q.quoteId);
    await provider.completeNextJob("done");
    await waitForStatus(h, paid.jobId, "completed");

    const board = (await (await fetch(`${h.base}/api/leaderboard`)).json()) as Json;
    expect(board.source).toBe("memory");
    expect(board.providers[0]).toMatchObject({
      rank: 1,
      providerId: provider.providerId,
      providerIdHash: providerIdHash(provider.providerId),
      address: provider.address,
      live: true,
      jobsOk: 1,
      successRate: 1,
      earnedUsdMicros: 1_000,
      earnedUsdcUnits: "1000",
    });
    provider.close();
  });
});

describe("with no facilitator key", () => {
  it("still boots and quotes, but answers the paid route with 503 and the fix", async () => {
    const bare = await boot({
      config: { operator: null, facilitatorAccount: null, facilitatorMode: "self", ledgerAddress: null },
      injectFacilitator: false,
    });
    try {
      const provider = await connectProvider(bare);
      const { status, body } = await quote(bare);
      expect(status).toBe(200);
      const res = await fetch(`${bare.base}/api/jobs/${body.quoteId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toMatch(/XORV_FACILITATOR_KEY/);

      const net = (await (await fetch(`${bare.base}/api/network`)).json()) as Json;
      expect(net).toMatchObject({ ledger: null, operator: null, facilitator: { available: false } });
      provider.close();
    } finally {
      await bare.stop();
    }
  });
});
