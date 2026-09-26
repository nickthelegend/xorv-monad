/**
 * Key parsing is the one place a wrong guess surfaces much later as
 * INVALID_SIGNATURE on a transaction that otherwise looks fine, so both curves
 * and every encoding the ecosystem hands out are covered explicitly.
 */

import { describe, expect, it } from "vitest";
import { PrivateKey } from "@hiero-ledger/sdk";
import { isAccountId, parsePrivateKey } from "../src/hedera.js";
import {
  HEDERA_MAINNET_CAIP2,
  HEDERA_TESTNET_CAIP2,
  hashscanAccount,
  hashscanTopic,
  hashscanTx,
  mirrorNodeUrl,
  networkLabel,
  usdcTokenId,
} from "../src/constants.js";

describe("parsePrivateKey", () => {
  it("parses a 0x-prefixed ECDSA key, which is what the Hedera portal shows", () => {
    const generated = PrivateKey.generateECDSA();
    const parsed = parsePrivateKey(`0x${generated.toStringRaw()}`);
    expect(parsed.publicKey.toStringRaw()).toBe(generated.publicKey.toStringRaw());
  });

  it("parses a bare 64-char hex ECDSA key", () => {
    const generated = PrivateKey.generateECDSA();
    const parsed = parsePrivateKey(generated.toStringRaw());
    expect(parsed.publicKey.toStringRaw()).toBe(generated.publicKey.toStringRaw());
  });

  it("parses DER-encoded ED25519", () => {
    const generated = PrivateKey.generateED25519();
    const parsed = parsePrivateKey(generated.toStringDer());
    expect(parsed.publicKey.toStringRaw()).toBe(generated.publicKey.toStringRaw());
  });

  it("parses DER-encoded ECDSA", () => {
    const generated = PrivateKey.generateECDSA();
    const parsed = parsePrivateKey(generated.toStringDer());
    expect(parsed.publicKey.toStringRaw()).toBe(generated.publicKey.toStringRaw());
  });

  it("tolerates surrounding whitespace, which pasted keys routinely carry", () => {
    const generated = PrivateKey.generateECDSA();
    const parsed = parsePrivateKey(`  ${generated.toStringRaw()}\n`);
    expect(parsed.publicKey.toStringRaw()).toBe(generated.publicKey.toStringRaw());
  });

  it("fails loudly on an empty or unparseable key instead of returning something wrong", () => {
    expect(() => parsePrivateKey("")).toThrow(/empty/);
    expect(() => parsePrivateKey("   ")).toThrow(/empty/);
    expect(() => parsePrivateKey("not-a-key")).toThrow(/could not parse/);
  });
});

describe("isAccountId", () => {
  it("accepts well-formed shard.realm.num ids", () => {
    expect(isAccountId("0.0.1234")).toBe(true);
    expect(isAccountId("0.0.9842030")).toBe(true);
    expect(isAccountId(" 0.0.1 ")).toBe(true);
  });

  it("rejects EVM addresses and malformed ids", () => {
    expect(isAccountId("0xc9d5aba4f387dbc4e666e992a1c934407d413025")).toBe(false);
    expect(isAccountId("0.0")).toBe(false);
    expect(isAccountId("abc")).toBe(false);
    expect(isAccountId("")).toBe(false);
  });
});

describe("network constants", () => {
  it("maps each network to its own USDC token and mirror node", () => {
    expect(usdcTokenId(HEDERA_TESTNET_CAIP2)).toBe("0.0.429274");
    expect(usdcTokenId(HEDERA_MAINNET_CAIP2)).toBe("0.0.456858");
    expect(mirrorNodeUrl(HEDERA_TESTNET_CAIP2)).toContain("testnet");
    expect(mirrorNodeUrl(HEDERA_MAINNET_CAIP2)).toContain("mainnet");
  });

  it("defaults an unknown network to testnet rather than to mainnet", () => {
    // Failing safe matters here: an unrecognised value must never send a real
    // payment to a mainnet token id.
    expect(usdcTokenId("hedera:previewnet")).toBe("0.0.429274");
    expect(networkLabel("hedera:previewnet")).toBe("testnet");
  });
});

describe("hashscan links", () => {
  it("rewrites an SDK transaction id into HashScan's dashed form", () => {
    expect(hashscanTx(HEDERA_TESTNET_CAIP2, "0.0.9842030@1785475549.131327424")).toBe(
      "https://hashscan.io/testnet/transaction/0.0.9842030-1785475549-131327424",
    );
  });

  it("builds mainnet links off the same id shape", () => {
    expect(hashscanTx(HEDERA_MAINNET_CAIP2, "0.0.1@2.3")).toContain("hashscan.io/mainnet");
  });

  it("builds account and topic links", () => {
    expect(hashscanAccount(HEDERA_TESTNET_CAIP2, "0.0.9848438")).toBe(
      "https://hashscan.io/testnet/account/0.0.9848438",
    );
    expect(hashscanTopic(HEDERA_TESTNET_CAIP2, "0.0.9848247")).toBe(
      "https://hashscan.io/testnet/topic/0.0.9848247",
    );
  });
});
