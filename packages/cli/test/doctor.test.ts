/**
 * Diagnosis.
 *
 * These are pure functions over already-fetched data, which is the whole point
 * of the shape: the interesting cases — a broker on the wrong network, an
 * account that cannot receive the token it will be paid in, a CLI installed but
 * signed out — are exactly the ones you cannot reproduce on demand against a
 * live testnet.
 *
 * The distinction under test throughout is between *broken* and *unconfigured*.
 * A node with no Grok installed is not faulty; a node selling Claude Code while
 * signed out is, and it will take a stranger's money before failing.
 */

import { describe, expect, it } from "vitest";
import {
  adapterChecks,
  brokerChecks,
  configChecks,
  doctorReport,
  payoutChecks,
  probeAuth,
  sandboxChecks,
  type AdapterState,
} from "../src/commands/doctor.js";
import type { NodeConfig } from "../src/config.js";

const config = (over: Partial<NodeConfig> = {}): NodeConfig =>
  ({
    network: "hedera:testnet",
    accountId: "0.0.9848438",
    privateKey: "302e0201",
    label: "test-node",
    capabilities: [
      { id: "claude-code", adapter: "claude-code", displayName: "Claude Code", model: null, priceUsdMicros: 250_000, maxConcurrency: 1 },
    ],
    ...over,
  }) as NodeConfig;

const balances = (over = {}) => ({
  hbarTinybars: "554130000",
  usdcUnits: "1250000",
  usdcAssociated: true,
  canReceiveUsdc: true,
  maxAutoAssociations: 0,
  ...over,
});

const find = (checks: { name: string }[], name: string) => checks.find((c) => c.name === name);

describe("doctorReport", () => {
  it("counts warnings and failures separately — they mean different things", () => {
    const report = doctorReport([
      { name: "a", status: "ok", detail: "" },
      { name: "b", status: "warn", detail: "" },
      { name: "c", status: "fail", detail: "" },
    ]);
    expect(report.summary).toEqual({ ok: false, warnings: 1, failures: 1 });
  });

  it("is ok when nothing failed, even with warnings outstanding", () => {
    expect(doctorReport([{ name: "a", status: "warn", detail: "" }]).summary.ok).toBe(true);
  });
});

describe("configChecks", () => {
  it("fails an unconfigured node and says what to run", () => {
    const [check] = configChecks(null);
    expect(check.status).toBe("fail");
    expect(check.fix).toBe("xorv init");
  });

  it("fails a node with nothing to sell", () => {
    expect(find(configChecks(config({ capabilities: [] })), "capabilities")?.status).toBe("fail");
  });

  it("fails a node with no payout account — it cannot be paid", () => {
    expect(find(configChecks(config({ accountId: "" })), "payout")?.status).toBe("fail");
  });

  it("warns when a price is set below plausible cost", () => {
    // Loss-making by default is a bug in the default, not a market decision.
    const cheap = config({
      capabilities: [
        { id: "echo", adapter: "echo", displayName: "Echo", model: null, priceUsdMicros: 100, maxConcurrency: 1 },
      ],
    } as Partial<NodeConfig>);
    expect(find(configChecks(cheap), "pricing")?.status).toBe("warn");
  });

  it("passes a properly configured node", () => {
    expect(configChecks(config()).every((c) => c.status === "ok")).toBe(true);
  });
});

describe("sandboxChecks", () => {
  it("warns and offers a container when there is no filesystem boundary", () => {
    for (const tier of ["none", "env"] as const) {
      const checks = sandboxChecks(tier, 40, false);
      expect(find(checks, "sandbox")?.status).toBe("warn");
      expect(find(checks, "sandbox")?.fix).toContain("container");
      expect(find(checks, "isolation")?.detail).toContain("could read any file");
    }
  });

  it("reports a real boundary as ok and names what it protects", () => {
    const checks = sandboxChecks("seatbelt", 45, false);
    expect(find(checks, "sandbox")?.status).toBe("ok");
    expect(find(checks, "isolation")?.detail).toContain("payout key");
    expect(find(checks, "isolation")?.detail).toContain("45 env var(s) withheld");
  });

  it("flags safe mode as a warning — it earns less", () => {
    expect(find(sandboxChecks("seatbelt", 0, true), "mode")?.status).toBe("warn");
  });
});

describe("payoutChecks", () => {
  it("fails an account that cannot receive USDC", () => {
    // The failure that looks like success: the payment is rejected at
    // settlement, long after the buyer thinks they've paid.
    const checks = payoutChecks("hedera:testnet", "0.0.1", balances({ canReceiveUsdc: false, usdcAssociated: false }));
    expect(find(checks, "usdc")?.status).toBe("fail");
    expect(find(checks, "usdc")?.fix).toBe("xorv wallet associate");
  });

  it("accepts automatic association without demanding an explicit one", () => {
    const checks = payoutChecks(
      "hedera:testnet",
      "0.0.1",
      balances({ usdcAssociated: false, maxAutoAssociations: -1 }),
    );
    expect(find(checks, "usdc")?.status).toBe("ok");
    expect(find(checks, "usdc")?.detail).toContain("unlimited");
  });

  it("does not treat a zero HBAR balance as a problem", () => {
    // The facilitator pays gas; a provider never needs HBAR.
    const checks = payoutChecks("hedera:testnet", "0.0.1", balances({ hbarTinybars: "0" }));
    expect(find(checks, "balance")?.status).toBe("ok");
    expect(find(checks, "balance")?.detail).toContain("facilitator pays gas");
  });
});

describe("brokerChecks", () => {
  const info = {
    network: "hedera:testnet",
    facilitator: { description: "self-hosted", feePayer: "0.0.9842030" },
    stats: { providersLive: 3 },
  };

  it("fails a network mismatch, which breaks every settlement", () => {
    const checks = brokerChecks("http://b", { ...info, network: "hedera:mainnet" }, "hedera:testnet");
    expect(find(checks, "network")?.status).toBe("fail");
  });

  it("passes when both sides agree", () => {
    expect(find(brokerChecks("http://b", info, "hedera:testnet"), "network")?.status).toBe("ok");
  });
});

describe("adapterChecks", () => {
  const state = (over: Partial<AdapterState> = {}): AdapterState => ({
    kind: "claude-code",
    label: "Claude Code",
    installed: true,
    selling: true,
    auth: { authed: true, hint: "" },
    ...over,
  });

  it("fails a CLI that is sold but signed out — every job would fail after payment", () => {
    const [check] = adapterChecks([state({ auth: { authed: false, hint: "run `claude` and sign in" } })]);
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("signed out");
    expect(check.fix).toContain("sign in");
  });

  it("fails a CLI that is sold but not installed", () => {
    expect(adapterChecks([state({ installed: false })])[0].status).toBe("fail");
  });

  it("does not fault a CLI the operator simply chose not to sell", () => {
    expect(adapterChecks([state({ installed: false, selling: false })])[0].status).toBe("warn");
  });

  it("warns rather than passing when sign-in could not be confirmed", () => {
    // An optimistic yes here means a stranger pays for an error message.
    expect(adapterChecks([state({ auth: { authed: null, hint: "" } })])[0].status).toBe("warn");
  });

  it("fails outright when no agent CLI is installed at all", () => {
    const checks = adapterChecks([state({ installed: false, selling: false })]);
    expect(find(checks, "agents")?.status).toBe("fail");
  });

  it("passes an installed, signed-in, selling CLI", () => {
    expect(adapterChecks([state()])[0].status).toBe("ok");
  });
});

describe("probeAuth", () => {
  it("reports a signed-out codex from the absence of its credential file", () => {
    expect(probeAuth("codex", "/nonexistent-home").authed).toBe(false);
  });

  it("says it cannot tell rather than guessing, where there is no cheap signal", () => {
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
    expect(probeAuth("grok", "/nonexistent-home").authed).toBeNull();
  });

  it("treats echo as always usable — it needs no credentials", () => {
    expect(probeAuth("echo", "/nonexistent-home").authed).toBe(true);
  });
});
