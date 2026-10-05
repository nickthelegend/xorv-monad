/**
 * The operator's signer: a raw key, or a Privy server wallet locked by a Privy policy.
 *
 * The operator is the broker's hot wallet. It funds escrows from buyers'
 * EIP-3009 authorizations, releases and refunds them, writes the audit log and
 * sponsors provider registrations. Held as a raw key, a leak means it can call
 * anything: the escrow's admin functions, a transfer of every MON it holds,
 * a different chain. Held as a Privy server wallet, the key never leaves Privy's
 * enclave and every transaction is checked against `operatorPolicy` first:
 *
 *   - on this chain only, with zero value (no MON can leave it);
 *   - to the escrow, log, registry or a settlement token, and nothing else;
 *   - calling only the eight functions the broker actually uses.
 *
 * Privy can also pay the gas (`sponsor: true`, native gas sponsorship, which
 * supports Monad testnet), so the operator needs no MON at all.
 *
 *   XORV_SIGNER=key          the raw XORV_OPERATOR_KEY (the default)
 *   XORV_SIGNER=privy        PRIVY_APP_ID, PRIVY_APP_SECRET, XORV_PRIVY_WALLET_ID,
 *                            XORV_PRIVY_WALLET_ADDRESS; XORV_PRIVY_SPONSOR=0 to pay
 *                            gas yourself; PRIVY_AUTHORIZATION_KEY if the wallet
 *                            has an owner. `pnpm --filter @xorv/broker privy:setup`
 *                            creates the policy and the wallet.
 *
 * There is no stand-in: without the Privy keys the broker signs with the raw key
 * and says so (`/api/network` → operator.signer.mode "key").
 */
import {
  type Abi,
  type AbiFunction,
  type Address,
  type EIP1193RequestFn,
  type Hex,
  type WalletClient,
  createWalletClient,
  custom,

  getAddress,
  http,
  parseAbi,
} from "viem";
import { chainIdFor, rpcUrl, stablecoins } from "./constants.js";
import { evmChain, writeClient } from "./chain.js";
import { XORV_ESCROW_ABI } from "./xorv-escrow.abi.js";
import { XORV_LOG_ABI } from "./xorv-log.abi.js";
import { XORV_REGISTRY_ABI } from "./registry.js";

export type SignerMode = "key" | "privy";

export interface PrivySignerEnv {
  appId: string;
  appSecret: string;
  walletId: string;
  walletAddress: Address;
  sponsor: boolean;
  authorizationKey: string | null;
}

export interface OperatorSigner {
  mode: SignerMode;
  /** Set for "privy". */
  privy?: PrivySignerEnv;
}

/** Which signer the environment asks for, with every missing value named at once. */
export function signerFromEnv(env: NodeJS.ProcessEnv = process.env): OperatorSigner {
  const mode = (env.XORV_SIGNER?.trim() || "key") as SignerMode;
  if (mode === "key") return { mode };
  if (mode !== "privy") throw new Error(`XORV_SIGNER must be key or privy, got "${mode}"`);
  const need = ["PRIVY_APP_ID", "PRIVY_APP_SECRET", "XORV_PRIVY_WALLET_ID", "XORV_PRIVY_WALLET_ADDRESS"];
  const missing = need.filter((k) => !env[k]?.trim());
  if (missing.length) {
    throw new Error(
      `XORV_SIGNER=privy needs ${missing.join(", ")}. Create the app at dashboard.privy.io, then run ` +
        "`pnpm --filter @xorv/broker privy:setup` for the wallet.",
    );
  }
  return {
    mode,
    privy: {
      appId: env.PRIVY_APP_ID!.trim(),
      appSecret: env.PRIVY_APP_SECRET!.trim(),
      walletId: env.XORV_PRIVY_WALLET_ID!.trim(),
      walletAddress: getAddress(env.XORV_PRIVY_WALLET_ADDRESS!.trim()),
      sponsor: env.XORV_PRIVY_SPONSOR?.trim() !== "0",
      authorizationKey: env.PRIVY_AUTHORIZATION_KEY?.trim() || null,
    },
  };
}

/* ───────────────────────────── the policy ───────────────────────────── */

export interface PolicyCondition {
  field_source: "ethereum_transaction" | "ethereum_calldata";
  field: string;
  operator: "eq" | "gt" | "gte" | "lt" | "lte" | "in";
  value: string | string[];
  abi?: Abi;
}

export interface PolicyRule {
  name: string;
  method: "eth_sendTransaction" | "eth_signTransaction";
  action: "ALLOW" | "DENY";
  conditions: PolicyCondition[];
}

/** The body `POST /v1/policies` takes. */
export interface PrivyPolicy {
  version: "1.0";
  name: string;
  chain_type: "ethereum";
  rules: PolicyRule[];
}

/** EIP-3009, both signature encodings: x402's exact scheme uses either. */
const EIP3009_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
]);

/** Only the named functions of an ABI: the policy decodes with nothing it doesn't allow. */
function only(abi: Abi, name: string): Abi {
  const picked = abi.filter((item): item is AbiFunction => item.type === "function" && item.name === name);
  if (!picked.length) throw new Error(`operatorPolicy: no function ${name} in the ABI`);
  return picked;
}

export interface OperatorContracts {
  network: string;
  escrow?: string | null;
  log?: string | null;
  registry?: string | null;
  /** Settlement tokens; defaults to the network's configured stablecoins. */
  tokens?: string[];
}

/**
 * The policy the operator wallet runs under: one ALLOW rule per (contract,
 * function) the broker calls, each pinned to this chain and to zero value.
 * Anything else, including the escrow's own admin functions, matches no rule
 * and is denied.
 */
export function operatorPolicy(c: OperatorContracts): PrivyPolicy {
  const chainId = String(chainIdFor(c.network));
  const tokens = c.tokens ?? stablecoins(c.network).map((t) => t.address);
  const calls: Array<{ contract: string; label: string; fn: string; abi: Abi }> = [];
  if (c.escrow) {
    for (const fn of ["fund", "release", "refund", "reassign", "cancel"]) {
      calls.push({ contract: c.escrow, label: "escrow", fn, abi: only(XORV_ESCROW_ABI as Abi, fn) });
    }
  }
  if (c.log) calls.push({ contract: c.log, label: "log", fn: "append", abi: only(XORV_LOG_ABI as Abi, "append") });
  if (c.registry) {
    calls.push({ contract: c.registry, label: "registry", fn: "registerFor", abi: only(XORV_REGISTRY_ABI as Abi, "registerFor") });
  }
  for (const token of tokens) {
    calls.push({ contract: token, label: "token", fn: "transferWithAuthorization", abi: EIP3009_ABI as Abi });
  }
  return {
    version: "1.0",
    name: `xorv-operator-${chainId}`,
    chain_type: "ethereum",
    rules: calls.map(({ contract, label, fn, abi }) => ({
      name: `${label}.${fn} on ${chainId}`,
      method: "eth_sendTransaction",
      action: "ALLOW",
      conditions: [
        { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: chainId },
        { field_source: "ethereum_transaction", field: "to", operator: "eq", value: getAddress(contract).toLowerCase() },
        { field_source: "ethereum_transaction", field: "value", operator: "lte", value: "0x0" },
        { field_source: "ethereum_calldata", field: "function_name", operator: "eq", value: fn, abi },
      ],
    })),
  };
}

/* ────────────────────────── the wallet client ────────────────────────── */

interface RpcTx {
  from?: string;
  to?: string;
  data?: Hex;
  value?: Hex;
  gas?: Hex;
}

/** Sends one transaction somewhere other than the node; returns its hash. */
export type TransactionSender = (tx: RpcTx) => Promise<Hex>;

/**
 * A viem wallet client whose `eth_sendTransaction` goes to `send` and whose
 * every other call goes to the network's RPC. The account is a JSON-RPC account,
 * so `writeContract` hands the unsigned transaction to `send` as is: the
 * signer, not viem, holds the key.
 */
export function routedWalletClient(network: string, address: Address, send: TransactionSender): WalletClient {
  const node = http(rpcUrl(network), { timeout: 30_000, retryCount: 5, retryDelay: 1_000 })({ chain: evmChain(network) });
  const request: EIP1193RequestFn = (async ({ method, params }: { method: string; params?: unknown }) => {
    if (method === "eth_sendTransaction") return send((params as RpcTx[])[0]!);
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
    return node.request({ method, params } as never);
  }) as EIP1193RequestFn;
  return createWalletClient({ account: address, chain: evmChain(network), transport: custom({ request }) });
}

/** The slice of `@privy-io/node` the sender uses, so tests can stand in for it. */
export interface PrivyApi {
  sendTransaction(
    walletId: string,
    input: {
      caip2: string;
      params: { transaction: { to?: string; data?: Hex; value?: Hex; chain_id?: number; gas_limit?: Hex } };
      sponsor?: boolean;
      authorization_context?: { authorization_private_keys: string[] };
    },
  ): Promise<{ hash?: string; transaction_id?: string }>;
  transactionHash(transactionId: string): Promise<{ hash: string | null; status: string }>;
}

export async function privyApi(env: PrivySignerEnv): Promise<PrivyApi> {
  const { PrivyClient } = await import("@privy-io/node");
  const privy = new PrivyClient({ appId: env.appId, appSecret: env.appSecret });
  return {
    sendTransaction: (walletId, input) => privy.wallets().ethereum().sendTransaction(walletId, input as never),
    async transactionHash(id) {
      const t = await privy.transactions().get(id);
      return { hash: t.transaction_hash, status: t.status };
    },
  };
}

/**
 * The real thing: Privy signs inside its enclave after checking the wallet's
 * policy, and with `sponsor` pays the gas. A sponsored send can come back
 * before its hash exists, so the sender waits on Privy's transaction record.
 */
export function privySender(
  network: string,
  env: PrivySignerEnv,
  apiOrLoader: PrivyApi | (() => Promise<PrivyApi>),
  opts: { pollMs?: number; timeoutMs?: number } = {},
): TransactionSender {
  const chainId = chainIdFor(network);
  let loaded: Promise<PrivyApi> | null = typeof apiOrLoader === "function" ? null : Promise.resolve(apiOrLoader);
  return async (tx) => {
    loaded ??= (apiOrLoader as () => Promise<PrivyApi>)();
    const api = await loaded;
    const sent = await api.sendTransaction(env.walletId, {
      caip2: `eip155:${chainId}`,
      params: { transaction: { to: tx.to, data: tx.data, value: tx.value ?? "0x0", chain_id: chainId, ...(tx.gas ? { gas_limit: tx.gas } : {}) } },
      sponsor: env.sponsor,
      ...(env.authorizationKey ? { authorization_context: { authorization_private_keys: [env.authorizationKey] } } : {}),
    });
    if (sent.hash) return sent.hash as Hex;
    if (!sent.transaction_id) throw new Error("Privy accepted the transaction but returned neither a hash nor a transaction id");
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      const t = await api.transactionHash(sent.transaction_id);
      if (t.hash) return t.hash as Hex;
      if (["failed", "execution_reverted", "provider_error", "replaced"].includes(t.status)) {
        throw new Error(`Privy transaction ${sent.transaction_id} ended ${t.status}`);
      }
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 1_000));
    }
    throw new Error(`Privy transaction ${sent.transaction_id} has no hash after ${(opts.timeoutMs ?? 60_000) / 1000}s`);
  };
}

export interface OperatorWallet {
  wallet: WalletClient;
  address: Address;
  /** One line for logs and /api/network. */
  description: string;
  policy: PrivyPolicy | null;
}

/** The operator's wallet client for whichever signer is configured. The Privy client loads on first send. */
export function operatorWallet(
  signer: OperatorSigner,
  contracts: OperatorContracts,
  rawKey: string,
  hooks: { api?: PrivyApi } = {},
): OperatorWallet {
  const { network } = contracts;
  if (signer.mode === "key") {
    const wallet = writeClient(network, rawKey);
    return { wallet, address: wallet.account!.address, description: "a local key, unrestricted (Privy not configured)", policy: null };
  }
  const policy = operatorPolicy(contracts);
  const env = signer.privy!;
  return {
    wallet: routedWalletClient(network, env.walletAddress, privySender(network, env, hooks.api ?? (() => privyApi(env)))),
    address: env.walletAddress,
    description: `Privy server wallet ${env.walletId}, policy-locked${env.sponsor ? ", gas sponsored by Privy" : ""}`,
    policy,
  };
}
