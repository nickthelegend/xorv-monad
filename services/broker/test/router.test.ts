/**
 * The Qwen router as a tool-using agent, with the model replaced by a script
 * (an injected fetch that answers each turn) and every data source stubbed:
 * no network, no keys, no chain.
 *
 * What is pinned: the loop (list → read → select, reads run together), what
 * each tool reads and how its result is summarised for the trace, the bounds
 * (turns, lookups, the wall-clock budget), the checks on the pick (live,
 * under the ceiling, retried once), the fallbacks, and that nothing the model
 * writes — least of all a private job's prompt — gets into the trace. Plus
 * the pieces the matcher uses when no router runs: the reputation book (Envio
 * first, memory second) and the registry's reputation tie-break.
 */

import { describe, expect, it, vi } from "vitest";
import {
  explorerAgent,
  explorerTx,
  providerIdHash,
  resolvePreset,
  type JobRequest,
  type LedgerEvent,
  type ReputationSummary,
} from "@xorv/protocol";
import {
  NOT_A_CANDIDATE,
  QwenRouter,
  REPUTATION_PRIOR,
  ReputationBook,
  RoleClient,
  createRouterData,
  reputationScore,
  runReadTool,
  type Erc8004Read,
  type RouteCandidate,
  type RouterData,
} from "../src/ai/index.js";
import type { ToolContext as ToolContextForTest } from "../src/ai/router-tools.js";
import { Registry } from "../src/registry.js";
import type { LedgerReader } from "../src/ledger-reader.js";
import type { PublicTrustSignal } from "../src/trust/index.js";

const NETWORK = "eip155:10143";
const KEYS = { XORV_QWEN_API_KEY: "sk-qwen-test-000000000000" };
const SECRET = "marmalade-4412";

const ADDR = {
  echo: "0xaaaa00000000000000000000000000000000000a",
  kimi: "0xbbbb00000000000000000000000000000000000b",
  qwen: "0xcccc00000000000000000000000000000000000c",
  big: "0xdddd00000000000000000000000000000000000d",
};

function candidate(over: Partial<RouteCandidate> & Pick<RouteCandidate, "providerId" | "adapter">): RouteCandidate {
  return {
    label: over.providerId,
    address: ADDR.echo,
    agentId: null,
    capabilityId: over.adapter,
    displayName: over.adapter,
    model: null,
    priceUsdMicros: 1_000,
    liveness: "online",
    heartbeatAgeS: 3,
    successRate: null,
    jobs: 0,
    avgRating: null,
    avgVerified: null,
    hasAgent: false,
    ...over,
  };
}

/** Matcher order: cheapest first. The claude-code node is over the buyer's ceiling. */
const CANDIDATES: RouteCandidate[] = [
  candidate({ providerId: "prv_echo", label: "cheap echo", adapter: "echo", priceUsdMicros: 1_000 }),
  candidate({
    providerId: "prv_qwen",
    label: "qwen node",
    adapter: "qwen",
    model: "qwen3.8-max",
    address: ADDR.qwen,
    agentId: "12",
    hasAgent: true,
    priceUsdMicros: 4_000,
    successRate: 0.5,
    jobs: 4,
  }),
  candidate({
    providerId: "prv_kimi",
    label: "kimi node",
    adapter: "kimi",
    model: "kimi-k3",
    address: ADDR.kimi,
    agentId: "7",
    hasAgent: true,
    priceUsdMicros: 5_000,
    successRate: 0.9,
    jobs: 10,
    avgRating: 88,
    avgVerified: 91.4,
  }),
  candidate({ providerId: "prv_big", label: "big node", adapter: "claude-code", address: ADDR.big, priceUsdMicros: 90_000 }),
];

const REQUEST: JobRequest = { prompt: "Write a haiku about Monad", maxPriceUsdMicros: 50_000 };

// ---------------------------------------------------------------------------
// A scripted Qwen
// ---------------------------------------------------------------------------

type Call = { name: string; args: Record<string, unknown> | string; id?: string };
type Turn =
  | { calls: Call[]; reasoning?: string }
  | { content: string }
  | { status: number; text: string }
  | { hang: true };

interface Recorded {
  body: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  tools: string[];
}

/** A chat-completions endpoint that answers turn N with script[N] (or a function of the request). */
function scriptedQwen(script: Array<Turn | ((r: Recorded) => Turn)>) {
  const calls: Recorded[] = [];
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const recorded: Recorded = {
      body,
      messages: body.messages as Array<Record<string, unknown>>,
      tools: ((body.tools as Array<{ function: { name: string } }> | undefined) ?? []).map((t) => t.function.name),
    };
    calls.push(recorded);
    const entry = script[Math.min(calls.length - 1, script.length - 1)]!;
    const turn = typeof entry === "function" ? entry(recorded) : entry;
    if ("hang" in turn) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
      });
    }
    if ("status" in turn) return new Response(turn.text, { status: turn.status });
    const message =
      "content" in turn
        ? { role: "assistant", content: turn.content }
        : {
            role: "assistant",
            content: "",
            reasoning_content: turn.reasoning ?? "Comparing the candidates.",
            tool_calls: turn.calls.map((c, i) => ({
              id: c.id ?? `call_${calls.length}_${i}`,
              type: "function",
              function: { name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) },
            })),
          };
    return new Response(
      JSON.stringify({
        model: "qwen3.8-max-0925",
        choices: [{ index: 0, message, finish_reason: "content" in turn ? "stop" : "tool_calls" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function router(fetch: typeof globalThis.fetch, opts: { budgetMs?: number; maxTurns?: number; maxToolCalls?: number; thinking?: boolean; toolTimeoutMs?: number } = {}) {
  const client = new RoleClient({ role: "router", preset: resolvePreset("qwen", KEYS), timeoutMs: opts.budgetMs ?? 5_000, fetch });
  return new QwenRouter({
    client,
    maxTurns: opts.maxTurns,
    maxToolCalls: opts.maxToolCalls,
    thinking: opts.thinking,
    toolTimeoutMs: opts.toolTimeoutMs,
    log: () => undefined,
  });
}

function trustSignal(over: Partial<PublicTrustSignal> = {}): PublicTrustSignal {
  return {
    address: ADDR.kimi,
    score: 78,
    band: "high",
    firstSeen: "2025-01-01T00:00:00Z",
    walletAgeDays: 400,
    txCount: 120,
    txCountCapped: false,
    firstFunder: null,
    relatedWalletCount: 1,
    labels: ["Active Trader"],
    riskFlags: [],
    paidTx: [],
    paidUsdc: "0.01",
    source: "nansen",
    mode: "fixture",
    degraded: false,
    fetchedAt: "2026-09-27T00:00:00Z",
    attribution: "Data by Nansen",
    attributionUrl: "https://www.nansen.ai",
    ...over,
  } as PublicTrustSignal;
}

function erc8004Read(over: Partial<Erc8004Read> = {}): Erc8004Read {
  return {
    agentId: "7",
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    ledger: "0x00000000000000000000000000000000000000Aa",
    verifier: "0x00000000000000000000000000000000000000Bb",
    buyerRatings: { count: 5, average: 92 },
    verifierScores: { count: 3, average: 88 },
    agentWallet: ADDR.kimi,
    walletMatchesPayout: true,
    failed: [],
    ...over,
  };
}

/** Every source stubbed with plausible data for the kimi node. */
function stubData(): RouterData & { counts: Record<string, number> } {
  const counts: Record<string, number> = { erc8004: 0, receipts: 0, indexer: 0, trust: 0 };
  return {
    network: NETWORK,
    counts,
    erc8004: async (agentId) => {
      counts.erc8004! += 1;
      return erc8004Read({ agentId });
    },
    receipts: async () => {
      counts.receipts! += 1;
      return {
        source: "indexer",
        ledger: "0x00000000000000000000000000000000000000Aa",
        scanned: 200,
        receipts: 7,
        ok: 6,
        failed: 1,
        earnedUnits: "30000",
        lastAt: 1_790_000_000_000,
        ratings: 2,
        avgRating: 90,
        latest: [{ txHash: `0x${"ab".repeat(32)}`, ok: true, at: 1_790_000_000_000 }],
      };
    },
    indexerStats: async () => {
      counts.indexer! += 1;
      return {
        configured: true,
        found: true,
        jobsTotal: 12,
        jobsOk: 11,
        jobsFailed: 1,
        successRate: 11 / 12,
        earnedUnits: "120000",
        avgDurationMs: 4_000,
        ratingsCount: 4,
        avgRating: 88,
        lastJobAt: 1_790_000_000,
        agent: { feedbackCount: 7, buyerRatingCount: 4, buyerRatingAvg: 88, verifiedCount: 3, verifiedScore: 90 },
      };
    },
    trust: () => {
      counts.trust! += 1;
      return { enabled: true, signal: trustSignal() };
    },
  };
}

/** Qwen's usual shape: list, look at the kimi node four ways at once, pick it. */
const HAPPY_PATH: Turn[] = [
  { calls: [{ name: "list_candidates", args: {} }] },
  {
    calls: [
      { name: "erc8004_reputation", args: { agentId: "7" } },
      { name: "recent_receipts", args: { providerId: "prv_kimi" } },
      { name: "indexer_provider_stats", args: { providerId: "prv_kimi" } },
      { name: "nansen_trust", args: { providerId: "prv_kimi" } },
    ],
  },
  {
    calls: [
      {
        name: "select_provider",
        args: {
          providerId: "prv_kimi",
          reason: "Kimi suits a short writing task, and agent #7 averages 92 from 5 on-chain buyer ratings.",
          difficulty: "easy",
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------

describe("the Qwen router's tool loop", () => {
  it("lists, reads Monad state in parallel, then picks a provider — and records every step", async () => {
    const qwen = scriptedQwen(HAPPY_PATH);
    const data = stubData();
    const routing = await router(qwen.fetch).route(REQUEST, CANDIDATES, data);

    expect(routing).toMatchObject({
      by: "qwen",
      model: "qwen3.8-max-0925",
      providerId: "prv_kimi",
      providerLabel: "kimi node",
      agentId: "7",
      adapter: "kimi",
      reason: "Kimi suits a short writing task, and agent #7 averages 92 from 5 on-chain buyer ratings.",
      difficulty: "easy",
      candidates: 3,
      turns: 3,
      toolCalls: 5,
      thinking: true,
    });
    expect(routing.fallback).toBeUndefined();
    expect(data.counts).toEqual({ erc8004: 1, receipts: 1, indexer: 1, trust: 1 });

    const steps = routing.steps!;
    expect(steps.map((s) => s.tool)).toEqual([
      "list_candidates",
      "erc8004_reputation",
      "recent_receipts",
      "indexer_provider_stats",
      "nansen_trust",
      "select_provider",
    ]);
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(steps[0]!.summary).toBe("listed 3 live options from 3 providers under $0.0500 (echo, qwen, kimi)");
    expect(steps[1]).toMatchObject({ args: { agentId: "7" }, source: "chain" });
    expect(steps[1]!.summary).toBe(
      "read agent #7's ERC-8004 reputation on Monad (avg 92 from 5 buyer ratings; Kimi verifier 88 over 3 scores; agent wallet is the payout address)",
    );
    expect(steps[1]!.links![0]).toEqual({ label: "agent #7", url: explorerAgent(NETWORK, "7") });
    expect(steps[2]!.summary).toBe("checked 7 receipts on XorvLedger via Envio: 6 delivered, 1 failed; 2 buyer ratings, avg 90; earned $0.0300");
    expect(steps[2]!.links![0]).toEqual({ label: "latest receipt", url: explorerTx(NETWORK, `0x${"ab".repeat(32)}`) });
    expect(steps[3]!.summary).toBe("Envio indexer: 12 jobs, 92% delivered, avg rating 88 (4), verified 90, earned $0.1200");
    expect(steps[4]!.summary).toBe("Nansen trust 78 (high) for payout wallet 0xbbbb…000b");
    expect(steps[5]).toMatchObject({ args: { providerId: "prv_kimi", adapter: "kimi" } });
    expect(steps[5]!.summary).toBe("picked kimi node — kimi at $0.0050, agent #7");
    for (const step of steps) expect(step.ms).toBeGreaterThanOrEqual(0);

    // What Qwen was sent: tools, thinking on with a budget, auto tool choice, no JSON mode.
    const first = qwen.calls[0]!;
    expect(first.body).toMatchObject({
      model: "qwen3.8-max",
      tool_choice: "auto",
      enable_thinking: true,
      thinking_budget: 256,
      parallel_tool_calls: true,
      stream: false,
    });
    expect(first.body.response_format).toBeUndefined();
    expect(first.tools).toEqual([
      "list_candidates",
      "erc8004_reputation",
      "recent_receipts",
      "indexer_provider_stats",
      "nansen_trust",
      "select_provider",
    ]);
    expect(first.messages[0]!.content).toMatch(/job router for Xorv/);
    expect(first.messages[1]!.content).toContain("<prompt>\nWrite a haiku about Monad\n</prompt>");
    expect(first.messages[1]!.content).toContain("ceiling is $0.0500; 3 live options are within it");

    // Turn 2 saw the candidate list as a tool result — never the node over the ceiling.
    const second = qwen.calls[1]!;
    const listed = second.messages.find((m) => m.role === "tool")!;
    const list = JSON.parse(String(listed.content)) as { candidates: Array<{ providerId: string }> };
    expect(list.candidates.map((c) => c.providerId)).toEqual(["prv_echo", "prv_qwen", "prv_kimi"]);
    // The history carries the calls and their answers, never the model's thinking.
    const third = qwen.calls[2]!;
    expect(third.messages.filter((m) => m.role === "tool")).toHaveLength(5);
    expect(JSON.stringify(third.messages)).not.toContain("Comparing the candidates");
    const trust = JSON.parse(String(third.messages.at(-1)!.content)) as Record<string, unknown>;
    expect(trust).toMatchObject({ score: 78, band: "high" });
    expect(Object.keys(trust)).not.toContain("smartMoney");
  });

  it("turns thinking off on request, still with tools", async () => {
    const qwen = scriptedQwen(HAPPY_PATH);
    await router(qwen.fetch, { thinking: false }).route(REQUEST, CANDIDATES, stubData());
    expect(qwen.calls[0]!.body).toMatchObject({ enable_thinking: false, tool_choice: "auto" });
    expect(qwen.calls[0]!.body.thinking_budget).toBeUndefined();
  });

  it("gives a made-up pick one more turn, then uses the corrected one", async () => {
    const qwen = scriptedQwen([
      { calls: [{ name: "list_candidates", args: {} }] },
      { calls: [{ name: "select_provider", args: { providerId: "prv_big", reason: "Big job." } }] },
      { calls: [{ name: "select_provider", args: { providerId: "prv_qwen", reason: "Qwen answers in one pass." } }] },
    ]);
    const routing = await router(qwen.fetch).route(REQUEST, CANDIDATES, stubData());
    expect(routing).toMatchObject({ providerId: "prv_qwen", adapter: "qwen", turns: 3 });
    expect(routing.steps!.map((s) => [s.tool, s.ok])).toEqual([
      ["list_candidates", true],
      ["select_provider", false],
      ["select_provider", true],
    ]);
    expect(routing.steps![1]!.args).toEqual({ providerId: NOT_A_CANDIDATE });
    const retry = qwen.calls[2]!.messages.at(-1)!;
    expect(retry.role).toBe("tool");
    expect(String(retry.content)).toMatch(/not a live candidate under the ceiling/);
  });

  it("falls back to the matcher on a pick that stays invalid, without quoting the model", async () => {
    const qwen = scriptedQwen([
      { calls: [{ name: "list_candidates", args: {} }] },
      { calls: [{ name: "select_provider", args: { providerId: `prv_${SECRET}`, reason: `about ${SECRET}` } }] },
    ]);
    const routing = await router(qwen.fetch, { maxTurns: 2 }).route(REQUEST, CANDIDATES, stubData());
    expect(routing).toMatchObject({ providerId: null, adapter: null, fallback: "invalid", difficulty: null, turns: 2 });
    expect(routing.reason).toBe("Qwen 3.8 Max picked a provider that is not a live option within the ceiling — matched on price instead");
    expect(JSON.stringify(routing)).not.toContain(SECRET);
  });

  it("rejects an adapter the chosen provider doesn't offer under the ceiling", async () => {
    const qwen = scriptedQwen([
      { calls: [{ name: "select_provider", args: { providerId: "prv_kimi", adapter: "claude-code", reason: "x" } }] },
      { calls: [{ name: "select_provider", args: { providerId: "prv_kimi", adapter: "KIMI", reason: "ok" } }] },
    ]);
    const routing = await router(qwen.fetch).route(REQUEST, CANDIDATES, stubData());
    expect(routing).toMatchObject({ providerId: "prv_kimi", adapter: "kimi", turns: 2 });
  });

  it("accepts a pick written as JSON in the answer text", async () => {
    const qwen = scriptedQwen([{ content: 'Done. {"providerId": "prv_qwen", "reason": "Qwen fits a quick answer."}' }]);
    const routing = await router(qwen.fetch).route(REQUEST, CANDIDATES, stubData());
    expect(routing).toMatchObject({ providerId: "prv_qwen", adapter: "qwen", turns: 1, toolCalls: 0 });
  });

  it("falls back on a timeout, keeping the steps it managed", async () => {
    const qwen = scriptedQwen([{ calls: [{ name: "list_candidates", args: {} }] }, { hang: true }]);
    const started = Date.now();
    const routing = await router(qwen.fetch, { budgetMs: 150 }).route(REQUEST, CANDIDATES, stubData());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(routing).toMatchObject({ providerId: null, adapter: null, fallback: "timeout" });
    expect(routing.reason).toBe("Qwen 3.8 Max ran out of its 150ms routing budget — matched on price instead");
    expect(routing.steps!.map((s) => s.tool)).toEqual(["list_candidates"]);
  });

  it("gives up on a slow tool at its own timeout and tells the model", async () => {
    const data = stubData();
    data.receipts = () => new Promise(() => undefined);
    const qwen = scriptedQwen([
      { calls: [{ name: "recent_receipts", args: { providerId: "prv_kimi" } }] },
      { calls: [{ name: "select_provider", args: { providerId: "prv_kimi", reason: "ok" } }] },
    ]);
    const routing = await router(qwen.fetch, { toolTimeoutMs: 40 }).route(REQUEST, CANDIDATES, data);
    expect(routing.providerId).toBe("prv_kimi");
    expect(routing.steps![0]).toMatchObject({ tool: "recent_receipts", ok: false, summary: "couldn't read the XorvLedger receipts: timed out after 40ms" });
    expect(String(qwen.calls[1]!.messages.at(-1)!.content)).toMatch(/timed out/);
  });

  it("falls back on a provider error and on a model that never chooses", async () => {
    const down = await router(scriptedQwen([{ status: 503, text: "overloaded" }]).fetch).route(REQUEST, CANDIDATES, stubData());
    expect(down).toMatchObject({ providerId: null, fallback: "error", reason: "Qwen 3.8 Max was unavailable — matched on price instead" });

    const chatty = await router(scriptedQwen([{ content: "Let me think about it." }]).fetch, { maxTurns: 2 }).route(REQUEST, CANDIDATES, stubData());
    expect(chatty).toMatchObject({ fallback: "invalid", turns: 2 });
    expect(chatty.reason).toMatch(/did not choose a provider/);
  });

  it("caps the turns: the last one only offers select_provider, with a nudge", async () => {
    const qwen = scriptedQwen([{ calls: [{ name: "list_candidates", args: {} }] }]);
    const routing = await router(qwen.fetch).route(REQUEST, CANDIDATES, stubData());
    expect(qwen.calls).toHaveLength(4);
    expect(qwen.calls[2]!.tools).toHaveLength(6);
    expect(qwen.calls[3]!.tools).toEqual(["select_provider"]);
    expect(qwen.calls[3]!.messages.filter((m) => m.role === "user").at(-1)!.content).toMatch(/last lookup\. Call select_provider now/);
    // The final turn's list_candidates call is answered too, but the loop is over.
    expect(routing).toMatchObject({ fallback: "invalid", turns: 4, providerId: null });
    expect(routing.reason).toBe("Qwen 3.8 Max used all 4 turns without choosing a provider — matched on price instead");
  });

  it("caps the lookups: calls past the cap are answered without running, then only select_provider is offered", async () => {
    const data = stubData();
    const many: Call[] = Array.from({ length: 8 }, () => ({ name: "nansen_trust", args: { providerId: "prv_kimi" } }));
    const qwen = scriptedQwen([
      { calls: many },
      { calls: [{ name: "select_provider", args: { providerId: "prv_kimi", reason: "trusted wallet" } }] },
    ]);
    const routing = await router(qwen.fetch).route(REQUEST, CANDIDATES, data);
    expect(data.counts.trust).toBe(6);
    expect(routing).toMatchObject({ providerId: "prv_kimi", toolCalls: 6, turns: 2 });
    expect(routing.steps!.filter((s) => s.tool === "nansen_trust")).toHaveLength(6);
    const answers = qwen.calls[1]!.messages.filter((m) => m.role === "tool");
    expect(answers).toHaveLength(8);
    expect(String(answers[7]!.content)).toMatch(/lookup budget spent/);
    expect(qwen.calls[1]!.tools).toEqual(["select_provider"]);
  });

  it("keeps whatever the model writes out of the trace — a private job's prompt included", async () => {
    const qwen = scriptedQwen([
      {
        calls: [
          { name: "erc8004_reputation", args: { agentId: `${SECRET} 7` } },
          { name: "recent_receipts", args: { providerId: SECRET } },
          { name: "list_candidates", args: { adapter: SECRET } },
          { name: "no_such_tool", args: { note: SECRET } },
        ],
      },
      { calls: [{ name: "select_provider", args: { providerId: "prv_kimi", reason: `The ${SECRET} memo suits Kimi.` } }] },
    ]);
    const routing = await router(qwen.fetch).route(
      { prompt: `Draft the confidential memo about ${SECRET}`, maxPriceUsdMicros: 50_000, encryptTo: "x".repeat(43) },
      CANDIDATES,
      stubData(),
    );
    // The buyer's own quote carries the model's reason (public.ts withholds it on a private job)…
    expect(routing.reason).toContain(SECRET);
    // …but the trace is only validated ids and the broker's own summaries.
    expect(JSON.stringify(routing.steps)).not.toContain(SECRET);
    expect(routing.steps![0]).toMatchObject({ args: { agentId: NOT_A_CANDIDATE }, ok: false });
    expect(routing.steps![1]).toMatchObject({ args: { providerId: NOT_A_CANDIDATE }, ok: false });
    expect(routing.steps![2]).toMatchObject({ args: { adapter: NOT_A_CANDIDATE } });
  });

  it("with nothing to choose from under the ceiling, falls back without calling the model", async () => {
    const qwen = scriptedQwen(HAPPY_PATH);
    const routing = await router(qwen.fetch).route({ prompt: "p", maxPriceUsdMicros: 500 }, CANDIDATES, stubData());
    expect(routing).toMatchObject({ fallback: "invalid", candidates: 0 });
    expect(qwen.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("the router's tools", () => {
  const ctx = (data: RouterData | null, over: Partial<ToolContextForTest> = {}): ToolContextForTest => ({
    network: NETWORK,
    request: REQUEST,
    candidates: CANDIDATES.slice(0, 3),
    data,
    timeoutMs: 1_000,
    ...over,
  });

  it("erc8004_reputation says when the agent wallet isn't the payee, and when there's nothing on-chain yet", async () => {
    const data: RouterData = {
      network: NETWORK,
      erc8004: async () =>
        erc8004Read({ buyerRatings: { count: 0, average: null }, verifierScores: null, verifier: null, agentWallet: ADDR.echo, walletMatchesPayout: false }),
    };
    const out = await runReadTool("erc8004_reputation", '{"agentId":7}', ctx(data));
    expect(out.step.summary).toBe("read agent #7's ERC-8004 reputation on Monad (no buyer ratings yet; agent wallet is NOT the payout address)");
    expect(out.result).toMatchObject({ agentId: "7", agentWalletIsPayout: false, verifierScores: null });

    const none = await runReadTool("erc8004_reputation", '{"agentId":"7"}', ctx({ network: NETWORK }));
    expect(none.step).toMatchObject({ ok: false, summary: "couldn't read agent #7's ERC-8004 reputation: no chain reader" });

    const stranger = await runReadTool("erc8004_reputation", '{"agentId":"99"}', ctx(data));
    expect(stranger.step).toMatchObject({ ok: false, args: { agentId: NOT_A_CANDIDATE } });
    expect(stranger.result.error).toMatch(/not one of the candidates/);
  });

  it("indexer_provider_stats says when no indexer is configured, and when the provider isn't indexed", async () => {
    const off = await runReadTool("indexer_provider_stats", '{"providerId":"prv_kimi"}', ctx({ network: NETWORK, indexerStats: async () => ({ configured: false }) }));
    expect(off.step.summary).toBe("no Envio indexer configured on this broker");
    expect(off.result).toMatchObject({ indexed: false });
    expect(String(off.result.note)).toMatch(/XORV_INDEXER_URL/);

    const missing = await runReadTool(
      "indexer_provider_stats",
      '{"providerId":"prv_kimi"}',
      ctx({ network: NETWORK, indexerStats: async () => ({ configured: true, found: false }) }),
    );
    expect(missing.step).toMatchObject({ ok: true, source: "indexer", summary: "not in the Envio index yet (no registration indexed)" });
  });

  it("recent_receipts and nansen_trust say when their source is missing", async () => {
    const noLedger = await runReadTool(
      "recent_receipts",
      '{"providerId":"prv_kimi"}',
      ctx({
        network: NETWORK,
        receipts: async () => ({ source: "none", ledger: null, scanned: 0, receipts: 0, ok: 0, failed: 0, earnedUnits: "0", lastAt: null, ratings: 0, avgRating: null, latest: [] }),
      }),
    );
    expect(noLedger.step.summary).toBe("no XorvLedger configured on this broker, so no receipts to check");

    const off = await runReadTool("nansen_trust", '{"providerId":"prv_kimi"}', ctx({ network: NETWORK, trust: () => ({ enabled: false, signal: null }) }));
    expect(off.step.summary).toBe("Nansen trust signals are off on this broker");
    const pending = await runReadTool("nansen_trust", '{"providerId":"prv_kimi"}', ctx({ network: NETWORK, trust: () => ({ enabled: true, signal: null }) }));
    expect(pending.step.summary).toBe("no Nansen signal yet for payout wallet 0xbbbb…000b");
    const flagged = await runReadTool(
      "nansen_trust",
      '{"providerId":"prv_kimi"}',
      ctx({ network: NETWORK, trust: () => ({ enabled: true, signal: trustSignal({ score: 31, band: "low", riskFlags: ["fresh-wallet"] }) }) }),
    );
    expect(flagged.step.summary).toBe("Nansen trust 31 (low) for payout wallet 0xbbbb…000b; flags: fresh-wallet");
  });

  it("list_candidates filters by adapter and caps its rows", async () => {
    const many = Array.from({ length: 20 }, (_, i) => candidate({ providerId: `prv_${i}`, adapter: i % 2 ? "kimi" : "qwen" }));
    const all = await runReadTool("list_candidates", "{}", ctx(null, { candidates: many }));
    expect(all.result).toMatchObject({ count: 20, shown: 12 });
    const kimi = await runReadTool("list_candidates", '{"adapter":"kimi"}', ctx(null, { candidates: many }));
    expect(kimi.result).toMatchObject({ count: 10, shown: 10 });
    expect(kimi.step.args).toEqual({ adapter: "kimi" });
  });

  it("a failing source is a failed step, not a thrown route", async () => {
    const out = await runReadTool(
      "indexer_provider_stats",
      '{"providerId":"prv_kimi"}',
      ctx({ network: NETWORK, indexerStats: async () => Promise.reject(new Error("indexer HTTP 502 at https://secret-host")) }),
    );
    expect(out.step).toMatchObject({ ok: false, summary: "couldn't read the Envio indexer stats: the source failed" });
    expect(JSON.stringify(out)).not.toContain("secret-host");
  });
});

// ---------------------------------------------------------------------------

describe("the router's data sources", () => {
  const LEDGER = "0x00000000000000000000000000000000000000Aa";
  const VERIFIER = "0x00000000000000000000000000000000000000Bb";
  const receipt = (over: Record<string, unknown>, txByte: string): LedgerEvent =>
    ({
      kind: "receipts",
      id: `1:${txByte}`,
      blockNumber: 1,
      txHash: `0x${txByte.repeat(32)}`,
      at: 1_790_000_000_000,
      data: { jobId: `0x${txByte.repeat(32)}`, agentId: null, buyer: ADDR.echo, payTo: ADDR.kimi, amount: "5000", paymentTx: "0x1", requestHash: "0x", resultHash: "0x", durationMs: 10, ok: true, ...over },
    }) as LedgerEvent;

  it("reads ERC-8004 through getSummary for XorvLedger and the verifier, plus the agent wallet", async () => {
    const summaries: Array<[string, string[], string]> = [];
    const data = createRouterData({
      network: NETWORK,
      ledgerAddress: LEDGER,
      verifierAddress: () => VERIFIER,
      reader: null,
      indexer: null,
      agentWallet: async () => ADDR.kimi.toUpperCase().replace("0X", "0x"),
      reputationSummary: async (agentId, clients, tag1): Promise<ReputationSummary> => {
        summaries.push([agentId, clients, tag1]);
        return tag1 === "starred"
          ? { count: 5, summaryValue: "92", summaryValueDecimals: 0, average: 92 }
          : { count: 3, summaryValue: "8800", summaryValueDecimals: 2, average: 88 };
      },
    });
    const read = await data.erc8004!("7", ADDR.kimi);
    expect(summaries).toEqual([
      ["7", [LEDGER], "starred"],
      ["7", [VERIFIER], "xorv-verified"],
    ]);
    expect(read).toMatchObject({ buyerRatings: { count: 5, average: 92 }, verifierScores: { count: 3, average: 88 }, walletMatchesPayout: true, failed: [] });
    // Cached: a second read within the window costs nothing.
    await data.erc8004!("7", ADDR.kimi);
    expect(summaries).toHaveLength(2);
  });

  it("reports partial ERC-8004 failures, and fails the read when nothing answers", async () => {
    const partial = createRouterData({
      network: NETWORK,
      ledgerAddress: LEDGER,
      reader: null,
      indexer: null,
      agentWallet: async () => Promise.reject(new Error("rpc down")),
      reputationSummary: async () => ({ count: 0, summaryValue: "0", summaryValueDecimals: 0, average: null }),
    });
    expect(await partial.erc8004!("7", ADDR.kimi)).toMatchObject({ failed: ["agent wallet"], verifierScores: null, buyerRatings: { count: 0 } });

    const dead = createRouterData({
      network: NETWORK,
      ledgerAddress: LEDGER,
      reader: null,
      indexer: null,
      agentWallet: async () => Promise.reject(new Error("rpc down")),
      reputationSummary: async () => Promise.reject(new Error("rpc down")),
    });
    await expect(dead.erc8004!("7", ADDR.kimi)).rejects.toThrow(/ERC-8004 reads failed/);
  });

  it("finds a provider's receipts by payee or agent, and joins the ratings on them", async () => {
    const reader: LedgerReader = {
      async events(kind) {
        if (kind === "receipts") {
          return {
            source: "indexer",
            events: [
              receipt({}, "a1"),
              receipt({ ok: false, amount: "5000" }, "a2"),
              receipt({ payTo: ADDR.echo }, "a3"),
              receipt({ payTo: ADDR.qwen, agentId: "7" }, "a4"),
              receipt({ paymentTx: null }, "a5"),
            ],
          };
        }
        return {
          source: "indexer",
          events: [
            { kind: "ratings", id: "r1", blockNumber: 0, txHash: "0x", at: 0, data: { jobId: `0x${"a1".repeat(32)}`, agentId: "3", buyer: ADDR.echo, value: 80, feedbackHash: "0x" } },
            { kind: "ratings", id: "r2", blockNumber: 0, txHash: "0x", at: 0, data: { jobId: `0x${"ff".repeat(32)}`, agentId: "7", buyer: ADDR.echo, value: 100, feedbackHash: "0x" } },
            { kind: "ratings", id: "r3", blockNumber: 0, txHash: "0x", at: 0, data: { jobId: `0x${"a3".repeat(32)}`, agentId: "9", buyer: ADDR.echo, value: 10, feedbackHash: "0x" } },
          ],
        } as never;
      },
      async leaderboard() {
        return null;
      },
    };
    const data = createRouterData({ network: NETWORK, ledgerAddress: LEDGER, reader, indexer: null });
    const read = await data.receipts!({ providerId: "prv_kimi", address: ADDR.kimi, agentId: "7" });
    expect(read).toMatchObject({
      source: "indexer",
      scanned: 5,
      receipts: 4,
      ok: 3,
      failed: 1,
      // a1 and a4 are paid and delivered; a5 was recorded unpaid.
      earnedUnits: "10000",
      ratings: 2,
      avgRating: 90,
    });
    expect(read.latest.map((l) => l.txHash)).toEqual([`0x${"a1".repeat(32)}`, `0x${"a2".repeat(32)}`, `0x${"a4".repeat(32)}`]);
  });

  it("asks the indexer for the provider by its on-chain id, and says so when there is no indexer", async () => {
    const bodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchStub = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          data: {
            Provider_by_pk: {
              id: providerIdHash("prv_kimi").toLowerCase(),
              jobsTotal: 12,
              jobsOk: 11,
              jobsFailed: 1,
              successRate: "0.9166",
              earnedUsdc: "120000",
              avgDurationMs: 4000,
              ratingsCount: 4,
              avgRating: 88,
              lastJobAt: 1_790_000_000,
              agent: { feedbackCount: 7, buyerRatingCount: 4, buyerRatingAvg: "88", verifiedCount: 3, verifiedScore: 90 },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const data = createRouterData({ network: NETWORK, ledgerAddress: null, reader: null, indexer: { url: "http://indexer.test/v1/graphql", fetch: fetchStub } });
    const read = await data.indexerStats!("prv_kimi");
    expect(bodies[0]!.variables).toEqual({ id: providerIdHash("prv_kimi").toLowerCase() });
    expect(bodies[0]!.query).toMatch(/Provider_by_pk/);
    expect(read).toMatchObject({ configured: true, found: true, jobsTotal: 12, successRate: 0.9166, earnedUnits: "120000", agent: { verifiedScore: 90 } });

    const none = createRouterData({ network: NETWORK, ledgerAddress: null, reader: null, indexer: null });
    expect(await none.indexerStats!("prv_kimi")).toEqual({ configured: false });
  });
});

// ---------------------------------------------------------------------------

describe("reputation for the matcher", () => {
  it("shrinks a thin record toward neutral and has no opinion without one", () => {
    expect(REPUTATION_PRIOR).toEqual({ value: 50, weight: 3 });
    expect(reputationScore(null)).toBeNull();
    expect(reputationScore({ avgRating: null, ratings: 0, avgVerified: null, verified: 0, source: "memory" })).toBeNull();
    expect(reputationScore({ avgRating: 100, ratings: 1, avgVerified: null, verified: 0, source: "memory" })).toBe(62.5);
    expect(reputationScore({ avgRating: 90, ratings: 5, avgVerified: 90, verified: 5, source: "indexer" })).toBeCloseTo(80.77, 1);
  });

  it("uses the Envio indexer when it knows the provider, and memory until then", async () => {
    const jobs = [
      { providerId: "prv_a", rating: { value: 40 } },
      { providerId: "prv_a", verification: { score: 60 } },
      { providerId: "prv_b", rating: { value: 90 } },
    ];
    const queries: Array<Record<string, unknown>> = [];
    const fetchStub = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: Record<string, unknown> };
      queries.push(body.variables);
      return new Response(
        JSON.stringify({
          data: {
            Provider: [
              { id: providerIdHash("prv_a").toLowerCase(), ratingsCount: 10, avgRating: "95", agent: { verifiedCount: 10, verifiedScore: 93 } },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const book = new ReputationBook({ indexer: { url: "http://indexer.test", fetch: fetchStub }, jobs: () => jobs });
    // First look: memory, and a background refresh starts.
    expect(book.entry("prv_a")).toMatchObject({ source: "memory", ratings: 1, avgRating: 40, verified: 1, avgVerified: 60 });
    expect(book.entry("prv_b")).toMatchObject({ source: "memory" });
    // The refresh the first look started only knew prv_a; the next covers every provider asked about.
    await book.refresh();
    expect(queries[0]!.ids).toEqual([providerIdHash("prv_a").toLowerCase()]);
    await book.refresh();
    expect(queries.at(-1)!.ids).toEqual([providerIdHash("prv_a").toLowerCase(), providerIdHash("prv_b").toLowerCase()]);
    expect(book.entry("prv_a")).toMatchObject({ source: "indexer", ratings: 10, avgRating: 95, verified: 10, avgVerified: 93 });
    // The indexer has no row for prv_b: memory still answers for it.
    expect(book.entry("prv_b")).toMatchObject({ source: "memory", avgRating: 90 });
    expect(book.status()).toMatchObject({ source: "indexer", indexedProviders: 1, lastError: null });
  });

  it("keeps answering from memory while the indexer is down", async () => {
    const log = vi.fn();
    const book = new ReputationBook({
      indexer: { url: "http://indexer.test", fetch: (async () => new Response("down", { status: 502 })) as unknown as typeof fetch },
      jobs: () => [{ providerId: "prv_a", rating: { value: 70 } }],
      log,
    });
    book.entry("prv_a");
    await book.refresh();
    expect(book.entry("prv_a")).toMatchObject({ source: "memory", avgRating: 70 });
    expect(book.status().lastError).toMatch(/indexer HTTP 502/);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("breaks a price tie toward the better-rated provider, but never beats a cheaper one", () => {
    const registry = new Registry();
    const register = (nodeId: string, price: number) =>
      registry.register({
        label: nodeId,
        address: `0x${nodeId.padStart(40, "0")}`,
        agentId: null,
        endpoint: "http://localhost:1",
        capabilities: [{ id: "kimi", adapter: "kimi", displayName: "Kimi", model: null, priceUsdMicros: price, maxConcurrency: 1 }],
        version: "0.2.0",
        nodeId,
      });
    const a = register("aaaa", 5_000);
    const b = register("bbbb", 5_000);
    const cheap = register("cccc", 4_000);
    const scores = new Map<string, number | null>([
      [a.id, null],
      [b.id, 90],
      [cheap.id, 5],
    ]);
    registry.setReputationScorer((p) => scores.get(p.id) ?? null);
    expect(registry.candidates({ maxPriceUsdMicros: 10_000 }).map((m) => m.provider.id)).toEqual([cheap.id, b.id, a.id]);
    // Flip the reputations and the tie flips with them.
    scores.set(a.id, 90);
    scores.set(b.id, 20);
    expect(registry.candidates({ maxPriceUsdMicros: 10_000 }).map((m) => m.provider.id)).toEqual([cheap.id, a.id, b.id]);
  });
});
