import { describe, expect, it } from "vitest";
import type { NetworkInfo } from "@xorv/protocol/web";
import { aiRoles, describeLatency, describeRouting, describeScreening, roleLabel } from "@/lib/ai";

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
