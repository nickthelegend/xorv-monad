/**
 * Private jobs and history vaults, end to end through the real app.
 *
 * Same shape as integration.test.ts — the real Hono app, the real x402
 * resource server with upfront settlement, the real WebSocket hub, a buyer
 * signing a real EIP-3009 authorization — with only Monad stubbed. The
 * question every test here asks is the same: after a private job, is there
 * any plaintext result anywhere the broker stores or serves? And for vaults:
 * can anyone but the passkey that owns one change it?
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { wrapFetchWithPayment } from "@x402/fetch";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  VAULT_MAX_CIPHERTEXT_BYTES,
  buyerX402Client,
  decryptVault,
  deriveInboxKeys,
  deriveVaultAuth,
  deriveVaultKey,
  encryptVault,
  openResult,
  sealResult,
  signVaultWrite,
  resolvePreset,
  textHash,
  toBase64Url,
  type LedgerEventKind,
} from "@xorv/protocol";

import { createApp } from "../src/app.js";
import type { BrokerConfig } from "../src/config.js";
import type { ChainLike, PublishResult, ReceiptInput } from "../src/chain.js";
import type { LedgerReader } from "../src/ledger-reader.js";
import { Hub } from "../src/hub.js";
import { JobStore } from "../src/jobs.js";
import { Registry } from "../src/registry.js";
import { openPersistence } from "../src/store.js";
import { VaultStore } from "../src/vaults.js";
import type { RoutingRecord, ScreeningRecord, VerificationRecord } from "../src/ai/types.js";
import type { AiHooks } from "../src/ai-hooks.js";
import { QwenRouter, RoleClient } from "../src/ai/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const NETWORK = "eip155:10143";
const LEDGER = getAddress("0x00000000000000000000000000000000000000aa");
const PAYEE = "0xaaaa00000000000000000000000000000000000a";
const SECRET = "marmalade-4412";
const PROMPT = `Draft the confidential memo about ${SECRET}`;
const ANSWER = `Here is the memo about ${SECRET}: …`;
const INBOX = deriveInboxKeys(Uint8Array.from({ length: 32 }, (_, i) => (i * 3 + 1) & 0xff));

// ---------------------------------------------------------------------------
// Stubs — only what would touch Monad
// ---------------------------------------------------------------------------

class StubChain implements ChainLike {
  readonly network = NETWORK;
  readonly ledgerAddress = LEDGER;
  readonly writerAddress = "0x0000000000000000000000000000000000000Bb1";
  readonly receipts: ReceiptInput[] = [];
  private tx = 0;
  mode() {
    return "write" as const;
  }
  counts() {
    return { registrations: 0, heartbeats: 0, receipts: this.receipts.length, ratings: 0 } satisfies Record<LedgerEventKind, number>;
  }
  pendingReceipts() {
    return 0;
  }
  lastPublishError() {
    return null;
  }
  private result(): PublishResult {
    this.tx += 1;
    const txHash = `0x${this.tx.toString(16).padStart(64, "0")}`;
    return { contract: LEDGER, txHash, explorerUrl: `https://testnet.monadscan.com/tx/${txHash}`, blockNumber: "1" };
  }
  async registerProvider() {
    return this.result();
  }
  async heartbeat() {
    return this.result();
  }
  async recordJob(input: ReceiptInput) {
    this.receipts.push(input);
    return this.result();
  }
  async rateJob(): Promise<PublishResult> {
    return this.result();
  }
  async verifyTypedDataOnChain() {
    return false;
  }
  async flush() {}
  async close() {}
}

/** Accepts any authorization; the payment path itself is integration.test.ts's subject. */
function stubFacilitator(): FacilitatorClient {
  const from = (payload: PaymentPayload) => (payload.payload as { authorization: { from: string } }).authorization.from;
  let n = 0;
  return {
    async verify(payload: PaymentPayload) {
      return { isValid: true, payer: from(payload) };
    },
    async settle(payload: PaymentPayload, requirements: PaymentRequirements) {
      n += 1;
      return { success: true, transaction: `0x${"5e".repeat(31)}${n.toString(16).padStart(2, "0")}`, network: requirements.network, payer: from(payload) };
    },
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
    },
  } as unknown as FacilitatorClient;
}

class StubReader implements LedgerReader {
  async events() {
    return { source: "rpc" as const, events: [] };
  }
  async leaderboard() {
    return null;
  }
}

function testConfig(): BrokerConfig {
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
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  base: string;
  chain: StubChain;
  jobs: JobStore;
  verify: ReturnType<typeof vi.fn>;
  paidFetch: typeof fetch;
  stop(): Promise<void>;
}

async function boot(opts: { vaults?: VaultStore; ai?: Omit<AiHooks, "verifier"> } = {}): Promise<Harness> {
  const chain = new StubChain();
  const registry = new Registry();
  const jobs = new JobStore();
  const verify = vi.fn(
    async (): Promise<VerificationRecord> => ({
      by: "kimi",
      model: "kimi-k3",
      score: 90,
      pass: true,
      rationale: "fine",
      ms: 1,
      flags: [],
      at: Date.now(),
    }),
  );
  let hub: Hub | null = null;
  const { app, hubHandlers } = createApp({
    config: testConfig(),
    chain,
    registry,
    jobs,
    getHub: () => hub,
    facilitator: stubFacilitator(),
    ledgerReader: new StubReader(),
    agentWallet: async () => null,
    agentAuthorizes: async () => false,
    ai: {
      ...opts.ai,
      verifier: {
        info: { by: "kimi", model: "kimi-k3", enabled: true, provider: "kimi", label: "Kimi K3", timeoutMs: 20_000 },
        timeoutMs: 20_000,
        verify,
      },
    },
    vaults: opts.vaults,
  });
  const server = serve({ fetch: app.fetch, port: 0 }) as unknown as Server;
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  hub = new Hub(server, registry, hubHandlers);
  const buyer = privateKeyToAccount(generatePrivateKey());
  return {
    base: `http://127.0.0.1:${port}`,
    chain,
    jobs,
    verify,
    paidFetch: wrapFetchWithPayment(
      fetch,
      buyerX402Client({ signer: buyer, network: NETWORK, maxUsdcUnits: "10000000" }),
    ) as typeof fetch,
    async stop() {
      hub?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A provider node that answers the way it is told to. */
async function provider(h: Harness, label = "node-a", adapter = "echo") {
  const res = await fetch(`${h.base}/api/providers/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label,
      address: PAYEE,
      endpoint: "http://localhost:1",
      capabilities: [{ id: adapter, adapter, displayName: adapter, model: null, priceUsdMicros: 1_000, maxConcurrency: 4 }],
      version: "0.2.0",
      region: null,
      nodeId: `node-${label}`,
    }),
  });
  const body = (await res.json()) as { token: string };
  const ws = new WebSocket(`${h.base.replace("http", "ws")}/ws/provider?token=${body.token}`);
  const dispatched: Json[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as Json;
    if (msg.type === "job.dispatch") dispatched.push(msg.job);
  });
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  return { dispatched, send, close: () => ws.close() };
}

async function waitFor<T>(probe: () => T | undefined | null, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for condition");
}

async function quote(h: Harness, extra: Record<string, unknown>) {
  const res = await fetch(`${h.base}/api/quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: PROMPT, title: `memo ${SECRET}`, maxPriceUsdMicros: 50_000, ...extra }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

async function buyPrivate(h: Harness) {
  const q = await quote(h, { encryptTo: INBOX.encryptTo });
  expect(q.status).toBe(200);
  const res = await h.paidFetch(q.body.payUrl.replace("http://broker.test", h.base), { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as Json;
}

let h: Harness;
afterEach(async () => {
  await h?.stop();
});

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

describe("encryptTo on quotes", () => {
  beforeEach(async () => {
    h = await boot();
  });

  it("accepts a derived inbox key", async () => {
    const node = await provider(h);
    const q = await quote(h, { encryptTo: INBOX.encryptTo });
    expect(q.status).toBe(200);
    node.close();
  });

  it("refuses anything a provider could not seal to — before reserving anyone", async () => {
    const node = await provider(h);
    for (const bad of ["", "abc", `${INBOX.encryptTo}=`, toBase64Url(new Uint8Array(32)), toBase64Url(new Uint8Array(33)), 42]) {
      const q = await quote(h, { encryptTo: bad });
      expect(q.status, `encryptTo=${String(bad)}`).toBe(400);
      expect(q.body.error).toMatch(/encryptTo/);
    }
    node.close();
  });

  it("treats null as a public job", async () => {
    const node = await provider(h);
    const q = await quote(h, { encryptTo: null });
    expect(q.status).toBe(200);
    node.close();
  });
});

// ---------------------------------------------------------------------------
// The private job loop
// ---------------------------------------------------------------------------

describe("a private job", () => {
  beforeEach(async () => {
    h = await boot();
  });

  it("is dispatched with the inbox key and stores only the envelope, which the receipt hashes", async () => {
    const node = await provider(h);
    const paid = await buyPrivate(h);
    const job = await waitFor(() => node.dispatched[0]);
    expect(job.encryptTo).toBe(INBOX.encryptTo);

    const envelope = sealResult(INBOX.encryptTo, ANSWER, job.jobId);
    node.send({ type: "job.accepted", jobId: job.jobId });
    node.send({ type: "job.event", jobId: job.jobId, event: { at: Date.now(), kind: "status", text: "working privately · 1 step" } });
    node.send({ type: "job.result", jobId: job.jobId, result: envelope, durationMs: 50 });

    const stored = await waitFor(() => (h.jobs.get(paid.jobId)?.status === "completed" ? h.jobs.get(paid.jobId) : null));
    expect(stored!.result).toBe(envelope);
    expect(stored!.resultHash).toBe(textHash(envelope));

    const receipt = await waitFor(() => h.chain.receipts[0]);
    expect(receipt.result).toBe(envelope);
    expect(openResult(INBOX.secretKey, stored!.result, paid.jobId)).toBe(ANSWER);
    node.close();
  });

  it("is public only as 'private': no prompt, no title, no plaintext result, no plaintext events", async () => {
    const node = await provider(h);
    const paid = await buyPrivate(h);
    const job = await waitFor(() => node.dispatched[0]);
    // An older node that ignores encryptTo would stream text and reasoning;
    // the broker keeps none of it for a private job.
    node.send({ type: "job.event", jobId: job.jobId, event: { at: Date.now(), kind: "message", text: ANSWER } });
    node.send({ type: "job.event", jobId: job.jobId, event: { at: Date.now(), kind: "reasoning", text: `thinking about ${SECRET}` } });
    node.send({ type: "job.event", jobId: job.jobId, event: { at: Date.now(), kind: "status", text: "working privately · 2 steps" } });
    node.send({ type: "job.result", jobId: job.jobId, result: sealResult(INBOX.encryptTo, ANSWER, job.jobId), durationMs: 50 });
    await waitFor(() => (h.jobs.get(paid.jobId)?.status === "completed" ? true : null));

    const one = (await (await fetch(`${h.base}/api/jobs/${paid.jobId}`)).json()) as Json;
    expect(one.job.private).toBe(true);
    expect(one.job.prompt).toBe("");
    expect(one.job.title).toBeNull();
    expect(one.job.events.every((e: Json) => e.kind === "status")).toBe(true);

    const list = await (await fetch(`${h.base}/api/jobs`)).text();
    const snapshot = await (await fetch(`${h.base}/api/jobs/${paid.jobId}/stream`)).text();
    for (const body of [JSON.stringify(one), list, snapshot]) expect(body).not.toContain(SECRET);

    // The one who holds the passkey still gets the answer, from the public route.
    expect(openResult(INBOX.secretKey, one.job.result, paid.jobId)).toBe(ANSWER);
    node.close();
  });

  it("serves the router's and screener's reasons as withheld, since the models paraphrase the prompt", async () => {
    // Asked why an adapter "suits this job", a model describes the job. Those
    // sentences sat next to prompt: "" on every public read of a private job.
    await h.stop();
    const role = { by: "qwen", model: "stub-1", enabled: true, provider: "qwen", label: "Stub", timeoutMs: 1_000 } as const;
    h = await boot({
      ai: {
        screener: {
          info: role,
          timeoutMs: 1_000,
          failMode: "open",
          screen: async (): Promise<ScreeningRecord> => ({
            by: "stub",
            model: "stub-1",
            verdict: "allow",
            category: "none",
            reason: `A memo about ${SECRET}, harmless.`,
            ms: 1,
          }),
        },
        router: {
          info: role,
          timeoutMs: 1_000,
          route: async (): Promise<RoutingRecord> => ({
            by: "stub",
            model: "stub-1",
            adapter: "codex",
            reason: `Codex writes the confidential ${SECRET} memo best.`,
            difficulty: "hard",
            ms: 1,
            candidates: 2,
          }),
        },
      },
    });
    const a = await provider(h, "node-a", "echo");
    const b = await provider(h, "node-b", "codex");
    const q = await quote(h, { encryptTo: INBOX.encryptTo });
    expect(q.status).toBe(200);
    // The buyer's own quote still explains itself.
    expect(q.body.routing.reason).toContain(SECRET);
    const res = await h.paidFetch(q.body.payUrl.replace("http://broker.test", h.base), { method: "POST" });
    const paid = (await res.json()) as Json;
    // Routed to the codex node; finish the job so the stream closes.
    const job = await waitFor(() => b.dispatched[0]);
    b.send({ type: "job.result", jobId: job.jobId, result: sealResult(INBOX.encryptTo, ANSWER, job.jobId), durationMs: 50 });
    await waitFor(() => (h.jobs.get(paid.jobId)?.status === "completed" ? true : null));

    const one = (await (await fetch(`${h.base}/api/jobs/${paid.jobId}`)).json()) as Json;
    expect(one.job.routing).toMatchObject({ adapter: "codex", reason: "withheld for a private job", difficulty: null });
    expect(one.job.screening).toMatchObject({ verdict: "allow", category: "none", reason: "withheld for a private job" });
    const list = await (await fetch(`${h.base}/api/jobs`)).text();
    const snapshot = await (await fetch(`${h.base}/api/jobs/${paid.jobId}/stream`)).text();
    for (const body of [JSON.stringify(one), list, snapshot]) expect(body).not.toContain(SECRET);
    a.close();
    b.close();
  });

  it("serves the agent router's trace on a private job, but never what the model wrote about the prompt", async () => {
    // The real tool-using router, with a Qwen that tries to smuggle the prompt
    // into its tool arguments and its reason.
    await h.stop();
    let n = 0;
    const call = (name: string, args: Json) => ({ id: `c${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
    const bodies: Json[] = [];
    const qwenFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Json;
      bodies.push(body);
      const results = (body.messages as Json[]).filter((m) => m.role === "tool");
      let message: Json;
      if (results.length === 0) message = { role: "assistant", content: null, tool_calls: [call("list_candidates", {})] };
      else {
        const rows = JSON.parse(results[0].content).candidates as Json[];
        const codex = rows.find((r) => r.adapter === "codex");
        message =
          results.length === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [call("recent_receipts", { providerId: `the ${SECRET} memo` }), call("nansen_trust", { providerId: codex.providerId })],
              }
            : {
                role: "assistant",
                content: null,
                tool_calls: [call("select_provider", { providerId: codex.providerId, reason: `Codex writes the ${SECRET} memo best.`, difficulty: "hard" })],
              };
      }
      return new Response(JSON.stringify({ model: "qwen3.8-max", choices: [{ message }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new RoleClient({
      role: "router",
      preset: resolvePreset("qwen", { XORV_QWEN_API_KEY: "sk-test-qwen-000000" }),
      timeoutMs: 5_000,
      fetch: qwenFetch,
    });
    h = await boot({ ai: { router: new QwenRouter({ client, log: () => undefined }) } });
    const a = await provider(h, "node-a", "echo");
    const b = await provider(h, "node-b", "codex");
    const q = await quote(h, { encryptTo: INBOX.encryptTo });
    expect(q.status).toBe(200);
    // The router read the prompt (routing needs it) and the buyer's quote explains itself…
    expect(bodies[0].messages[1].content).toContain(SECRET);
    expect(q.body.routing).toMatchObject({ adapter: "codex", difficulty: "hard" });
    expect(q.body.routing.reason).toContain(SECRET);
    // …but the trace never carried the model's words, even in the buyer's own copy.
    expect(q.body.routing.steps.map((st: Json) => st.tool)).toEqual(["list_candidates", "recent_receipts", "nansen_trust", "select_provider"]);
    expect(JSON.stringify(q.body.routing.steps)).not.toContain(SECRET);
    expect(q.body.routing.steps[1]).toMatchObject({ args: { providerId: "(not a candidate)" }, ok: false });

    const res = await h.paidFetch(q.body.payUrl.replace("http://broker.test", h.base), { method: "POST" });
    const paid = (await res.json()) as Json;
    const job = await waitFor(() => b.dispatched[0]);
    b.send({ type: "job.result", jobId: job.jobId, result: sealResult(INBOX.encryptTo, ANSWER, job.jobId), durationMs: 50 });
    await waitFor(() => (h.jobs.get(paid.jobId)?.status === "completed" ? true : null));

    const one = (await (await fetch(`${h.base}/api/jobs/${paid.jobId}`)).json()) as Json;
    // Public reads keep the trace — what the router looked at is public data — and withhold the reason.
    expect(one.job.routing).toMatchObject({ adapter: "codex", reason: "withheld for a private job", difficulty: null, turns: 3 });
    expect(one.job.routing.steps).toHaveLength(4);
    const list = await (await fetch(`${h.base}/api/jobs`)).text();
    const snapshot = await (await fetch(`${h.base}/api/jobs/${paid.jobId}/stream`)).text();
    for (const body of [JSON.stringify(one), list, snapshot]) expect(body).not.toContain(SECRET);
    a.close();
    b.close();
  });

  it("skips the AI verifier, which would need the plaintext", async () => {
    const node = await provider(h);
    const paid = await buyPrivate(h);
    const job = await waitFor(() => node.dispatched[0]);
    node.send({ type: "job.result", jobId: job.jobId, result: sealResult(INBOX.encryptTo, ANSWER, job.jobId), durationMs: 50 });
    await waitFor(() => (h.jobs.get(paid.jobId)?.status === "completed" ? true : null));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.verify).not.toHaveBeenCalled();
    node.close();
  });

  it("discards a plaintext result unstored and fails over, rather than publishing it", async () => {
    const node = await provider(h);
    const paid = await buyPrivate(h);
    const job = await waitFor(() => node.dispatched[0]);
    node.send({ type: "job.result", jobId: job.jobId, result: ANSWER, durationMs: 50 });

    const failed = await waitFor(() => (h.jobs.get(paid.jobId)?.status === "failed" ? h.jobs.get(paid.jobId) : null));
    expect(failed!.result ?? null).toBeNull();
    expect(failed!.error).toMatch(/unsealed result/);
    const body = await (await fetch(`${h.base}/api/jobs/${paid.jobId}`)).text();
    expect(body).not.toContain(SECRET);
    node.close();
  });

  it("stores only the allowlisted envelope fields a provider sent", async () => {
    const node = await provider(h);
    const paid = await buyPrivate(h);
    const job = await waitFor(() => node.dispatched[0]);
    const envelope = JSON.parse(sealResult(INBOX.encryptTo, ANSWER, job.jobId)) as Json;
    node.send({ type: "job.result", jobId: job.jobId, result: JSON.stringify({ ...envelope, debug: ANSWER }), durationMs: 50 });
    const stored = await waitFor(() => (h.jobs.get(paid.jobId)?.status === "completed" ? h.jobs.get(paid.jobId) : null));
    expect(stored!.result).not.toContain(SECRET);
    expect(openResult(INBOX.secretKey, stored!.result, paid.jobId)).toBe(ANSWER);
    node.close();
  });

  it("keeps a provider's raw error text out of a private job", async () => {
    const node = await provider(h);
    const paid = await buyPrivate(h);
    const job = await waitFor(() => node.dispatched[0]);
    node.send({ type: "job.error", jobId: job.jobId, error: `adapter crashed while writing about ${SECRET}`, durationMs: 50 });
    const failed = await waitFor(() => (h.jobs.get(paid.jobId)?.status === "failed" ? h.jobs.get(paid.jobId) : null));
    expect(failed!.error).toBe("private job failed on the provider");
    node.close();
  });

  it("leaves public jobs exactly as they were", async () => {
    const node = await provider(h);
    const q = await quote(h, {});
    const res = await h.paidFetch(q.body.payUrl.replace("http://broker.test", h.base), { method: "POST" });
    const paid = (await res.json()) as Json;
    const job = await waitFor(() => node.dispatched[0]);
    expect(job.encryptTo).toBeUndefined();
    node.send({ type: "job.event", jobId: job.jobId, event: { at: Date.now(), kind: "message", text: "streamed" } });
    node.send({ type: "job.result", jobId: job.jobId, result: ANSWER, durationMs: 50 });
    await waitFor(() => (h.jobs.get(paid.jobId)?.status === "completed" ? true : null));
    const one = (await (await fetch(`${h.base}/api/jobs/${paid.jobId}`)).json()) as Json;
    expect(one.job.private).toBe(false);
    expect(one.job.prompt).toBe(PROMPT);
    expect(one.job.result).toBe(ANSWER);
    expect(one.job.events.some((e: Json) => e.kind === "message")).toBe(true);
    await waitFor(() => (h.verify.mock.calls.length > 0 ? true : null));
    node.close();
  });
});

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

const VAULT_KEY = deriveVaultKey(Uint8Array.from({ length: 32 }, (_, i) => (i * 17 + 2) & 0xff));
const AUTH = deriveVaultAuth(Uint8Array.from({ length: 32 }, (_, i) => (i * 19 + 4) & 0xff));
const INTRUDER = deriveVaultAuth(Uint8Array.from({ length: 32 }, (_, i) => (i * 23 + 6) & 0xff));

function write(version: number, plaintext = `{"v":1,"entries":[]}`, auth = AUTH, vaultId = AUTH.vaultId) {
  return signVaultWrite(auth.seed, vaultId, encryptVault(VAULT_KEY, plaintext, vaultId, version));
}

async function put(id: string, body: unknown) {
  const res = await fetch(`${h.base}/api/vaults/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

describe("vaults", () => {
  beforeEach(async () => {
    h = await boot();
  });

  it("serves 404 for a vault that doesn't exist yet, and ciphertext once it does", async () => {
    const missing = await fetch(`${h.base}/api/vaults/${AUTH.vaultId}`);
    expect(missing.status).toBe(404);

    const first = write(1, `{"v":1,"entries":[{"prompt":"${SECRET}"}]}`);
    expect((await put(AUTH.vaultId, first)).status).toBe(200);

    const got = (await (await fetch(`${h.base}/api/vaults/${AUTH.vaultId}`)).json()) as Json;
    expect(got).toMatchObject({ id: AUTH.vaultId, ciphertext: first.ciphertext, iv: first.iv, version: 1 });
    expect(JSON.stringify(got)).not.toContain(SECRET);
    expect(decryptVault(VAULT_KEY, got, AUTH.vaultId)).toContain(SECRET);
  });

  it("accepts only the next version: replays and gaps get 409 with the current version", async () => {
    const v1 = write(1);
    expect((await put(AUTH.vaultId, v1)).status).toBe(200);
    const replay = await put(AUTH.vaultId, v1);
    expect(replay.status).toBe(409);
    expect(replay.body.version).toBe(1);
    expect((await put(AUTH.vaultId, write(3))).status).toBe(409);
    const v2 = write(2);
    expect((await put(AUTH.vaultId, v2)).status).toBe(200);
    // Rolling back to a genuinely signed older write is refused.
    expect((await put(AUTH.vaultId, v1)).status).toBe(409);
    expect((await put(AUTH.vaultId, v2)).status).toBe(409);
  });

  it("refuses writes not signed by the key the vault id names (403)", async () => {
    // The intruder signs correctly with their own key, for the victim's id.
    const forged = write(1, "{}", INTRUDER, AUTH.vaultId);
    expect((await put(AUTH.vaultId, forged)).status).toBe(403);
    // The victim's real public key with the intruder's signature.
    expect((await put(AUTH.vaultId, { ...forged, publicKey: write(1).publicKey })).status).toBe(403);
    // A genuine write whose ciphertext was swapped afterwards.
    const genuine = write(1);
    const swapped = { ...genuine, ciphertext: write(1, '{"v":1,"entries":[{"x":1}]}').ciphertext };
    expect((await put(AUTH.vaultId, swapped)).status).toBe(403);
    expect((await fetch(`${h.base}/api/vaults/${AUTH.vaultId}`)).status).toBe(404);
  });

  it("rejects malformed writes and ids (400)", async () => {
    expect((await put("not-a-vault", write(1))).status).toBe(400);
    expect((await put(AUTH.vaultId, { ...write(1), version: 0 })).status).toBe(400);
    expect((await put(AUTH.vaultId, { ...write(1), iv: "AAAA" })).status).toBe(400);
    expect((await put(AUTH.vaultId, null)).status).toBe(400);
    expect((await fetch(`${h.base}/api/vaults/${"A".repeat(64)}`)).status).toBe(400);
  });

  it("answers 413 for a ciphertext over the cap", async () => {
    const tooBig = { ...write(1), ciphertext: "A".repeat(Math.ceil((VAULT_MAX_CIPHERTEXT_BYTES * 4) / 3) + 400) };
    const res = await put(AUTH.vaultId, tooBig);
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/KiB/);
  });

  it("answers 507 when the broker holds as many vaults as it will", async () => {
    await h.stop();
    h = await boot({ vaults: new VaultStore(undefined, 1) });
    expect((await put(AUTH.vaultId, write(1))).status).toBe(200);
    expect((await put(INTRUDER.vaultId, write(1, "{}", INTRUDER, INTRUDER.vaultId))).status).toBe(507);
    // …but the vault it already has can still be written.
    expect((await put(AUTH.vaultId, write(2))).status).toBe(200);
  });

  it("caps new vaults per client address, but not writes to a vault it already has", async () => {
    // Anyone can mint a vault key and vaults are never evicted, so creating
    // one is limited far below writing one.
    const expected = [];
    for (let i = 0; i < 11; i += 1) {
      const auth = deriveVaultAuth(Uint8Array.from({ length: 32 }, (_, j) => (j * 29 + i + 7) & 0xff));
      expected.push((await put(auth.vaultId, write(1, "{}", auth, auth.vaultId))).status);
    }
    expect(expected.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(expected[10]).toBe(429);
    const first = deriveVaultAuth(Uint8Array.from({ length: 32 }, (_, j) => (j * 29 + 7) & 0xff));
    expect((await put(first.vaultId, write(2, "{}", first, first.vaultId))).status).toBe(200);
  });

  it("answers 507 for a new vault once the byte cap is reached, and still takes rewrites", async () => {
    await h.stop();
    const one = write(1).ciphertext.length;
    h = await boot({ vaults: new VaultStore(undefined, 100, one + 10) });
    expect((await put(AUTH.vaultId, write(1))).status).toBe(200);
    expect((await put(INTRUDER.vaultId, write(1, "{}", INTRUDER, INTRUDER.vaultId))).status).toBe(507);
    expect((await put(AUTH.vaultId, write(2, `{"v":1,"entries":[{"prompt":"a much longer entry than before"}]}`))).status).toBe(200);
  });
});

describe("vault persistence", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-vaults-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("survives a restart, ciphertext and version intact", () => {
    const file = path.join(dir, "broker.db");
    const first = openPersistence(file);
    const w = write(1);
    expect(new VaultStore(first).put(AUTH.vaultId, w).ok).toBe(true);
    first.close();

    const second = openPersistence(file);
    const restored = new VaultStore(second);
    expect(restored.get(AUTH.vaultId)).toMatchObject({ ciphertext: w.ciphertext, iv: w.iv, version: 1, publicKey: w.publicKey });
    expect(restored.nextVersion(AUTH.vaultId)).toBe(2);
    second.close();
  });

  it("keeps only metadata in memory and reads ciphertext from disk on demand", () => {
    // Every vault's ciphertext used to live in the heap (up to 10,000 × 176
    // KiB), and a boot parsed them all.
    const file = path.join(dir, "broker.db");
    const first = openPersistence(file);
    const store = new VaultStore(first);
    const w = write(1, `{"v":1,"entries":[{"prompt":"${SECRET}"}]}`);
    expect(store.put(AUTH.vaultId, w).ok).toBe(true);
    first.close();

    const second = openPersistence(file);
    const disk = second as typeof second & { loadVaults(): unknown; loadVault(id: string): unknown };
    const loadAll = vi.spyOn(disk, "loadVaults");
    const loadOne = vi.spyOn(disk, "loadVault");
    const restored = new VaultStore(second);
    expect(loadAll).not.toHaveBeenCalled();
    expect(restored.size).toBe(1);
    expect(restored.bytes).toBe(w.ciphertext.length);
    expect(loadOne).not.toHaveBeenCalled();
    expect(restored.get(AUTH.vaultId)?.ciphertext).toBe(w.ciphertext);
    expect(loadOne).toHaveBeenCalledWith(AUTH.vaultId);
    // A write goes to disk, not the heap: the next read comes from disk again.
    expect(restored.put(AUTH.vaultId, write(2)).ok).toBe(true);
    loadOne.mockClear();
    expect(restored.get(AUTH.vaultId)?.version).toBe(2);
    expect(loadOne).toHaveBeenCalledTimes(1);
    second.close();
  });
});
