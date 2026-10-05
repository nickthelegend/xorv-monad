/**
 * The browser wallet, without a browser.
 *
 * Everything here drives a fake EIP-1193 provider, which is exactly what a real
 * wallet exposes — `request({method, params})` plus two events. That is the
 * whole interface Xorv uses, so a fake is not an approximation of the extension;
 * it is the same contract.
 *
 * The chain handling is what earns the most attention. An EIP-712 domain
 * includes `chainId`, so a wallet sitting on the wrong network produces a
 * structurally valid authorization that verifies against nothing — the payment
 * is refused with no field to point at. Getting onto the Xorv chain (Monad
 * testnet) *before* asking for a signature is therefore load-bearing, and so is
 * handling the case where the wallet has never heard of the chain at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import { DEFAULT_STABLECOIN, STABLECOINS, STABLECOINS_BY_CHAIN, XORV_CHAIN } from "../lib/chains";
import { NETWORKS } from "@xorv/protocol";
import { chooseAccept } from "../lib/pay-with-wallet";
import {
  connectWallet,
  restoreWallet,
  sendStablecoin,
  sessionForProvider,
  shortAddress,
  switchToXorvChain,
  walletAvailable,
  watchWallet,
} from "../lib/wallet";

const ADDRESS = "0x03294ce27e218d1611b2ebc0b0ffddb95f129f36";
const CHECKSUMMED = "0x03294Ce27e218d1611B2ebc0b0ffdDb95F129F36";
const CHAIN_HEX = `0x${XORV_CHAIN.id.toString(16)}`;

interface FakeOpts {
  accounts?: string[];
  chainId?: string;
  /** Throw this from wallet_switchEthereumChain. 4902 = unknown chain. */
  switchError?: { code: number } | null;
}

function fakeProvider(opts: FakeOpts = {}) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  let chainId = opts.chainId ?? CHAIN_HEX;

  const provider = {
    calls,
    listeners,
    /** The user picking another network in the wallet's own menu. */
    moveTo(hex: string) {
      chainId = hex;
    },
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push({ method, params });
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return opts.accounts ?? [ADDRESS];
        case "eth_chainId":
          return chainId;
        case "wallet_switchEthereumChain":
          if (opts.switchError) throw opts.switchError;
          chainId = CHAIN_HEX;
          return null;
        case "wallet_addEthereumChain":
          chainId = CHAIN_HEX;
          return null;
        case "eth_signTypedData_v4":
          return "0xsignature";
        case "eth_sendTransaction":
          return "0xtxhash";
        default:
          throw new Error(`unexpected method ${method}`);
      }
    },
    on(event: string, handler: (...a: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    removeListener(event: string, handler: (...a: unknown[]) => void) {
      listeners.get(event)?.delete(handler);
    },
  };
  (globalThis as { window?: unknown }).window = { ethereum: provider };
  return provider;
}

const methods = (p: ReturnType<typeof fakeProvider>) => p.calls.map((c) => c.method);

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {};
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe("walletAvailable", () => {
  it("is false with no injected provider, and says so rather than throwing", () => {
    expect(walletAvailable()).toBe(false);
  });

  it("is true once a provider is injected", () => {
    fakeProvider();
    expect(walletAvailable()).toBe(true);
  });
});

describe("connectWallet", () => {
  it("prompts for accounts and returns a checksummed address", async () => {
    const p = fakeProvider();
    const session = await connectWallet();
    // Checksummed, not the lowercase form the wallet returned: one address must
    // have one spelling, or comparisons against `payTo` start failing.
    expect(session.address).toBe(CHECKSUMMED);
    expect(methods(p)).toContain("eth_requestAccounts");
  });

  it("switches the wallet to Monad Testnet when it is on another network", async () => {
    const p = fakeProvider({ chainId: "0x1" });
    const session = await connectWallet();
    expect(methods(p)).toContain("wallet_switchEthereumChain");
    expect(session.chainId).toBe(XORV_CHAIN.id);
  });

  it("does not prompt a switch when the wallet is already on the right chain", async () => {
    const p = fakeProvider({ chainId: CHAIN_HEX });
    await connectWallet();
    expect(methods(p)).not.toContain("wallet_switchEthereumChain");
  });

  it("offers to add the chain when the wallet has never heard of it (EIP-1193 4902)", async () => {
    // The realistic first-run case. Without this the user is told to configure
    // an RPC endpoint by hand, which is where most people stop.
    const p = fakeProvider({ chainId: "0x1", switchError: { code: 4902 } });
    await connectWallet();
    expect(methods(p)).toContain("wallet_addEthereumChain");
    const added = p.calls.find((c) => c.method === "wallet_addEthereumChain");
    const [params] = added!.params as Array<{ chainId: string; rpcUrls: string[] }>;
    expect(params.chainId).toBe(CHAIN_HEX);
    expect(params.rpcUrls[0]).toContain("monad");
  });

  it("propagates any other switch failure instead of silently adding a chain", async () => {
    // 4001 is "user rejected". Adding the chain anyway would re-prompt someone
    // who just said no.
    fakeProvider({ chainId: "0x1", switchError: { code: 4001 } });
    await expect(connectWallet()).rejects.toMatchObject({ code: 4001 });
  });

  it("fails with an actionable message when there is no wallet at all", async () => {
    await expect(connectWallet()).rejects.toThrow(/No EVM wallet found/);
  });

  it("fails when the wallet returns an empty account list", async () => {
    fakeProvider({ accounts: [] });
    await expect(connectWallet()).rejects.toThrow(/no account/i);
  });
});

describe("restoreWallet", () => {
  it("reconnects silently via eth_accounts, which never prompts", async () => {
    const p = fakeProvider();
    const session = await restoreWallet();
    expect(session?.address).toBe(CHECKSUMMED);
    expect(methods(p)).toContain("eth_accounts");
    expect(methods(p)).not.toContain("eth_requestAccounts");
  });

  it("never prompts a network switch on page load", async () => {
    // A silent restore that pops a wallet dialog on every reload is worse than
    // no restore. The connect and payment paths both ensure the chain instead.
    const p = fakeProvider({ chainId: "0x1" });
    const session = await restoreWallet();
    expect(methods(p)).not.toContain("wallet_switchEthereumChain");
    // …and reports the wrong chain so the UI can offer the switch itself.
    expect(session?.chainId).toBe(1);
  });

  it("returns null rather than throwing when nothing is authorised", async () => {
    fakeProvider({ accounts: [] });
    expect(await restoreWallet()).toBeNull();
  });

  it("returns null when there is no wallet", async () => {
    expect(await restoreWallet()).toBeNull();
  });
});

describe("signTypedData", () => {
  it("uses v4 specifically", async () => {
    // Not interchangeable with v3: the two hash arrays and nested structs
    // differently, so a v3 signature over the same EIP-3009 authorization
    // verifies against nothing and reports only "invalid signature".
    const p = fakeProvider();
    const session = await connectWallet();
    await session.signTypedData({
      domain: { name: "Agora Dollar", version: "1" },
      types: {},
      primaryType: "TransferWithAuthorization",
      message: {},
    });
    expect(methods(p)).toContain("eth_signTypedData_v4");
  });

  it("passes the account first and the message as a JSON string", async () => {
    const p = fakeProvider();
    const session = await connectWallet();
    await session.signTypedData({
      domain: { name: "Agora Dollar", version: "1" },
      types: {},
      primaryType: "TransferWithAuthorization",
      message: { value: "1000" },
    });
    const call = p.calls.find((c) => c.method === "eth_signTypedData_v4");
    const [account, json] = call!.params as [string, string];
    expect(account).toBe(CHECKSUMMED);
    expect(JSON.parse(json).message.value).toBe("1000");
  });

  it("serialises bigint fields, which is how x402 builds the authorization", async () => {
    // A browser-wallet payment on the deployed job board failed with "Do not
    // know how to serialize a BigInt" before any signature was requested.
    const p = fakeProvider();
    const session = await connectWallet();
    await session.signTypedData({
      domain: { name: "Agora Dollar", version: "1" },
      types: {},
      primaryType: "TransferWithAuthorization",
      message: { value: 230000n, validAfter: 0n, validBefore: 1789309000n, nonce: "0x01" },
    });
    const call = p.calls.find((c) => c.method === "eth_signTypedData_v4");
    const [, json] = call!.params as [string, string];
    expect(JSON.parse(json).message).toEqual({ value: "230000", validAfter: "0", validBefore: "1789309000", nonce: "0x01" });
  });

  it("gets back onto the chain the domain names before signing", async () => {
    // Found live: the user switched network after connecting, the wallet
    // refused to sign for a chain it wasn't on, and "Pay" did nothing.
    const p = fakeProvider();
    const session = await connectWallet();
    p.moveTo("0x1");
    p.calls.length = 0;
    await session.signTypedData({
      domain: { name: "Agora Dollar", version: "1", chainId: XORV_CHAIN.id },
      types: {},
      primaryType: "ReceiveWithAuthorization",
      message: {},
    });
    const order = methods(p);
    expect(order).toContain("wallet_switchEthereumChain");
    expect(order.indexOf("wallet_switchEthereumChain")).toBeLessThan(order.indexOf("eth_signTypedData_v4"));
  });

  it("does not touch the network when the wallet is already on the domain's chain", async () => {
    const p = fakeProvider();
    const session = await connectWallet();
    p.calls.length = 0;
    await session.signTypedData({
      domain: { name: "Agora Dollar", version: "1", chainId: XORV_CHAIN.id },
      types: {},
      primaryType: "ReceiveWithAuthorization",
      message: {},
    });
    expect(methods(p)).not.toContain("wallet_switchEthereumChain");
  });

  it("refuses, without signing, a domain for a chain this app doesn't run on", async () => {
    const p = fakeProvider();
    const session = await connectWallet();
    p.calls.length = 0;
    await expect(
      session.signTypedData({
        domain: { name: "Agora Dollar", version: "1", chainId: 1 },
        types: {},
        primaryType: "ReceiveWithAuthorization",
        message: {},
      }),
    ).rejects.toThrow(/chain 1/);
    expect(methods(p)).not.toContain("eth_signTypedData_v4");
  });
});

describe("switchToXorvChain", () => {
  it("is a no-op when already on the right chain", async () => {
    const p = fakeProvider({ chainId: CHAIN_HEX });
    await switchToXorvChain();
    expect(methods(p)).not.toContain("wallet_switchEthereumChain");
  });

  it("switches when elsewhere", async () => {
    const p = fakeProvider({ chainId: "0x2105" });
    await switchToXorvChain();
    expect(methods(p)).toContain("wallet_switchEthereumChain");
  });
});

describe("watchWallet", () => {
  it("subscribes to account and chain changes and unsubscribes cleanly", () => {
    // A user who switches account has changed who is paying. Missing that means
    // paying from an address other than the one on screen.
    const p = fakeProvider();
    const onChange = vi.fn();
    const stop = watchWallet(onChange);
    expect(p.listeners.get("accountsChanged")?.size).toBe(1);
    expect(p.listeners.get("chainChanged")?.size).toBe(1);
    stop();
    expect(p.listeners.get("accountsChanged")?.size).toBe(0);
    expect(p.listeners.get("chainChanged")?.size).toBe(0);
  });

  it("returns a no-op unsubscribe when there is no wallet", () => {
    expect(() => watchWallet(vi.fn())()).not.toThrow();
  });
});

describe("shortAddress", () => {
  it("shortens a full address for chrome", () => {
    expect(shortAddress(CHECKSUMMED)).toBe("0x0329…9F36");
  });

  it("leaves something already short alone rather than mangling it", () => {
    expect(shortAddress("0x1234")).toBe("0x1234");
  });
});

/**
 * The Privy path hands the app a provider that is *not* `window.ethereum` —
 * an embedded wallet's EIP-1193 surface. These pin that the same payment and
 * transfer code runs over it unchanged.
 */
describe("provider-agnostic sessions (Privy embedded wallets)", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("signs typed data through the provider it was given, not window.ethereum", async () => {
    const embedded = fakeProvider();
    delete (globalThis as { window?: unknown }).window; // no injected wallet at all
    const session = sessionForProvider(embedded, ADDRESS, XORV_CHAIN.id);
    expect(session.address).toBe(CHECKSUMMED);
    const sig = await session.signTypedData({ domain: {}, types: {}, primaryType: "X", message: {} });
    expect(sig).toBe("0xsignature");
    const call = embedded.calls.find((c) => c.method === "eth_signTypedData_v4");
    expect((call?.params as unknown[])[0]).toBe(CHECKSUMMED);
  });

  it("sends the default stablecoin (AUSD) as an ERC-20 transfer to its contract", async () => {
    const p = fakeProvider();
    const hash = await sendStablecoin(p, ADDRESS, "0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B", "0.25");
    expect(hash).toBe("0xtxhash");
    const tx = (p.calls.find((c) => c.method === "eth_sendTransaction")?.params as Array<{
      from: string;
      to: string;
      data: `0x${string}`;
    }>)[0]!;
    expect(tx.to).toBe(DEFAULT_STABLECOIN.address);
    expect(tx.from).toBe(CHECKSUMMED);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe("transfer");
    // 0.25 at 6 decimals — every stablecoin Xorv takes is 6dp.
    expect(decoded.args).toEqual(["0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B", 250_000n]);
  });

  it("gets onto the chain before sending", async () => {
    const p = fakeProvider({ chainId: "0x1" });
    await sendStablecoin(p, ADDRESS, "0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B", "1");
    const order = methods(p);
    expect(order.indexOf("wallet_switchEthereumChain")).toBeLessThan(order.indexOf("eth_sendTransaction"));
  });

  it("refuses a zero amount before touching the wallet", async () => {
    const p = fakeProvider();
    await expect(
      sendStablecoin(p, ADDRESS, "0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B", "0"),
    ).rejects.toThrow(/above zero/);
    expect(methods(p)).not.toContain("eth_sendTransaction");
  });
});

describe("the chain table", () => {
  it("defaults to Monad Testnet with AUSD first", () => {
    expect(XORV_CHAIN.id).toBe(10143);
    expect(XORV_CHAIN.nativeCurrency.symbol).toBe("MON");
    expect(DEFAULT_STABLECOIN.symbol).toBe("AUSD");
    expect(STABLECOINS.map((t) => t.symbol)).toEqual(["AUSD", "USDC"]);
  });

  it("agrees with @xorv/protocol, so the browser and the broker offer the same tokens", () => {
    for (const info of Object.values(NETWORKS)) {
      const mine = STABLECOINS_BY_CHAIN[info.chainId] ?? [];
      expect(mine.map((t) => [t.symbol, t.address.toLowerCase(), t.eip712])).toEqual(
        info.stablecoins.map((t) => [t.symbol, t.address.toLowerCase(), t.eip712]),
      );
    }
  });

  it("sends a chosen stablecoin to that token's contract", async () => {
    const p = fakeProvider();
    const usdc = STABLECOINS[1]!.address;
    await sendStablecoin(p, ADDRESS, "0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B", "1", usdc);
    const tx = (p.calls.find((c) => c.method === "eth_sendTransaction")?.params as Array<{ to: string }>)[0]!;
    expect(tx.to).toBe(usdc);
  });
});

describe("chooseAccept", () => {
  const accepts = [
    { asset: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC", amount: "1000", symbol: "AUSD" },
    { asset: "0x534b2f3A21130d7a60830c2Df862319e593943A3", amount: "1000", symbol: "USDC" },
  ];

  it("pays with the first stablecoin the wallet can afford", () => {
    const balances = { [accepts[0]!.asset.toLowerCase()]: 0n, [accepts[1]!.asset.toLowerCase()]: 5_000n };
    expect(chooseAccept(accepts, balances)!.symbol).toBe("USDC");
  });

  it("prefers AUSD when balances are unknown", () => {
    expect(chooseAccept(accepts, {})!.symbol).toBe("AUSD");
  });

  it("honours an explicit choice and refuses one not offered", () => {
    expect(chooseAccept(accepts, {}, "USDC")!.symbol).toBe("USDC");
    expect(chooseAccept(accepts, {}, "DAI")).toBeNull();
  });
});
