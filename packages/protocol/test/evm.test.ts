/**
 * Key parsing and address handling are where a wrong guess surfaces much
 * later — as funds sent to an address nobody controls, or a settled payment
 * that never attaches to its job because two spellings of one address didn't
 * compare equal. So every input shape the ecosystem hands out is pinned here,
 * including the Hedera-era ones that must be refused.
 */

import { describe, expect, it } from "vitest";
import { encodeAbiParameters, getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET } from "../src/chains.js";
import {
  ERC20_ABI,
  GAS_HEADROOM_PERCENT,
  accountFromKey,
  fetchBalances,
  formatMon,
  isEvmAddress,
  normalizeAddress,
  parsePrivateKey,
  publicClientFor,
  sameAddress,
  walletClientFor,
  withGasHeadroom,
  withSignerLock,
} from "../src/evm.js";
import { RpcError, fakeRpc, hex } from "./support/fake-rpc.js";

// Shaped exactly like the Hedera SDK's PKCS#8 DER exports (same prefixes); throwaway key bytes.
const HEDERA_DER_ED25519 =
  "302e020100300506032b65700422042091132178e72057a1d7528025956fe39b0b847f200ab59b2fdd367017f3087137";
const HEDERA_DER_ECDSA =
  "3030020100300706052b8104000a042204208b0a8c0a2e1b8f1a4e2c1d7c5d4b3a2918171615141312111009080706050403";

describe("parsePrivateKey", () => {
  it("accepts a 0x-prefixed 32-byte hex key", () => {
    const key = generatePrivateKey();
    expect(parsePrivateKey(key)).toBe(key);
  });

  it("accepts the same key without the 0x prefix", () => {
    const key = generatePrivateKey();
    expect(parsePrivateKey(key.slice(2))).toBe(key);
  });

  it("normalizes case and a 0X prefix", () => {
    const key = generatePrivateKey();
    expect(parsePrivateKey(`0X${key.slice(2).toUpperCase()}`)).toBe(key);
  });

  it("tolerates surrounding whitespace, which pasted keys routinely carry", () => {
    const key = generatePrivateKey();
    expect(parsePrivateKey(`  ${key}\n`)).toBe(key);
  });

  it("parses a Hedera portal ECDSA hex key unchanged — same secp256k1 key, now an EVM account", () => {
    const portalHex = "0x8b0a8c0a2e1b8f1a4e2c1d7c5d4b3a2918171615141312111009080706050403";
    expect(parsePrivateKey(portalHex)).toBe(portalHex);
  });

  it("refuses a DER-encoded ED25519 key, saying Hedera ED25519 keys cannot be reused on Monad", () => {
    expect(() => parsePrivateKey(HEDERA_DER_ED25519)).toThrow(/ED25519/);
    expect(() => parsePrivateKey(HEDERA_DER_ED25519)).toThrow(/Hedera ED25519 keys cannot be reused on Monad/);
    expect(() => parsePrivateKey(`0x${HEDERA_DER_ED25519}`)).toThrow(/cannot be reused on Monad/);
  });

  it("refuses a DER-encoded ECDSA key and points at the raw hex instead", () => {
    expect(() => parsePrivateKey(HEDERA_DER_ECDSA)).toThrow(/DER-encoded ECDSA/);
    expect(() => parsePrivateKey(HEDERA_DER_ECDSA)).toThrow(/last 64 hex/);
  });

  it("refuses other DER shapes with the Hedera hint", () => {
    expect(() => parsePrivateKey(`3077020101${"ab".repeat(40)}`)).toThrow(/DER-encoded key.*cannot be reused on Monad/);
  });

  it("fails loudly on an empty or unparseable key instead of returning something wrong", () => {
    expect(() => parsePrivateKey("")).toThrow(/empty/);
    expect(() => parsePrivateKey("   ")).toThrow(/empty/);
    expect(() => parsePrivateKey("not-a-key")).toThrow(/could not parse/);
    expect(() => parsePrivateKey("0x1234")).toThrow(/could not parse/);
    expect(() => parsePrivateKey(`0x${"g".repeat(64)}`)).toThrow(/could not parse/);
  });

  it("refuses values outside the secp256k1 key range", () => {
    expect(() => parsePrivateKey(`0x${"0".repeat(64)}`)).toThrow(/outside the secp256k1 key range/);
    expect(() => parsePrivateKey(`0x${"f".repeat(64)}`)).toThrow(/outside the secp256k1 key range/);
  });
});

describe("accountFromKey", () => {
  it("derives the same address viem does, with a nonce manager attached", () => {
    const key = generatePrivateKey();
    const account = accountFromKey(key.slice(2));
    expect(account.address).toBe(privateKeyToAccount(key).address);
    expect(account.nonceManager).toBeDefined();
  });

  it("propagates the parse error", () => {
    expect(() => accountFromKey(HEDERA_DER_ED25519)).toThrow(/cannot be reused on Monad/);
  });
});

describe("addresses", () => {
  const CHECKSUMMED = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

  it("normalizes lowercase and checksummed input to the checksummed form", () => {
    expect(normalizeAddress(CHECKSUMMED.toLowerCase())).toBe(CHECKSUMMED);
    expect(normalizeAddress(CHECKSUMMED)).toBe(CHECKSUMMED);
    expect(normalizeAddress(`  ${CHECKSUMMED}  `)).toBe(CHECKSUMMED);
  });

  it("refuses a mixed-case address with a bad checksum — that is what a typo looks like", () => {
    const typo = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96046";
    expect(() => normalizeAddress(typo)).toThrow(/invalid checksum/);
    expect(isEvmAddress(typo)).toBe(false);
  });

  it("refuses non-addresses, including Hedera account ids", () => {
    expect(() => normalizeAddress("0.0.9848438")).toThrow(/not an EVM address/);
    expect(() => normalizeAddress("0x1234")).toThrow(/not an EVM address/);
    expect(() => normalizeAddress("")).toThrow(/not an EVM address/);
  });

  it("isEvmAddress accepts EVM addresses and rejects Hedera ids", () => {
    expect(isEvmAddress(CHECKSUMMED)).toBe(true);
    expect(isEvmAddress(CHECKSUMMED.toLowerCase())).toBe(true);
    expect(isEvmAddress(` ${CHECKSUMMED} `)).toBe(true);
    expect(isEvmAddress("0.0.1234")).toBe(false);
    expect(isEvmAddress("abc")).toBe(false);
    expect(isEvmAddress("")).toBe(false);
  });

  it("sameAddress compares case-insensitively", () => {
    expect(sameAddress(CHECKSUMMED, CHECKSUMMED.toLowerCase())).toBe(true);
    expect(sameAddress(CHECKSUMMED.toUpperCase().replace("0X", "0x"), CHECKSUMMED)).toBe(true);
    expect(sameAddress(` ${CHECKSUMMED}`, CHECKSUMMED)).toBe(true);
    expect(sameAddress(CHECKSUMMED, "0x0000000000000000000000000000000000000001")).toBe(false);
  });

  it("sameAddress is never true for missing or non-address values", () => {
    expect(sameAddress(undefined, undefined)).toBe(false);
    expect(sameAddress(null, CHECKSUMMED)).toBe(false);
    expect(sameAddress("", "")).toBe(false);
    expect(sameAddress("0.0.1", "0.0.1")).toBe(false);
  });
});

describe("clients", () => {
  it("builds a public client on the configured chain", () => {
    const client = publicClientFor(MONAD_TESTNET);
    expect(client.chain?.id).toBe(10143);
  });

  it("builds a wallet client that can also read", () => {
    const account = accountFromKey(generatePrivateKey());
    const wallet = walletClientFor(MONAD_TESTNET, account);
    expect(wallet.account.address).toBe(account.address);
    expect(typeof wallet.readContract).toBe("function");
    expect(typeof wallet.writeContract).toBe("function");
  });

  it("refuses an unsupported network", () => {
    expect(() => publicClientFor("hedera:testnet")).toThrow(/unsupported network/);
  });
});

describe("fetchBalances", () => {
  const owner = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

  it("reads MON via eth_getBalance and USDC via balanceOf on the network's USDC", async () => {
    const { transport, calls } = fakeRpc({
      eth_getBalance: () => hex(1_500_000_000_000_000_000n),
      eth_call: ([tx]) => {
        const call = tx as { to: string; data: string };
        expect(getAddress(call.to)).toBe("0x534b2f3A21130d7a60830c2Df862319e593943A3");
        // balanceOf(address) selector, owner checksummed into the calldata.
        expect(call.data.startsWith("0x70a08231")).toBe(true);
        expect(call.data.toLowerCase()).toContain(owner.slice(2));
        return encodeAbiParameters([{ type: "uint256" }], [25_000n]);
      },
    });
    const balances = await fetchBalances(MONAD_TESTNET, owner, { transport });
    expect(balances).toEqual({ monWei: "1500000000000000000", usdcUnits: "25000" });
    expect(calls.map((c) => c.method).sort()).toEqual(["eth_call", "eth_getBalance"]);
  });

  it("throws on an RPC error rather than reporting a zero balance", async () => {
    const { transport } = fakeRpc({
      eth_getBalance: () => {
        throw new RpcError("upstream unavailable");
      },
      eth_call: () => encodeAbiParameters([{ type: "uint256" }], [0n]),
    });
    await expect(fetchBalances(MONAD_TESTNET, owner, { transport })).rejects.toThrow(/upstream unavailable/);
  });

  it("refuses a malformed address before touching the network", async () => {
    const { transport, calls } = fakeRpc({});
    await expect(fetchBalances(MONAD_TESTNET, "0.0.1234", { transport })).rejects.toThrow(/not an EVM address/);
    expect(calls).toHaveLength(0);
  });

  it("exposes the ERC-20 slice the CLI needs", () => {
    expect(ERC20_ABI.map((f) => f.name)).toEqual(["balanceOf", "decimals", "symbol", "transfer"]);
  });
});

describe("formatMon", () => {
  it("renders whole and fractional MON, truncated rather than rounded up", () => {
    expect(formatMon("0")).toBe("0 MON");
    expect(formatMon(10n ** 18n)).toBe("1 MON");
    expect(formatMon("1500000000000000000")).toBe("1.5 MON");
    expect(formatMon(1_234_567_890_000_000_000n)).toBe("1.2345 MON");
    expect(formatMon(999_999_999_999_999_999n)).toBe("0.999999 MON");
    expect(formatMon(21_000n * 102_000_000_000n)).toBe("0.002142 MON");
  });

  it("marks dust instead of printing it as zero", () => {
    expect(formatMon(1n)).toBe("<0.000001 MON");
  });

  it("handles negatives (e.g. a balance delta)", () => {
    expect(formatMon(-(10n ** 18n))).toBe("-1 MON");
  });
});

describe("withGasHeadroom", () => {
  it("adds the agreed percentage and rounds up", () => {
    expect(GAS_HEADROOM_PERCENT).toBe(15);
    expect(withGasHeadroom(100_000n)).toBe(115_000n);
    expect(withGasHeadroom(141_600n)).toBe(162_840n);
    // 1 * 1.15 = 1.15 → 2: never round a gas limit down.
    expect(withGasHeadroom(1n)).toBe(2n);
  });
});

describe("withSignerLock", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("runs tasks for one signer strictly in order, even when later ones are faster", async () => {
    const order: string[] = [];
    const address = "0x00000000000000000000000000000000000000aa";
    await Promise.all([
      withSignerLock(address, async () => {
        await sleep(30);
        order.push("a");
      }),
      withSignerLock(address.toUpperCase().replace("0X", "0x"), async () => {
        order.push("b");
      }),
      withSignerLock(address, async () => {
        await sleep(5);
        order.push("c");
      }),
    ]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("lets different signers proceed concurrently", async () => {
    const order: string[] = [];
    await Promise.all([
      withSignerLock("0x00000000000000000000000000000000000000b1", async () => {
        await sleep(30);
        order.push("slow");
      }),
      withSignerLock("0x00000000000000000000000000000000000000b2", async () => {
        order.push("fast");
      }),
    ]);
    expect(order).toEqual(["fast", "slow"]);
  });

  it("does not let one failed send wedge the queue behind it", async () => {
    const address = "0x00000000000000000000000000000000000000cc";
    const failed = withSignerLock(address, async () => {
      throw new Error("nonce too low");
    });
    const next = withSignerLock(address, async () => "sent");
    await expect(failed).rejects.toThrow(/nonce too low/);
    await expect(next).resolves.toBe("sent");
  });
});
