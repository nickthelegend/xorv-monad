"use client";

/**
 * The browser wallet.
 *
 * This one file replaces three — `hashpack.ts`, `hedera-wallet.ts` and
 * `hedera-address.ts` — and the reason is the single biggest practical
 * argument for an EVM chain in this whole project.
 *
 * ## What used to be here
 *
 * Hedera's x402 `exact` scheme settles a **native protobuf
 * TransferTransaction**. Ordinary EVM wallets sign EVM RLP transactions, so
 * they could authenticate a user and then not pay: Privy had to be ripped out
 * for exactly this reason. What replaced it was HashPack over WalletConnect,
 * which meant a WalletConnect project id, a relay handshake, `DAppConnector`,
 * `DAppSigner`, and a transaction built with a *second copy* of the Hedera SDK
 * because the wallet library type-checked against a different package name than
 * the rest of the repo. It also meant one genuinely nasty bug: a default freeze
 * offers several candidate nodes, HashPack signs only the first node's body,
 * and the library merges that one signature into all of them — so the payment
 * was rejected as unsigned until the transaction was pinned to a single node.
 *
 * ## What is here now
 *
 * Arbitrum is an EVM chain, and the payment is an **EIP-712 typed-data signature**
 * over an EIP-3009 authorization. Every EVM wallet in existence can do that
 * over EIP-1193 with `eth_signTypedData_v4`. So:
 *
 *  - no WalletConnect project id, no relay, no modal library,
 *  - no second SDK, no protobuf, no node pinning,
 *  - no address→account-id resolution, because the address *is* the account
 *    and exists without ever being funded.
 *
 * And the user still pays no gas: the signature is not a transaction, and the
 * facilitator is what reaches the chain.
 *
 * Deliberately built on the raw EIP-1193 provider rather than a connector kit.
 * The whole surface used here is four RPC calls, and the dependency it saves is
 * larger than the file.
 */

import { encodeFunctionData, erc20Abi, getAddress, parseUnits, type Address } from "viem";
import { DEFAULT_STABLECOIN, XORV_CHAIN } from "./chains";

/** The EIP-1193 subset actually used. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export interface WalletSession {
  address: Address;
  chainId: number;
  /** Signs EIP-712 typed data. This is the entire payment capability. */
  signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

export function walletAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

function provider(): Eip1193Provider {
  if (!walletAvailable()) {
    throw new Error(
      "No EVM wallet found. Install MetaMask, Rabby or any EIP-1193 wallet and reload.",
    );
  }
  return window.ethereum!;
}

function sessionFor(address: string, chainId: number): WalletSession {
  return sessionForProvider(provider(), address, chainId);
}

/**
 * A payment session over any EIP-1193 provider.
 *
 * The injected wallet and a Privy wallet — embedded or external — both hand
 * back one of these, which is why the payment code never needs to know which
 * kind of wallet it is talking to: an address and `eth_signTypedData_v4` is
 * the whole contract.
 */
export function sessionForProvider(
  p: Eip1193Provider,
  address: string,
  chainId: number,
): WalletSession {
  const account = getAddress(address);
  return {
    address: account,
    chainId,
    async signTypedData(message) {
      // v4 specifically: earlier versions hash arrays and nested structs
      // differently, so a v3 signature over the same EIP-3009 authorization
      // verifies against nothing and reports only "invalid signature".
      // x402 builds the EIP-3009 message with bigint amounts and timestamps, and
      // JSON.stringify throws on a bigint ("Do not know how to serialize a
      // BigInt"), so every browser-wallet payment failed before a signature was
      // even requested. EIP-712 JSON carries uint256 values as decimal strings.
      //
      // The wallet must be on the chain the domain names: MetaMask refuses to
      // sign otherwise, and the payment button did nothing at all when the
      // user had switched networks after connecting. Sending and refunding
      // already switched first; signing — the one every payment uses — didn't.
      const wanted = Number((message as { domain?: { chainId?: unknown } }).domain?.chainId);
      if (Number.isFinite(wanted) && wanted > 0) {
        const current = Number((await p.request({ method: "eth_chainId" })) as string);
        if (current !== wanted) {
          if (wanted !== XORV_CHAIN.id) {
            throw new Error(`This payment is for chain ${wanted}, but this app runs on ${XORV_CHAIN.name}.`);
          }
          await ensureChain(p);
        }
      }
      const signature = await p.request({
        method: "eth_signTypedData_v4",
        params: [account, JSON.stringify(message, (_key, value) => (typeof value === "bigint" ? value.toString() : value))],
      });
      return signature as `0x${string}`;
    },
  };
}

/**
 * Put the wallet on the Xorv chain (Arbitrum Sepolia by default), adding the
 * network if it has never seen it.
 *
 * Worth doing before asking for a signature rather than after. An EIP-712
 * domain includes `chainId`, so a wallet sitting on some other network signs a
 * structurally valid authorization for a chain the facilitator is not on — and
 * the only symptom is a rejected payment.
 */
async function ensureChain(p: Eip1193Provider): Promise<number> {
  const target = `0x${XORV_CHAIN.id.toString(16)}`;
  const current = (await p.request({ method: "eth_chainId" })) as string;
  if (current?.toLowerCase() === target) return XORV_CHAIN.id;

  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target }] });
  } catch (err) {
    // 4902 means "unrecognised chain" — the wallet has never heard of this
    // network (Robinhood Chain Testnet, say), so offer to add it rather than
    // telling the user to configure an RPC by hand.
    const code = (err as { code?: number })?.code;
    if (code !== 4902) throw err;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: target,
          chainName: XORV_CHAIN.name,
          nativeCurrency: XORV_CHAIN.nativeCurrency,
          rpcUrls: [...XORV_CHAIN.rpcUrls.default.http],
          blockExplorerUrls: [XORV_CHAIN.blockExplorers?.default.url].filter(Boolean),
        },
      ],
    });
  }
  return XORV_CHAIN.id;
}

/** Prompt for access. Opens the wallet's own UI. */
export async function connectWallet(): Promise<WalletSession> {
  const p = provider();
  const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error("The wallet returned no account.");
  const chainId = await ensureChain(p);
  return sessionFor(address, chainId);
}

/**
 * Reconnect silently if the wallet already granted access.
 *
 * `eth_accounts` never prompts — it reports what is already authorised — so
 * this is safe to run on every page load and is what stops a reload from
 * throwing the user back through the connect modal.
 */
export async function restoreWallet(): Promise<WalletSession | null> {
  if (!walletAvailable()) return null;
  try {
    const p = provider();
    const accounts = (await p.request({ method: "eth_accounts" })) as string[];
    const address = accounts?.[0];
    if (!address) return null;
    const chainId = Number((await p.request({ method: "eth_chainId" })) as string);
    // Deliberately not switching chains here. A silent restore must not pop a
    // network-change prompt on page load; the connect path and the payment path
    // both ensure the right chain, and `chainId` is surfaced so the UI can say so.
    return sessionFor(address, chainId);
  } catch {
    return null;
  }
}

/** Ensure the connected wallet is on the Xorv chain, prompting if it is not. */
export async function switchToXorvChain(): Promise<void> {
  await ensureChain(provider());
}

/** The same, for a provider that did not come from `window.ethereum`. */
export async function switchProviderToXorvChain(p: Eip1193Provider): Promise<number> {
  return ensureChain(p);
}

/**
 * Send a stablecoin — an ordinary ERC-20 transfer, broadcast by the wallet.
 *
 * Unlike a job payment this *is* a transaction, so the sender pays gas — in
 * ETH, on every Arbitrum chain. Paying for jobs never needs ETH; this does.
 */
export async function sendStablecoin(
  p: Eip1193Provider,
  from: string,
  to: string,
  amount: string,
  token: `0x${string}` = DEFAULT_STABLECOIN.address,
): Promise<`0x${string}`> {
  const recipient = getAddress(to.trim());
  const units = parseUnits(amount.trim(), 6);
  if (units <= 0n) throw new Error("Amount must be above zero.");
  await ensureChain(p);
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, units],
  });
  const hash = await p.request({
    method: "eth_sendTransaction",
    params: [{ from: getAddress(from), to: getAddress(token), data }],
  });
  return hash as `0x${string}`;
}

/**
 * Refund an escrowed job to its buyer, from whatever wallet is connected.
 *
 * `XorvEscrow.refund` is permissionless once the job's deadline has passed,
 * and the money can only go to the buyer who paid — so any wallet can press
 * the button, and the one pressing it pays only the ETH gas. This is the
 * buyer's guarantee made clickable: a broker that stalls can't keep the money.
 */
export async function refundEscrow(
  p: Eip1193Provider,
  from: string,
  escrow: string,
  jobId: `0x${string}`,
): Promise<`0x${string}`> {
  await ensureChain(p);
  const data = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "refund",
        stateMutability: "nonpayable",
        inputs: [{ name: "jobId", type: "bytes32" }],
        outputs: [],
      },
    ] as const,
    functionName: "refund",
    args: [jobId],
  });
  const hash = await p.request({
    method: "eth_sendTransaction",
    params: [{ from: getAddress(from), to: getAddress(escrow), data }],
  });
  return hash as `0x${string}`;
}

/** Subscribe to account and chain changes. Returns an unsubscribe function. */
export function watchWallet(onChange: () => void): () => void {
  if (!walletAvailable()) return () => {};
  const p = provider();
  p.on?.("accountsChanged", onChange);
  p.on?.("chainChanged", onChange);
  return () => {
    p.removeListener?.("accountsChanged", onChange);
    p.removeListener?.("chainChanged", onChange);
  };
}

/** Shorten an address for chrome: `0x0329…9F36`. */
export function shortAddress(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}
