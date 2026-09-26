/**
 * Configuration, facilitator choice and registration input — the places where
 * a wrong string should fail loudly at the edge instead of quietly later.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.js";
import { resolveFacilitator } from "../src/facilitator.js";
import { validateRegistration } from "../src/app.js";

const VARS = [
  "XORV_NETWORK",
  "XORV_OPERATOR_KEY",
  "XORV_FACILITATOR_KEY",
  "XORV_FACILITATOR",
  "XORV_LEDGER_ADDRESS",
  "XORV_LEDGER_FROM_BLOCK",
  "XORV_HEARTBEAT_PUBLISH_EVERY",
  "XORV_RECEIPT_BATCH_MS",
  "XORV_PUBLIC_URL",
  "XORV_BROKER_URL",
  "XORV_STABLECOIN",
  "XORV_ROUTER",
];

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) delete process.env[name];
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("loadConfig", () => {
  it("boots with no keys at all: testnet, read-only, no ledger", () => {
    const config = loadConfig();
    expect(config.network).toBe("eip155:10143");
    expect(config.operator).toBeNull();
    expect(config.facilitatorAccount).toBeNull();
    expect(config.facilitatorMode).toBeNull();
    expect(config.ledgerAddress).toBeNull();
    expect(config.heartbeatPublishEvery).toBe(20);
    expect(config.dbFile).toMatch(/xorv-monad\.db$/);
    expect(config.ai).toEqual({ router: "off", screener: "off", verifier: "off" });
  });

  it("refuses a leftover Hedera network with a message that names the fix", () => {
    process.env.XORV_NETWORK = "hedera:testnet";
    expect(() => loadConfig()).toThrow(/Monad.*eip155:10143/);
  });

  it("uses the operator key for the facilitator unless given its own", () => {
    const operatorKey = generatePrivateKey();
    process.env.XORV_OPERATOR_KEY = operatorKey;
    const config = loadConfig();
    expect(config.operator!.address).toBe(privateKeyToAccount(operatorKey).address);
    expect(config.facilitatorAccount!.address).toBe(config.operator!.address);

    const facilitatorKey = generatePrivateKey();
    process.env.XORV_FACILITATOR_KEY = facilitatorKey.slice(2); // without 0x is fine
    expect(loadConfig().facilitatorAccount!.address).toBe(privateKeyToAccount(facilitatorKey).address);
  });

  it("names the variable when a key is malformed", () => {
    process.env.XORV_OPERATOR_KEY = "0.0.12345";
    expect(() => loadConfig()).toThrow(/XORV_OPERATOR_KEY/);
  });

  it("checksums the ledger address and rejects a typo", () => {
    process.env.XORV_LEDGER_ADDRESS = "0x00000000000000000000000000000000000000aa";
    process.env.XORV_LEDGER_FROM_BLOCK = "123";
    const config = loadConfig();
    expect(config.ledgerAddress).toBe("0x00000000000000000000000000000000000000AA");
    expect(config.ledgerFromBlock).toBe(123n);
    process.env.XORV_LEDGER_ADDRESS = "0xnope";
    expect(() => loadConfig()).toThrow(/XORV_LEDGER_ADDRESS/);
  });

  it("prefers XORV_PUBLIC_URL for the URLs baked into on-chain strings", () => {
    process.env.XORV_BROKER_URL = "http://localhost:9999";
    expect(loadConfig().publicUrl).toBe("http://localhost:9999");
    process.env.XORV_PUBLIC_URL = "https://broker.example.com/";
    expect(loadConfig().publicUrl).toBe("https://broker.example.com");
  });

  it("validates the AI role switches", () => {
    process.env.XORV_ROUTER = "qwen";
    expect(loadConfig().ai.router).toBe("qwen");
    process.env.XORV_ROUTER = "gpt";
    expect(() => loadConfig()).toThrow(/XORV_ROUTER/);
  });
});

describe("resolveFacilitator", () => {
  it("falls back to the hosted facilitator when nothing was configured, and says so", () => {
    const choice = resolveFacilitator({ network: "eip155:10143", facilitatorMode: null, facilitatorAccount: null });
    expect(choice.facilitator).not.toBeNull();
    expect(choice.mode).toBe("hosted");
    expect(choice.url).toBe("https://x402-facilitator.molandak.org");
    expect(choice.notice).toMatch(/hosted facilitator/);
  });

  it("never turns an explicit `self` into hosted: payments are disabled instead", () => {
    const choice = resolveFacilitator({ network: "eip155:10143", facilitatorMode: "self", facilitatorAccount: null });
    expect(choice.facilitator).toBeNull();
    expect(choice.unavailableReason).toMatch(/XORV_FACILITATOR_KEY/);
  });

  it("self-hosts with a key", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const choice = resolveFacilitator({ network: "eip155:10143", facilitatorMode: null, facilitatorAccount: account });
    expect(choice.mode).toBe("self");
    expect(choice.address).toBe(account.address);
    expect(choice.notice).toBeNull();
  });
});

describe("validateRegistration", () => {
  const base = {
    label: "node",
    address: "0x52908400098527886e0f7030069857d2e4169ee7",
    endpoint: "http://localhost:1",
    capabilities: [{ id: "echo", adapter: "echo" as const, displayName: "Echo", priceUsdMicros: 1_000, maxConcurrency: 1 }],
    version: "0.2.0",
    nodeId: "n1",
  };

  it("stores the payout address checksummed, whatever casing it arrived in", () => {
    const parsed = validateRegistration(base);
    expect("registration" in parsed && parsed.registration.address).toBe("0x52908400098527886E0F7030069857D2E4169EE7");
  });

  it("rejects a mistyped checksum, a non-address, a Hedera id and the zero address", () => {
    for (const address of [
      "0x52908400098527886E0F7030069857D2E4169Ee7",
      "nope",
      "0.0.12345",
      "0x0000000000000000000000000000000000000000",
      "",
    ]) {
      expect("error" in validateRegistration({ ...base, address })).toBe(true);
    }
  });

  it("accepts a decimal agent id and nothing else", () => {
    const ok = validateRegistration({ ...base, agentId: "0042" });
    expect("registration" in ok && ok.agentId).toBe("42");
    expect("error" in validateRegistration({ ...base, agentId: "0x2a" })).toBe(true);
    expect("error" in validateRegistration({ ...base, agentId: "-1" })).toBe(true);
    const none = validateRegistration({ ...base, agentId: null });
    expect("registration" in none && none.agentId).toBeNull();
  });
});
