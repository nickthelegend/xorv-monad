/**
 * EVM plumbing shared by the broker, the CLI, the MCP server and the apps.
 *
 * On Monad an account *is* a secp256k1 key: the address is derived from it, so
 * there is no separate account id to configure, no token association to run
 * before someone can be paid, and no key-curve guessing. What replaces those
 * Hedera chores is smaller but sharper:
 *
 *  - **Address casing.** The same address arrives checksummed from viem,
 *    lowercased from a wallet, and uppercased from a copy-paste. Compare with
 *    `sameAddress`, store what `normalizeAddress` returns — a strict `===`
 *    between two spellings of one address is how a settled payment fails to
 *    attach to its job.
 *  - **Nonces.** Several writers (the x402 facilitator, the ledger writer, the
 *    reputation relay) may sign from one EOA. `accountFromKey` wires viem's
 *    shared `nonceManager`, and `withSignerLock` serializes broadcasts per
 *    address so two concurrent sends cannot race for the same nonce.
 *  - **Gas limits.** Monad bills the gas *limit*, not gas used, so a padded
 *    constant is money thrown away on every transaction, while an unpadded
 *    estimate can run out when state shifts between estimate and inclusion.
 *    `withGasHeadroom` is the one agreed margin.
 */

import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  nonceManager,
  publicActions,
  type Account,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type PrivateKeyAccount,
  type PublicActions,
  type PublicClient,
  type Transport,
  type WalletActions,
  type WalletRpcSchema,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { networkConfig, viemChain } from "./chains.js";

/**
 * Per-request RPC timeout. A quote or a settlement that hangs on a wedged RPC
 * is worse than one that fails fast and is retried.
 */
export const RPC_TIMEOUT_MS = 30_000;

/** Headroom added to every gas estimate, in percent. See the module doc. */
export const GAS_HEADROOM_PERCENT = 15;

/** secp256k1 group order; a private key must be in [1, n-1]. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** DER prefix of a PKCS#8 ED25519 private key — what Hedera's older tooling exports. */
const DER_ED25519_PREFIX = "302e020100300506032b657004220420";

/** DER prefix of a PKCS#8 secp256k1 private key — Hedera's "DER Encoded" ECDSA export. */
const DER_SECP256K1_PREFIX = "3030020100300706052b8104000a04220420";

/**
 * Parse an EVM private key into the `0x`-prefixed 32-byte hex viem wants.
 *
 * Accepts 64 hex characters with or without `0x` (and surrounding whitespace,
 * which pasted keys routinely carry). Everything else is refused with a
 * message that says what to do, because the likeliest wrong input is a key
 * left over from the Hedera prototype:
 *
 *  - DER-encoded **ED25519** cannot be used at all — Monad accounts are
 *    secp256k1 — so the error says to create a new EVM key.
 *  - DER-encoded **ECDSA secp256k1** *is* usable, but only as its raw 32
 *    bytes, so the error points at the raw hex instead of silently unwrapping
 *    it (a key that "just works" in a surprising format is how people end up
 *    funding an address they didn't expect).
 *
 * One mistake cannot be caught: a raw 64-hex ED25519 key is indistinguishable
 * from a secp256k1 key and will parse — it just derives an unrelated, empty
 * address. `xorv doctor` showing a zero balance is the tell.
 */
export function parsePrivateKey(raw: string): Hex {
  const key = raw.trim();
  if (!key) throw new Error("empty private key");

  const hex = (/^0x/i.test(key) ? key.slice(2) : key).toLowerCase();

  if (hex.startsWith(DER_ED25519_PREFIX)) {
    throw new Error(
      "this is a DER-encoded ED25519 key (the Hedera prototype's format). Hedera ED25519 keys " +
        "cannot be reused on Monad, whose accounts are secp256k1 — create a new EVM key " +
        "(e.g. `cast wallet new`) and fund it with MON",
    );
  }
  if (hex.startsWith(DER_SECP256K1_PREFIX)) {
    throw new Error(
      "this is a DER-encoded ECDSA key. Monad wants the raw 32-byte hex: use the last 64 hex " +
        "characters (the Hedera portal's \"HEX Encoded Private Key\")",
    );
  }
  if (/^30[0-9a-f]+$/.test(hex) && hex.length > 64) {
    throw new Error(
      "this looks like a DER-encoded key. Monad needs a raw 32-byte secp256k1 key (64 hex " +
        "characters, optional 0x); Hedera ED25519 keys cannot be reused on Monad",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(
      "could not parse private key: expected 32 bytes of hex (64 characters, optional 0x prefix)",
    );
  }
  const scalar = BigInt(`0x${hex}`);
  if (scalar === 0n || scalar >= SECP256K1_N) {
    throw new Error("could not parse private key: value is outside the secp256k1 key range");
  }
  return `0x${hex}`;
}

/**
 * A viem account for a raw key, with viem's shared `nonceManager` attached.
 *
 * The nonce manager keeps a local counter per (address, chain), so back-to-back
 * sends from the same key get consecutive nonces without a `pending` round-trip
 * each — and because it is one shared instance, two accounts built from the
 * same key in one process share the counter too.
 */
export function accountFromKey(raw: string): PrivateKeyAccount {
  return privateKeyToAccount(parsePrivateKey(raw), { nonceManager });
}

/**
 * Canonical (EIP-55 checksummed) form of an address; throws on anything else.
 *
 * Mixed-case input must carry a *valid* checksum — a wrong one is exactly what
 * a single-character typo looks like, and a typo'd payout address is money
 * sent into the void. All-lowercase input has no checksum to check and is
 * accepted.
 */
export function normalizeAddress(value: string): Address {
  const trimmed = value.trim();
  if (!isAddress(trimmed, { strict: false })) {
    throw new Error(`not an EVM address: "${value}"`);
  }
  if (!isAddress(trimmed, { strict: true })) {
    throw new Error(
      `address "${value}" has an invalid checksum — check it for a typo, or paste it all-lowercase`,
    );
  }
  return getAddress(trimmed);
}

/** Cheap shape check so a typo'd address fails at config time, not on-chain. */
export function isEvmAddress(value: string): boolean {
  return isAddress(value.trim(), { strict: true });
}

/**
 * Case-insensitive address equality. False when either side is missing or is
 * not an address at all, so `sameAddress(undefined, undefined)` is not a match.
 */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.trim();
  const y = b.trim();
  if (!isAddress(x, { strict: false }) || !isAddress(y, { strict: false })) return false;
  return x.toLowerCase() === y.toLowerCase();
}

/** Where a client should send its RPC traffic. */
export interface ClientOptions {
  /** Use this transport instead of HTTP — tests pass a viem `custom()` one. */
  transport?: Transport;
  /** Use this RPC URL instead of the network's (or `XORV_RPC_URL`). */
  rpcUrl?: string;
}

function rpcTransport(network: string, opts: ClientOptions): Transport {
  return (
    opts.transport ??
    http(opts.rpcUrl ?? networkConfig(network).rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 2 })
  );
}

/** A read-only client for a network. */
export function publicClientFor(network: string, opts: ClientOptions = {}): PublicClient {
  return createPublicClient({ chain: viemChain(network), transport: rpcTransport(network, opts) });
}

/**
 * A signing client for a network, extended with the public actions, so one
 * object can estimate, simulate, send and wait — which is every write path in
 * this codebase.
 */
export function walletClientFor(
  network: string,
  account: Account,
  opts: ClientOptions = {},
): XorvWalletClient {
  return createWalletClient({
    account,
    chain: viemChain(network),
    transport: rpcTransport(network, opts),
  }).extend(publicActions);
}

/** What `walletClientFor` returns: a wallet client that can also read. */
export type XorvWalletClient = Client<
  Transport,
  Chain,
  Account,
  WalletRpcSchema,
  WalletActions<Chain, Account> & PublicActions<Transport, Chain, Account>
>;

/** The slice of ERC-20 the CLI and scripts need. */
export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface AccountBalances {
  /** Native MON, in wei (18 decimals), as an integer string. */
  monWei: string;
  /** The network's stablecoin (USDC), in its smallest unit, as an integer string. */
  usdcUnits: string;
}

/**
 * MON and USDC balances for an address.
 *
 * Throws on any RPC error rather than reporting zero: "you have no USDC" and
 * "we couldn't ask" call for very different actions, and a zero shown for an
 * unreachable RPC sends an operator to a faucet they don't need.
 *
 * On EVM any address can receive an ERC-20 without opting in, so there is no
 * "can this account be paid?" question left to answer here.
 */
export async function fetchBalances(
  network: string,
  address: string,
  opts: ClientOptions & { client?: PublicClient } = {},
): Promise<AccountBalances> {
  const owner = normalizeAddress(address);
  const client = opts.client ?? publicClientFor(network, opts);
  const [monWei, usdcUnits] = await Promise.all([
    client.getBalance({ address: owner }),
    client.readContract({
      address: networkConfig(network).usdc.address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner],
    }),
  ]);
  return { monWei: monWei.toString(), usdcUnits: usdcUnits.toString() };
}

/**
 * Render wei as a MON figure: "1.2345 MON", "0.000021 MON".
 *
 * Truncated, never rounded up — a balance display that overstates what is
 * there by half a digit is a small lie told at exactly the moment someone is
 * deciding whether they can afford gas. Four decimals at ≥ 1 MON, six below,
 * and a "<" marker for dust that would otherwise print as zero.
 */
export function formatMon(wei: string | bigint): string {
  const value = typeof wei === "bigint" ? wei : BigInt(wei);
  if (value === 0n) return "0 MON";
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const [whole = "0", frac = ""] = formatEther(abs).split(".");
  const places = abs >= 10n ** 18n ? 4 : 6;
  const kept = frac.slice(0, places).replace(/0+$/, "");
  if (whole === "0" && !kept) return `${negative ? "-" : ""}<0.${"0".repeat(places - 1)}1 MON`;
  return `${negative ? "-" : ""}${whole}${kept ? `.${kept}` : ""} MON`;
}

/**
 * Add the agreed headroom to a gas estimate, rounding up.
 *
 * Use it for every write: `gas: withGasHeadroom(await client.estimateContractGas(...))`.
 */
export function withGasHeadroom(estimate: bigint): bigint {
  const scaled = estimate * BigInt(100 + GAS_HEADROOM_PERCENT);
  return (scaled + 99n) / 100n;
}

const signerQueues = new Map<string, Promise<unknown>>();

/**
 * Run `task` after every earlier task for the same signer has finished.
 *
 * Wrap the *broadcast* (the `writeContract`/`sendTransaction` call), not the
 * wait for the receipt: nonces are assigned at send time, so serializing sends
 * is enough to make them strictly ordered, and waiting on receipts outside the
 * lock keeps throughput at one transaction per RPC round-trip rather than one
 * per block.
 *
 * Queues are keyed by address and shared process-wide, so the facilitator and
 * the ledger writer serialize against each other when they share an EOA — the
 * default, since `XORV_FACILITATOR_KEY` falls back to the operator key.
 */
export function withSignerLock<T>(address: string, task: () => Promise<T>): Promise<T> {
  const key = address.toLowerCase();
  // The stored tail never rejects (see `settled`), so a failed send does not
  // wedge the queue for everyone behind it.
  const previous = signerQueues.get(key) ?? Promise.resolve();
  const run = previous.then(() => task());
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  signerQueues.set(key, settled);
  // Drop the entry once this task is the tail, so idle signers don't pin memory.
  void settled.then(() => {
    if (signerQueues.get(key) === settled) signerQueues.delete(key);
  });
  return run;
}

export type { Account, Address, Chain, Hex };

/** Multicall3, at its canonical address on Monad testnet and mainnet (and on any fork of them). */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/** One read for `readBatch`: the same shape as `readContract`'s parameters. */
export interface BatchCall {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

/**
 * Several contract reads as one `eth_call` through Multicall3.
 *
 * Monad's public RPC allows 25 `eth_call`s a second, so a payment check that
 * needs four reads spends one of them instead of four. A chain without
 * Multicall3 (a bare dev node) or any failure of the batch falls back to the
 * reads one by one, which then reports the real error, if there is one.
 */
export async function readBatch(client: PublicClient, calls: readonly BatchCall[]): Promise<unknown[]> {
  if (calls.length > 1 && client.chain?.contracts?.multicall3) {
    try {
      return await client.multicall({ contracts: calls as never, allowFailure: false });
    } catch {
      // fall through to individual reads
    }
  }
  return Promise.all(calls.map((call) => client.readContract(call as never)));
}
