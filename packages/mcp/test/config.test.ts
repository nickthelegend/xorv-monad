import { describe, expect, it } from "vitest";
import { describeConfig, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to Monad testnet, a $0.05 per-job cap and a $0.50 session budget", () => {
    const config = loadConfig({});
    expect(config.network).toBe("eip155:10143");
    expect(config.brokerUrl).toBe("http://localhost:8402");
    expect(config.maxPriceUsdMicros).toBe(50_000);
    expect(config.sessionBudgetUsdMicros).toBe(500_000);
    expect(config.signer.mode).toBe("none");
    expect(config.problems).toEqual([]);
  });

  it("reads XORV_MAX_PRICE, and still honours 0.1's XORV_MAX_USD", () => {
    expect(loadConfig({ XORV_MAX_PRICE: "0.02" }).maxPriceUsdMicros).toBe(20_000);
    expect(loadConfig({ XORV_MAX_USD: "$0.03" }).maxPriceUsdMicros).toBe(30_000);
    expect(loadConfig({ XORV_MAX_PRICE: "0.02", XORV_MAX_USD: "0.03" }).maxPriceUsdMicros).toBe(20_000);
  });

  it("accepts mainnet, and trims a trailing slash off the broker URL", () => {
    const config = loadConfig({ XORV_NETWORK: "eip155:143", XORV_BROKER_URL: "https://broker.example/" });
    expect(config.network).toBe("eip155:143");
    expect(config.brokerUrl).toBe("https://broker.example");
  });

  it("reports a leftover Hedera network instead of throwing", () => {
    const config = loadConfig({ XORV_NETWORK: "hedera:testnet" });
    expect(config.problems).toHaveLength(1);
    expect(config.problems[0]).toMatch(/eip155:10143/);
    expect(config.problems[0]).toMatch(/Hedera prototype/);
  });

  it("reports unusable dollar amounts", () => {
    expect(loadConfig({ XORV_MAX_PRICE: "lots" }).problems[0]).toMatch(/XORV_MAX_PRICE="lots"/);
    expect(loadConfig({ XORV_MAX_PRICE: "0" }).problems[0]).toMatch(/greater than zero/);
    expect(loadConfig({ XORV_SESSION_BUDGET_USD: "-1" }).problems[0]).toMatch(/XORV_SESSION_BUDGET_USD/);
  });

  it("allows an explicitly unlimited session budget", () => {
    expect(loadConfig({ XORV_SESSION_BUDGET_USD: "unlimited" }).sessionBudgetUsdMicros).toBeNull();
    expect(loadConfig({ XORV_SESSION_BUDGET_USD: "2.5" }).sessionBudgetUsdMicros).toBe(2_500_000);
  });

  it("describes itself without leaking secrets", () => {
    const config = loadConfig({ XORV_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" });
    const line = describeConfig(config, "local key (XORV_PRIVATE_KEY)");
    expect(line).toContain("cap $0.0500/job");
    expect(line).toContain("session budget $0.5000");
    expect(line).not.toContain("ac0974");
  });
});
