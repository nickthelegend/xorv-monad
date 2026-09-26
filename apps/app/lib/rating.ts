/**
 * Rating a finished job — gasless for the buyer.
 *
 * A rating is an EIP-712 `Rating` message signed by the wallet that paid for
 * the job. The broker relays it to `XorvLedger.rateJob`, which checks the
 * signature against the recorded buyer and forwards it to the ERC-8004
 * Reputation Registry as `giveFeedback(agentId, value, …)`. The buyer signs
 * and pays nothing; the relay pays the MON.
 *
 * The broker proposes the message (it knows the feedback file and its hash),
 * but the buyer's side never signs what it is handed verbatim. The typed data
 * is rebuilt locally with protocol's `ratingTypedData` — canonical types, the
 * XorvLedger domain for *this* chain — and the fields that matter are checked
 * against what the buyer actually chose: this job, this score, a deadline that
 * has not passed, the ledger the broker advertises. A broker bug that proposes
 * someone else's job or a different score is an error, not a signature.
 */

import type { Hex } from "viem";
import { explorerTx, jobIdHash, networkConfig, ratingTypedData, sameAddress, type RatingInput } from "@xorv/protocol/web";
import { errorMessage, isUserRejection } from "@/lib/errors";

export const RATING_STARS = 5;

/** Stars (1–5) → the 0–100 value ERC-8004 feedback carries. Five stars is 100. */
export function starsToValue(stars: number): number {
  const whole = Math.round(stars);
  if (!Number.isFinite(whole) || whole < 1 || whole > RATING_STARS) {
    throw new Error(`a rating is 1 to ${RATING_STARS} stars, got ${String(stars)}`);
  }
  return whole * (100 / RATING_STARS);
}

/** 0–100 → stars, for showing a rating that already exists. */
export function valueToStars(value: number): number {
  return Math.max(0, Math.min(RATING_STARS, Math.round(value / (100 / RATING_STARS))));
}

export type RatingTypedData = ReturnType<typeof ratingTypedData>;

/** Anything that can sign typed data as the buyer: a viem/Privy account, a wallet-client adapter. */
export interface RatingSigner {
  address: string;
  signTypedData(typedData: RatingTypedData): Promise<Hex>;
}

export class RatingError extends Error {
  readonly rejected: boolean;
  constructor(message: string, opts: { rejected?: boolean } = {}) {
    super(message);
    this.name = "RatingError";
    this.rejected = opts.rejected ?? false;
  }
}

export interface RatingRequest {
  typedData: RatingTypedData;
  /** Unix seconds, as the decimal string the rate call echoes back. */
  deadline: string;
}

export interface RatingReceipt {
  value: number;
  /** The relay transaction (`rateJob` → `giveFeedback`), when the broker returned one. */
  txHash: string | null;
  explorerUrl: string | null;
  /** The ERC-8004 feedback file the rating points at; its keccak is on-chain. */
  feedbackURI: string | null;
}

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => v !== null && typeof v === "object" && !Array.isArray(v);

/** Pull `{ domain, message }` out of whichever envelope the broker used. */
function typedDataEnvelope(body: unknown): { domain: Loose; message: Loose; primaryType?: unknown } | null {
  if (!isObject(body)) return null;
  for (const candidate of [body.typedData, body.typed_data, body]) {
    if (isObject(candidate) && isObject(candidate.domain) && isObject(candidate.message)) {
      return { domain: candidate.domain, message: candidate.message, primaryType: candidate.primaryType };
    }
  }
  // A broker that sends the raw pieces instead of a typed-data blob.
  if (isObject(body.rating) && typeof body.ledger === "string") {
    return { domain: { name: "XorvLedger", version: "1", verifyingContract: body.ledger }, message: body.rating };
  }
  return null;
}

/**
 * Check what the broker proposed and rebuild it canonically.
 *
 * @throws {RatingError} naming the first thing that doesn't match.
 */
export function verifyRatingRequest(
  body: unknown,
  expect: { jobId: string; value: number; network: string; ledger?: string | null; nowSeconds?: number },
): RatingRequest {
  const envelope = typedDataEnvelope(body);
  if (!envelope) throw new RatingError("The broker didn't return a rating to sign.");
  const { domain, message } = envelope;

  if (envelope.primaryType !== undefined && envelope.primaryType !== "Rating") {
    throw new RatingError(`Refusing to sign: expected a Rating, got ${String(envelope.primaryType)}.`);
  }
  if (domain.name !== "XorvLedger" || String(domain.version) !== "1") {
    throw new RatingError("Refusing to sign: the rating is not for the XorvLedger contract.");
  }
  const chainId = networkConfig(expect.network).chainId;
  if (domain.chainId !== undefined && Number(domain.chainId) !== chainId) {
    throw new RatingError(`Refusing to sign: the rating is for chain ${String(domain.chainId)}, not ${chainId}.`);
  }
  const ledger = typeof domain.verifyingContract === "string" ? domain.verifyingContract : "";
  if (expect.ledger && !sameAddress(ledger, expect.ledger)) {
    throw new RatingError(`Refusing to sign: the rating targets ${ledger}, not the network's ledger ${expect.ledger}.`);
  }

  let typedData: RatingTypedData;
  try {
    typedData = ratingTypedData({ network: expect.network, ledger, rating: message as unknown as RatingInput });
  } catch (err) {
    throw new RatingError(`The broker's rating is malformed: ${errorMessage(err)}`);
  }

  if (typedData.message.jobId.toLowerCase() !== jobIdHash(expect.jobId).toLowerCase()) {
    throw new RatingError("Refusing to sign: the rating is for a different job.");
  }
  if (typedData.message.value !== BigInt(expect.value)) {
    throw new RatingError(`Refusing to sign: the rating says ${typedData.message.value}, you chose ${expect.value}.`);
  }
  const now = BigInt(expect.nowSeconds ?? Math.floor(Date.now() / 1000));
  if (typedData.message.deadline <= now) {
    throw new RatingError("The rating's signing window has already closed — try again.");
  }
  return { typedData, deadline: typedData.message.deadline.toString() };
}

interface RatingCall {
  brokerUrl: string;
  jobId: string;
  value: number;
  network: string;
  fetch?: typeof fetch;
}

function jobUrl(brokerUrl: string, jobId: string): string {
  return `${brokerUrl.replace(/\/+$/, "")}/api/jobs/${encodeURIComponent(jobId)}`;
}

/** `GET /api/jobs/:id/rating?value=` → verified typed data to sign. */
export async function fetchRatingRequest(opts: RatingCall & { ledger?: string | null }): Promise<RatingRequest> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const res = await doFetch(`${jobUrl(opts.brokerUrl, opts.jobId)}/rating?value=${opts.value}`, { cache: "no-store" });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const said = isObject(body) && typeof body.error === "string" ? body.error : null;
    throw new RatingError(said ?? `The broker returned ${res.status} for the rating.`);
  }
  return verifyRatingRequest(body, opts);
}

/** `POST /api/jobs/:id/rate` with the buyer's signature → the relay receipt. */
export async function submitRating(opts: RatingCall & { deadline: string; signature: Hex }): Promise<RatingReceipt> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const res = await doFetch(`${jobUrl(opts.brokerUrl, opts.jobId)}/rate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: opts.value, deadline: opts.deadline, signature: opts.signature }),
  });
  const body = (await res.json().catch(() => ({}))) as Loose;
  if (!res.ok) {
    throw new RatingError(typeof body.error === "string" ? body.error : `The broker couldn't relay the rating (${res.status}).`);
  }
  const nested = isObject(body.rating) ? body.rating : {};
  const pick = (...values: unknown[]) => values.find((v): v is string => typeof v === "string" && v.length > 0) ?? null;
  const txHash = pick(body.txHash, body.transaction, body.hash, nested.txHash);
  return {
    value: opts.value,
    txHash,
    explorerUrl: pick(body.explorerUrl) ?? (txHash ? explorerTx(opts.network, txHash) : null),
    feedbackURI: pick(body.feedbackURI, nested.feedbackURI),
  };
}

/**
 * The whole flow: fetch and verify the proposal, have the buyer sign it, relay.
 *
 * @throws {RatingError} — `rejected` is set when the buyer declined to sign.
 */
export async function rateJob(opts: RatingCall & { signer: RatingSigner; ledger?: string | null }): Promise<RatingReceipt> {
  const request = await fetchRatingRequest(opts);
  let signature: Hex;
  try {
    signature = await opts.signer.signTypedData(request.typedData);
  } catch (err) {
    if (isUserRejection(err)) throw new RatingError("You declined the signature — no rating was sent.", { rejected: true });
    throw new RatingError(`The wallet couldn't sign the rating: ${errorMessage(err)}`);
  }
  return submitRating({ ...opts, deadline: request.deadline, signature });
}
