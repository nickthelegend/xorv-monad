import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NetworkInfo } from "@xorv/protocol/web";
import {
  aiRoles,
  describeLatency,
  describeRouting,
  describeScreening,
  describeTrace,
  roleLabel,
  routingTrace,
  safeLink,
} from "@/lib/ai";
import { RoutingTrace } from "@/components/routing-trace";

function info(over: Record<string, unknown>): NetworkInfo {
  return { ai: { router: null, screener: null, verifier: null }, ...over } as unknown as NetworkInfo;
}

describe("aiRoles", () => {
  it("uses the broker's full report when it sends one", () => {
    const report = {
      screener: { enabled: true, provider: "hunyuan", label: "Hunyuan hy4", model: "hy4-preview", timeoutMs: 5000, reason: null, stats: null, failMode: "open" },
      router: { enabled: false, provider: "qwen", label: "Qwen 3.8 Max", model: "qwen3.8-max", timeoutMs: 6000, reason: "no API key — set DASHSCOPE_API_KEY", stats: null },
      verifier: { enabled: true, provider: "kimi", label: "Kimi K3", model: "kimi-k3", timeoutMs: 20000, reason: null, stats: null },
    };
    const roles = aiRoles(info({ aiRoles: report }));
    expect(roles.router).toMatchObject({ enabled: false, reason: "no API key — set DASHSCOPE_API_KEY" });
    expect(roles.screener).toMatchObject({ enabled: true, failMode: "open" });
  });

  it("falls back to the protocol's ai block from an older broker", () => {
    const roles = aiRoles(info({ ai: { router: { by: "qwen", model: "qwen3.8-max-0902" }, screener: null, verifier: null } }));
    expect(roles.router).toMatchObject({ enabled: true, label: "Qwen 3.8 Max", model: "qwen3.8-max-0902" });
    expect(roles.verifier).toMatchObject({ enabled: false, label: "Kimi K3", model: "kimi-k3" });
  });
});

describe("the quote's AI lines", () => {
  it("names the router and its pick, or says it fell back to price", () => {
    expect(
      describeRouting({ by: "qwen", model: "qwen3.8-max", adapter: "kimi", reason: "A short writing task.", difficulty: "easy" }),
    ).toBe("Routed by Qwen 3.8 Max to kimi (easy): A short writing task.");
    expect(
      describeRouting({
        by: "qwen",
        model: "qwen3.8-max",
        adapter: null,
        reason: "Qwen 3.8 Max timed out after 6000ms — matched on price instead",
        fallback: "timeout",
      }),
    ).toBe("Qwen 3.8 Max: Qwen 3.8 Max timed out after 6000ms — matched on price instead");
  });

  it("says who screened the prompt, and never dresses an unscreened prompt up as allowed", () => {
    expect(describeScreening({ by: "hunyuan", model: "hy4-preview", verdict: "allow", reason: "Ordinary task." })).toBe(
      "Screened by Hunyuan hy4: allowed — Ordinary task.",
    );
    expect(
      describeScreening({
        by: "hunyuan",
        model: "hy4-preview",
        verdict: "allow",
        reason: "not screened: Hunyuan hy4 timed out after 5000ms; allowed because XORV_SCREENER_FAIL=open",
        unavailable: true,
      }),
    ).toMatch(/^Hunyuan hy4: not screened/);
  });

  it("labels roles and latency for the network page", () => {
    expect(roleLabel({ by: "qwen", model: "qwen3.8-max", label: "Qwen 3.8 Max" })).toBe("Qwen 3.8 Max");
    expect(roleLabel({ by: "kimi", model: "kimi-k3" })).toBe("Kimi K3");
    expect(roleLabel(null)).toBeNull();
    expect(describeLatency(null)).toBeNull();
    expect(describeLatency({ calls: 3, ok: 2, failed: 1, timeouts: 1, lastMs: 9, avgMs: 1234, lastError: null })).toBe(
      "1.2 s avg · 3 calls · 1 failed",
    );
  });
});

/** A routing record as the agent router leaves it on a quote and a job. */
const AGENT_ROUTING = {
  by: "qwen",
  model: "qwen3.8-max",
  adapter: "kimi" as const,
  providerId: "prv_kimi",
  providerLabel: "kimi node",
  agentId: "7",
  reason: "Kimi suits a short writing task, and agent #7 averages 92 from 5 on-chain buyer ratings.",
  difficulty: "easy",
  ms: 2_430,
  turns: 3,
  toolCalls: 3,
  thinking: true,
  candidates: 3,
  steps: [
    { tool: "list_candidates", args: {}, summary: "listed 3 live options from 3 providers under $0.0500 (echo, qwen, kimi)", ms: 0, ok: true },
    {
      tool: "erc8004_reputation",
      args: { agentId: "7" },
      summary: "read agent #7's ERC-8004 reputation on Monad (avg 92 from 5 buyer ratings; agent wallet is the payout address)",
      ms: 412,
      ok: true,
      links: [
        { label: "agent #7", url: "https://testnet.monadvision.com/nft/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/7" },
        { label: "evil", url: "javascript:alert(1)" },
      ],
    },
    {
      tool: "recent_receipts",
      args: { providerId: "prv_kimi" },
      summary: "checked 7 receipts on XorvLedger via Envio: 6 delivered, 1 failed",
      ms: 95,
      ok: true,
      links: [{ label: "latest receipt", url: `https://testnet.monadvision.com/tx/0x${"ab".repeat(32)}` }],
    },
    { tool: "nansen_trust", args: { providerId: "prv_kimi" }, summary: "couldn't read the Nansen trust signal: timed out after 3000ms", ms: 3_000, ok: false },
    { tool: "select_provider", args: { providerId: "prv_kimi", adapter: "kimi" }, summary: "picked kimi node — kimi at $0.0050, agent #7", ms: 0, ok: true },
  ],
};

describe("the router's agent trace", () => {
  it("names the provider the agent router picked", () => {
    expect(describeRouting(AGENT_ROUTING)).toBe(
      "Routed by Qwen 3.8 Max to kimi node (kimi, easy): Kimi suits a short writing task, and agent #7 averages 92 from 5 on-chain buyer ratings.",
    );
  });

  it("reads the trace defensively and keeps only http(s) links", () => {
    const trace = routingTrace(AGENT_ROUTING)!;
    expect(trace.steps.map((s) => s.label)).toEqual([
      "Candidates",
      "ERC-8004 reputation",
      "XorvLedger receipts",
      "Nansen trust",
      "Decision",
    ]);
    expect(trace.steps[1]!.links).toEqual([
      { label: "agent #7", url: "https://testnet.monadvision.com/nft/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/7" },
    ]);
    expect(trace.steps[3]!.ok).toBe(false);
    expect(describeTrace(trace)).toBe("3 lookups in 3 turns · 2.4 s · thinking on");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("/relative")).toBeNull();
    // An older broker's record, or a router that didn't run: nothing to show.
    expect(routingTrace({ by: "qwen", model: "m", adapter: "kimi", reason: "r" })).toBeNull();
    expect(routingTrace(null)).toBeNull();
    expect(routingTrace({ steps: [{ tool: 7 }, "junk"] })).toBeNull();
  });

  it("renders every lookup with its summary, timing and explorer links", () => {
    const html = renderToStaticMarkup(createElement(RoutingTrace, { routing: AGENT_ROUTING }));
    expect(html).toContain("How Qwen 3.8 Max chose");
    expect(html).toContain("3 lookups in 3 turns · 2.4 s · thinking on");
    expect(html).toContain("read agent #7&#x27;s ERC-8004 reputation on Monad (avg 92 from 5 buyer ratings; agent wallet is the payout address)");
    expect(html).toContain("checked 7 receipts on XorvLedger via Envio");
    expect(html).toContain('href="https://testnet.monadvision.com/nft/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/7"');
    expect(html).toContain(`href="https://testnet.monadvision.com/tx/0x${"ab".repeat(32)}"`);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("412 ms");
    expect(html).toContain("picked kimi node");
    expect(html.match(/<li/g)).toHaveLength(5);

    const fallback = renderToStaticMarkup(
      createElement(RoutingTrace, { routing: { ...AGENT_ROUTING, adapter: null, fallback: "timeout", steps: AGENT_ROUTING.steps.slice(0, 2) } }),
    );
    expect(fallback).toContain("wasn’t used (timeout); the matcher chose on price, then reputation");
    expect(renderToStaticMarkup(createElement(RoutingTrace, { routing: { by: "qwen", adapter: "kimi" } }))).toBe("");
  });
});
