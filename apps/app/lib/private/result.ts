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
 * without rendering anything. `readSealedResult` never throws: it runs while
 * the job page renders, and an envelope a provider got wrong (or forged) —
 * an ephemeral key that isn't a usable X25519 point, a plaintext that isn't
 * UTF-8 — must become a message on the page, not an unmounted app.
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
  /** The envelope is malformed: it cannot be opened by anyone, whatever key they hold. */
  | { kind: "invalid"; reason: string }
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
      // A key that decrypts but yields garbage is the envelope's fault, not the link's.
      if (!isWrongKey(err) && !isUnusableKey(err)) return invalid(err);
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
    if (isWrongKey(err)) return { kind: "foreign" };
    return invalid(err);
  }
}

/** AES-GCM refused: this key is not the one the result was sealed to. */
function isWrongKey(err: unknown): boolean {
  return err instanceof SealedError && err.code === "DECRYPT_FAILED";
}

/** The key itself is malformed (a share link's fragment that isn't a 32-byte key). */
function isUnusableKey(err: unknown): boolean {
  return err instanceof SealedError && err.code === "INVALID_KEY";
}

function invalid(err: unknown): SealedRead {
  return { kind: "invalid", reason: err instanceof Error ? err.message : String(err) };
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
