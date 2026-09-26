/**
 * Config can hold a spending key, so the tests care about more than
 * round-tripping: the file mode is actually restrictive, a crash mid-write
 * can't leave an operator locked out of their own payout key, and a config
 * left behind by the Hedera prototype is recognised instead of failing later
 * as a mystery.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let home: string;

// A throwaway key and the address it derives (viem's own test vector #0).
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "xorv-home-"));
  process.env.XORV_HOME = home;
  // The module reads XORV_HOME at import time, so each test gets a fresh copy.
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.XORV_HOME;
  delete process.env.XORV_PRIVATE_KEY;
  delete process.env.XORV_BROKER_URL;
});

async function loadModule() {
  return import("../src/config.js");
}

function baseConfig(mod: Awaited<ReturnType<typeof loadModule>>, over: Record<string, unknown> = {}) {
  return {
    nodeId: "abc",
    label: "test-node",
    network: "eip155:10143",
    brokerUrl: "http://localhost:8402",
    address: ADDRESS,
    privateKey: KEY,
    agentId: "42",
    capabilities: [mod.defaultCapability("echo")],
    region: "eu-west",
    tunnel: { enabled: true, hostname: null },
    sandboxDir: path.join(home, "jobs"),
    providerId: "prv_1",
    token: "tok",
    ...over,
  };
}

describe("config round trip", () => {
  it("saves and reloads every field", async () => {
    const mod = await loadModule();
    const config = baseConfig(mod);
    mod.saveConfig(config);
    expect(mod.loadConfig()).toEqual(config);
  });

  it("round-trips an address-only node with no key at all", async () => {
    const mod = await loadModule();
    mod.saveConfig(baseConfig(mod, { privateKey: "", agentId: null }));
    const loaded = mod.loadConfig()!;
    expect(loaded.privateKey).toBe("");
    expect(loaded.agentId).toBeNull();
    expect(fs.readFileSync(mod.configPath(), "utf8")).not.toMatch(/0x[0-9a-f]{64}/i);
  });

  it("returns null when nothing is configured yet", async () => {
    const mod = await loadModule();
    expect(mod.configExists()).toBe(false);
    expect(mod.loadConfig()).toBeNull();
  });

  it("requireConfig points the operator at `xorv init`", async () => {
    const mod = await loadModule();
    expect(() => mod.requireConfig()).toThrow(/xorv init/);
  });

  // POSIX file modes: NTFS has no 0600/0700 — Windows reports 0666 whatever
  // chmod was asked for, so there is nothing to assert there.
  it.skipIf(process.platform === "win32")("writes the config 0600 and the home directory 0700 (POSIX only)", async () => {
    const mod = await loadModule();
    mod.saveConfig(baseConfig(mod));
    expect(fs.statSync(mod.configPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });

  it("leaves no temp file behind after a save", async () => {
    const mod = await loadModule();
    mod.saveConfig(baseConfig(mod));
    expect(fs.existsSync(`${mod.configPath()}.tmp`)).toBe(false);
  });

  it("fills in Monad defaults for a sparse config", async () => {
    const mod = await loadModule();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(mod.configPath(), JSON.stringify({ label: "old" }));
    const loaded = mod.loadConfig()!;
    expect(loaded.label).toBe("old");
    expect(loaded.network).toBe("eip155:10143");
    expect(loaded.address).toBe("");
    expect(loaded.agentId).toBeNull();
    expect(loaded.capabilities).toEqual([]);
    expect(loaded.tunnel).toEqual({ enabled: false, hostname: null });
  });

  it("carries a numeric agent id as a decimal string", async () => {
    const mod = await loadModule();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(mod.configPath(), JSON.stringify({ address: ADDRESS, agentId: 7 }));
    expect(mod.loadConfig()!.agentId).toBe("7");
  });

  it("reports a corrupt config clearly instead of crashing on JSON.parse", async () => {
    const mod = await loadModule();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(mod.configPath(), "{ not json");
    expect(() => mod.loadConfig()).toThrow(/could not read/);
  });
});

describe("a config left by the Hedera prototype", () => {
  const hederaConfig = {
    nodeId: "n1",
    label: "old-node",
    network: "hedera:testnet",
    brokerUrl: "https://broker.example.test",
    accountId: "0.0.9848438",
    privateKey: "302e020100300506032b657004220420deadbeef",
    capabilities: [
      { id: "claude-code", adapter: "claude-code", displayName: "Claude Code", model: null, priceUsdMicros: 123_000, maxConcurrency: 2 },
    ],
    region: "eu-west",
    tunnel: { enabled: false, hostname: null },
    providerId: "prv_old",
    token: "tok_old",
  };

  function writeLegacy(mod: Awaited<ReturnType<typeof loadModule>>, over: Record<string, unknown> = {}) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(mod.configPath(), JSON.stringify({ ...hederaConfig, ...over }));
  }

  it("is refused with a message that says to re-run `xorv init`", async () => {
    const mod = await loadModule();
    writeLegacy(mod);
    expect(() => mod.loadConfig()).toThrow(mod.LegacyConfigError);
    expect(() => mod.loadConfig()).toThrow(/Hedera version of Xorv.*0\.0\.9848438.*hedera:testnet.*xorv init/);
  });

  it("is recognised by its 0.0.N account even without a hedera: network", async () => {
    const mod = await loadModule();
    writeLegacy(mod, { network: undefined });
    expect(() => mod.loadConfig()).toThrow(/xorv init/);
  });

  it("is recognised by its hedera: network even without an account", async () => {
    const mod = await loadModule();
    writeLegacy(mod, { accountId: undefined, network: "hedera:mainnet" });
    expect(() => mod.loadConfig()).toThrow(/hedera:mainnet/);
  });

  it("keeps name, capabilities and prices for `xorv init`, and drops the chain-specific fields", async () => {
    const mod = await loadModule();
    writeLegacy(mod);
    const { config, legacy } = mod.loadPreviousConfig();
    expect(legacy).toEqual({ network: "hedera:testnet", accountId: "0.0.9848438" });
    expect(config!.label).toBe("old-node");
    expect(config!.nodeId).toBe("n1");
    expect(config!.capabilities[0]!.priceUsdMicros).toBe(123_000);
    expect(config!.brokerUrl).toBe("https://broker.example.test");
    expect(config!.network).toBe("eip155:10143");
    expect(config!.address).toBe("");
    expect(config!.privateKey).toBe("");
    expect(config!.providerId).toBeNull();
    expect(config!.token).toBeNull();
  });

  it("does not trip on a current config", async () => {
    const mod = await loadModule();
    mod.saveConfig(baseConfig(mod));
    expect(mod.loadPreviousConfig().legacy).toBeNull();
  });
});

describe("keys and addresses", () => {
  it("prefers XORV_PRIVATE_KEY over the file, for secret managers", async () => {
    const mod = await loadModule();
    const other = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    process.env.XORV_PRIVATE_KEY = other;
    expect(mod.resolvePrivateKey({ privateKey: KEY })).toBe(other);
  });

  it("normalizes a key pasted without 0x", async () => {
    const mod = await loadModule();
    expect(mod.resolvePrivateKey({ privateKey: KEY.slice(2) })).toBe(KEY);
  });

  it("explains that an address-only node has no key, rather than failing to parse one", async () => {
    const mod = await loadModule();
    expect(() => mod.resolvePrivateKey({ privateKey: "" })).toThrow(/address-only.*XORV_PRIVATE_KEY/);
  });

  it("names where an unusable key came from", async () => {
    const mod = await loadModule();
    process.env.XORV_PRIVATE_KEY = "302e020100300506032b657004220420deadbeef";
    expect(() => mod.resolvePrivateKey({ privateKey: "" })).toThrow(/XORV_PRIVATE_KEY.*ED25519/);
  });

  it("checksums the payout address and refuses a missing one", async () => {
    const mod = await loadModule();
    expect(mod.payoutAddress(baseConfig(mod, { address: ADDRESS.toLowerCase() }) as never)).toBe(ADDRESS);
    expect(() => mod.payoutAddress(baseConfig(mod, { address: "" }) as never)).toThrow(/xorv init/);
  });

  it("prefers XORV_BROKER_URL and strips trailing slashes", async () => {
    const mod = await loadModule();
    process.env.XORV_BROKER_URL = "https://broker.example.com///";
    expect(mod.resolveBrokerUrl({ brokerUrl: "http://ignored" })).toBe("https://broker.example.com");
  });
});

describe("earnings ledger", () => {
  it("appends rows and reads them back newest-last", async () => {
    const mod = await loadModule();
    mod.appendEarning({ at: 1, jobId: "job_a", asset: "usdc", amount: "1000", usdMicros: 1_000, durationMs: 500, ok: true });
    mod.appendEarning({ at: 2, jobId: "job_b", asset: "usdc", amount: "2000", usdMicros: 2_000, durationMs: 700, ok: false });
    const rows = mod.readEarnings();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.jobId).toBe("job_a");
    expect(rows[1]!.ok).toBe(false);
  });

  it("still reads rows the Hedera prototype wrote in HBAR", async () => {
    const mod = await loadModule();
    ensureHomeDir();
    fs.writeFileSync(
      mod.earningsPath(),
      `${JSON.stringify({ at: 1, jobId: "job_old", asset: "hbar", amount: "1462167", usdMicros: 1_000, durationMs: 700, ok: true, transactionId: "0.0.9842030@1785475549.131327424" })}\n`,
    );
    mod.appendEarning({ at: 2, jobId: "job_new", asset: "usdc", amount: "5000", usdMicros: 5_000, durationMs: 300, ok: true });
    const rows = mod.readEarnings();
    expect(rows.map((r) => r.asset)).toEqual(["hbar", "usdc"]);
    expect(rows[0]!.usdMicros).toBe(1_000);
  });

  it("returns an empty list when nothing has been earned yet", async () => {
    const mod = await loadModule();
    expect(mod.readEarnings()).toEqual([]);
  });

  it("skips a partial line left by an interrupted append", async () => {
    const mod = await loadModule();
    mod.appendEarning({ at: 1, jobId: "job_a", asset: "usdc", amount: "1", usdMicros: 1, durationMs: 1, ok: true });
    fs.appendFileSync(mod.earningsPath(), '{"at":2,"jobId":"trunc');
    expect(mod.readEarnings()).toHaveLength(1);
  });
});

function ensureHomeDir(): void {
  fs.mkdirSync(home, { recursive: true });
}

describe("defaultCapability", () => {
  const kinds = [
    "claude-code",
    "codex",
    "grok",
    "opencode",
    "qwen",
    "kimi",
    "hunyuan",
    "qwen-code",
    "openai-compatible",
    "echo",
  ] as const;

  it("gives every adapter a sane preset", async () => {
    const mod = await loadModule();
    for (const kind of kinds) {
      const capability = mod.defaultCapability(kind);
      expect(capability.adapter).toBe(kind);
      expect(capability.priceUsdMicros).toBeGreaterThan(0);
      expect(capability.maxConcurrency).toBeGreaterThan(0);
      expect(capability.displayName.length).toBeGreaterThan(0);
    }
  });

  it("names the sponsor models exactly as the providers do", async () => {
    const mod = await loadModule();
    expect(mod.defaultCapability("qwen").model).toBe("qwen3.8-max");
    expect(mod.defaultCapability("kimi").model).toBe("kimi-k3");
    expect(mod.defaultCapability("hunyuan").model).toBe("hy4-preview");
    expect(mod.defaultCapability("qwen-code").model).toBe("qwen3.8-max");
    expect(mod.defaultCapability("claude-code").model).toBeNull();
  });

  it("prices echo lowest, since it is a test capability", async () => {
    const mod = await loadModule();
    const echo = mod.defaultCapability("echo").priceUsdMicros;
    for (const kind of kinds.filter((k) => k !== "echo")) {
      expect(mod.defaultCapability(kind).priceUsdMicros).toBeGreaterThan(echo);
    }
  });
});
