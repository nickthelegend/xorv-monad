/**
 * Kimi's scores, written to ERC-8004 as reputation.
 *
 * After the verifier scores a job, the broker's *verifier EOA* calls
 *
 *   ReputationRegistry.giveFeedback(agentId, score, 0, "xorv-verified", adapter,
 *                                   endpoint, feedbackURI, feedbackHash)
 *
 * directly — not through XorvLedger, which relays *buyer* ratings under tag
 * "starred". Two different client addresses, two different tags, so anyone
 * reading the registry can tell a paying buyer's opinion from the network's
 * automated check, and the Envio indexer classifies these as XORV_VERIFIED
 * (it trusts "xorv-verified" feedback from the ledger's broker EOA and from
 * any address listed in ENVIO_XORV_VERIFIER_ADDRESSES — list this one there
 * when XORV_VERIFIER_KEY is not the operator key).
 *
 * Rules the registry enforces, and what they mean here:
 *  - it rejects feedback from the agent's owner or approved operators, so the
 *    verifier EOA must never own or operate a provider's agent NFT (the
 *    `estimateGas` preflight surfaces that revert before any gas is spent);
 *  - `endpoint`, `feedbackURI` and `feedbackHash` are only emitted, not
 *    stored, so the feedback file is the durable record. It is served from
 *    `/verifications/<jobId>.json` as canonical JSON whose keccak256 is the
 *    committed `feedbackHash`, and it is rebuilt from facts that are frozen
 *    once the job is scored (the payment, the prompt and result hashes, the
 *    verdict and its timestamp) — the file served next year must still hash
 *    to what went on-chain today.
 *
 * Gas: ~280k per first feedback from a client, billed on the *limit* on
 * Monad, so the write carries `estimateGas` + 15% and nothing more. It goes
 * through the protocol's per-address signer lock, the same queue the ledger
 * writer and the facilitator use, so a verifier sharing the operator key
 * never races them for a nonce. Best-effort throughout: a failed write is
 * logged, counted and stored on the job as `feedbackError`; it never touches
 * the job itself.
 */

import type { Address, Hex, PrivateKeyAccount, Transport } from "viem";
import {
  REPUTATION_ABI,
  buildFeedbackFile,
  explorerTx,
  jobIdHash,
  networkConfig,
  serializeFeedbackFile,
  textHash,
  walletClientFor,
  withGasHeadroom,
  withSignerLock,
  type FeedbackFile,
  type XorvWalletClient,
} from "@xorv/protocol";
import type { PublishResult } from "../chain.js";
import type { StoredJob } from "../jobs.js";
import { ratingTag } from "../ratings.js";
import type { VerificationRecord } from "./types.js";

/** ERC-8004 `tag1` for the verifier's scores; the indexer keys XORV_VERIFIED on it. */
export const VERIFIED_TAG1 = "xorv-verified";

const RECEIPT_TIMEOUT_MS = 30_000;

export interface VerificationFeedbackEnv {
  network: string;
  publicUrl: string;
  /** The ERC-8004 `endpoint` — the jobs service named in every agent file. */
  jobsEndpoint: string;
  /** The XorvLedger, when there is one, so the file can point at the job's receipt. */
  ledger: string | null;
}

export interface VerificationFeedback {
  file: FeedbackFile;
  /** The exact bytes served — canonical JSON. */
  bytes: string;
  feedbackHash: Hex;
  feedbackURI: string;
}

/** Where a job's verification feedback file is served. */
export function verificationURI(publicUrl: string, jobId: string): string {
  return `${publicUrl}/verifications/${jobId}.json`;
}

/**
 * The feedback file for one verified job.
 *
 * Everything in it is frozen by the time it is built: the payment, the
 * prompt and result hashes, the adapter tag, and the verdict with its own
 * timestamp. Nothing that changes later (a receipt tx, a buyer rating, the
 * clock) goes in.
 */
export function verificationFeedback(
  env: VerificationFeedbackEnv,
  job: StoredJob,
  verification: VerificationRecord,
  target: { agentId: string; verifier: string },
): VerificationFeedback {
  const payment = job.payment;
  if (!payment) throw new Error("a job without a recorded payment has no proof of payment to cite");
  const chainId = networkConfig(env.network).chainId;
  const file = buildFeedbackFile({
    network: env.network,
    agentId: target.agentId,
    // The verifier EOA calls giveFeedback itself, so it is the ERC-8004 client.
    clientAddress: target.verifier,
    createdAt: verification.at,
    value: verification.score,
    tag1: VERIFIED_TAG1,
    tag2: ratingTag(job),
    endpoint: env.jobsEndpoint,
    payment: { from: payment.payer, to: payment.payTo, txHash: payment.txHash, amount: payment.amount },
    reasoning: verification.rationale,
    xorv: {
      kind: "verification",
      jobId: job.id,
      jobIdHash: jobIdHash(job.id),
      ...(env.ledger ? { ledger: `eip155:${chainId}:${env.ledger}` } : {}),
      requestHash: textHash(job.request.prompt),
      resultHash: job.resultHash ?? textHash(job.result ?? ""),
      verifier: {
        by: verification.by,
        model: verification.model,
        score: verification.score,
        pass: verification.pass,
        flags: verification.flags ?? [],
      },
    },
  });
  const bytes = serializeFeedbackFile(file);
  return { file, bytes, feedbackHash: textHash(bytes), feedbackURI: verificationURI(env.publicUrl, job.id) };
}

export interface GiveFeedbackInput {
  agentId: string;
  /** 0–100, `valueDecimals` 0 — the same scale as buyer ratings. */
  value: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: Hex;
}

/** `giveFeedback`'s arguments, in ABI order and types. */
export function giveFeedbackArgs(input: GiveFeedbackInput) {
  if (!Number.isInteger(input.value) || input.value < 0 || input.value > 100) {
    throw new Error(`feedback value must be an integer 0-100, got ${input.value}`);
  }
  return [
    BigInt(input.agentId),
    BigInt(input.value),
    0,
    input.tag1,
    input.tag2,
    input.endpoint,
    input.feedbackURI,
    input.feedbackHash,
  ] as const;
}

/** Where verifier scores go on-chain. An interface so tests can capture writes without an RPC. */
export interface FeedbackSink {
  /** The EOA that signs `giveFeedback` — the ERC-8004 client address. */
  readonly address: string;
  readonly reputationRegistry: string;
  giveFeedback(input: GiveFeedbackInput): Promise<PublishResult>;
  counts(): { published: number; failed: number; lastError: string | null };
}

export interface ReputationWriterOptions {
  network: string;
  account: PrivateKeyAccount;
  rpcUrl?: string;
  transport?: Transport;
  /** Replace the broadcast-and-wait step (tests). */
  submit?: (args: ReturnType<typeof giveFeedbackArgs>) => Promise<PublishResult>;
  log?: (line: string) => void;
}

/** Sends verifier feedback to the ERC-8004 Reputation Registry from the verifier EOA. */
export class ReputationWriter implements FeedbackSink {
  readonly address: Address;
  readonly reputationRegistry: Address;
  private readonly network: string;
  private readonly account: PrivateKeyAccount;
  private readonly wallet: XorvWalletClient | null;
  private readonly submitOverride: ReputationWriterOptions["submit"];
  private readonly log: (line: string) => void;
  private published = 0;
  private failed = 0;
  private lastError: string | null = null;

  constructor(opts: ReputationWriterOptions) {
    this.network = opts.network;
    this.account = opts.account;
    this.address = opts.account.address;
    this.reputationRegistry = networkConfig(opts.network).erc8004.reputation;
    this.submitOverride = opts.submit;
    this.log = opts.log ?? ((line) => console.error(line));
    this.wallet = opts.submit
      ? null
      : walletClientFor(opts.network, opts.account, { rpcUrl: opts.rpcUrl, transport: opts.transport });
  }

  counts() {
    return { published: this.published, failed: this.failed, lastError: this.lastError };
  }

  /** Write one score. Throws on failure (the caller records it on the job); counts either way. */
  async giveFeedback(input: GiveFeedbackInput): Promise<PublishResult> {
    try {
      const args = giveFeedbackArgs(input);
      const result = this.submitOverride ? await this.submitOverride(args) : await this.broadcast(args);
      this.published += 1;
      return result;
    } catch (err) {
      this.failed += 1;
      const message = describe(err);
      this.lastError = `giveFeedback(agent #${input.agentId}): ${message}`;
      this.log(`[verifier] ${this.lastError}`);
      throw new Error(message);
    }
  }

  /**
   * Estimate, sign and send under the signer lock; wait for inclusion outside
   * it — the same shape as the ledger writer's broadcast, for the same
   * reasons (nonces are assigned at send time; Monad bills the gas limit).
   */
  private async broadcast(args: ReturnType<typeof giveFeedbackArgs>): Promise<PublishResult> {
    const wallet = this.wallet;
    if (!wallet) throw new Error("reputation writer has no wallet");
    const request = {
      address: this.reputationRegistry,
      abi: REPUTATION_ABI,
      functionName: "giveFeedback",
      args,
      account: this.account,
    } as const;
    let hash: Hex;
    try {
      hash = await withSignerLock(this.account.address, async () => {
        // The estimate doubles as the preflight: a feedback the registry
        // would refuse (self-feedback, an unknown agent) reverts here, free.
        const gas = withGasHeadroom(await wallet.estimateContractGas(request as never));
        return wallet.writeContract({ ...request, gas } as never);
      });
    } catch (err) {
      this.account.nonceManager?.reset({ address: this.account.address, chainId: wallet.chain.id });
      throw err;
    }
    const receipt = await wallet.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== "success") throw new Error(`giveFeedback reverted on-chain (${hash})`);
    return {
      contract: this.reputationRegistry,
      txHash: hash,
      explorerUrl: explorerTx(this.network, hash),
      blockNumber: receipt.blockNumber.toString(),
    };
  }
}

function describe(err: unknown): string {
  const e = err as { shortMessage?: unknown; message?: unknown } | null;
  const message = typeof e?.shortMessage === "string" && e.shortMessage ? e.shortMessage : err instanceof Error ? err.message : String(err);
  return message.length > 300 ? `${message.slice(0, 299)}…` : message;
}
