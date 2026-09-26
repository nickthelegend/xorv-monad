/**
 * Config holds a spending key, so the tests care about two things beyond
 * round-tripping: the file mode is actually restrictive, and a crash mid-write
 * can't leave an operator locked out of their own payout account.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let home: string;

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

import { vi } from "vitest";

async function loadModule() {
  return import("../src/config.js");
}

describe("config round trip", () => {
  it("saves and reloads every field", async () => {
    const mod = await loadModule();
    const config = {
      nodeId: "abc",
      label: "test-node",
      network: "hedera:testnet",
      brokerUrl: "http://localhost:8402",
      accountId: "0.0.1001",
      privateKey: "deadbeef",
      capabilities: [mod.defaultCapability("echo")],
      region: "eu-west",
      tunnel: { enabled: true, hostname: null },
      sandboxDir: path.join(home, "jobs"),
      providerId: "prv_1",
      token: "tok",
    };
    mod.saveConfig(config);
    expect(mod.loadConfig()).toEqual(config);
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

  it("writes the config 0600 and the home directory 0700", async () => {
    const mod = await loadModule();
    mod.saveConfig({
      nodeId: "a",
      label: "n",
      network: "hedera:testnet",
      brokerUrl: "u",
      accountId: "0.0.1",
      privateKey: "k",
      capabilities: [],
      region: null,
      tunnel: { enabled: false, hostname: null },
      sandboxDir: home,
      providerId: null,
      token: null,
    });
    expect(fs.statSync(mod.configPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });

  it("leaves no temp file behind after a save", async () => {
    const mod = await loadModule();
    mod.saveConfig({
      nodeId: "a",
      label: "n",
      network: "hedera:testnet",
      brokerUrl: "u",
      accountId: "0.0.1",
      privateKey: "k",
      capabilities: [],
      region: null,
      tunnel: { enabled: false, hostname: null },
      sandboxDir: home,
      providerId: null,
      token: null,
    });
    expect(fs.existsSync(`${mod.configPath()}.tmp`)).toBe(false);
  });

  it("fills in defaults for a config written by an older version", async () => {
    const mod = await loadModule();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(mod.configPath(), JSON.stringify({ label: "old" }));
    const loaded = mod.loadConfig()!;
    expect(loaded.label).toBe("old");
    expect(loaded.network).toBe("hedera:testnet");
    expect(loaded.capabilities).toEqual([]);
    expect(loaded.tunnel).toEqual({ enabled: false, hostname: null });
  });

  it("reports a corrupt config clearly instead of crashing on JSON.parse", async () => {
    const mod = await loadModule();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(mod.configPath(), "{ not json");
    expect(() => mod.loadConfig()).toThrow(/could not read/);
  });
});

describe("environment overrides", () => {
  it("prefers XORV_PRIVATE_KEY over the file, for secret managers", async () => {
    const mod = await loadModule();
    process.env.XORV_PRIVATE_KEY = "from-env";
    const config = { privateKey: "from-file" } as never;
    expect(mod.resolvePrivateKey(config)).toBe("from-env");
  });

  it("errors clearly when neither is set", async () => {
    const mod = await loadModule();
    expect(() => mod.resolvePrivateKey({ privateKey: "" } as never)).toThrow(/no payout key/);
  });

  it("prefers XORV_BROKER_URL and strips trailing slashes", async () => {
    const mod = await loadModule();
    process.env.XORV_BROKER_URL = "https://broker.example.com///";
    expect(mod.resolveBrokerUrl({ brokerUrl: "http://ignored" } as never)).toBe(
      "https://broker.example.com",
    );
  });
});

describe("earnings ledger", () => {
  it("appends rows and reads them back newest-last", async () => {
    const mod = await loadModule();
    mod.appendEarning({
      at: 1,
      jobId: "job_a",
      asset: "usdc",
      amount: "1000",
      usdMicros: 1_000,
      durationMs: 500,
      ok: true,
    });
    mod.appendEarning({
      at: 2,
      jobId: "job_b",
      asset: "hbar",
      amount: "1462167",
      usdMicros: 1_000,
      durationMs: 700,
      ok: false,
    });
    const rows = mod.readEarnings();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.jobId).toBe("job_a");
    expect(rows[1]!.ok).toBe(false);
  });

  it("returns an empty list when nothing has been earned yet", async () => {
    const mod = await loadModule();
    expect(mod.readEarnings()).toEqual([]);
  });

  it("skips a partial line left by an interrupted append", async () => {
    const mod = await loadModule();
    mod.appendEarning({
      at: 1,
      jobId: "job_a",
      asset: "usdc",
      amount: "1",
      usdMicros: 1,
      durationMs: 1,
      ok: true,
    });
    fs.appendFileSync(mod.earningsPath(), '{"at":2,"jobId":"trunc');
    expect(mod.readEarnings()).toHaveLength(1);
  });
});

describe("defaultCapability", () => {
  it("gives every adapter a sane preset", async () => {
    const mod = await loadModule();
    for (const kind of [
      "claude-code",
      "codex",
      "grok",
      "opencode",
      "openai-compatible",
      "echo",
    ] as const) {
      const capability = mod.defaultCapability(kind);
      expect(capability.adapter).toBe(kind);
      expect(capability.priceUsdMicros).toBeGreaterThan(0);
      expect(capability.maxConcurrency).toBeGreaterThan(0);
      expect(capability.displayName.length).toBeGreaterThan(0);
    }
  });

  it("prices echo lowest, since it is a test capability", async () => {
    const mod = await loadModule();
    const echo = mod.defaultCapability("echo").priceUsdMicros;
    for (const kind of ["claude-code", "codex", "grok"] as const) {
      expect(mod.defaultCapability(kind).priceUsdMicros).toBeGreaterThan(echo);
    }
  });
});
