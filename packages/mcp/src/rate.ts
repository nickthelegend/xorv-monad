/**
 * Rating a job: the buyer's signed verdict, relayed on-chain for free.
 *
 *   GET  /api/jobs/:id/rating?value=N  → the EIP-712 `Rating` the broker wants signed
 *   sign it with the active payer (local key or Privy server wallet)
 *   POST /api/jobs/:id/rate            → the broker checks the signature is the
 *                                        payer's and relays `XorvLedger.rateJob`,
 *                                        which writes ERC-8004 reputation feedback
 *
 * The buyer spends no gas and holds no MON. What it does hold is a signing
 * key, so — as with payments — nothing is signed on the broker's say-so
 * alone. The typed data must be a XorvLedger `Rating` on this server's chain,
 * for *this* job id and *this* value, and the broker must agree that this
 * server's address is the one that paid. A broker that tried to get a
 * different job, a different score or another chain's ledger signed gets a
 * refusal instead.
 */

import {
  explorerTx,
  jobIdHash,
  networkConfig,
  ratingTypedData,
  sameAddress,
  type RatingInput,
} from "@xorv/protocol";
import { brokerErrorText, type BrokerClient } from "./broker.js";
import type { PayerSigner, ResolvedPayer } from "./signer.js";

/** `GET /api/jobs/:id/rating` — what the broker asks the payer to sign. */
export interface RatingOffer {
  jobId: string;
  value: number;
  /** Unix seconds; the signature is relayable until then. */
  deadline: number;
  /** The job's payer — the only address whose signature the broker will relay. */
  signer: string;
  agentId: string;
  feedbackURI: string;
  feedbackHash: string;
  typedData: {
    domain: { name?: string; version?: string; chainId?: number | string; verifyingContract?: string };
    types?: unknown;
    primaryType?: string;
    message: RatingInput;
  };
}

export interface RateResult {
  payer: ResolvedPayer;
  offer: RatingOffer;
  txHash: string | null;
  explorerUrl: string | null;
  feedbackURI: string;
}

export class RateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateError";
  }
}

/**
 * Check a rating offer against what was asked for and return the typed data
 * to sign, rebuilt locally from its fields.
 *
 * Rebuilding (rather than signing the JSON as received) also turns the
 * decimal-string `uint256`s back into bigints and re-validates every field
 * through the protocol's own `ratingMessage` — the typed data signed is
 * exactly the struct `XorvLedger.rateJob` will hash.
 */
export function vetRatingOffer(
  offer: RatingOffer,
  ctx: { network: string; jobId: string; value: number; payer: string },
): ReturnType<typeof ratingTypedData> {
  const cfg = networkConfig(ctx.network);
  const domain = offer.typedData?.domain ?? {};
  const message = offer.typedData?.message;
  if (!message) throw new RateError("the broker's rating offer carries no message to sign");

  if (!sameAddress(offer.signer, ctx.payer)) {
    throw new RateError(
      `job ${ctx.jobId} was paid for by ${offer.signer}, but this server signs as ${ctx.payer} — only the buyer who paid can rate a job`,
    );
  }
  if (domain.name !== "XorvLedger" || domain.version !== "1" || (offer.typedData.primaryType ?? "Rating") !== "Rating") {
    throw new RateError(
      `refusing to sign: expected a XorvLedger v1 Rating, got domain ${JSON.stringify(domain.name)} v${String(domain.version)} / ${String(offer.typedData.primaryType)}`,
    );
  }
  if (Number(domain.chainId) !== cfg.chainId) {
    throw new RateError(
      `refusing to sign: the rating is for chain ${String(domain.chainId)} but this server runs on ${cfg.caip2} (chain ${cfg.chainId})`,
    );
  }
  if (!domain.verifyingContract) throw new RateError("refusing to sign: the rating names no XorvLedger contract");
  if (String(message.jobId).toLowerCase() !== jobIdHash(ctx.jobId).toLowerCase()) {
    throw new RateError(`refusing to sign: the rating's jobId ${String(message.jobId)} is not job ${ctx.jobId}`);
  }
  if (String(message.value) !== String(ctx.value) || Number(offer.value) !== ctx.value) {
    throw new RateError(`refusing to sign: asked to rate ${ctx.value}, but the broker's message says ${String(message.value)}`);
  }
  if (String(message.deadline) !== String(offer.deadline)) {
    throw new RateError("refusing to sign: the message deadline does not match the offer's");
  }

  try {
    return ratingTypedData({ network: cfg.caip2, ledger: domain.verifyingContract, rating: message });
  } catch (err) {
    throw new RateError(`refusing to sign a malformed rating: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function rateJob(
  deps: { broker: BrokerClient; signer: PayerSigner; network: string },
  args: { jobId: string; value: number },
): Promise<RateResult> {
  if (!Number.isInteger(args.value) || args.value < 0 || args.value > 100) {
    throw new RateError("a rating is an integer from 0 (useless) to 100 (perfect)");
  }
  const payer = await deps.signer.resolve().catch((err: unknown) => {
    throw new RateError(err instanceof Error ? err.message : String(err));
  });

  const path = `/api/jobs/${encodeURIComponent(args.jobId)}`;
  let offer: RatingOffer;
  try {
    offer = await deps.broker.getJson<RatingOffer>(`${path}/rating?value=${args.value}`);
  } catch (err) {
    const body = (err as { body?: unknown }).body;
    throw new RateError(`Could not get job ${args.jobId}'s rating to sign: ${brokerErrorText(body) ?? (err instanceof Error ? err.message : String(err))}`);
  }

  const typedData = vetRatingOffer(offer, { network: deps.network, jobId: args.jobId, value: args.value, payer: payer.address });

  let signature: string;
  try {
    signature = await payer.account.signTypedData(typedData);
  } catch (err) {
    // With a Privy wallet this is where a policy denial surfaces.
    throw new RateError(`The ${payer.mode === "privy" ? "Privy wallet" : "payer key"} refused to sign the rating: ${err instanceof Error ? err.message : String(err)}`);
  }

  const reply = await deps.broker.postJson<{ ok?: boolean; txHash?: string; explorerUrl?: string; feedbackURI?: string; error?: string }>(
    `${path}/rate`,
    { value: args.value, deadline: offer.deadline, signature },
  );
  if (!reply.ok || !reply.body?.ok) {
    throw new RateError(`The broker did not relay the rating (${reply.status}): ${brokerErrorText(reply.body) ?? "no reason given"}`);
  }
  const txHash = reply.body.txHash ?? null;
  return {
    payer,
    offer,
    txHash,
    explorerUrl: reply.body.explorerUrl ?? (txHash ? explorerTx(deps.network, txHash) : null),
    feedbackURI: reply.body.feedbackURI ?? offer.feedbackURI,
  };
}
