/**
 * Diagnosis.
 *
 * These are pure functions over already-fetched data, which is the whole point
 * of the shape: the interesting cases — a broker on the wrong network, an RPC
 * on the wrong chain, an identity whose wallet is not the payout address, a
 * CLI installed but signed out — are exactly the ones you cannot reproduce on
 * demand against a live testnet.
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
  identityChecks,
  payoutChecks,
  probeAuth,
  rpcChecks,
  sandboxChecks,
  type AdapterState,
} from "../src/commands/doctor.js";
import type { IdentityState } from "../src/commands/identity.js";
import type { NodeConfig } from "../src/config.js";

const PAYOUT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const config = (over: Partial<NodeConfig> = {}): NodeConfig =>
  ({
    network: "eip155:10143",
    address: PAYOUT,
    privateKey: "",
    agentId: null,
    label: "test-node",
    capabilities: [
      { id: "claude-code", adapter: "claude-code", displayName: "Claude Code", model: null, priceUsdMicros: 250_000, maxConcurrency: 1 },
    ],
    ...over,
  }) as NodeConfig;

const find = (checks: { name: string }[], name: string) => checks.find((c) => c.name === name) as
  | { name: string; status: string; detail: string; fix?: string }
  | undefined;

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
    expect(check!.status).toBe("fail");
    expect(check!.fix).toBe("xorv init");
  });

  it("fails a node with nothing to sell", () => {
    expect(find(configChecks(config({ capabilities: [] })), "capabilities")?.status).toBe("fail");
  });

  it("fails a node with no payout address — it cannot be paid", () => {
    expect(find(configChecks(config({ address: "" })), "payout")?.status).toBe("fail");
  });

  it("is happy with an address-only node — a provider needs no key", () => {
    expect(configChecks(config({ privateKey: "" })).every((c) => c.status === "ok")).toBe(true);
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

  it("shows the pinned model next to the capability", () => {
    const qwen = config({
      capabilities: [
        { id: "qwen", adapter: "qwen", displayName: "Qwen 3.8 Max", model: "qwen3.8-max", priceUsdMicros: 40_000, maxConcurrency: 1 },
      ],
    } as Partial<NodeConfig>);
    expect(find(configChecks(qwen), "capabilities")?.detail).toContain("qwen3.8-max");
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

describe("rpcChecks", () => {
  const url = "https://testnet-rpc.monad.xyz";

  it("passes an RPC on the expected chain", () => {
    const [check] = rpcChecks("eip155:10143", url, { chainId: 10143, latencyMs: 42 });
    expect(check!.status).toBe("ok");
    expect(check!.detail).toContain("chain 10143");
  });

  it("fails an RPC on the wrong chain — signatures and identities would land elsewhere", () => {
    const [check] = rpcChecks("eip155:10143", url, { chainId: 143, latencyMs: 42 });
    expect(check!.status).toBe("fail");
    expect(check!.detail).toMatch(/chain 143.*eip155:10143/);
    expect(check!.fix).toContain("XORV_RPC_URL");
  });

  it("fails an unreachable RPC and says where to look", () => {
    const [check] = rpcChecks("eip155:143", url, { error: "fetch failed" });
    expect(check!.status).toBe("fail");
    expect(check!.detail).toContain("fetch failed");
  });
});

describe("payoutChecks", () => {
  it("links the payout address on the explorer", () => {
    const checks = payoutChecks("eip155:10143", PAYOUT, { monWei: "0", usdcUnits: "1250000" });
    expect(find(checks, "payout")?.detail).toContain(`https://testnet.monadvision.com/address/${PAYOUT}`);
  });

  it("does not treat a zero MON balance as a problem", () => {
    // The facilitator pays gas and any address can receive USDC; a provider
    // never needs MON to earn.
    const checks = payoutChecks("eip155:10143", PAYOUT, { monWei: "0", usdcUnits: "1250000" });
    expect(find(checks, "balance")?.status).toBe("ok");
    expect(find(checks, "balance")?.detail).toContain("facilitator pays gas");
    expect(find(checks, "balance")?.detail).toContain("$1.25");
  });

  it("reports MON when there is some", () => {
    const checks = payoutChecks("eip155:10143", PAYOUT, { monWei: 2n * 10n ** 18n, usdcUnits: 0n });
    expect(find(checks, "balance")?.detail).toContain("2 MON");
  });
});

describe("identityChecks", () => {
  const state = (over: Partial<IdentityState> = {}): IdentityState => ({
    agentId: "42",
    owner: PAYOUT,
    wallet: PAYOUT,
    uri: "https://broker.example.test/agents/n1.json",
    payout: PAYOUT,
    walletMatches: true,
    ownerMatches: true,
    ...over,
  });

  it("warns — not fails — when there is no identity; the node still earns", () => {
    const [check] = identityChecks("eip155:10143", config({ privateKey: "0x01" }), null);
    expect(check!.status).toBe("warn");
    expect(check!.fix).toBe("xorv identity register");
  });

  it("points an address-only node at the wallet that holds its key", () => {
    const [check] = identityChecks("eip155:10143", config({ privateKey: "" }), null);
    expect(check!.fix).toMatch(/wallet that holds the payout key/);
  });

  it("passes an identity whose wallet is the payout address, with its explorer link", () => {
    const [check] = identityChecks("eip155:10143", config({ agentId: "42" }), state());
    expect(check!.status).toBe("ok");
    expect(check!.detail).toContain("/nft/0x8004A818BFB912233c491871b3d84c89A494BD9e/42");
  });

  it("fails when the agent wallet is not the payout address — receipts would not bind", () => {
    const [check] = identityChecks("eip155:10143", config({ agentId: "42" }), state({ wallet: OTHER, walletMatches: false }));
    expect(check!.status).toBe("fail");
    expect(check!.detail).toContain(OTHER);
  });

  it("fails when the registry cannot be read for a configured agent", () => {
    const [check] = identityChecks("eip155:10143", config({ agentId: "42" }), { error: "execution reverted" });
    expect(check!.status).toBe("fail");
    expect(check!.detail).toContain("execution reverted");
  });
});

describe("brokerChecks", () => {
  const info = {
    network: "eip155:10143",
    facilitator: { description: "self-hosted facilitator", address: "0x00000000219ab540356cBB839Cbe05303d7705Fa" },
    ledger: { address: "0x1111111111111111111111111111111111111111" },
    ai: { router: { model: "qwen3.8-max" }, screener: { model: "hy4-preview" }, verifier: { model: "kimi-k3" } },
    stats: { providersLive: 3 },
  };

  it("fails a network mismatch, which breaks every settlement", () => {
    const checks = brokerChecks("http://b", { ...info, network: "eip155:143" }, "eip155:10143");
    expect(find(checks, "network")?.status).toBe("fail");
    expect(find(checks, "network")?.fix).toContain("eip155:143");
  });

  it("passes when both sides agree", () => {
    expect(find(brokerChecks("http://b", info, "eip155:10143"), "network")?.status).toBe("ok");
  });

  it("names the facilitator's gas payer and the AI roles", () => {
    const checks = brokerChecks("http://b", info, "eip155:10143");
    expect(find(checks, "facilitator")?.detail).toContain(info.facilitator.address);
    expect(find(checks, "ai roles")?.detail).toBe("router qwen3.8-max · screener hy4-preview · verifier kimi-k3");
  });

  it("reads a broker not yet moved to Monad as a mismatch, not a crash", () => {
    // The Hedera broker's shape: no ledger, no ai, a feePayer instead of an address.
    const hedera = {
      network: "hedera:testnet",
      facilitator: { description: "self-hosted", feePayer: "0.0.9842030" },
      stats: { providersLive: 1 },
    } as never;
    const checks = brokerChecks("http://b", hedera, "eip155:10143");
    expect(find(checks, "network")?.status).toBe("fail");
    expect(find(checks, "facilitator")?.detail).toBe("self-hosted");
  });

  it("warns when the broker keeps no on-chain receipts", () => {
    expect(find(brokerChecks("http://b", { ...info, ledger: null }, "eip155:10143"), "ledger")?.status).toBe("warn");
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
    expect(check!.status).toBe("fail");
    expect(check!.detail).toContain("signed out");
    expect(check!.fix).toContain("sign in");
  });

  it("fails a CLI that is sold but not set up, with its setup hint", () => {
    const [check] = adapterChecks([
      state({ kind: "qwen", label: "Qwen 3.8 Max", installed: false, auth: { authed: null, hint: "set XORV_QWEN_API_KEY" } }),
    ]);
    expect(check!.status).toBe("fail");
    expect(check!.fix).toContain("XORV_QWEN_API_KEY");
  });

  it("does not fault a CLI the operator simply chose not to sell", () => {
    expect(adapterChecks([state({ installed: false, selling: false })])[0]!.status).toBe("warn");
  });

  it("warns rather than passing when sign-in could not be confirmed", () => {
    // An optimistic yes here means a stranger pays for an error message.
    expect(adapterChecks([state({ auth: { authed: null, hint: "" } })])[0]!.status).toBe("warn");
  });

  it("fails outright when no agent CLI is installed at all", () => {
    const checks = adapterChecks([state({ installed: false, selling: false })]);
    expect(find(checks, "agents")?.status).toBe("fail");
  });

  it("passes an installed, signed-in, selling CLI", () => {
    expect(adapterChecks([state()])[0]!.status).toBe("ok");
  });
});

describe("probeAuth", () => {
  it("reports a signed-out codex from the absence of its credential file", () => {
    expect(probeAuth("codex", "/nonexistent-home").authed).toBe(false);
  });

  it("says it cannot tell rather than guessing, where there is no cheap signal", () => {
    expect(probeAuth("grok", "/nonexistent-home", {}).authed).toBeNull();
  });

  it("treats echo as always usable — it needs no credentials", () => {
    expect(probeAuth("echo", "/nonexistent-home").authed).toBe(true);
  });

  it("reads the hosted models' keys from either of their variables", () => {
    expect(probeAuth("qwen", "/h", {}).authed).toBe(false);
    expect(probeAuth("qwen", "/h", {}).hint).toContain("DASHSCOPE_API_KEY");
    expect(probeAuth("qwen", "/h", { DASHSCOPE_API_KEY: "sk-1" }).authed).toBe(true);
    expect(probeAuth("kimi", "/h", { MOONSHOT_API_KEY: "sk-1" }).authed).toBe(true);
    expect(probeAuth("hunyuan", "/h", { XORV_HUNYUAN_API_KEY: "sk-1" }).authed).toBe(true);
    expect(probeAuth("hunyuan", "/h", {}).hint).toContain("TOKENHUB_API_KEY");
  });
});
