/**
 * The broker test harness: end-to-end, in one process, with no network and no credentials.
 *
 * A real HTTP server, the real Hono app, the real x402 resource server and the
 * real WebSocket hub. Only two things are stubbed, and only because they are
 * the parts that touch the chain: the facilitator (which would broadcast the
 * authorization) and the audit writer (which would append to XorvLog).
 * Everything between a buyer's first request and a published receipt is the
 * production code path.
 *
 * The client side uses the genuine `@x402/*` client with a stub *scheme*, so
 * the 402 negotiation, header encoding and retry are all exercised for real —
 * only the signature is fake. A real signature is proven separately, against
 * the real chain, by `scripts/m1-settle.mts`.
 */

import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import WebSocket from "ws";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";

import { createApp } from "../src/app.js";
import type { BrokerConfig } from "../src/config.js";
import type { ChainLike, PublishResult } from "../src/chain.js";
import { Hub } from "../src/hub.js";
import { JobStore } from "../src/jobs.js";
import { Registry } from "../src/registry.js";
import { MemoryEscrow } from "../src/escrow.js";
import type { ReputationSource } from "../src/reputation.js";
import { ESCROW_SCHEME } from "@xorv/protocol";

// ---------------------------------------------------------------------------
// Stubs — only the two things that would touch the chain
// ---------------------------------------------------------------------------

export class StubChain implements ChainLike {
  readonly network = "eip155:10143";
  readonly operatorAddress = "0xeEE4CA97A7Af69B42d9cafD3955735C1130eB51E";
  readonly publicClient = null as never;
  readonly walletClient = null as never;
  readonly published: Array<{ kind: string; data: unknown }> = [];
  private tally = { registry: 0, heartbeat: 0, receipts: 0 };

  describeLog() {
    return {
      address: "0x383f5153db8bb18c7c25157fb3493645a465eEf3",
      url: "https://sepolia.arbiscan.io/address/0x383f5153db8bb18c7c25157fb3493645a465eEf3",
    };
  }
  counts() {
    return { ...this.tally };
  }
  lastPublishError(): string | null {
    return null;
  }
  private record(kind: keyof StubChain["tally"], data: unknown): PublishResult {
    this.tally[kind] += 1;
    this.published.push({ kind, data });
    return {
      contract: "0x383f5153db8bb18c7c25157fb3493645a465eEf3",
      transactionHash: `0x${String(this.published.length).padStart(64, "0")}`,
      explorerUrl: "https://sepolia.arbiscan.io/tx/stub",
    };
  }
  async publishRegistration(provider: { id: string }) {
    return this.record("registry", provider);
  }
  async publishHeartbeat(data: unknown) {
    return this.record("heartbeat", data);
  }
  async publishReceipt(data: unknown) {
    return this.record("receipts", data);
  }
  close(): void {}
}

/** A facilitator that always approves — the crypto is not what's under test here. */
export function stubFacilitator(
  settled: PaymentRequirements[],
  opts: { escrow?: MemoryEscrow; failSettle?: boolean; verifyDelayMs?: number } = {},
): FacilitatorClient {
  return {
    async verify(_payload: PaymentPayload, requirements: PaymentRequirements) {
      // A real facilitator reads the chain here; the delay is what lets two
      // requests for one quote both be in flight at once.
      if (opts.verifyDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.verifyDelayMs));
      return { isValid: true, payer: "0x03294Ce27e218d1611B2ebc0b0ffdDb95F129F36", ...{ requirements } };
    },
    async settle(_payload: PaymentPayload, requirements: PaymentRequirements) {
      if (opts.failSettle) {
        return {
          success: false,
          errorReason: "transaction_reverted",
          errorMessage: "stub: settlement failed",
          transaction: "",
          network: requirements.network,
        };
      }
      settled.push(requirements);
      // What XorvEscrow.fund would have written on chain.
      if (requirements.scheme === ESCROW_SCHEME && opts.escrow) {
        const extra = requirements.extra as { jobId: string; provider: string; deadline: number };
        opts.escrow.fund(extra.jobId, extra.provider, extra.deadline);
      }
      return {
        success: true,
        transaction: `0x${String(settled.length).padStart(64, "7")}`,
        network: requirements.network,
        payer: "0x03294Ce27e218d1611B2ebc0b0ffdDb95F129F36",
      };
    },
    async getSupported() {
      return {
        kinds: [
          { x402Version: 2, scheme: "exact", network: "eip155:10143" },
          { x402Version: 2, scheme: ESCROW_SCHEME, network: "eip155:10143" },
        ],
        extensions: [],
        signers: {},
      };
    },
  } as unknown as FacilitatorClient;
}

/**
 * A scheme client that produces a payload without signing anything.
 *
 * It must echo `x402Version` back — the client composes the final payload from
 * this result and refuses to encode a header without a version.
 */
export class StubScheme implements SchemeNetworkClient {
  constructor(readonly scheme: string = "exact") {}
  seen: PaymentRequirements[] = [];
  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
    this.seen.push(requirements);
    return { x402Version, payload: { transaction: "c3R1Yi10cmFuc2FjdGlvbg==" } };
  }
}

export function testConfig(): BrokerConfig {
  return {
    network: "eip155:10143",
    operatorAddress: "0xeEE4CA97A7Af69B42d9cafD3955735C1130eB51E",
    // A throwaway key. Nothing in this test broadcasts, so it needs to parse
    // and nothing more; the facilitator that would use it is stubbed out.
    operatorKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    logAddress: "0x383f5153db8bb18c7c25157fb3493645a465eEf3",
    port: 0,
    publicUrl: "http://localhost",
    corsOrigins: [],
    feeBps: 0,
    facilitatorMode: "self",
    dbFile: null,
    mongoUri: null,
    mongoDb: "xorv",
    escrowAddress: null,
    registryAddress: null,
    escrowDeadlineSeconds: 1800,
    escrowFundingWaitMs: 5_000,
    escrowRetries: 2,
    escrowRetryDelayMs: 10,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface Harness {
  base: string;
  chain: StubChain;
  registry: Registry;
  jobs: JobStore;
  settled: PaymentRequirements[];
  scheme: StubScheme;
  paidFetch: typeof fetch;
  httpClient: x402HTTPClient;
  /** The broker's 15-second housekeeping pass, run on demand. */
  sweep(): void;
  stop(): Promise<void>;
}

export async function boot(
  opts: {
    escrow?: MemoryEscrow;
    failSettle?: boolean;
    clientScheme?: string;
    reputation?: ReputationSource;
    /** Escrow refund deadline in seconds; tests of the deadline path set it tiny. */
    deadlineSeconds?: number;
    /** How long payment verification takes, as an RPC read would. */
    verifyDelayMs?: number;
  } = {},
): Promise<Harness> {
  const config = { ...testConfig(), ...(opts.deadlineSeconds ? { escrowDeadlineSeconds: opts.deadlineSeconds } : {}) };
  const chain = new StubChain();
  const registry = new Registry();
  const jobs = new JobStore();
  const settled: PaymentRequirements[] = [];

  let hub: Hub | null = null;
  const { app, hubHandlers, sweep } = createApp({
    config,
    chain,
    registry,
    jobs,
    getHub: () => hub,
    facilitator: stubFacilitator(settled, opts),
    // Escrow off unless a test asks for it: the rest of the suite covers the
    // direct-payment path, which is what a broker without XORV_ESCROW_ADDRESS runs.
    escrow: opts.escrow ?? null,
    reputation: opts.reputation ?? null,
    // Uses the network table's stablecoins (AUSD first, then USDC) — nothing
    // is read from the chain, so the whole suite stays off the network.
  });

  const server = serve({ fetch: app.fetch, port: 0 }) as unknown as Server;
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  hub = new Hub(server, registry, hubHandlers);

  const scheme = new StubScheme(opts.clientScheme ?? "exact");
  const client = new x402Client().register("eip155:*", scheme);
  const paidFetch = wrapFetchWithPayment(fetch, client) as typeof fetch;

  return {
    base: `http://127.0.0.1:${port}`,
    chain,
    registry,
    jobs,
    settled,
    scheme,
    paidFetch,
    httpClient: new x402HTTPClient(client),
    sweep,
    async stop() {
      hub?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A provider node: registers over HTTP, then holds a control socket like the CLI does. */
export async function connectProvider(
  h: Harness,
  opts: {
    label?: string;
    address?: string;
    price?: number;
    nodeId?: string;
    available?: Record<string, boolean>;
    maxConcurrency?: number;
  } = {},
) {
  const res = await fetch(`${h.base}/api/providers/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: opts.label ?? "test-node",
      address: opts.address ?? "0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B",
      endpoint: "http://localhost:1",
      capabilities: [
        {
          id: "echo",
          adapter: "echo",
          displayName: "Echo (test)",
          model: null,
          priceUsdMicros: opts.price ?? 1_000,
          maxConcurrency: opts.maxConcurrency ?? 4,
        },
      ],
      version: "0.1.0",
      region: null,
      nodeId: opts.nodeId ?? `node-${opts.label ?? "test"}`,
      ...(opts.available ? { available: opts.available } : {}),
    }),
  });
  const body = (await res.json()) as { provider: { id: string }; token: string; wsUrl: string };

  const ws = new WebSocket(`${h.base.replace("http", "ws")}/ws/provider?token=${body.token}`);
  const dispatched: Array<{ jobId: string; prompt: string }> = [];
  /** Job ids the broker told this node to stop. */
  const cancelled: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as { type: string; jobId?: string; job?: { jobId: string; prompt: string } };
    if (msg.type === "job.dispatch" && msg.job) dispatched.push(msg.job);
    if (msg.type === "job.cancel" && msg.jobId) cancelled.push(msg.jobId);
  });

  return {
    providerId: body.provider.id,
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
      ws.send(
        JSON.stringify({ type: "job.result", jobId: job.jobId, result, durationMs: 120 }),
      );
      return job;
    },
    async failNextJob(error = "boom") {
      const job = await waitFor(() => dispatched[0], 4_000);
      ws.send(JSON.stringify({ type: "job.error", jobId: job.jobId, error, durationMs: 50 }));
      return job;
    },
    close() {
      ws.close();
    },
  };
}

export async function waitFor<T>(probe: () => T | undefined, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for condition");
}

export async function quote(h: Harness, prompt = "hello", max = 50_000) {
  const res = await fetch(`${h.base}/api/quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, maxPriceUsdMicros: max }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

