/**
 * Turning a wallet address into a Hedera account.
 *
 * The case worth being careful about is the one in the middle: an address that
 * is perfectly valid but has no account behind it yet, because nothing has ever
 * sent it HBAR. Treating that as an error tells a new user something is broken;
 * treating it as resolved lets the app use it as a `payTo` and fail at
 * settlement. It has to be its own state, and these pin that.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeLongZero,
  isEvmAddress,
  resolveHederaAccount,
  shortAddress,
} from "../lib/hedera-address";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

function mirror(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response) as typeof fetch;
}

describe("isEvmAddress", () => {
  it("accepts a 20-byte hex address in either case", () => {
    expect(isEvmAddress("0x0000000000000000000000000000000000964678")).toBe(true);
    expect(isEvmAddress("0xC9D5ABA4F387DBC4E666E992A1C934407D413025")).toBe(true);
    expect(isEvmAddress("  0xc9d5aba4f387dbc4e666e992a1c934407d413025  ")).toBe(true);
  });

  it("rejects Hedera account ids, short hex and junk", () => {
    expect(isEvmAddress("0.0.9848440")).toBe(false);
    expect(isEvmAddress("0xdeadbeef")).toBe(false);
    expect(isEvmAddress("c9d5aba4f387dbc4e666e992a1c934407d413025")).toBe(false);
    expect(isEvmAddress("")).toBe(false);
  });
});

describe("decodeLongZero", () => {
  it("decodes a long-zero address to its account id, with no network call", () => {
    // 0x…964678 → 0x964678 = 9848440, the demo buyer account.
    expect(decodeLongZero("0x0000000000000000000000000000000000964678")).toBe("0.0.9848440");
    expect(decodeLongZero("0x0000000000000000000000000000000000964676")).toBe("0.0.9848438");
  });

  it("handles a small account number", () => {
    expect(decodeLongZero("0x0000000000000000000000000000000000000002")).toBe("0.0.2");
  });

  it("returns null for a real ECDSA-derived address", () => {
    // Not long-zero: the leading 12 bytes carry key material.
    expect(decodeLongZero("0xc9d5aba4f387dbc4e666e992a1c934407d413025")).toBeNull();
  });

  it("returns null for the zero address rather than inventing account 0", () => {
    expect(decodeLongZero("0x0000000000000000000000000000000000000000")).toBeNull();
  });

  it("returns null for anything that isn't 20 bytes", () => {
    expect(decodeLongZero("0x00")).toBeNull();
    expect(decodeLongZero("nonsense")).toBeNull();
  });
});

describe("resolveHederaAccount", () => {
  it("resolves a long-zero address locally, without hitting the mirror node", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    const result = await resolveHederaAccount(
      "hedera:testnet",
      "0x0000000000000000000000000000000000964678",
    );

    expect(result).toEqual({
      status: "resolved",
      accountId: "0.0.9848440",
      evmAddress: "0x0000000000000000000000000000000000964678",
      createdVia: "native",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("resolves an EVM-derived address through the mirror node", async () => {
    mirror(200, { account: "0.0.1234567" });
    const result = await resolveHederaAccount(
      "hedera:testnet",
      "0xc9d5aba4f387dbc4e666e992a1c934407d413025",
    );
    expect(result).toMatchObject({
      status: "resolved",
      accountId: "0.0.1234567",
      createdVia: "evm",
    });
  });

  it("reports a 404 as not-created, NOT as an error", async () => {
    // This is the ordinary state of a brand-new Privy wallet. Calling it an
    // error would tell that user something is broken when nothing is.
    mirror(404, {});
    const result = await resolveHederaAccount(
      "hedera:testnet",
      "0xc9d5aba4f387dbc4e666e992a1c934407d413025",
    );
    expect(result.status).toBe("not-created");
  });

  it("treats a 200 with no account field as not-created", async () => {
    mirror(200, {});
    const result = await resolveHederaAccount(
      "hedera:testnet",
      "0xc9d5aba4f387dbc4e666e992a1c934407d413025",
    );
    expect(result.status).toBe("not-created");
  });

  it("reports a genuine mirror-node failure as an error", async () => {
    mirror(503, {});
    const result = await resolveHederaAccount(
      "hedera:testnet",
      "0xc9d5aba4f387dbc4e666e992a1c934407d413025",
    );
    expect(result).toMatchObject({ status: "error" });
    if (result.status === "error") expect(result.message).toContain("503");
  });

  it("reports a network failure as an error rather than throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const result = await resolveHederaAccount(
      "hedera:testnet",
      "0xc9d5aba4f387dbc4e666e992a1c934407d413025",
    );
    expect(result).toMatchObject({ status: "error", message: "offline" });
  });

  it("rejects a malformed address before making any request", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const result = await resolveHederaAccount("hedera:testnet", "0.0.9848440");
    expect(result).toMatchObject({ status: "error" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("queries the network's own mirror node", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({ account: "0.0.1" }) } as Response;
    }) as unknown as typeof fetch;

    await resolveHederaAccount("hedera:mainnet", "0xc9d5aba4f387dbc4e666e992a1c934407d413025");
    expect(seen[0]).toContain("mainnet");
  });
});

describe("shortAddress", () => {
  it("elides the middle", () => {
    expect(shortAddress("0x0000000000000000000000000000000000964678")).toBe("0x0000…4678");
  });

  it("leaves an already-short value alone", () => {
    expect(shortAddress("0xabcd")).toBe("0xabcd");
  });
});
