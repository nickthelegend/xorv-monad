/**
 * Rating a job: a gasless EIP-712 signature that becomes ERC-8004 reputation.
 *
 * The buyer who paid signs XorvLedger's `Rating` struct; the broker relays it
 * to `XorvLedger.rateJob`, which checks the signature against the job's
 * recorded payer and forwards `giveFeedback` to the ERC-8004 Reputation
 * Registry for the provider's agent. The buyer spends no MON.
 *
 * The broker proposes the typed data (it knows the feedback file URI/hash and
 * the deadline), but the plugin does not sign what it is handed: it rebuilds
 * the payload with `ratingTypedData` from `@xorv/protocol` against the ledger
 * the broker publishes in `/api/network`, checks every field it can verify
 * independently — domain, chain, contract, job id hash, value, deadline — and
 * signs its own copy through MetaMask.
 */

import { jobIdHash, networkConfig, ratingTypedData, sameAddress, type NetworkInfo } from "@xorv/protocol";
import type { Hex } from "viem";
import type { BrokerClient, RatingReceipt, RatingRequest } from "./broker.js";
import { targetChainIdOf } from "./config.js";
import { XorvPluginError } from "./errors.js";
import { assertSignedBy, signTypedDataWithWallet, type TypedDataInput, type WalletExecutor } from "./executor.js";

/** A relayed rating must be usable soon; anything further out than this is not what the broker's GET promises. */
const MAX_DEADLINE_AHEAD_SECONDS = 2 * 60 * 60;

export interface RateResult {
  jobId: string;
  stars: number;
  value: number;
  agentId: string;
  signer: string;
  txHash: string;
  explorerUrl: string;
  feedbackURI: string;
  feedbackHash: string;
}

/**
 * Rebuild and check the broker's proposed rating. Returns the typed data to
 * sign, or throws `XORV_RATING_REFUSED` naming the field that disagreed.
 */
export function verifyRatingRequest(opts: {
  jobId: string;
  value: number;
  request: RatingRequest;
  network: NetworkInfo;
  nowSeconds?: number;
}): { typedData: ReturnType<typeof ratingTypedData>; chainId: number } {
  const { request, network } = opts;
  const chainId = targetChainIdOf(network.network);
  if (chainId === null) {
    throw new XorvPluginError(
      "XORV_UNSUPPORTED_NETWORK",
      `the broker runs on ${network.network}, which this plugin does not sign for`,
      "Point --broker at a Monad broker.",
    );
  }
  if (!network.ledger?.address) {
    throw new XorvPluginError(
      "XORV_RATING_REFUSED",
      "the broker has no XorvLedger configured, so a rating cannot be recorded",
      "Ratings need a broker with XORV_LEDGER_ADDRESS set.",
    );
  }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const deadline = Number(request.deadline);
  if (!Number.isInteger(deadline) || deadline <= now || deadline > now + MAX_DEADLINE_AHEAD_SECONDS) {
    throw refused(`the rating deadline ${String(request.deadline)} is not within the next two hours`);
  }

  const proposed = request.typedData;
  const msg = (proposed?.message ?? {}) as Record<string, unknown>;
  const typedData = ratingTypedData({
    network: networkConfig(network.network).caip2,
    ledger: network.ledger.address,
    rating: {
      jobId: jobIdHash(opts.jobId),
      value: opts.value,
      tag2: typeof msg.tag2 === "string" ? msg.tag2 : "",
      endpoint: typeof msg.endpoint === "string" ? msg.endpoint : "",
      feedbackURI: request.feedbackURI,
      feedbackHash: request.feedbackHash,
      deadline,
    },
  });

  // Every field of the broker's proposal must equal ours.
  const domain = (proposed?.domain ?? {}) as Record<string, unknown>;
  if (domain.name !== typedData.domain.name || String(domain.version) !== typedData.domain.version) {
    throw refused(`unexpected EIP-712 domain ${String(domain.name)} v${String(domain.version)} (want XorvLedger v1)`);
  }
  if (Number(domain.chainId) !== chainId) throw refused(`the rating is for chain ${String(domain.chainId)}, not ${chainId}`);
  if (!sameAddress(String(domain.verifyingContract ?? ""), typedData.domain.verifyingContract)) {
    throw refused(`the rating names contract ${String(domain.verifyingContract)}, not the broker's ledger ${typedData.domain.verifyingContract}`);
  }
  if (proposed?.primaryType !== "Rating") throw refused(`unexpected primary type ${String(proposed?.primaryType)}`);
  if (String(msg.jobId).toLowerCase() !== typedData.message.jobId.toLowerCase()) {
    throw refused(`the rating is for a different job (${String(msg.jobId)})`);
  }
  if (String(msg.value) !== String(opts.value) || request.value !== opts.value) {
    throw refused(`the rating value is ${String(msg.value)}, not ${opts.value}`);
  }
  if (String(msg.deadline) !== String(deadline)) throw refused("the rating deadline does not match the request");
  if (msg.feedbackURI !== request.feedbackURI || String(msg.feedbackHash).toLowerCase() !== request.feedbackHash.toLowerCase()) {
    throw refused("the feedback file in the rating does not match the request");
  }
  return { typedData, chainId };
}

export async function rateJob(opts: {
  broker: BrokerClient;
  executor: WalletExecutor;
  jobId: string;
  stars: number;
  value: number;
  /** The active wallet, when known — lets a wrong-wallet attempt fail before a signature is requested. */
  address?: string | null;
  signal?: AbortSignal;
}): Promise<RateResult> {
  const [request, network] = await Promise.all([
    opts.broker.ratingRequest(opts.jobId, opts.value),
    opts.broker.network(),
  ]);
  if (opts.address && request.signer && !sameAddress(opts.address, request.signer)) {
    throw new XorvPluginError(
      "XORV_SIGNER_MISMATCH",
      `job ${opts.jobId} was paid by ${request.signer}; the active MetaMask wallet is ${opts.address}`,
      `Only the buyer who paid can rate a job. Select that wallet (mm wallet select) or pass --from ${request.signer}.`,
    );
  }
  const { typedData, chainId } = verifyRatingRequest({ jobId: opts.jobId, value: opts.value, request, network });

  const signature: Hex = await signTypedDataWithWallet(opts.executor, {
    chainId,
    typedData: typedData as unknown as TypedDataInput,
    intent: `Rate Xorv job ${opts.jobId}: ${opts.stars}/5 stars for ERC-8004 agent #${request.agentId} (gasless, no funds move)`,
    signal: opts.signal,
  });
  await assertSignedBy(typedData as unknown as TypedDataInput, signature, request.signer);

  const receipt: RatingReceipt = await opts.broker.submitRating(opts.jobId, {
    value: opts.value,
    deadline: Number(request.deadline),
    signature,
  });
  return {
    jobId: opts.jobId,
    stars: opts.stars,
    value: opts.value,
    agentId: request.agentId,
    signer: request.signer,
    txHash: receipt.txHash,
    explorerUrl: receipt.explorerUrl,
    feedbackURI: receipt.feedbackURI ?? request.feedbackURI,
    feedbackHash: receipt.feedbackHash ?? request.feedbackHash,
  };
}

function refused(message: string): XorvPluginError {
  return new XorvPluginError(
    "XORV_RATING_REFUSED",
    `${message} — refusing to sign`,
    "Nothing was signed. This is a broker fault; report it or retry later.",
  );
}
