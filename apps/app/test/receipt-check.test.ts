import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, keccak256, stringToBytes, type Hex } from "viem";
import { XORV_LEDGER_ABI, deriveInboxKeys, jobIdHash, sealResult } from "@xorv/protocol/web";
import { receiptMatchesCiphertext } from "@/lib/private/result";
import { checkResultAgainstReceipt, type ReceiptReader } from "@/lib/private/receipt-check";

/*
 * The job page's "the receipt commits to this ciphertext" used to compare the
 * broker's envelope with the broker's own hash of it. A broker (or a tampered
 * store) that swaps the envelope recomputes that hash too, and the page still
 * showed the green check. The claim has to be checked against the receipt on
 * Monad, which nobody can rewrite after the fact.
 */

const LEDGER = "0x1111111111111111111111111111111111111111";
const OTHER_CONTRACT = "0x2222222222222222222222222222222222222222";
const BUYER = "0x3333333333333333333333333333333333333333";
const PROVIDER = "0x4444444444444444444444444444444444444444";
const TX = `0x${"ab".repeat(32)}`;
const inbox = deriveInboxKeys(new Uint8Array(32).fill(9));

/** A JobRecorded log exactly as XorvLedger emits it. */
function jobRecorded(jobId: string, resultHash: Hex, address = LEDGER) {
  const topics = encodeEventTopics({
    abi: XORV_LEDGER_ABI,
    eventName: "JobRecorded",
    args: { jobId: jobIdHash(jobId), agentId: 7n, buyer: BUYER },
  }) as Hex[];
  const data = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint32" },
      { type: "bool" },
    ],
    [PROVIDER, 10_000n, `0x${"cd".repeat(32)}`, `0x${"ee".repeat(32)}`, resultHash, 1200, true],
  );
  return { address, topics, data };
}

function chain(logs: ReturnType<typeof jobRecorded>[]): ReceiptReader {
  return {
    getTransactionReceipt: async ({ hash }) => {
      if (hash !== TX) throw new Error("transaction not found");
      return { logs };
    },
  };
}

const hashOf = (text: string): Hex => keccak256(stringToBytes(text));

describe("checking a sealed result against its XorvLedger receipt", () => {
  const genuine = sealResult(inbox.encryptTo, "the real answer", "job_1");
  // Anyone can seal to the buyer's public inbox key: a swapped envelope opens without error.
  const swapped = sealResult(inbox.encryptTo, "a forged answer", "job_1");

  it("catches a broker that swapped the envelope and recomputed its own resultHash", async () => {
    // What the page used to check: the broker's envelope against the broker's hash. It passes.
    expect(receiptMatchesCiphertext(swapped, hashOf(swapped))).toBe(true);
    // The receipt on Monad still commits to the original.
    const check = await checkResultAgainstReceipt({
      client: chain([jobRecorded("job_1", hashOf(genuine))]),
      txHash: TX,
      ledger: LEDGER,
      jobId: "job_1",
      result: swapped,
    });
    expect(check).toEqual({ status: "mismatch", resultHash: hashOf(genuine) });
  });

  it("matches the genuine envelope, finding this job's event in a batched receipt", async () => {
    const check = await checkResultAgainstReceipt({
      client: chain([
        jobRecorded("job_0", hashOf("someone else's result")),
        jobRecorded("job_1", hashOf(genuine), OTHER_CONTRACT), // same event shape, wrong contract
        jobRecorded("job_1", hashOf(genuine)),
      ]),
      txHash: TX,
      ledger: LEDGER.toUpperCase().replace("0X", "0x"),
      jobId: "job_1",
      result: genuine,
    });
    expect(check).toEqual({ status: "match", resultHash: hashOf(genuine) });
  });

  it("says so when the transaction holds no receipt for this job from this ledger, or the chain can't be read", async () => {
    const onlyOthers = chain([jobRecorded("job_0", hashOf(genuine)), jobRecorded("job_1", hashOf(genuine), OTHER_CONTRACT)]);
    expect(await checkResultAgainstReceipt({ client: onlyOthers, txHash: TX, ledger: LEDGER, jobId: "job_1", result: genuine })).toEqual({
      status: "not-found",
    });
    expect(
      await checkResultAgainstReceipt({ client: onlyOthers, txHash: `0x${"00".repeat(32)}`, ledger: LEDGER, jobId: "job_1", result: genuine }),
    ).toEqual({ status: "unavailable" });
  });
});
