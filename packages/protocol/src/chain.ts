/**
 * Chain plumbing shared by the broker, the CLI and the setup scripts.
 *
 * This module is the whole of what used to be `hedera.ts`, and it is a third
 * the size. Two things went away and neither is coming back:
 *
 * **Key-curve guessing.** Hedera keys are ED25519 or ECDSA, DER-encoded or
 * hex, and the two parsers throw on each other's input — so the old code tried
 * three decoders in order and hoped. An EVM private key is 32 bytes of hex.
 * There is one format and it either is one or it isn't.
 *
 * **Token association.** On Hedera an account must opt in to a token before it
 * can be paid in it, or the transfer dies at consensus with
 * `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`. ERC-20 has no such concept. Any address
 * can receive AUSD or USDC, always, having done nothing — and on Monad it
 * needs no MON to do so.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  domainSeparator,
  http,
  erc20Abi,
  isAddress as viemIsAddress,
  getAddress,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { nonceManager } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  GAS_TOKEN_DECIMALS,
  GAS_TOKEN_SYMBOL,
  chainIdFor,
  networkInfo,
  primaryStablecoin,
  rpcUrl,
  stablecoins,
  type StablecoinInfo,
} from "./constants.js";

/**
 * A supported network as viem sees it.
 *
 * Built here rather than imported from `viem/chains` so the RPC honours
 * `XORV_RPC_URL` — a self-hosted or paid endpoint is the difference between a
 * demo that works and one that rate-limits halfway through — and so the local
 * Anvil node is described the same way as Monad.
 */
export function evmChain(network: string): Chain {
  const id = chainIdFor(network);
  const info = networkInfo(network);
  return defineChain({
    id,
    name: info.name,
    nativeCurrency: { name: "Monad", symbol: GAS_TOKEN_SYMBOL, decimals: GAS_TOKEN_DECIMALS },
    rpcUrls: { default: { http: [rpcUrl(network)] } },
    blockExplorers: { default: { name: info.explorerName, url: info.explorer } },
    testnet: info.testnet,
  });
}

/**
 * Parse an EVM private key.
 *
 * Accepts it with or without the `0x`, because half the tooling out there
 * prints it each way, and rejects anything else immediately. A malformed key
 * that slips through here surfaces much later as a signature nobody can verify,
 * which is a far worse place to find out.
 */
export function parsePrivateKey(raw: string): `0x${string}` {
  const key = raw.trim();
  if (!key) throw new Error("empty private key");
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `not an EVM private key: expected 32 bytes of hex (64 characters), got ${hex.length}`,
    );
  }
  return `0x${hex}`;
}

/** The account a private key controls. */
export function accountFor(rawKey: string): PrivateKeyAccount {
  // viem's shared nonce manager, keyed by address and chain. The broker sends
  // from one operator key through two wallet clients — the facilitator's
  // escrow funding and the chain writer's releases, refunds, sponsorships and
  // audit entries — often in the same second. Without a shared manager each
  // asked the node for "the next nonce", got the same answer, and one of the
  // pair died with "nonce too low". Found on a dev node: a settlement and a
  // registry sponsorship collided on the first paid job.
  return privateKeyToAccount(parsePrivateKey(rawKey), { nonceManager });
}

/**
 * How long to keep trying when the RPC pushes back.
 *
 * Public RPC endpoints answer bursts with rate-limit errors (-32005, 429).
 * viem already retries those, but its default backoff — 150ms, doubling, three
 * attempts — is spent in about a second, well inside a typical limit window,
 * and an audit heartbeat or registration that meets a busy moment simply
 * fails. 1s doubling over five attempts rides out the window without hiding a
 * genuinely dead endpoint for long.
 */
const RPC_RETRY = { retryCount: 5, retryDelay: 1_000 } as const;

/** A read-only client, for balances and contract reads. */
export function readClient(network: string): PublicClient {
  return createPublicClient({
    chain: evmChain(network),
    transport: http(rpcUrl(network), { timeout: 30_000, ...RPC_RETRY }),
  }) as PublicClient;
}

/** A client that can sign and broadcast, for the facilitator and the log. */
export function writeClient(network: string, rawKey: string): WalletClient {
  return createWalletClient({
    account: accountFor(rawKey),
    chain: evmChain(network),
    transport: http(rpcUrl(network), { timeout: 30_000, ...RPC_RETRY }),
  });
}

export interface StablecoinBalance {
  symbol: string;
  address: string;
  /** Balance in the token's smallest unit (6dp), as an integer string. */
  units: string;
  /** Set when the balance could not be read; `units` is then "0". */
  error?: string;
}

export interface AccountBalances {
  /**
   * MON for gas, in wei (18dp).
   *
   * Only the operator — whose facilitator relays payments and whose broker
   * writes the audit log — ever spends it. Buyers sign typed data and
   * providers only receive, so for them this is informational and zero is fine.
   */
  gasWei: string;
  /** One entry per configured stablecoin, default first. */
  stablecoins: StablecoinBalance[];
}

/**
 * An address's MON balance and its balance in every configured stablecoin.
 *
 * A token whose balance can't be read (no contract at that address, an RPC
 * hiccup) reports "0" with an `error`, rather than failing the whole read —
 * one misconfigured token must not hide the others.
 */
export async function fetchBalances(network: string, address: string): Promise<AccountBalances> {
  const client = readClient(network);
  const account = getAddress(address);
  const tokens = stablecoins(network);
  const [gasWei, units] = await Promise.all([
    client.getBalance({ address: account }),
    Promise.allSettled(
      tokens.map((token) =>
        client.readContract({
          address: getAddress(token.address),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account],
        }),
      ),
    ),
  ]);
  return {
    gasWei: gasWei.toString(),
    stablecoins: tokens.map((token, i) => {
      const r = units[i]!;
      return r.status === "fulfilled"
        ? { symbol: token.symbol, address: token.address, units: String(r.value) }
        : {
            symbol: token.symbol,
            address: token.address,
            units: "0",
            error: r.reason instanceof Error ? r.reason.message.split("\n")[0] : String(r.reason),
          };
    }),
  };
}

/** Balance of one stablecoin (the default one when `token` is omitted), in smallest units. */
export async function stablecoinBalance(
  network: string,
  address: string,
  token: string = primaryStablecoin(network).address,
): Promise<string> {
  const client = readClient(network);
  const units = await client.readContract({
    address: getAddress(token),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(address)],
  });
  return units.toString();
}

/** The one read every EIP-3009 token supports that pins down its EIP-712 domain. */
const DOMAIN_SEPARATOR_ABI = [
  {
    name: "DOMAIN_SEPARATOR",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

export interface DomainCheck {
  symbol: string;
  address: string;
  /** The configured `(name, version)`. */
  eip712: { name: string; version: string };
  /** What the configured values hash to on this chain. */
  expected: `0x${string}`;
  /** What the contract reports, or null when the read failed. */
  actual: `0x${string}` | null;
  ok: boolean;
  error?: string;
}

/**
 * Check a stablecoin's configured EIP-712 domain against the live contract.
 *
 * The domain is configured, never read, because it cannot be read portably:
 * AUSD's domain name ("Agora Dollar") is not its `name()` ("AUSD"). What every
 * EIP-3009 token does expose is `DOMAIN_SEPARATOR()`, the hash of
 * `(name, version, chainId, verifyingContract)`. Recomputing that from the
 * configured strings and comparing is a complete check — a wrong `version`
 * ("1" instead of "2" is the classic) cannot collide — and it is the difference
 * between finding a bad domain at boot and finding it as an opaque
 * "invalid signature" on a buyer's first payment.
 */
export async function verifyStablecoinDomain(
  network: string,
  token: StablecoinInfo,
): Promise<DomainCheck> {
  const expected = domainSeparator({
    domain: {
      name: token.eip712.name,
      version: token.eip712.version,
      chainId: chainIdFor(network),
      verifyingContract: getAddress(token.address),
    },
  });
  const base = { symbol: token.symbol, address: token.address, eip712: token.eip712, expected };
  try {
    const actual = (await readClient(network).readContract({
      address: getAddress(token.address),
      abi: DOMAIN_SEPARATOR_ABI,
      functionName: "DOMAIN_SEPARATOR",
    })) as `0x${string}`;
    return { ...base, actual, ok: actual.toLowerCase() === expected.toLowerCase() };
  } catch (err) {
    return {
      ...base,
      actual: null,
      ok: false,
      error: err instanceof Error ? err.message.split("\n")[0] : String(err),
    };
  }
}

/** `verifyStablecoinDomain` for every configured stablecoin on a network. */
export async function verifyStablecoinDomains(network: string): Promise<DomainCheck[]> {
  return Promise.all(stablecoins(network).map((token) => verifyStablecoinDomain(network, token)));
}

/** Cheap shape check so a typo'd address fails at config time, not on-chain. */
export function isAccountAddress(value: string): boolean {
  return viemIsAddress(value.trim(), { strict: false });
}

/** Checksummed form, or null when the input isn't an address at all. */
export function normalizeAddress(value: string): Address | null {
  const trimmed = value.trim();
  return viemIsAddress(trimmed, { strict: false }) ? getAddress(trimmed) : null;
}

/** `0x1234…abcd` — addresses are unreadable at full length in a table. */
export function shortAddress(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 12 ? `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}` : trimmed;
}
