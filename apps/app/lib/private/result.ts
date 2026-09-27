/**
 * Reading a private job's result on the job page.
 *
 * Three ways a sealed result can be in front of someone:
 *
 *  - they hold the passkey it was sealed to → unlock the inbox, open it;
 *  - someone who holds it shared *this one result* → the link's fragment
 *    carries the per-result content key (`#k=…`), which never reaches a
 *    server and opens nothing else;
 *  - neither → they see that it is sealed, and can still check that the
 *    ciphertext is exactly what the on-chain receipt committed to (the
 *    receipt read from Monad — lib/private/receipt-check.ts — not the
 *    broker's copy of the hash).
 *
 * Pure functions over the job and a keyring, so the decision is testable
 * without rendering anything.
 */

import { keccak256, stringToBytes } from "viem";
import {
  SealedError,
  fromBase64Url,
  isSealedResult,
  keyFingerprint,
  parseSealedResult,
  type SealedResult,
} from "@xorv/protocol/web";
import { KeyringLockedError, openSharedResult } from "@/lib/private/keyring";

export type SealedRead =
  | { kind: "opened"; text: string; via: "passkey" | "link" }
  | { kind: "locked" }
  /** Sealed to a different passkey than the one unlocked. */
  | { kind: "foreign" }
  /** A shared link whose key doesn't open this result. */
  | { kind: "bad-link" }
  | { kind: "not-sealed" };

export interface ResultOpener {
  isUnlocked(namespace: "inbox"): boolean;
  openResult(envelope: unknown, jobId: string): string;
}

/** Try to read a job's sealed result with whatever this viewer has. */
export function readSealedResult(opts: {
  jobId: string;
  result: string | null | undefined;
  keyring: ResultOpener | null;
  sharedKey?: string | null;
}): SealedRead {
  const { jobId, result, keyring, sharedKey } = opts;
  if (!result || !isSealedResult(result)) return { kind: "not-sealed" };
  if (sharedKey) {
    try {
      return { kind: "opened", text: openSharedResult(sharedKey, result, jobId), via: "link" };
    } catch (err) {
      if (!(err instanceof SealedError)) throw err;
      // Fall through to the passkey, if there is one: a stale link shouldn't
      // stop the owner from reading their own result.
      if (!keyring?.isUnlocked("inbox")) return { kind: "bad-link" };
    }
  }
  if (!keyring || !keyring.isUnlocked("inbox")) return { kind: "locked" };
  try {
    return { kind: "opened", text: keyring.openResult(result, jobId), via: "passkey" };
  } catch (err) {
    if (err instanceof KeyringLockedError) return { kind: "locked" };
    if (err instanceof SealedError && err.code === "DECRYPT_FAILED") return { kind: "foreign" };
    throw err;
  }
}

/** What the page can say about an envelope without opening it. */
export function envelopeSummary(result: string): {
  envelope: SealedResult;
  alg: string;
  ephemeralFingerprint: string;
  ciphertextBytes: number;
} {
  const envelope = parseSealedResult(result);
  return {
    envelope,
    alg: envelope.alg,
    ephemeralFingerprint: keyFingerprint(fromBase64Url(envelope.epk)!),
    // Minus the 16-byte GCM tag: the plaintext's length, which AES-GCM does not hide.
    ciphertextBytes: Math.max(0, fromBase64Url(envelope.ct)!.length - 16),
  };
}

/**
 * Does `result` hash (keccak-256) to `resultHash`? What that proves depends
 * on where the hash came from: against the broker's own `job.resultHash` it
 * only shows the broker is self-consistent; against the `resultHash` in the
 * XorvLedger receipt on Monad (receipt-check.ts) it is how a private result
 * stays accountable on-chain.
 */
export function receiptMatchesCiphertext(result: string | null | undefined, resultHash: string | null | undefined): boolean {
  if (!result || !resultHash) return false;
  return keccak256(stringToBytes(result)).toLowerCase() === resultHash.toLowerCase();
}

/** `#k=<content key>` → the key, or null. The fragment is never sent to a server. */
export function sharedKeyFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const key = params.get("k");
  return key && /^[A-Za-z0-9_-]{43}$/.test(key) ? key : null;
}

/** A link that opens one result and nothing else. */
export function shareLink(origin: string, jobId: string, contentKey: string): string {
  return `${origin}/jobs/${encodeURIComponent(jobId)}#k=${contentKey}`;
}
