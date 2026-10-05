/**
 * The `escrow` x402 scheme: pay into XorvEscrow instead of straight to the provider.
 *
 * x402's stock `exact` scheme moves money buyer → payee the moment a request
 * is paid. For a one-shot API call that is right. For an AI job that runs for
 * minutes on a stranger's machine it puts all the risk on the buyer: if the
 * node dies mid-job, the money has already gone.
 *
 * This scheme keeps the x402 shape — 402, sign, retry, 200 — and changes only
 * where the money waits. The buyer signs an EIP-3009 `ReceiveWithAuthorization`
 * whose payee is the escrow contract, and the facilitator redeems it by calling
 * `XorvEscrow.fund`. The broker later releases (delivered), refunds (failed) or
 * reassigns (another node takes over); if it never does, anyone can refund the
 * buyer once the deadline passes.
 *
 * ## The nonce is the job
 *
 * An EIP-3009 nonce is normally random. Here it is
 * `keccak256(abi.encode(FUNDING_NONCE_TYPEHASH, chainId, escrow, jobId, deadline))`
 * — the same derivation the contract performs. The buyer's single signature
 * therefore commits to the job and its refund deadline as well as the amount,
 * token and payee. The client **recomputes** the nonce from the requirements
 * rather than accepting one from the server, so a malicious broker cannot get
 * a buyer to sign an authorization for some other job.
 *
 * The payload has exactly the `exact` scheme's shape (`{authorization,
 * signature}`), which keeps wallet code shared between the two.
 */

import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkClient,
  SchemeNetworkFacilitator,
  SchemeNetworkServer,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  isAddressEqual,
  keccak256,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { XORV_ESCROW_ABI } from "./xorv-escrow.abi.js";

// Re-exported so browser code on the ./escrow subpath can decode escrow events.
export { XORV_ESCROW_ABI };

/** The x402 scheme identifier. */
export const ESCROW_SCHEME = "escrow";

/** Must match `XorvEscrow.FUNDING_NONCE_TYPEHASH`. */
export const FUNDING_NONCE_TYPEHASH = keccak256(
  stringToHex("XorvFunding(uint256 chainId,address escrow,bytes32 jobId,uint40 deadline)"),
);

/** Must match the token's EIP-3009 typehash; identical on USDC and USDG. */
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** `XorvEscrow.Status`, mirrored. */
export const ESCROW_STATUS = ["none", "funded", "released", "refunded"] as const;
export type EscrowStatus = (typeof ESCROW_STATUS)[number];

/** What `extra` carries on an escrow payment requirement. */
export interface EscrowExtra {
  /** The token's EIP-712 domain. USDG exposes no `version()`, so it can't be read on chain. */
  name: string;
  version: string;
  escrow: Address;
  /** bytes32 job id the escrow records the payment under. */
  jobId: Hex;
  /** Unix seconds after which anyone may refund the buyer. */
  deadline: number;
  /** Informational: the provider the job is matched to. Not signed over; see XorvEscrow.reassign. */
  provider?: Address;
}

export interface EscrowAuthorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface EscrowPayload {
  authorization: EscrowAuthorization;
  signature: Hex;
}

/** The bytes32 job id for a Xorv quote. Deterministic, so both 402 passes agree. */
export function escrowJobId(quoteId: string): Hex {
  return keccak256(stringToHex(`xorv:job:${quoteId}`));
}

/** The nonce XorvEscrow expects for `(jobId, deadline)`. Mirrors `fundingNonce` on chain. */
export function fundingNonce(opts: {
  chainId: number;
  escrow: Address;
  jobId: Hex;
  deadline: number;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint40" },
      ],
      [
        FUNDING_NONCE_TYPEHASH,
        BigInt(opts.chainId),
        getAddress(opts.escrow),
        opts.jobId,
        opts.deadline,
      ],
    ),
  );
}

function chainIdOf(network: string): number {
  const id = Number(network.split(":")[1]);
  if (!network.startsWith("eip155:") || !Number.isSafeInteger(id)) {
    throw new Error(`escrow scheme: not an EVM network: ${network}`);
  }
  return id;
}

/** Parse and validate `extra`. Throws with the field at fault. */
export function parseEscrowExtra(extra: Record<string, unknown> | undefined): EscrowExtra {
  const e = extra ?? {};
  const fail = (field: string): never => {
    throw new Error(`escrow scheme: requirements.extra.${field} is missing or malformed`);
  };
  if (typeof e.name !== "string" || !e.name) fail("name");
  if (typeof e.version !== "string" || !e.version) fail("version");
  if (typeof e.escrow !== "string" || !isAddress(e.escrow)) fail("escrow");
  if (typeof e.jobId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(e.jobId)) fail("jobId");
  if (typeof e.deadline !== "number" || !Number.isSafeInteger(e.deadline) || e.deadline <= 0) {
    fail("deadline");
  }
  if (e.provider !== undefined && (typeof e.provider !== "string" || !isAddress(e.provider))) {
    fail("provider");
  }
  return {
    name: e.name as string,
    version: e.version as string,
    escrow: getAddress(e.escrow as string),
    jobId: e.jobId as Hex,
    deadline: e.deadline as number,
    provider: e.provider ? getAddress(e.provider as string) : undefined,
  };
}

function typedData(requirements: PaymentRequirements, extra: EscrowExtra, auth: EscrowAuthorization) {
  return {
    domain: {
      name: extra.name,
      version: extra.version,
      chainId: chainIdOf(requirements.network),
      verifyingContract: getAddress(requirements.asset),
    },
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization" as const,
    message: {
      from: getAddress(auth.from),
      to: getAddress(auth.to),
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Anything that can sign EIP-712: a viem account, a wallet client, a browser wallet. */
export interface EscrowClientSigner {
  readonly address: Address;
  signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

/**
 * Buyer side. Register with `x402Client.register("eip155:*", new EscrowClientScheme(signer))`.
 *
 * Refuses to sign anything that would not fund exactly the job described:
 * payTo must be the escrow named in `extra`, and the nonce is derived locally.
 */
export class EscrowClientScheme implements SchemeNetworkClient {
  readonly scheme = ESCROW_SCHEME;

  constructor(
    private readonly signer: EscrowClientSigner,
    private readonly opts: { now?: () => number } = {},
  ) {}

  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
    const extra = parseEscrowExtra(requirements.extra);
    if (!isAddressEqual(getAddress(requirements.payTo), extra.escrow)) {
      throw new Error("escrow scheme: payTo is not the escrow contract named in extra");
    }
    const now = Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
    if (extra.deadline <= now) {
      throw new Error("escrow scheme: the job's refund deadline has already passed");
    }
    const authorization: EscrowAuthorization = {
      from: getAddress(this.signer.address),
      to: extra.escrow,
      value: requirements.amount,
      validAfter: "0",
      validBefore: String(now + requirements.maxTimeoutSeconds),
      nonce: fundingNonce({
        chainId: chainIdOf(requirements.network),
        escrow: extra.escrow,
        jobId: extra.jobId,
        deadline: extra.deadline,
      }),
    };
    const signature = await this.signer.signTypedData(
      typedData(requirements, extra, authorization) as never,
    );
    const payload: EscrowPayload = { authorization, signature };
    return { x402Version, payload: payload as unknown as Record<string, unknown> };
  }
}

// ---------------------------------------------------------------------------
// Resource server
// ---------------------------------------------------------------------------

/**
 * Server side. The broker builds `extra` itself (it knows the quote), so this
 * only needs to pass requirements through and convert prices.
 */
export class EscrowServerScheme implements SchemeNetworkServer {
  readonly scheme = ESCROW_SCHEME;

  async parsePrice(price: unknown, _network: Network) {
    if (price && typeof price === "object" && "amount" in price && "asset" in price) {
      const p = price as { amount: string; asset: string; extra?: Record<string, unknown> };
      return { amount: p.amount, asset: p.asset, extra: p.extra };
    }
    throw new Error("escrow scheme: price must be an explicit {amount, asset}");
  }

  async enhancePaymentRequirements(requirements: PaymentRequirements) {
    parseEscrowExtra(requirements.extra);
    return requirements;
  }
}

// ---------------------------------------------------------------------------
// Facilitator
// ---------------------------------------------------------------------------

/** Seconds of slack required on `validBefore`, so an authorization can't expire in flight. */
const VALID_BEFORE_BUFFER_S = 6;

const ERC20_READ_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

function invalid(reason: string, message: string, payer?: string): VerifyResponse {
  return { isValid: false, invalidReason: reason, invalidMessage: message, payer };
}

/**
 * Facilitator side: verifies the authorization and funds the escrow with it.
 *
 * The wallet must hold the escrow's attester key, because `fund` is
 * attester-only — which is what stops a third party that saw a signature from
 * funding the job with a provider of their choosing.
 */
export class EscrowFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = ESCROW_SCHEME;
  readonly caipFamily = "eip155:*";

  constructor(
    private readonly clients: { public: PublicClient; wallet: WalletClient },
    private readonly opts: {
      /**
       * The only escrow this facilitator will fund. The attester key can call
       * `fund` on any contract that trusts it, so a request naming some other
       * escrow is refused before anything is signed.
       */
      escrow?: Address;
      /** Called around the write so the broker can pause background RPC readers. */
      onWrite?: (phase: "start" | "end") => void;
      now?: () => number;
    } = {},
  ) {}

  getExtra(): undefined {
    return undefined;
  }

  getSigners(): string[] {
    const account = this.clients.wallet.account;
    return account ? [account.address] : [];
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    let extra: EscrowExtra;
    let body: EscrowPayload;
    try {
      extra = parseEscrowExtra(requirements.extra);
      body = payload.payload as unknown as EscrowPayload;
      if (!body?.authorization || typeof body.signature !== "string") {
        return invalid("invalid_payload", "payload must be {authorization, signature}");
      }
    } catch (err) {
      return invalid("invalid_requirements", (err as Error).message);
    }
    const auth = body.authorization;
    const payer = auth.from;

    if (this.opts.escrow && !isAddressEqual(extra.escrow, getAddress(this.opts.escrow))) {
      return invalid("unknown_escrow", `this facilitator only funds ${this.opts.escrow}`, payer);
    }

    if (requirements.scheme !== ESCROW_SCHEME || payload.accepted?.scheme !== ESCROW_SCHEME) {
      return invalid("unsupported_scheme", "not an escrow payment", payer);
    }
    if (payload.accepted.network !== requirements.network) {
      return invalid("network_mismatch", "payload is for a different network", payer);
    }
    if (!isAddress(auth.from) || !isAddress(auth.to)) {
      return invalid("invalid_payload", "authorization addresses are malformed", payer);
    }
    if (
      !isAddressEqual(getAddress(auth.to), extra.escrow) ||
      !isAddressEqual(getAddress(requirements.payTo), extra.escrow)
    ) {
      return invalid("invalid_payee", "authorization must pay the escrow contract", payer);
    }
    if (auth.value !== requirements.amount) {
      return invalid("invalid_amount", `authorized ${auth.value}, required ${requirements.amount}`, payer);
    }
    const expectedNonce = fundingNonce({
      chainId: chainIdOf(requirements.network),
      escrow: extra.escrow,
      jobId: extra.jobId,
      deadline: extra.deadline,
    });
    if (auth.nonce.toLowerCase() !== expectedNonce.toLowerCase()) {
      return invalid("invalid_nonce", "nonce is not this job's funding nonce", payer);
    }
    const now = Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
    if (BigInt(auth.validAfter) >= BigInt(now)) {
      return invalid("authorization_not_yet_valid", "validAfter is in the future", payer);
    }
    if (BigInt(auth.validBefore) <= BigInt(now + VALID_BEFORE_BUFFER_S)) {
      return invalid("authorization_expired", "validBefore has passed or is about to", payer);
    }

    const pub = this.clients.public;
    // viem's verifyTypedData also accepts ERC-1271 / ERC-6492 signatures, so a
    // smart-account buyer verifies here exactly as the token will check it.
    const signatureOk = await pub
      .verifyTypedData({
        address: getAddress(auth.from),
        ...(typedData(requirements, extra, auth) as object),
        signature: body.signature,
      } as never)
      .catch(() => false);
    if (!signatureOk) {
      return invalid("invalid_signature", "signature does not match the authorization", payer);
    }

    const asset = getAddress(requirements.asset);
    const [balance, used, allowed, job] = await Promise.all([
      pub.readContract({ address: asset, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [getAddress(auth.from)] }),
      pub.readContract({ address: asset, abi: ERC20_READ_ABI, functionName: "authorizationState", args: [getAddress(auth.from), expectedNonce] }),
      pub.readContract({ address: extra.escrow, abi: XORV_ESCROW_ABI, functionName: "tokenAllowed", args: [asset] }),
      pub.readContract({ address: extra.escrow, abi: XORV_ESCROW_ABI, functionName: "getJob", args: [extra.jobId] }),
    ]);
    if (!allowed) return invalid("asset_not_allowed", `escrow does not accept ${asset}`, payer);
    if (used) return invalid("nonce_already_used", "this job was already funded", payer);
    if ((job as { status: number }).status !== 0) {
      return invalid("job_exists", "the escrow already holds a job with this id", payer);
    }
    if ((balance as bigint) < BigInt(auth.value)) {
      return invalid("insufficient_funds", `balance ${balance} < ${auth.value}`, payer);
    }
    return { isValid: true, payer };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = requirements.network;
    const verdict = await this.verify(payload, requirements);
    if (!verdict.isValid) {
      return {
        success: false,
        errorReason: verdict.invalidReason,
        errorMessage: verdict.invalidMessage,
        payer: verdict.payer,
        transaction: "",
        network,
      };
    }
    const extra = parseEscrowExtra(requirements.extra);
    const { authorization: auth, signature } = payload.payload as unknown as EscrowPayload;
    if (!extra.provider) {
      return {
        success: false,
        errorReason: "invalid_requirements",
        errorMessage: "extra.provider is required to fund a job",
        payer: auth.from,
        transaction: "",
        network,
      };
    }

    this.opts.onWrite?.("start");
    try {
      const account = this.clients.wallet.account;
      if (!account) throw new Error("facilitator wallet has no account");
      const hash = await this.clients.wallet.writeContract({
        account,
        chain: this.clients.wallet.chain,
        address: extra.escrow,
        abi: XORV_ESCROW_ABI,
        functionName: "fund",
        args: [
          {
            jobId: extra.jobId,
            buyer: getAddress(auth.from),
            provider: extra.provider,
            token: getAddress(requirements.asset),
            amount: BigInt(auth.value),
            deadline: extra.deadline,
            validAfter: BigInt(auth.validAfter),
            validBefore: BigInt(auth.validBefore),
            signature,
          },
        ],
      });
      const receipt = await this.clients.public.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        return {
          success: false,
          errorReason: "transaction_reverted",
          errorMessage: `fund reverted in ${hash}`,
          payer: auth.from,
          transaction: hash,
          network,
        };
      }
      return { success: true, payer: auth.from, transaction: hash, network };
    } catch (err) {
      const e = err as Error & { shortMessage?: string };
      return {
        success: false,
        errorReason: "settlement_failed",
        errorMessage: e.shortMessage ?? e.message,
        payer: auth.from,
        transaction: "",
        network,
      };
    } finally {
      this.opts.onWrite?.("end");
    }
  }
}

// ---------------------------------------------------------------------------
// After funding: the broker's three verbs
// ---------------------------------------------------------------------------

export interface EscrowJob {
  buyer: Address;
  deadline: number;
  status: EscrowStatus;
  feeBps: number;
  provider: Address;
  amount: bigint;
  token: Address;
}

export async function readEscrowJob(
  client: PublicClient,
  escrow: Address,
  jobId: Hex,
): Promise<EscrowJob> {
  const j = (await client.readContract({
    address: escrow,
    abi: XORV_ESCROW_ABI,
    functionName: "getJob",
    args: [jobId],
  })) as {
    buyer: Address;
    deadline: number;
    status: number;
    feeBps: number;
    provider: Address;
    amount: bigint;
    token: Address;
  };
  return { ...j, status: ESCROW_STATUS[j.status] ?? "none" };
}

async function send(
  clients: { public: PublicClient; wallet: WalletClient },
  escrow: Address,
  functionName: "release" | "refund" | "reassign" | "cancel",
  args: readonly unknown[],
): Promise<Hex> {
  const account = clients.wallet.account;
  if (!account) throw new Error("escrow: wallet has no account");
  const hash = await clients.wallet.writeContract({
    account,
    chain: clients.wallet.chain,
    address: escrow,
    abi: XORV_ESCROW_ABI,
    functionName,
    args,
  } as never);
  const receipt = await clients.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`escrow ${functionName} reverted: ${hash}`);
  return hash;
}

/** Pay the provider. `resultSha256` is the hex SHA-256 of the result, with or without 0x. */
export function releaseEscrow(
  clients: { public: PublicClient; wallet: WalletClient },
  escrow: Address,
  jobId: Hex,
  resultSha256: string,
): Promise<Hex> {
  const hash = (resultSha256.startsWith("0x") ? resultSha256 : `0x${resultSha256}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("releaseEscrow: result hash must be 32 bytes");
  return send(clients, escrow, "release", [jobId, hash]);
}

/** Return the buyer's money; as attester this counts against the provider. */
export function refundEscrow(
  clients: { public: PublicClient; wallet: WalletClient },
  escrow: Address,
  jobId: Hex,
): Promise<Hex> {
  return send(clients, escrow, "refund", [jobId]);
}

/** Refund the buyer because they called the job off — no mark against the provider. */
export function cancelEscrow(
  clients: { public: PublicClient; wallet: WalletClient },
  escrow: Address,
  jobId: Hex,
): Promise<Hex> {
  return send(clients, escrow, "cancel", [jobId]);
}

/** Hand the job to another provider; the money stays in escrow. */
export function reassignEscrow(
  clients: { public: PublicClient; wallet: WalletClient },
  escrow: Address,
  jobId: Hex,
  newProvider: Address,
): Promise<Hex> {
  return send(clients, escrow, "reassign", [jobId, getAddress(newProvider)]);
}

/** Random 32 bytes, for tests and one-off ids. */
export function randomJobId(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
