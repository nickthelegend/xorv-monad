/**
 * Sealed results and passkey-derived keys.
 *
 * The property everything else leans on is determinism: the same PRF output
 * must yield the same keys on every device, forever. A synced passkey
 * reproduces the PRF output; these tests pin what we do with it — including
 * known-answer vectors, because a "harmless" change to a derivation label
 * would silently orphan every sealed result and every vault already written.
 */

import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  PRF_NAMESPACES,
  PRF_NAMESPACE_ORDER,
  SEALED_RESULT_ALG,
  SealedError,
  decodeEncryptTo,
  deriveInboxKeys,
  deriveVaultAuth,
  deriveVaultKey,
  fromBase64Url,
  isSealedResult,
  isValidEncryptTo,
  keyFingerprint,
  openResult,
  openResultWithContentKey,
  parseSealedResult,
  prfSaltFor,
  resultContentKey,
  sealResult,
  toBase64Url,
} from "../src/web.js";

/** Stand-ins for PRF outputs: what two devices with one synced passkey would both get. */
const PRF_A = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PRF_B = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const JOB = "job_4f2kX9aQbT1z";

function expectCode(fn: () => unknown, code: SealedError["code"]): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SealedError);
    expect((err as SealedError).code).toBe(code);
    return;
  }
  throw new Error(`expected a SealedError ${code}`);
}

/** Flip one bit of a base64url field. */
function flip(field: string, byteIndex = 0): string {
  const bytes = fromBase64Url(field)!;
  bytes[byteIndex] = bytes[byteIndex]! ^ 0x01;
  return toBase64Url(bytes);
}

describe("PRF namespaces", () => {
  it("salts are sha256 of the versioned label, 32 bytes each, as Mera requires", () => {
    for (const ns of PRF_NAMESPACE_ORDER) {
      const salt = prfSaltFor(ns);
      expect(salt).toHaveLength(32);
      expect(bytesToHex(salt)).toBe(bytesToHex(sha256(utf8ToBytes(PRF_NAMESPACES[ns]))));
    }
  });

  it("every namespace has its own salt", () => {
    const salts = PRF_NAMESPACE_ORDER.map((ns) => bytesToHex(prfSaltFor(ns)));
    expect(new Set(salts).size).toBe(PRF_NAMESPACE_ORDER.length);
    expect(Object.values(PRF_NAMESPACES)).toEqual(["xorv:inbox:v1", "xorv:vault:v1", "xorv:vault-auth:v1"]);
  });

  it("known-answer salts — changing a label orphans every key derived under it", () => {
    expect(bytesToHex(prfSaltFor("inbox"))).toBe(bytesToHex(sha256(utf8ToBytes("xorv:inbox:v1"))));
    expect(bytesToHex(prfSaltFor("vault"))).toBe(bytesToHex(sha256(utf8ToBytes("xorv:vault:v1"))));
    expect(bytesToHex(prfSaltFor("vaultAuth"))).toBe(bytesToHex(sha256(utf8ToBytes("xorv:vault-auth:v1"))));
  });
});

describe("key derivation", () => {
  it("is deterministic: the same PRF bytes on a second device give the same inbox keys", () => {
    const deviceA = deriveInboxKeys(PRF_A);
    const deviceB = deriveInboxKeys(new Uint8Array(PRF_A)); // a fresh copy, as another device would hold
    expect(bytesToHex(deviceB.secretKey)).toBe(bytesToHex(deviceA.secretKey));
    expect(deviceB.encryptTo).toBe(deviceA.encryptTo);
    expect(keyFingerprint(deviceB.publicKey)).toBe(keyFingerprint(deviceA.publicKey));
  });

  it("pins known-answer vectors for every namespace", () => {
    // Computed once from PRF_A. If one of these changes, existing users can no
    // longer open their results or their vault — bump the namespace version
    // (xorv:inbox:v2) instead of editing a derivation in place.
    expect(deriveInboxKeys(PRF_A).encryptTo).toBe(KNOWN.inboxEncryptTo);
    expect(bytesToHex(deriveVaultKey(PRF_A))).toBe(KNOWN.vaultKey);
    expect(deriveVaultAuth(PRF_A).vaultId).toBe(KNOWN.vaultId);
  });

  it("different passkeys give unrelated keys", () => {
    expect(deriveInboxKeys(PRF_A).encryptTo).not.toBe(deriveInboxKeys(PRF_B).encryptTo);
    expect(bytesToHex(deriveVaultKey(PRF_A))).not.toBe(bytesToHex(deriveVaultKey(PRF_B)));
    expect(deriveVaultAuth(PRF_A).vaultId).not.toBe(deriveVaultAuth(PRF_B).vaultId);
  });

  it("namespaces are separated even if the same PRF bytes were fed to every derivation", () => {
    // In the app each namespace gets its own PRF output (its own salt); HKDF's
    // per-namespace salt and info are the second wall, pinned here.
    const inbox = bytesToHex(deriveInboxKeys(PRF_A).secretKey);
    const vault = bytesToHex(deriveVaultKey(PRF_A));
    const auth = bytesToHex(deriveVaultAuth(PRF_A).seed);
    expect(new Set([inbox, vault, auth, bytesToHex(PRF_A)]).size).toBe(4);
  });

  it("refuses anything that is not a 32-byte PRF output", () => {
    expectCode(() => deriveInboxKeys(new Uint8Array(31)), "INVALID_KEY");
    expectCode(() => deriveVaultKey(new Uint8Array(33)), "INVALID_KEY");
    expectCode(() => deriveVaultAuth("nope" as unknown as Uint8Array), "INVALID_KEY");
  });
});

describe("encryptTo", () => {
  const good = deriveInboxKeys(PRF_A).encryptTo;

  it("accepts a derived inbox key", () => {
    expect(isValidEncryptTo(good)).toBe(true);
    expect(decodeEncryptTo(good)).toHaveLength(32);
  });

  it("rejects the wrong length, padding and non-url alphabets", () => {
    expect(isValidEncryptTo(good.slice(0, -2))).toBe(false);
    expect(isValidEncryptTo(`${good}=`)).toBe(false);
    expect(isValidEncryptTo(`${good.slice(0, -1)}+`)).toBe(false);
    expect(isValidEncryptTo(`${good.slice(0, -1)}/`)).toBe(false);
    expect(isValidEncryptTo(toBase64Url(new Uint8Array(33).fill(9)))).toBe(false);
    expect(isValidEncryptTo(null)).toBe(false);
    expect(isValidEncryptTo(42)).toBe(false);
  });

  it("rejects low-order points, which would seal to everyone", () => {
    expect(isValidEncryptTo(toBase64Url(new Uint8Array(32)))).toBe(false);
    const one = new Uint8Array(32);
    one[0] = 1;
    expect(isValidEncryptTo(toBase64Url(one))).toBe(false);
    expectCode(() => sealResult(toBase64Url(new Uint8Array(32)), "secret", JOB), "INVALID_KEY");
  });
});

describe("sealResult / openResult", () => {
  const inbox = deriveInboxKeys(PRF_A);

  it("round-trips, including unicode and the empty string", () => {
    for (const text of ["the answer", "", "日本語 · émoji 🔐 · \u0000 nul", "x".repeat(200_000)]) {
      const envelope = sealResult(inbox.encryptTo, text, JOB);
      expect(openResult(inbox.secretKey, envelope, JOB)).toBe(text);
    }
  });

  it("opens on a second device that re-derived the keys from the same PRF output", () => {
    const envelope = sealResult(inbox.encryptTo, "cross-device", JOB);
    const secondDevice = deriveInboxKeys(new Uint8Array(PRF_A));
    expect(openResult(secondDevice.secretKey, envelope, JOB)).toBe("cross-device");
  });

  it("produces the documented envelope and nothing readable", () => {
    const envelope = sealResult(inbox.encryptTo, "the plaintext answer", JOB);
    const parsed = JSON.parse(envelope) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["alg", "ct", "epk", "iv", "v"]);
    expect(parsed.v).toBe(1);
    expect(parsed.alg).toBe(SEALED_RESULT_ALG);
    expect(fromBase64Url(parsed.epk as string)).toHaveLength(32);
    expect(fromBase64Url(parsed.iv as string)).toHaveLength(12);
    expect(envelope).not.toContain("plaintext");
    expect(isSealedResult(envelope)).toBe(true);
  });

  it("uses a fresh ephemeral key and nonce every time", () => {
    const a = parseSealedResult(sealResult(inbox.encryptTo, "same", JOB));
    const b = parseSealedResult(sealResult(inbox.encryptTo, "same", JOB));
    expect(a.epk).not.toBe(b.epk);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("fails closed for the wrong key", () => {
    const envelope = sealResult(inbox.encryptTo, "secret", JOB);
    expectCode(() => openResult(deriveInboxKeys(PRF_B).secretKey, envelope, JOB), "DECRYPT_FAILED");
  });

  it("is bound to the job id — an envelope replayed under another job does not open", () => {
    const envelope = sealResult(inbox.encryptTo, "secret", JOB);
    expectCode(() => openResult(inbox.secretKey, envelope, "job_someOtherJob"), "DECRYPT_FAILED");
    expectCode(() => sealResult(inbox.encryptTo, "secret", ""), "INVALID_ENVELOPE");
  });

  it("detects tampering with the ciphertext, the tag, the nonce and the ephemeral key", () => {
    const sealed = parseSealedResult(sealResult(inbox.encryptTo, "secret answer", JOB));
    const ctBytes = fromBase64Url(sealed.ct)!;
    const tampered = [
      { ...sealed, ct: flip(sealed.ct, 0) },
      { ...sealed, ct: flip(sealed.ct, ctBytes.length - 1) }, // inside the GCM tag
      { ...sealed, iv: flip(sealed.iv, 5) },
      { ...sealed, epk: deriveInboxKeys(PRF_B).encryptTo }, // another valid point
      { ...sealed, ct: toBase64Url(ctBytes.subarray(1)) }, // truncated
    ];
    for (const envelope of tampered) {
      expectCode(() => openResult(inbox.secretKey, envelope, JOB), "DECRYPT_FAILED");
    }
  });

  it("refuses malformed envelopes before trying to decrypt", () => {
    const sealed = parseSealedResult(sealResult(inbox.encryptTo, "secret", JOB));
    const bad: unknown[] = [
      "the plaintext result",
      "{not json",
      "[]",
      JSON.stringify({ ...sealed, v: 2 }),
      JSON.stringify({ ...sealed, alg: "rot13" }),
      JSON.stringify({ ...sealed, epk: "short" }),
      JSON.stringify({ ...sealed, iv: toBase64Url(new Uint8Array(16)) }),
      JSON.stringify({ ...sealed, ct: toBase64Url(new Uint8Array(15)) }),
      null,
      42,
    ];
    for (const value of bad) {
      expect(isSealedResult(value)).toBe(false);
      expectCode(() => openResult(inbox.secretKey, value, JOB), "INVALID_ENVELOPE");
    }
  });

  it("drops unknown envelope fields when parsing", () => {
    const sealed = parseSealedResult(sealResult(inbox.encryptTo, "secret", JOB));
    const parsed = parseSealedResult({ ...sealed, note: "hello", plaintext: "leak" });
    expect(parsed).toEqual(sealed);
  });
});

describe("per-result content keys (share one result, nothing else)", () => {
  const inbox = deriveInboxKeys(PRF_A);

  it("a disclosed content key opens exactly its own result", () => {
    const first = sealResult(inbox.encryptTo, "first answer", JOB);
    const second = sealResult(inbox.encryptTo, "second answer", "job_second");
    const key = toBase64Url(resultContentKey(inbox.secretKey, first, JOB));

    expect(openResultWithContentKey(key, first, JOB)).toBe("first answer");
    expectCode(() => openResultWithContentKey(key, second, "job_second"), "DECRYPT_FAILED");
    expectCode(() => openResultWithContentKey(key, first, "job_second"), "DECRYPT_FAILED");
  });

  it("is not the inbox secret, and differs per envelope", () => {
    const a = sealResult(inbox.encryptTo, "same", JOB);
    const b = sealResult(inbox.encryptTo, "same", JOB);
    const ka = bytesToHex(resultContentKey(inbox.secretKey, a, JOB));
    const kb = bytesToHex(resultContentKey(inbox.secretKey, b, JOB));
    expect(ka).not.toBe(kb);
    expect(ka).not.toBe(bytesToHex(inbox.secretKey));
  });

  it("rejects a key of the wrong size", () => {
    const envelope = sealResult(inbox.encryptTo, "x", JOB);
    expectCode(() => openResultWithContentKey("AAAA", envelope, JOB), "INVALID_KEY");
  });
});

describe("base64url", () => {
  it("round-trips every length", () => {
    for (let n = 0; n <= 40; n += 1) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const text = toBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(Buffer.from(text, "base64url").equals(Buffer.from(bytes))).toBe(true);
      expect(Array.from(fromBase64Url(text)!)).toEqual(Array.from(bytes));
    }
  });

  it("has exactly one spelling per value", () => {
    expect(fromBase64Url("AQ")).toEqual(new Uint8Array([1]));
    expect(fromBase64Url("AR")).toBeNull(); // non-zero trailing bits
    expect(fromBase64Url("AQ==")).toBeNull();
    expect(fromBase64Url("A+/B")).toBeNull();
    expect(fromBase64Url("A")).toBeNull();
    expect(fromBase64Url(" AQ")).toBeNull();
  });
});

describe("keyFingerprint", () => {
  it("is short, grouped and stable", () => {
    const fp = keyFingerprint(deriveInboxKeys(PRF_A).publicKey);
    expect(fp).toMatch(/^[0-9a-f]{4}(·[0-9a-f]{4}){3}$/);
    expect(keyFingerprint(deriveInboxKeys(new Uint8Array(PRF_A)).publicKey)).toBe(fp);
  });
});

const KNOWN = {
  inboxEncryptTo: "PVLVaQpjMx7Mxsv7dlxb9c_ihMVDgbhkyi2pDBLDYGc",
  vaultKey: "304a4d20e7e20163e2473e553b25dcf342e2b07b109d399110f1655b9b9df735",
  vaultId: "dd2dc66566ef6cb0f97bf239f6c6af5246b96ff682893b2918a68f4e74d3dfd7",
};
