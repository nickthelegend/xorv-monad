import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadDemoPayer } from "@/lib/server/demo-payer";

/*
 * The demo account is the one place the app holds a key, behind an
 * unauthenticated route. These pin its guard rails: testnet only, a real
 * secp256k1 key, a per-job ceiling, and no key material in any error.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

function stub(env: Record<string, string>) {
  for (const name of ["XORV_NETWORK", "NEXT_PUBLIC_XORV_NETWORK", "XORV_DEMO_PAYER_KEY", "XORV_DEMO_MAX_USDC_UNITS", "XORV_BROKER_URL", "NEXT_PUBLIC_XORV_BROKER_URL"]) {
    vi.stubEnv(name, env[name] ?? "");
  }
}

describe("loadDemoPayer", () => {
  it("derives the account from the key alone and defaults to a $0.50 cap on testnet", () => {
    const key = generatePrivateKey();
    stub({ XORV_DEMO_PAYER_KEY: key, XORV_BROKER_URL: "http://broker.test/" });
    const loaded = loadDemoPayer();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.payer.account.address).toBe(privateKeyToAccount(key).address);
    expect(loaded.payer.network).toBe("eip155:10143");
    expect(loaded.payer.maxUsdcUnits).toBe("500000");
    expect(loaded.payer.brokerUrl).toBe("http://broker.test");
  });

  it("refuses on mainnet even with a key", () => {
    stub({ XORV_NETWORK: "eip155:143", XORV_DEMO_PAYER_KEY: generatePrivateKey() });
    const loaded = loadDemoPayer();
    expect(loaded).toMatchObject({ ok: false, status: 403 });
  });

  it("reports a missing key as not configured", () => {
    stub({});
    expect(loadDemoPayer()).toMatchObject({ ok: false, status: 501 });
  });

  it("rejects a Hedera DER key without echoing it", () => {
    const der = `302e020100300506032b657004220420${"ab".repeat(32)}`;
    stub({ XORV_DEMO_PAYER_KEY: der });
    const loaded = loadDemoPayer();
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toMatch(/ED25519/);
    expect(loaded.error).not.toContain(der);
  });

  it("rejects a non-Monad network and a malformed cap", () => {
    stub({ XORV_NETWORK: "hedera:testnet", XORV_DEMO_PAYER_KEY: generatePrivateKey() });
    expect(loadDemoPayer()).toMatchObject({ ok: false, status: 500 });
    stub({ XORV_DEMO_PAYER_KEY: generatePrivateKey(), XORV_DEMO_MAX_USDC_UNITS: "0.5" });
    expect(loadDemoPayer()).toMatchObject({ ok: false, status: 500 });
  });
});
