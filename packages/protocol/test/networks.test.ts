import { afterEach, describe, expect, it } from "vitest";
import {
  ARBITRUM_ONE_CAIP2,
  ARBITRUM_SEPOLIA_CAIP2,
  DEFAULT_NETWORK,
  NETWORKS,
  ROBINHOOD_TESTNET_CAIP2,
  chainIdFor,
  explorerName,
  explorerTx,
  networkInfo,
  networkLabel,
  primaryStablecoin,
  rpcUrl,
  stablecoinAddress,
  stablecoinByAddress,
  stablecoinBySymbol,
  stablecoinSymbol,
  stablecoins,
  NITRO_DEVNODE_CAIP2,
} from "../src/constants.js";

const SEPOLIA_USDG = "0xFFC95faa3d63Cde504a05B567C600B78C0b41892";
const SEPOLIA_USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
const ROBINHOOD_USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F";

/**
 * Three Arbitrum chains, each with its own stablecoin list. The USDG domains
 * ("Global Dollar" / "1") were checked against the live contracts'
 * DOMAIN_SEPARATOR() before being written into the table.
 */
describe("networks", () => {
  afterEach(() => {
    delete process.env.XORV_RPC_URL;
    delete process.env.XORV_STABLECOIN;
    delete process.env.XORV_STABLECOIN_NAME;
    delete process.env.XORV_STABLECOIN_VERSION;
    delete process.env.XORV_STABLECOIN_SYMBOL;
  });

  it("defaults to Arbitrum Sepolia", () => {
    expect(DEFAULT_NETWORK).toBe("eip155:421614");
    expect(networkInfo("eip155:1").caip2).toBe(ARBITRUM_SEPOLIA_CAIP2);
  });

  it("answers for Arbitrum Sepolia with its RPC, explorer and label", () => {
    expect(chainIdFor(ARBITRUM_SEPOLIA_CAIP2)).toBe(421614);
    expect(rpcUrl(ARBITRUM_SEPOLIA_CAIP2)).toBe("https://sepolia-rollup.arbitrum.io/rpc");
    expect(networkLabel(ARBITRUM_SEPOLIA_CAIP2)).toBe("arbitrum-sepolia");
    expect(explorerTx(ARBITRUM_SEPOLIA_CAIP2, "0xabc")).toBe("https://sepolia.arbiscan.io/tx/0xabc");
    expect(explorerName(ARBITRUM_SEPOLIA_CAIP2)).toBe("Arbiscan");
  });

  it("answers for Robinhood Chain Testnet", () => {
    expect(chainIdFor(ROBINHOOD_TESTNET_CAIP2)).toBe(46630);
    expect(rpcUrl(ROBINHOOD_TESTNET_CAIP2)).toBe("https://rpc.testnet.chain.robinhood.com");
    expect(networkLabel(ROBINHOOD_TESTNET_CAIP2)).toBe("robinhood-testnet");
    expect(explorerTx(ROBINHOOD_TESTNET_CAIP2, "0x1")).toBe(
      "https://explorer.testnet.chain.robinhood.com/tx/0x1",
    );
    expect(stablecoins(ROBINHOOD_TESTNET_CAIP2).map((s) => s.symbol)).toEqual(["USDG"]);
    expect(stablecoinAddress(ROBINHOOD_TESTNET_CAIP2)).toBe(ROBINHOOD_USDG);
  });

  it("answers for Arbitrum One, with Paxos' mainnet USDG", () => {
    expect(chainIdFor(ARBITRUM_ONE_CAIP2)).toBe(42161);
    expect(explorerTx(ARBITRUM_ONE_CAIP2, "0x1")).toBe("https://arbiscan.io/tx/0x1");
    expect(networkInfo(ARBITRUM_ONE_CAIP2).testnet).toBe(false);
    const [usdg, usdc] = stablecoins(ARBITRUM_ONE_CAIP2);
    expect(usdg!.symbol).toBe("USDG");
    expect(usdg!.address).toBe("0x004B506865409877C9fA29bfb1ebA929984B9bbC");
    expect(usdg!.verified).toBe(true);
    expect(usdc!.address).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
  });

  it("puts USDG first on every network where it exists", () => {
    for (const network of Object.keys(NETWORKS)) {
      if (NETWORKS[network]!.stablecoins.length === 0) continue; // the local dev node
      expect(primaryStablecoin(network).symbol).toBe("USDG");
    }
  });

  it("carries each token's EIP-712 domain, since USDG has no version() to read", () => {
    expect(stablecoinBySymbol(ARBITRUM_SEPOLIA_CAIP2, "usdg")!.eip712).toEqual({
      name: "Global Dollar",
      version: "1",
    });
    expect(stablecoinBySymbol(ARBITRUM_SEPOLIA_CAIP2, "USDC")!.eip712).toEqual({
      name: "USD Coin",
      version: "2",
    });
  });

  it("looks tokens up by address case-insensitively, and names unknown ones generically", () => {
    expect(stablecoinByAddress(ARBITRUM_SEPOLIA_CAIP2, SEPOLIA_USDC.toLowerCase())!.symbol).toBe("USDC");
    expect(stablecoinSymbol(ARBITRUM_SEPOLIA_CAIP2, SEPOLIA_USDG)).toBe("USDG");
    expect(stablecoinSymbol(ARBITRUM_SEPOLIA_CAIP2, "0x1111111111111111111111111111111111111111")).toBe(
      "stablecoin",
    );
  });

  it("lets XORV_STABLECOIN pick the default by symbol or address, keeping the others", () => {
    process.env.XORV_STABLECOIN = "USDC";
    expect(stablecoins(ARBITRUM_SEPOLIA_CAIP2).map((s) => s.symbol)).toEqual(["USDC", "USDG"]);
    process.env.XORV_STABLECOIN = SEPOLIA_USDC.toLowerCase();
    expect(stablecoinAddress(ARBITRUM_SEPOLIA_CAIP2)).toBe(SEPOLIA_USDC);
  });

  it("ignores a symbol the network doesn't have rather than pricing in nothing", () => {
    process.env.XORV_STABLECOIN = "USDC";
    expect(stablecoins(ROBINHOOD_TESTNET_CAIP2).map((s) => s.symbol)).toEqual(["USDG"]);
  });

  it("accepts an unknown token address with an explicitly configured domain", () => {
    process.env.XORV_RPC_URL = "https://my.rpc";
    process.env.XORV_STABLECOIN = "0x1111111111111111111111111111111111111111";
    process.env.XORV_STABLECOIN_NAME = "Test Dollar";
    process.env.XORV_STABLECOIN_VERSION = "1";
    process.env.XORV_STABLECOIN_SYMBOL = "TUSD";
    expect(rpcUrl(ARBITRUM_SEPOLIA_CAIP2)).toBe("https://my.rpc");
    const [custom, ...rest] = stablecoins(ARBITRUM_SEPOLIA_CAIP2);
    expect(custom).toMatchObject({
      symbol: "TUSD",
      address: "0x1111111111111111111111111111111111111111",
      eip712: { name: "Test Dollar", version: "1" },
      verified: false,
    });
    expect(rest.map((s) => s.symbol)).toEqual(["USDG", "USDC"]);
  });

  it("every network entry is keyed by its own CAIP-2 id and has well-formed tokens", () => {
    for (const [key, info] of Object.entries(NETWORKS)) {
      expect(info.caip2).toBe(key);
      expect(chainIdFor(key)).toBe(info.chainId);
      // Only the local Nitro dev node has none of its own (XORV_STABLECOIN supplies one).
      if (key !== NITRO_DEVNODE_CAIP2) expect(info.stablecoins.length).toBeGreaterThan(0);
      for (const token of info.stablecoins) {
        expect(token.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(token.decimals).toBe(6);
        expect(token.eip712.name).toBeTruthy();
        expect(token.eip712.version).toBeTruthy();
      }
    }
  });
});

describe("the local Nitro dev node", () => {
  it("has no stablecoin of its own and takes one from XORV_STABLECOIN", () => {
    expect(stablecoins(NITRO_DEVNODE_CAIP2)).toEqual([]);
    process.env.XORV_STABLECOIN = "0x986931f67aFBBD833bC5f8347F369744AA851Db8";
    process.env.XORV_STABLECOIN_NAME = "Global Dollar";
    process.env.XORV_STABLECOIN_VERSION = "1";
    process.env.XORV_STABLECOIN_SYMBOL = "USDG";
    try {
      const [t] = stablecoins(NITRO_DEVNODE_CAIP2);
      expect(t).toMatchObject({ symbol: "USDG", eip712: { name: "Global Dollar", version: "1" }, verified: false });
      expect(chainIdFor(NITRO_DEVNODE_CAIP2)).toBe(412346);
    } finally {
      delete process.env.XORV_STABLECOIN;
      delete process.env.XORV_STABLECOIN_NAME;
      delete process.env.XORV_STABLECOIN_VERSION;
      delete process.env.XORV_STABLECOIN_SYMBOL;
    }
  });
});
