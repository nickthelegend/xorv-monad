/**
 * Key and address handling.
 *
 * This is deliberately the smallest test file in the package, and that is the
 * finding. Its Hedera predecessor spent a hundred lines on which of three
 * private-key encodings a string might be, and on whether an account had opted
 * in to the token it was about to be paid in. Neither question exists on an EVM
 * chain: a private key is 32 bytes of hex, and any address can receive any
 * ERC-20 having done nothing at all.
 *
 * What is left is worth pinning anyway, because a key that parses when it
 * should not produces a signature nobody can verify, and the error surfaces
 * nowhere near the cause.
 */

import { describe, expect, it } from "vitest";
import {
  accountFor,
  evmChain,
  isAccountAddress,
  normalizeAddress,
  parsePrivateKey,
  shortAddress,
} from "../src/chain.js";
import {
  MONAD_MAINNET_CAIP2,
  MONAD_TESTNET_CAIP2,
  MONAD_TESTNET_CHAIN_ID,
} from "../src/constants.js";

// A throwaway key with no funds on any network, used only to check parsing and
// address derivation. Deriving the address from a known key is what proves the
// parse produced the right 32 bytes rather than merely some 32 bytes.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("parsePrivateKey", () => {
  it("accepts a key with or without the 0x, because tooling prints it both ways", () => {
    expect(parsePrivateKey(KEY)).toBe(KEY);
    expect(parsePrivateKey(KEY.slice(2))).toBe(KEY);
    expect(parsePrivateKey(`  ${KEY}  `)).toBe(KEY);
  });

  it("derives the address the key actually controls", () => {
    expect(accountFor(KEY).address).toBe(ADDRESS);
  });

  it("rejects a key of the wrong length instead of signing with garbage", () => {
    expect(() => parsePrivateKey("0xdeadbeef")).toThrow(/32 bytes of hex/);
    expect(() => parsePrivateKey(`${KEY}00`)).toThrow(/32 bytes of hex/);
  });

  it("rejects a Hedera DER key, the likeliest thing to be pasted in by mistake", () => {
    expect(() => parsePrivateKey("0.0.9848440")).toThrow(/32 bytes of hex/);
    // A DER-encoded ED25519 key is the 16-byte OID prefix plus the 32-byte
    // scalar: 96 hex characters, so it fails on length. Note what this does
    // *not* protect against — the prefix is itself valid hex, so a key
    // truncated to its first 64 characters would parse cleanly and derive a
    // real, wrong address. Length is the only signal available; there is no
    // way to tell 32 bytes of one key from 32 bytes of another.
    const der = `302e020100300506032b657004220420${"ab".repeat(32)}`;
    expect(der).toHaveLength(96);
    expect(() => parsePrivateKey(der)).toThrow(/32 bytes of hex/);
  });

  it("rejects an empty key with a distinct message", () => {
    expect(() => parsePrivateKey("   ")).toThrow(/empty private key/);
  });
});

describe("address handling", () => {
  it("accepts a valid address in any case", () => {
    expect(isAccountAddress(ADDRESS)).toBe(true);
    expect(isAccountAddress(ADDRESS.toLowerCase())).toBe(true);
  });

  it("rejects a Hedera account id, which is the likeliest wrong paste", () => {
    expect(isAccountAddress("0.0.9848440")).toBe(false);
    expect(normalizeAddress("0.0.9848440")).toBeNull();
  });

  it("normalizes to the checksummed form so one address has one spelling", () => {
    expect(normalizeAddress(ADDRESS.toLowerCase())).toBe(ADDRESS);
  });

  it("shortens for display without mangling something already short", () => {
    expect(shortAddress(ADDRESS)).toBe("0x7099…79C8");
    expect(shortAddress("0x1234")).toBe("0x1234");
  });
});

describe("evmChain", () => {
  it("derives the EVM chain id from the CAIP-2 network", () => {
    expect(evmChain(MONAD_TESTNET_CAIP2).id).toBe(MONAD_TESTNET_CHAIN_ID);
    expect(evmChain(MONAD_MAINNET_CAIP2).id).toBe(143);
  });

  it("meters gas in MON on every network", () => {
    for (const network of [MONAD_TESTNET_CAIP2, MONAD_MAINNET_CAIP2]) {
      expect(evmChain(network).nativeCurrency).toMatchObject({ symbol: "MON", decimals: 18 });
    }
  });

  it("names the explorer per network", () => {
    expect(evmChain(MONAD_TESTNET_CAIP2).blockExplorers?.default.name).toBe("Monadscan");
    expect(evmChain(MONAD_MAINNET_CAIP2).blockExplorers?.default.url).toBe("https://monadscan.com");
  });

  it("marks testnet as testnet, so a wallet cannot silently show mainnet chrome", () => {
    expect(evmChain(MONAD_TESTNET_CAIP2).testnet).toBe(true);
    expect(evmChain(MONAD_MAINNET_CAIP2).testnet).toBe(false);
  });
});
