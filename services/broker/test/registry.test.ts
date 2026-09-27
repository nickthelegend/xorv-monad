/**
 * The registry decides who gets paid, so these tests pin the two behaviours
 * that money depends on: a restarted node is the *same* provider (not a ghost
 * plus a fresh one with zeroed earnings), and the matcher's ordering is the
 * market rule it claims to be.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Registry, RegistrationRefused, providerIdFor, type VerifiedRegistration } from "../src/registry.js";
import type { Capability } from "@xorv/protocol";

/** A distinct, valid payout address per small integer. */
function addr(n: number): string {
  return `0x${n.toString(16).padStart(40, "0")}`;
}

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

function registration(over: Partial<VerifiedRegistration> = {}): VerifiedRegistration {
  return {
    label: "node-a",
    address: addr(1001),
    agentId: null,
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
    const again = registry.register(registration({ label: "renamed" }), { token: first.token });
    expect(again.id).toBe(first.id);
    expect(registry.list()).toHaveLength(1);
    expect(again.label).toBe("renamed");
  });

  it("preserves lifetime earnings and job counts across a restart", () => {
    const first = registry.register(registration());
    registry.jobStarted(first.id);
    registry.jobFinished(first.id, { ok: true, durationMs: 1_000, usdcMicros: 10_000 });

    const again = registry.register(registration(), { token: first.token });
    expect(again.stats.jobsCompleted).toBe(1);
    expect(again.stats.earnedUsdcMicros).toBe(10_000);
    expect(again.registeredAt).toBe(first.registeredAt);
  });

  it("keeps the token for a node that presents it, and a stale token never resolves", () => {
    const first = registry.register(registration());
    const again = registry.registerNode(registration(), { token: first.token });
    expect(again.authenticated).toBe(true);
    expect(again.provider.token).toBe(first.token);
    expect(registry.byAuthToken(first.token)?.id).toBe(first.id);
    expect(registry.byAuthToken("nonsense")).toBeUndefined();
  });

  it("refuses the node id alone while its session is live, and never returns its token", () => {
    const first = registry.register(registration());
    // No token, or someone else's: the payout address must not move.
    expect(() => registry.register(registration({ address: addr(666) }))).toThrow(RegistrationRefused);
    const other = registry.register(registration({ nodeId: "other", address: addr(666) }));
    expect(() => registry.register(registration({ address: addr(666) }), { token: other.token })).toThrow(
      RegistrationRefused,
    );
    expect(registry.get(first.id)!.address).toBe(addr(1001));
    expect(registry.byAuthToken(first.token)?.id).toBe(first.id);
  });

  it("lets the node id alone reclaim an offline slot, with a fresh token that retires the old one", () => {
    vi.useFakeTimers();
    try {
      const first = registry.register(registration());
      registry.jobStarted(first.id);
      registry.jobFinished(first.id, { ok: true, durationMs: 1_000, usdcMicros: 10_000 });
      vi.advanceTimersByTime(46_000);
      const reclaimed = registry.registerNode(registration());
      expect(reclaimed.authenticated).toBe(false);
      expect(reclaimed.provider.id).toBe(first.id);
      expect(reclaimed.provider.token).not.toBe(first.token);
      expect(reclaimed.provider.stats.jobsCompleted).toBe(1);
      expect(registry.byAuthToken(first.token)).toBeUndefined();
      expect(registry.byAuthToken(reclaimed.provider.token)?.id).toBe(first.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives a stable provider id from the node id, across broker restarts", () => {
    // The id is hashed into ledger events and baked into the agent URI, so a
    // fresh Registry (a restarted broker) must hand the same node the same id.
    const first = new Registry().register(registration({ nodeId: "stable" }));
    const second = new Registry().register(registration({ nodeId: "stable" }));
    expect(first.id).toBe(second.id);
    expect(first.id).toBe(providerIdFor("stable"));
    expect(first.id).toMatch(/^prv_[A-Za-z0-9_-]{12}$/);
    // …without revealing the node id, which doubles as a credential.
    expect(first.id).not.toContain("stable");
  });

  it("stores the agent id it was given, and drops a stale registry tx when the payee changes", () => {
    const registry = new Registry();
    const first = registry.register(registration({ agentId: "42" }));
    expect(first.agentId).toBe("42");
    registry.setRegistryTx(first.id, "0xabc");
    const token = { token: first.token };
    expect(registry.register(registration({ agentId: "42" }), token).registryTxHash).toBe("0xabc");
    expect(registry.register(registration({ agentId: "42", address: addr(9) }), token).registryTxHash).toBeNull();
  });

  it("keeps distinct nodeIds as distinct providers", () => {
    registry.register(registration({ nodeId: "a" }));
    registry.register(registration({ nodeId: "b", address: addr(2002) }));
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

  it("still finds a reaped provider, as offline, for its public pages", () => {
    const provider = registry.register(registration());
    vi.advanceTimersByTime(11 * 60_000);
    registry.reap();
    expect(registry.get(provider.id)).toBeUndefined();
    expect(registry.find(provider.id)?.status).toBe("offline");
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
      registration({ nodeId: "pricey", address: addr(1), capabilities: [capability({ priceUsdMicros: 20_000 })] }),
    );
    const cheap = registry.register(
      registration({ nodeId: "cheap", address: addr(2), capabilities: [capability({ priceUsdMicros: 5_000 })] }),
    );
    expect(registry.match({ maxPriceUsdMicros: 100_000 })!.provider.id).toBe(cheap.id);
  });

  it("never matches a price that would ask for 0 USDC", () => {
    // A fractional micro-USD price rounds to a 0-unit payment; it must not win
    // quotes even if one got past registration.
    registry.register(
      registration({ nodeId: "free", address: addr(1), capabilities: [capability({ priceUsdMicros: 0.4 })] }),
    );
    expect(registry.match({ maxPriceUsdMicros: 100_000 })).toBeNull();
    const paid = registry.register(
      registration({ nodeId: "paid", address: addr(2), capabilities: [capability({ priceUsdMicros: 5_000 })] }),
    );
    expect(registry.match({ maxPriceUsdMicros: 100_000 })!.provider.id).toBe(paid.id);
  });

  it("breaks a price tie toward the better track record", () => {
    const good = registry.register(registration({ nodeId: "good", address: addr(1) }));
    const bad = registry.register(registration({ nodeId: "bad", address: addr(2) }));

    registry.jobStarted(good.id);
    registry.jobFinished(good.id, { ok: true, durationMs: 100 });
    registry.jobStarted(bad.id);
    registry.jobFinished(bad.id, { ok: false, durationMs: 100 });

    expect(registry.match({ maxPriceUsdMicros: 100_000 })!.provider.id).toBe(good.id);
  });

  it("honours an adapter requirement", () => {
    registry.register(
      registration({ nodeId: "claude", address: addr(1), capabilities: [capability()] }),
    );
    const codex = registry.register(
      registration({
        nodeId: "codex",
        address: addr(2),
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

  it("never hands a job back to a provider it excluded", () => {
    const a = registry.register(registration({ nodeId: "a", address: addr(1) }));
    const b = registry.register(
      registration({ nodeId: "b", address: addr(2), capabilities: [capability({ priceUsdMicros: 20_000 })] }),
    );
    expect(registry.match({ maxPriceUsdMicros: 100_000 })!.provider.id).toBe(a.id);
    expect(registry.match({ maxPriceUsdMicros: 100_000, exclude: [a.id] })!.provider.id).toBe(b.id);
    expect(registry.match({ maxPriceUsdMicros: 100_000, exclude: [a.id, b.id] })).toBeNull();
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

  it("lists every eligible capability in the order match would pick them", () => {
    registry.register(
      registration({
        capabilities: [
          capability({ id: "claude-code", priceUsdMicros: 10_000 }),
          capability({ id: "echo", adapter: "echo", priceUsdMicros: 1_000, maxConcurrency: 4 }),
          capability({ id: "kimi", adapter: "kimi", priceUsdMicros: 90_000 }),
        ],
      }),
    );
    registry.register(
      registration({ nodeId: "node-b-id", address: addr(1002), capabilities: [capability({ id: "qwen", adapter: "qwen", priceUsdMicros: 5_000 })] }),
    );
    const candidates = registry.candidates({ maxPriceUsdMicros: 50_000 });
    expect(candidates.map((m) => m.capability.id)).toEqual(["echo", "qwen", "claude-code"]);
    expect(registry.match({ maxPriceUsdMicros: 50_000 })).toEqual(candidates[0]);
    expect(registry.candidates({ adapter: "qwen", maxPriceUsdMicros: 50_000 }).map((m) => m.capability.id)).toEqual(["qwen"]);
    expect(registry.candidates({ maxPriceUsdMicros: 500 })).toEqual([]);
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

  it("credits earnings to the provider that was paid, not the one that finished", () => {
    const registry = new Registry();
    const paid = registry.register(registration({ nodeId: "paid", address: addr(1) }));
    const finisher = registry.register(registration({ nodeId: "finisher", address: addr(2) }));
    registry.jobFinished(finisher.id, { ok: true, durationMs: 5, usdcMicros: 0 });
    registry.creditEarnings(paid.id, 10_000);
    expect(registry.get(paid.id)!.stats.earnedUsdcMicros).toBe(10_000);
    expect(registry.get(finisher.id)!.stats.earnedUsdcMicros).toBe(0);
    expect(registry.get(finisher.id)!.stats.jobsCompleted).toBe(1);
  });

  it("frees a slot on a buyer cancel without counting a failure", () => {
    const registry = new Registry();
    const provider = registry.register(registration());
    registry.jobStarted(provider.id);
    registry.jobReleased(provider.id);
    const after = registry.get(provider.id)!;
    expect(after.activeJobs).toBe(0);
    expect(after.stats.jobsFailed).toBe(0);
  });
});
