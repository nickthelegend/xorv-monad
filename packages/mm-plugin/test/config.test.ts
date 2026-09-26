import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROKER_URL,
  networkForChainId,
  parseChainId,
  parseMaxUsd,
  parseStars,
  parseTimeoutSeconds,
  resolveBrokerUrl,
  targetChainIdOf,
} from "../src/lib/config.js";
import { XorvPluginError } from "../src/lib/errors.js";

describe("resolveBrokerUrl", () => {
  it("prefers the flag, then XORV_BROKER_URL, then localhost", () => {
    expect(resolveBrokerUrl("https://b.example/", { XORV_BROKER_URL: "https://env.example" })).toBe("https://b.example");
    expect(resolveBrokerUrl(undefined, { XORV_BROKER_URL: "https://env.example/" })).toBe("https://env.example");
    expect(resolveBrokerUrl("  ", {})).toBe(DEFAULT_BROKER_URL);
  });

  it("refuses non-http URLs", () => {
    expect(() => resolveBrokerUrl("ftp://x", {})).toThrow(/http or https/);
    expect(() => resolveBrokerUrl("not a url", {})).toThrow(XorvPluginError);
  });
});

describe("chains", () => {
  it("targets exactly Monad testnet and mainnet", () => {
    expect(networkForChainId(10143)).toBe("eip155:10143");
    expect(networkForChainId(143)).toBe("eip155:143");
    expect(networkForChainId(8453)).toBeNull();
    expect(targetChainIdOf("eip155:10143")).toBe(10143);
    expect(targetChainIdOf("eip155:1")).toBeNull();
    expect(targetChainIdOf("hedera:testnet")).toBeNull();
  });

  it("parses --chain-id", () => {
    expect(parseChainId(undefined)).toBeNull();
    expect(parseChainId("143")).toBe(143);
    expect(() => parseChainId("1")).toThrow(/not a Monad chain/);
  });
});

describe("parseMaxUsd", () => {
  it("reads dollars into micro-USD with a $0.05 default", () => {
    expect(parseMaxUsd(undefined)).toBe(50_000);
    expect(parseMaxUsd("$0.10")).toBe(100_000);
    expect(parseMaxUsd("0.001")).toBe(1_000);
  });

  it("refuses zero, negatives and garbage", () => {
    for (const bad of ["0", "-1", "abc"]) {
      expect(() => parseMaxUsd(bad)).toThrow(XorvPluginError);
    }
  });
});

describe("parseStars", () => {
  it("maps 1-5 stars onto the 0-100 ERC-8004 scale", () => {
    expect(parseStars("1")).toEqual({ stars: 1, value: 20 });
    expect(parseStars("5")).toEqual({ stars: 5, value: 100 });
  });

  it("refuses anything else", () => {
    for (const bad of ["0", "6", "4.5", "", undefined, "five"]) {
      expect(() => parseStars(bad)).toThrow(/1 to 5/);
    }
  });
});

describe("parseTimeoutSeconds", () => {
  it("defaults and bounds the wait", () => {
    expect(parseTimeoutSeconds(undefined)).toBe(600);
    expect(parseTimeoutSeconds("30")).toBe(30);
    expect(() => parseTimeoutSeconds("1")).toThrow(XorvPluginError);
    expect(() => parseTimeoutSeconds("99999")).toThrow(XorvPluginError);
  });
});
