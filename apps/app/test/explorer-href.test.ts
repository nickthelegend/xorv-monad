import { afterEach, describe, expect, it, vi } from "vitest";

async function load(rpc: string | undefined) {
  vi.resetModules();
  if (rpc === undefined) vi.stubEnv("NEXT_PUBLIC_XORV_RPC_URL", "");
  else vi.stubEnv("NEXT_PUBLIC_XORV_RPC_URL", rpc);
  return import("@/lib/network");
}

afterEach(() => vi.unstubAllEnvs());

describe("explorer links on a local fork", () => {
  it("drops links to the fork's own state, which no public explorer has, but keeps real-network links", async () => {
    const { explorerHref, IS_LOCAL_CHAIN, CHAIN_CONFIG } = await load("http://127.0.0.1:8650");
    expect(IS_LOCAL_CHAIN).toBe(true);
    const tx = `${CHAIN_CONFIG.explorerUrl}/tx/0xabc`;
    expect(explorerHref(tx)).toBeNull();
    expect(explorerHref(tx, true)).toBe(tx);
    expect(explorerHref("https://faucet.circle.com")).toBe("https://faucet.circle.com");
  });

  it("links everything on a Monad network, on MonadVision", async () => {
    const { explorerHref, IS_LOCAL_CHAIN, CHAIN_CONFIG } = await load(undefined);
    expect(IS_LOCAL_CHAIN).toBe(false);
    expect(CHAIN_CONFIG.explorerUrl).toBe("https://testnet.monadvision.com");
    expect(explorerHref(`${CHAIN_CONFIG.explorerUrl}/tx/0xabc`)).toBe("https://testnet.monadvision.com/tx/0xabc");
  });
});
