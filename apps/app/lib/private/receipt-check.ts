/**
 * Checking a private result against its on-chain receipt, not the broker's word.
 *
 * The job page gets both the sealed envelope and `resultHash` from the
 * broker, and the broker computes that hash from the same string it serves.
 * Comparing the two proves nothing: a broker (or a tampered store) that swaps
 * the envelope recomputes the hash too. What it cannot rewrite is the
 * XorvLedger receipt already on Monad. So this reads the receipt transaction,
 * finds the `JobRecorded` event the ledger emitted for this job id, and
 * compares the envelope with the `resultHash` in *that* event.
 *
 * (The receipt can only vouch for what was recorded: a broker dishonest at
 * the moment it wrote the receipt could have recorded a forged hash too. The
 * check catches every change made after the receipt was written.)
 */

import { decodeEventLog, type Hex } from "viem";
import { XORV_LEDGER_ABI, jobIdHash, sameAddress } from "@xorv/protocol/web";
import { receiptMatchesCiphertext } from "@/lib/private/result";

export type ReceiptCheck =
  /** The envelope hashes to the receipt's `resultHash`. */
  | { status: "match"; resultHash: Hex }
  /** The receipt on Monad commits to something else. */
  | { status: "mismatch"; resultHash: Hex }
  /** The transaction has no `JobRecorded` for this job from this ledger. */
  | { status: "not-found" }
  /** The chain couldn't be read (RPC down, rate-limited, tx unknown yet). */
  | { status: "unavailable" };

interface ReceiptLog {
  address: string;
  topics: readonly Hex[];
  data: Hex;
}

/** The one read this needs; a viem public client provides it. */
export interface ReceiptReader {
  getTransactionReceipt(args: { hash: Hex }): Promise<{ logs: readonly ReceiptLog[] }>;
}

/** The `resultHash` XorvLedger recorded for `jobId` in transaction `txHash`, or null. */
export async function readReceiptResultHash(opts: {
  client: ReceiptReader;
  txHash: string;
  ledger: string;
  jobId: string;
}): Promise<Hex | null> {
  const receipt = await opts.client.getTransactionReceipt({ hash: opts.txHash as Hex });
  const wanted = jobIdHash(opts.jobId).toLowerCase();
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, opts.ledger) || log.topics.length === 0) continue;
    try {
      const event = decodeEventLog({
        abi: XORV_LEDGER_ABI,
        eventName: "JobRecorded",
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      if (event.args.jobId.toLowerCase() === wanted) return event.args.resultHash;
    } catch {
      // Another event in the same transaction (a batch records many jobs).
    }
  }
  return null;
}

/** Does the served envelope match what the job's XorvLedger receipt committed to? */
export async function checkResultAgainstReceipt(opts: {
  client: ReceiptReader;
  txHash: string;
  ledger: string;
  jobId: string;
  result: string;
}): Promise<ReceiptCheck> {
  let onChain: Hex | null;
  try {
    onChain = await readReceiptResultHash(opts);
  } catch {
    return { status: "unavailable" };
  }
  if (!onChain) return { status: "not-found" };
  return receiptMatchesCiphertext(opts.result, onChain)
    ? { status: "match", resultHash: onChain }
    : { status: "mismatch", resultHash: onChain };
}
