/**
 * Buyer ratings: the EIP-712 message a buyer signs, and the ERC-8004 feedback
 * file its hash commits to.
 *
 * The flow is gasless for the buyer:
 *
 *   GET  /api/jobs/:id/rating?value=87   → typed data (and the feedback file's hash)
 *   buyer signs it in their wallet (Privy, MetaMask, a CLI key)
 *   POST /api/jobs/:id/rate              → the broker checks the signature is the
 *                                          payer's, then relays XorvLedger.rateJob,
 *                                          which calls ReputationRegistry.giveFeedback
 *
 * The one subtle requirement is that the feedback file is *reproducible*: its
 * keccak256 is inside the signed message and ends up on-chain, and the file
 * is served later from `/feedback/<jobId>.json`. So it is built only from
 * facts that are frozen once a job is terminal — the payment, the prompt and
 * result hashes, the adapter — plus the rating value and the deadline, which
 * travel with the signature. Its `createdAt` is derived from the deadline for
 * the same reason: the file served tomorrow must hash to what was signed today.
 */

import {
  RATING_TAG1,
  buildFeedbackFile,
  feedbackFileHash,
  jobIdHash,
  networkConfig,
  ratingMessage,
  ratingTypedData,
  textHash,
  type FeedbackFile,
  type RatingInput,
} from "@xorv/protocol";
import type { StoredJob } from "./jobs.js";

/** How long a rating signature stays relayable; also fixes the feedback file's `createdAt`. */
export const RATING_TTL_SECONDS = 3_600;

export interface RatingParts {
  rating: RatingInput;
  typedData: ReturnType<typeof ratingTypedData>;
  feedback: FeedbackFile;
  feedbackHash: string;
  feedbackURI: string;
}

export interface RatingEnv {
  network: string;
  ledger: string;
  publicUrl: string;
  /** The ERC-8004 `endpoint` a rating refers to — the jobs service in the agent file. */
  jobsEndpoint: string;
}

/** The feedback file for one job at one rating value and deadline. */
export function feedbackFor(
  env: RatingEnv,
  job: StoredJob,
  agentId: string,
  value: number,
  deadline: number,
): FeedbackFile {
  const payment = job.payment;
  if (!payment) throw new Error("a job without a recorded payment cannot be rated");
  const chainId = networkConfig(env.network).chainId;
  return buildFeedbackFile({
    network: env.network,
    agentId,
    // XorvLedger is who calls giveFeedback, so it is the ERC-8004 client.
    clientAddress: env.ledger,
    createdAt: (deadline - RATING_TTL_SECONDS) * 1000,
    value,
    tag1: RATING_TAG1,
    tag2: ratingTag(job),
    endpoint: env.jobsEndpoint,
    payment: { from: payment.payer, to: payment.payTo, txHash: payment.txHash, amount: payment.amount },
    xorv: {
      jobId: job.id,
      jobIdHash: jobIdHash(job.id),
      ledger: `eip155:${chainId}:${env.ledger}`,
      requestHash: textHash(job.request.prompt),
      resultHash: textHash(job.result ?? ""),
      ok: job.status === "completed",
    },
  });
}

/** Everything needed to sign, verify and relay one rating. */
export function ratingParts(
  env: RatingEnv,
  job: StoredJob,
  agentId: string,
  value: number,
  deadline: number,
): RatingParts {
  const feedback = feedbackFor(env, job, agentId, value, deadline);
  const feedbackHash = feedbackFileHash(feedback);
  const feedbackURI = `${env.publicUrl}/feedback/${job.id}.json`;
  const rating: RatingInput = {
    jobId: jobIdHash(job.id),
    value,
    tag2: ratingTag(job),
    endpoint: env.jobsEndpoint,
    feedbackURI,
    feedbackHash,
    deadline,
  };
  return {
    rating,
    typedData: ratingTypedData({ network: env.network, ledger: env.ledger, rating }),
    feedback,
    feedbackHash,
    feedbackURI,
  };
}

/**
 * ERC-8004 `tag2`: the adapter that ran the job, so reputation can be read per
 * adapter ("how good is this node's Claude Code?"). Kept short — every byte of
 * a tag is stored by the Reputation Registry, and Monad charges for state.
 */
export function ratingTag(job: StoredJob): string {
  return (job.capabilityAdapter ?? job.request.adapter ?? "unknown").slice(0, 31);
}

export { ratingMessage };
