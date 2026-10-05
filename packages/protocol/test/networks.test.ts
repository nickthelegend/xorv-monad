import { afterEach, describe, expect, it } from "vitest";
import {
  ANVIL_CAIP2,
  DEFAULT_NETWORK,
  GAS_TOKEN_SYMBOL,
  MONAD_MAINNET_CAIP2,
  MONAD_TESTNET_CAIP2,
  NETWORKS,
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
} from "../src/constants.js";

const TESTNET_AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const TESTNET_USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

/**
 * Monad testnet and mainnet, each with AUSD first and USDC second. The testnet
 * domains ("Agora Dollar" / "1", "USDC" / "2") were checked against the live
 * contracts' DOMAIN_SEPARATOR() before being written into the table.
 */
describe("networks", () => {
  afterEach(() => {
    delete process.env.XORV_RPC_URL;
    delete process.env.XORV_STABLECOIN;
    delete process.env.XORV_STABLECOIN_NAME;
    delete process.env.XORV_STABLECOIN_VERSION;
    delete process.env.XORV_STABLECOIN_SYMBOL;
  });

  it("defaults to Monad testnet, and gas is MON", () => {
    expect(DEFAULT_NETWORK).toBe("eip155:10143");
    expect(networkInfo("eip155:1").caip2).toBe(MONAD_TESTNET_CAIP2);
    expect(GAS_TOKEN_SYMBOL).toBe("MON");
  });

  it("answers for Monad testnet with its RPC, explorer and label", () => {
    expect(chainIdFor(MONAD_TESTNET_CAIP2)).toBe(10143);
    expect(rpcUrl(MONAD_TESTNET_CAIP2)).toBe("https://testnet-rpc.monad.xyz");
    expect(networkLabel(MONAD_TESTNET_CAIP2)).toBe("monad-testnet");
    expect(explorerTx(MONAD_TESTNET_CAIP2, "0xabc")).toBe("https://testnet.monadscan.com/tx/0xabc");
    expect(explorerName(MONAD_TESTNET_CAIP2)).toBe("Monadscan");
  });

  it("answers for Monad mainnet, with Agora's mainnet AUSD", () => {
    expect(chainIdFor(MONAD_MAINNET_CAIP2)).toBe(143);
    expect(explorerTx(MONAD_MAINNET_CAIP2, "0x1")).toBe("https://monadscan.com/tx/0x1");
    expect(networkInfo(MONAD_MAINNET_CAIP2).testnet).toBe(false);
    const [ausd, usdc] = stablecoins(MONAD_MAINNET_CAIP2);
    expect(ausd!.symbol).toBe("AUSD");
    expect(ausd!.address).toBe("0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a");
    expect(usdc!.address).toBe("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
  });

  it("puts AUSD first on every network", () => {
    for (const network of Object.keys(NETWORKS)) {
      if (NETWORKS[network]!.stablecoins.length === 0) continue; // the local dev node
      expect(primaryStablecoin(network).symbol).toBe("AUSD");
    }
  });

  it("carries each token's EIP-712 domain, which is not always its name()", () => {
    // AUSD's name() is "AUSD", but it signs under "Agora Dollar".
    expect(stablecoinBySymbol(MONAD_TESTNET_CAIP2, "ausd")!.eip712).toEqual({
      name: "Agora Dollar",
      version: "1",
    });
    expect(stablecoinBySymbol(MONAD_TESTNET_CAIP2, "USDC")!.eip712).toEqual({
      name: "USDC",
      version: "2",
    });
  });

  it("looks tokens up by address case-insensitively, and names unknown ones generically", () => {
    expect(stablecoinByAddress(MONAD_TESTNET_CAIP2, TESTNET_USDC.toLowerCase())!.symbol).toBe("USDC");
    expect(stablecoinSymbol(MONAD_TESTNET_CAIP2, TESTNET_AUSD)).toBe("AUSD");
    expect(stablecoinSymbol(MONAD_TESTNET_CAIP2, "0x1111111111111111111111111111111111111111")).toBe(
      "stablecoin",
    );
  });

  it("lets XORV_STABLECOIN pick the default by symbol or address, keeping the others", () => {
    process.env.XORV_STABLECOIN = "USDC";
    expect(stablecoins(MONAD_TESTNET_CAIP2).map((s) => s.symbol)).toEqual(["USDC", "AUSD"]);
    process.env.XORV_STABLECOIN = TESTNET_USDC.toLowerCase();
    expect(stablecoinAddress(MONAD_TESTNET_CAIP2)).toBe(TESTNET_USDC);
  });

  it("ignores a symbol the network doesn't have rather than pricing in nothing", () => {
    process.env.XORV_STABLECOIN = "USDG";
    expect(stablecoins(MONAD_TESTNET_CAIP2).map((s) => s.symbol)).toEqual(["AUSD", "USDC"]);
  });

  it("accepts an unknown token address with an explicitly configured domain", () => {
    process.env.XORV_RPC_URL = "https://my.rpc";
    process.env.XORV_STABLECOIN = "0x1111111111111111111111111111111111111111";
    process.env.XORV_STABLECOIN_NAME = "Test Dollar";
    process.env.XORV_STABLECOIN_VERSION = "1";
    process.env.XORV_STABLECOIN_SYMBOL = "TUSD";
    expect(rpcUrl(MONAD_TESTNET_CAIP2)).toBe("https://my.rpc");
    const [custom, ...rest] = stablecoins(MONAD_TESTNET_CAIP2);
    expect(custom).toMatchObject({
      symbol: "TUSD",
      address: "0x1111111111111111111111111111111111111111",
      eip712: { name: "Test Dollar", version: "1" },
      verified: false,
    });
    expect(rest.map((s) => s.symbol)).toEqual(["AUSD", "USDC"]);
  });

  it("every network entry is keyed by its own CAIP-2 id and has well-formed tokens", () => {
    for (const [key, info] of Object.entries(NETWORKS)) {
      expect(info.caip2).toBe(key);
      expect(chainIdFor(key)).toBe(info.chainId);
      // Only the local Anvil node has none of its own (XORV_STABLECOIN supplies one).
      if (key !== ANVIL_CAIP2) expect(info.stablecoins.length).toBeGreaterThan(0);
      for (const token of info.stablecoins) {
        expect(token.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(token.decimals).toBe(6);
        expect(token.eip712.name).toBeTruthy();
        expect(token.eip712.version).toBeTruthy();
      }
    }
  });
});

describe("the local Anvil node", () => {
  it("has no stablecoin of its own and takes one from XORV_STABLECOIN", () => {
    expect(stablecoins(ANVIL_CAIP2)).toEqual([]);
    process.env.XORV_STABLECOIN = "0x986931f67aFBBD833bC5f8347F369744AA851Db8";
    process.env.XORV_STABLECOIN_NAME = "USD Coin";
    process.env.XORV_STABLECOIN_VERSION = "2";
    process.env.XORV_STABLECOIN_SYMBOL = "USDC";
    try {
      const [t] = stablecoins(ANVIL_CAIP2);
      expect(t).toMatchObject({ symbol: "USDC", eip712: { name: "USD Coin", version: "2" }, verified: false });
      expect(chainIdFor(ANVIL_CAIP2)).toBe(31337);
    } finally {
      delete process.env.XORV_STABLECOIN;
      delete process.env.XORV_STABLECOIN_NAME;
      delete process.env.XORV_STABLECOIN_VERSION;
      delete process.env.XORV_STABLECOIN_SYMBOL;
    }
  });
});
