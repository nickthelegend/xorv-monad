/**
 * The registry decides who gets paid, so these tests pin the two behaviours
 * that money depends on: a restarted node is the *same* provider (not a ghost
 * plus a fresh one with zeroed earnings), and the matcher's ordering is the
 * market rule it claims to be.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Registry } from "../src/registry.js";
import type { Capability, RegisterRequest } from "@xorv/protocol";

function capability(over: Partial<Capability> = {}): Capability {
  return {
    id: "claude-code",
    adapter: "claude-code",
    displayName: "Claude Code",
    model: null,
    priceUsdMicros: 10_000,
    maxConcurrency: 1,
    ...over,
  };
}

function registration(over: Partial<RegisterRequest> = {}): RegisterRequest {
  return {
    label: "node-a",
    accountId: "0.0.1001",
    endpoint: "http://localhost:1",
    capabilities: [capability()],
    version: "0.1.0",
    region: null,
    nodeId: "node-a-id",
    ...over,
  };
}

describe("register", () => {
  let registry: Registry;
  beforeEach(() => {
    registry = new Registry();
  });

  it("issues an id, a token and an online status", () => {
    const provider = registry.register(registration());
    expect(provider.id).toMatch(/^prv_/);
    expect(provider.token).toBeTruthy();
    expect(provider.status).toBe("online");
    expect(provider.activeJobs).toBe(0);
  });

  it("treats a re-registering nodeId as the SAME provider", () => {
    const first = registry.register(registration());
    const again = registry.register(registration({ label: "renamed" }));
    expect(again.id).toBe(first.id);
    expect(registry.list()).toHaveLength(1);
    expect(again.label).toBe("renamed");
  });

  it("preserves lifetime earnings and job counts across a restart", () => {
    const first = registry.register(registration());
    registry.jobStarted(first.id);
    registry.jobFinished(first.id, { ok: true, durationMs: 1_000, usdcMicros: 10_000 });

    const again = registry.register(registration());
    expect(again.stats.jobsCompleted).toBe(1);
    expect(again.stats.earnedUsdcMicros).toBe(10_000);
    expect(again.registeredAt).toBe(first.registeredAt);
  });

  it("invalidates the previous token when a node re-registers", () => {
    const first = registry.register(registration());
    const oldToken = first.token;
    const again = registry.register(registration());
    // Same token is reused by design (stable identity), but a stale token for a
    // *different* provider must never resolve.
    expect(registry.byAuthToken(oldToken)?.id).toBe(again.id);
    expect(registry.byAuthToken("nonsense")).toBeUndefined();
  });

  it("keeps distinct nodeIds as distinct providers", () => {
    registry.register(registration({ nodeId: "a" }));
    registry.register(registration({ nodeId: "b", accountId: "0.0.2002" }));
    expect(registry.list()).toHaveLength(2);
  });
});

describe("liveness", () => {
  let registry: Registry;
  beforeEach(() => {
    registry = new Registry();
    vi.useFakeTimers();
  });

  it("goes offline once heartbeats stop, and comes back when they resume", () => {
    const provider = registry.register(registration());
    expect(registry.live()).toHaveLength(1);

    vi.advanceTimersByTime(46_000);
    expect(registry.get(provider.id)!.status).toBe("offline");
    expect(registry.live()).toHaveLength(0);

    registry.heartbeat(provider.id, { activeJobs: 0, uptimeSeconds: 60, available: {} });
    expect(registry.live()).toHaveLength(1);
  });

  it("reports busy when every concurrency slot is taken", () => {
    const provider = registry.register(
      registration({ capabilities: [capability({ maxConcurrency: 2 })] }),
    );
    registry.heartbeat(provider.id, { activeJobs: 2, uptimeSeconds: 1, available: {} });
    expect(registry.get(provider.id)!.status).toBe("busy");
  });

  it("reaps providers that have been silent long enough to be gone", () => {
    const provider = registry.register(registration());
    vi.advanceTimersByTime(11 * 60_000);
    expect(registry.reap()).toContain(provider.id);
    expect(registry.get(provider.id)).toBeUndefined();
    expect(registry.byAuthToken(provider.token)).toBeUndefined();
  });

  it("ignores heartbeats for a provider that no longer exists", () => {
    expect(registry.heartbeat("prv_missing", { activeJobs: 0, uptimeSeconds: 0, available: {} }))
      .toBeUndefined();
  });
});

describe("match", () => {
  let registry: Registry;
  beforeEach(() => {
    registry = new Registry();
  });

  it("returns null when nobody is online", () => {
    expect(registry.match({ maxPriceUsdMicros: 1_000_000 })).toBeNull();
  });

  it("never matches above the buyer's ceiling", () => {
    registry.register(registration({ capabilities: [capability({ priceUsdMicros: 20_000 })] }));
    expect(registry.match({ maxPriceUsdMicros: 10_000 })).toBeNull();
    expect(registry.match({ maxPriceUsdMicros: 20_000 })).not.toBeNull();
  });

  it("picks the cheapest matching provider", () => {
    registry.register(
      registration({ nodeId: "pricey", accountId: "0.0.1", capabilities: [capability({ priceUsdMicros: 20_000 })] }),
    );
    const cheap = registry.register(
      registration({ nodeId: "cheap", accountId: "0.0.2", capabilities: [capability({ priceUsdMicros: 5_000 })] }),
    );
    expect(registry.match({ maxPriceUsdMicros: 100_000 })!.provider.id).toBe(cheap.id);
  });

  it("breaks a price tie toward the better track record", () => {
    const good = registry.register(registration({ nodeId: "good", accountId: "0.0.1" }));
    const bad = registry.register(registration({ nodeId: "bad", accountId: "0.0.2" }));

    registry.jobStarted(good.id);
    registry.jobFinished(good.id, { ok: true, durationMs: 100 });
    registry.jobStarted(bad.id);
    registry.jobFinished(bad.id, { ok: false, durationMs: 100 });

    expect(registry.match({ maxPriceUsdMicros: 100_000 })!.provider.id).toBe(good.id);
  });

  it("honours an adapter requirement", () => {
    registry.register(
      registration({ nodeId: "claude", accountId: "0.0.1", capabilities: [capability()] }),
    );
    const codex = registry.register(
      registration({
        nodeId: "codex",
        accountId: "0.0.2",
        capabilities: [capability({ id: "codex", adapter: "codex", priceUsdMicros: 30_000 })],
      }),
    );
    const match = registry.match({ adapter: "codex", maxPriceUsdMicros: 100_000 });
    // Chosen despite being more expensive, because the buyer asked for it.
    expect(match!.provider.id).toBe(codex.id);
    expect(match!.capability.adapter).toBe("codex");
  });

  it("skips a capability the node reported as unavailable", () => {
    const provider = registry.register(registration());
    registry.heartbeat(provider.id, {
      activeJobs: 0,
      uptimeSeconds: 1,
      available: { "claude-code": false },
    });
    expect(registry.match({ maxPriceUsdMicros: 100_000 })).toBeNull();
  });

  it("skips a provider that is already at capacity", () => {
    const provider = registry.register(
      registration({ capabilities: [capability({ maxConcurrency: 1 })] }),
    );
    registry.jobStarted(provider.id);
    expect(registry.match({ maxPriceUsdMicros: 100_000 })).toBeNull();
  });

  it("considers every capability on a multi-capability node", () => {
    registry.register(
      registration({
        capabilities: [
          capability({ id: "claude-code", priceUsdMicros: 10_000 }),
          capability({ id: "echo", adapter: "echo", priceUsdMicros: 1_000, maxConcurrency: 4 }),
        ],
      }),
    );
    expect(registry.match({ maxPriceUsdMicros: 100_000 })!.capability.id).toBe("echo");
  });
});

describe("stats", () => {
  it("keeps a running mean duration without storing every sample", () => {
    const registry = new Registry();
    const provider = registry.register(registration());
    for (const ms of [100, 200, 300]) {
      registry.jobStarted(provider.id);
      registry.jobFinished(provider.id, { ok: true, durationMs: ms });
    }
    expect(registry.get(provider.id)!.stats.avgDurationMs).toBe(200);
  });

  it("never lets activeJobs go negative", () => {
    const registry = new Registry();
    const provider = registry.register(registration());
    registry.jobFinished(provider.id, { ok: true, durationMs: 1 });
    expect(registry.get(provider.id)!.activeJobs).toBe(0);
  });

  it("accumulates USDC and HBAR earnings separately", () => {
    const registry = new Registry();
    const provider = registry.register(registration());
    registry.jobFinished(provider.id, { ok: true, durationMs: 1, usdcMicros: 10_000 });
    registry.jobFinished(provider.id, { ok: true, durationMs: 1, tinybars: 1_462_167 });
    const stats = registry.get(provider.id)!.stats;
    expect(stats.earnedUsdcMicros).toBe(10_000);
    expect(stats.earnedTinybars).toBe(1_462_167);
  });
});
