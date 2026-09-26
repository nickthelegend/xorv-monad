/**
 * The chain table is protocol surface: a wrong USDC address or EIP-712 name
 * here makes every signed payment invalid, and a silent fallback to the wrong
 * network sends real money somewhere nobody intended. These pin the verified
 * values and the override rules.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_NETWORK,
  MONAD_BLOCK_TIME_MS,
  MONAD_FACILITATOR_URL,
  MONAD_MAINNET,
  MONAD_TESTNET,
  SUPPORTED_NETWORKS,
  chainIdOf,
  isSupportedNetwork,
  networkConfig,
  networkLabel,
  usdcAddress,
  viemChain,
} from "../src/chains.js";
import {
  explorerAddress,
  explorerAgent,
  explorerToken,
  explorerTx,
  shortHex,
} from "../src/explorer.js";

const OVERRIDES = [
  "XORV_RPC_URL",
  "XORV_EXPLORER_URL",
  "XORV_STABLECOIN",
  "XORV_STABLECOIN_NAME",
  "XORV_STABLECOIN_VERSION",
] as const;

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(OVERRIDES.map((k) => [k, process.env[k]]));
  for (const k of OVERRIDES) delete process.env[k];
});
afterEach(() => {
  for (const k of OVERRIDES) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("networks", () => {
  it("defaults to Monad testnet, and knows exactly two networks", () => {
    expect(DEFAULT_NETWORK).toBe("eip155:10143");
    expect(MONAD_TESTNET).toBe("eip155:10143");
    expect(MONAD_MAINNET).toBe("eip155:143");
    expect(SUPPORTED_NETWORKS).toEqual([MONAD_TESTNET, MONAD_MAINNET]);
    expect(isSupportedNetwork(MONAD_TESTNET)).toBe(true);
    expect(isSupportedNetwork(MONAD_MAINNET)).toBe(true);
    expect(isSupportedNetwork("hedera:testnet")).toBe(false);
    expect(isSupportedNetwork("eip155:8453")).toBe(false);
    expect(isSupportedNetwork(undefined)).toBe(false);
  });

  it("carries the verified testnet values", () => {
    const cfg = networkConfig(MONAD_TESTNET);
    expect(cfg).toMatchObject({
      caip2: "eip155:10143",
      chainId: 10143,
      label: "testnet",
      rpcUrl: "https://testnet-rpc.monad.xyz",
      wsUrl: "wss://testnet-rpc.monad.xyz",
      explorerUrl: "https://testnet.monadscan.com",
      facilitatorUrl: "https://x402-facilitator.molandak.org",
      faucets: { mon: "https://faucet.monad.xyz", usdc: "https://faucet.circle.com" },
    });
    expect(cfg.usdc).toEqual({
      address: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
      name: "USDC",
      version: "2",
      decimals: 6,
      symbol: "USDC",
    });
    expect(cfg.erc8004).toEqual({
      identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
    });
  });

  it("carries the verified mainnet values", () => {
    const cfg = networkConfig(MONAD_MAINNET);
    expect(cfg).toMatchObject({
      chainId: 143,
      label: "mainnet",
      rpcUrl: "https://rpc.monad.xyz",
      explorerUrl: "https://monadscan.com",
      faucets: { mon: null, usdc: null },
    });
    expect(cfg.usdc.address).toBe("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
    // "USD Coin" is what older @x402/evm shipped for 143, and it does not match
    // the on-chain DOMAIN_SEPARATOR — every signature made with it reverts.
    expect(cfg.usdc.name).toBe("USDC");
    expect(cfg.usdc.version).toBe("2");
    expect(cfg.erc8004.identity).toBe("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
    expect(cfg.erc8004.reputation).toBe("0x8004BAa17C55a88189AE136b182e5fdA19dE9b63");
    expect(cfg.erc8004.validation).toBe("0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58");
  });

  it("throws on an unsupported network instead of falling back to one", () => {
    // A stale Hedera config must fail at boot, naming the fix.
    expect(() => networkConfig("hedera:testnet")).toThrow(/unsupported network.*eip155:10143/);
    expect(() => networkConfig("eip155:1")).toThrow(/unsupported network/);
    expect(() => usdcAddress("hedera:mainnet")).toThrow(/unsupported network/);
  });

  it("hands out copies, so a caller mutating its config can't corrupt the table", () => {
    const a = networkConfig(MONAD_TESTNET);
    a.usdc.name = "USD Coin";
    a.erc8004.identity = "0x0000000000000000000000000000000000000000";
    const b = networkConfig(MONAD_TESTNET);
    expect(b.usdc.name).toBe("USDC");
    expect(b.erc8004.identity).toBe("0x8004A818BFB912233c491871b3d84c89A494BD9e");
  });

  it("labels mainnet only on an exact match, and never throws for a label", () => {
    expect(networkLabel(MONAD_MAINNET)).toBe("mainnet");
    expect(networkLabel(MONAD_TESTNET)).toBe("testnet");
    expect(networkLabel("something-else")).toBe("testnet");
  });

  it("parses the chain id out of any EIP-155 CAIP-2 id", () => {
    expect(chainIdOf(MONAD_TESTNET)).toBe(10143);
    expect(chainIdOf(MONAD_MAINNET)).toBe(143);
    expect(chainIdOf("eip155:8453")).toBe(8453);
    expect(() => chainIdOf("hedera:testnet")).toThrow(/not an EIP-155/);
    expect(() => chainIdOf("eip155:")).toThrow(/not an EIP-155/);
  });

  it("returns the network's USDC", () => {
    expect(usdcAddress(MONAD_TESTNET)).toBe("0x534b2f3A21130d7a60830c2Df862319e593943A3");
    expect(usdcAddress(MONAD_MAINNET)).toBe("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
  });
});

describe("environment overrides", () => {
  it("reads XORV_RPC_URL per call, without re-importing", () => {
    expect(networkConfig(MONAD_TESTNET).rpcUrl).toBe("https://testnet-rpc.monad.xyz");
    process.env.XORV_RPC_URL = "https://my-node.example/rpc";
    expect(networkConfig(MONAD_TESTNET).rpcUrl).toBe("https://my-node.example/rpc");
    delete process.env.XORV_RPC_URL;
    expect(networkConfig(MONAD_TESTNET).rpcUrl).toBe("https://testnet-rpc.monad.xyz");
  });

  it("reads XORV_EXPLORER_URL per call and strips trailing slashes", () => {
    process.env.XORV_EXPLORER_URL = "https://testnet.monadvision.com///";
    expect(networkConfig(MONAD_TESTNET).explorerUrl).toBe("https://testnet.monadvision.com");
    expect(explorerTx(MONAD_TESTNET, "0xabc")).toBe("https://testnet.monadvision.com/tx/0xabc");
  });

  it("treats a blank override as unset", () => {
    process.env.XORV_RPC_URL = "   ";
    expect(networkConfig(MONAD_TESTNET).rpcUrl).toBe("https://testnet-rpc.monad.xyz");
  });

  it("reads XORV_STABLECOIN per call, checksums it, and keeps the USDC domain unless told otherwise", () => {
    process.env.XORV_STABLECOIN = "0x1111111111111111111111111111111111111111";
    const cfg = networkConfig(MONAD_TESTNET);
    expect(cfg.usdc.address).toBe("0x1111111111111111111111111111111111111111");
    expect(cfg.usdc.name).toBe("USDC");
    expect(usdcAddress(MONAD_TESTNET)).toBe("0x1111111111111111111111111111111111111111");

    process.env.XORV_STABLECOIN = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    process.env.XORV_STABLECOIN_NAME = "Test Dollar";
    process.env.XORV_STABLECOIN_VERSION = "1";
    expect(networkConfig(MONAD_TESTNET).usdc).toMatchObject({
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      name: "Test Dollar",
      version: "1",
    });

    delete process.env.XORV_STABLECOIN;
    // The name/version overrides only apply alongside an address override.
    expect(networkConfig(MONAD_TESTNET).usdc.name).toBe("USDC");
  });

  it("refuses a malformed XORV_STABLECOIN rather than silently pricing in real USDC", () => {
    process.env.XORV_STABLECOIN = "0.0.429274";
    expect(() => networkConfig(MONAD_TESTNET)).toThrow(/XORV_STABLECOIN must be a 0x/);
  });
});

describe("viemChain", () => {
  it("builds a chain with the corrected block time and the configured endpoints", () => {
    const chain = viemChain(MONAD_TESTNET);
    expect(chain.id).toBe(10143);
    expect(chain.blockTime).toBe(MONAD_BLOCK_TIME_MS);
    expect(chain.rpcUrls.default.http).toEqual(["https://testnet-rpc.monad.xyz"]);
    expect(chain.rpcUrls.default.webSocket).toEqual(["wss://testnet-rpc.monad.xyz"]);
    expect(chain.blockExplorers?.default.url).toBe("https://testnet.monadscan.com");
    expect(chain.nativeCurrency.symbol).toBe("MON");
    expect(viemChain(MONAD_MAINNET).id).toBe(143);
  });

  it("applies overrides", () => {
    process.env.XORV_RPC_URL = "https://my-node.example/rpc";
    expect(viemChain(MONAD_MAINNET).rpcUrls.default.http).toEqual(["https://my-node.example/rpc"]);
  });

  it("exposes the hosted facilitator constant", () => {
    expect(MONAD_FACILITATOR_URL).toBe("https://x402-facilitator.molandak.org");
  });
});

describe("explorer links", () => {
  const TX = "0x5f1c7e3b2a9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b";

  it("links transactions verbatim — EVM hashes need no rewriting", () => {
    expect(explorerTx(MONAD_TESTNET, TX)).toBe(`https://testnet.monadscan.com/tx/${TX}`);
    expect(explorerTx(MONAD_MAINNET, TX)).toBe(`https://monadscan.com/tx/${TX}`);
  });

  it("checksums addresses and tokens for display", () => {
    expect(explorerAddress(MONAD_TESTNET, "0xd8da6bf26964af9d7eed9e03e53415d37aa96045")).toBe(
      "https://testnet.monadscan.com/address/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    );
    expect(explorerToken(MONAD_MAINNET, "0x754704bc059f8c67012fed69bc8a327a5aafb603")).toBe(
      "https://monadscan.com/token/0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    );
  });

  it("links an ERC-8004 agent as the Identity Registry NFT page", () => {
    expect(explorerAgent(MONAD_TESTNET, 42)).toBe(
      "https://testnet.monadscan.com/nft/0x8004A818BFB912233c491871b3d84c89A494BD9e/42",
    );
    expect(explorerAgent(MONAD_MAINNET, "10259")).toBe(
      "https://monadscan.com/nft/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/10259",
    );
    expect(explorerAgent(MONAD_MAINNET, 7n)).toMatch(/\/7$/);
  });

  it("throws for an unsupported network rather than inventing a URL", () => {
    expect(() => explorerTx("hedera:testnet", TX)).toThrow(/unsupported network/);
  });
});

describe("shortHex", () => {
  it("keeps the 0x-inclusive head and the tail", () => {
    expect(shortHex("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe("0xd8dA…6045");
    expect(shortHex("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", 10, 6)).toBe("0xd8dA6BF2…A96045");
  });

  it("leaves short values alone", () => {
    expect(shortHex("0x1234")).toBe("0x1234");
    // 11 chars = head 6 + tail 4 + the ellipsis: shortening would hide nothing.
    expect(shortHex("0x123456789")).toBe("0x123456789");
    expect(shortHex("0x1234567890")).toBe("0x1234…7890");
  });
});
