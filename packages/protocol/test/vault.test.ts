/**
 * The history vault: encryption bound to (vault id, version), and writes
 * authorized by an Ed25519 key whose hash is the vault id.
 *
 * The derivations are also checked against Node's own HKDF and X25519, so the
 * documented construction (docs/PRIVATE_JOBS.md) is what the code does — not
 * just whatever noble happens to compute.
 */

import { createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  SealedError,
  VAULT_MAX_ENTRIES,
  addVaultEntry,
  decryptVault,
  deriveInboxKeys,
  deriveVaultAuth,
  deriveVaultKey,
  emptyVault,
  encryptVault,
  isVaultId,
  mergeVaults,
  openResult,
  parseVaultContents,
  signVaultWrite,
  toBase64Url,
  fromBase64Url,
  sealResult,
  vaultIdFor,
  verifyVaultWrite,
  type PrivateJobEntry,
} from "../src/web.js";

const PRF_VAULT = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const PRF_AUTH = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff);
const PRF_OTHER = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 1) & 0xff);

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

function entry(jobId: string, createdAt: number, extra: Partial<PrivateJobEntry> = {}): PrivateJobEntry {
  return { jobId, title: null, prompt: `prompt for ${jobId}`, createdAt, ...extra };
}

describe("derivations match the documented construction", () => {
  it("vault key = HKDF-SHA256(prf, salt=label, info=label/aes-256-gcm)", () => {
    const expected = hkdfSync("sha256", PRF_VAULT, "xorv:vault:v1", "xorv:vault:v1/aes-256-gcm", 32);
    expect(bytesToHex(deriveVaultKey(PRF_VAULT))).toBe(Buffer.from(expected).toString("hex"));
  });

  it("vault-auth seed = HKDF-SHA256(prf, salt=label, info=label/ed25519), an RFC 8032 seed", () => {
    const expected = Buffer.from(hkdfSync("sha256", PRF_AUTH, "xorv:vault-auth:v1", "xorv:vault-auth:v1/ed25519", 32));
    const auth = deriveVaultAuth(PRF_AUTH);
    expect(bytesToHex(auth.seed)).toBe(expected.toString("hex"));
    // Node's Ed25519 from the same seed gives the same public key.
    const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), expected]);
    const spki = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
    expect(bytesToHex(auth.publicKey)).toBe(Buffer.from(spki).subarray(-32).toString("hex"));
  });

  it("inbox key = HKDF-SHA256(prf, salt=label, info=label/x25519), and ECDH agrees with Node's X25519", () => {
    const prf = PRF_OTHER;
    const secret = Buffer.from(hkdfSync("sha256", prf, "xorv:inbox:v1", "xorv:inbox:v1/x25519", 32));
    const inbox = deriveInboxKeys(prf);
    expect(bytesToHex(inbox.secretKey)).toBe(secret.toString("hex"));

    const nodeKey = createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), secret]),
      format: "der",
      type: "pkcs8",
    });
    const nodePub = Buffer.from(createPublicKey(nodeKey).export({ format: "der", type: "spki" })).subarray(-32);
    expect(bytesToHex(inbox.publicKey)).toBe(nodePub.toString("hex"));

    const peer = x25519.utils.randomSecretKey();
    const peerPub = x25519.getPublicKey(peer);
    const nodePeerPub = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(peerPub)]),
      format: "der",
      type: "spki",
    });
    const nodeShared = diffieHellman({ privateKey: nodeKey, publicKey: nodePeerPub });
    expect(bytesToHex(x25519.getSharedSecret(peer, inbox.publicKey))).toBe(nodeShared.toString("hex"));
  });

  it("an envelope sealed with this code opens after re-deriving from the same PRF output", () => {
    const envelope = sealResult(deriveInboxKeys(PRF_OTHER).encryptTo, "hello from a provider", "job_x");
    expect(openResult(deriveInboxKeys(Uint8Array.from(PRF_OTHER)).secretKey, envelope, "job_x")).toBe("hello from a provider");
  });
});

describe("vault ids", () => {
  it("are the hash of the vault-auth public key, deterministic across devices", () => {
    const a = deriveVaultAuth(PRF_AUTH);
    const b = deriveVaultAuth(new Uint8Array(PRF_AUTH));
    expect(a.vaultId).toBe(b.vaultId);
    expect(a.vaultId).toBe(vaultIdFor(a.publicKey));
    expect(isVaultId(a.vaultId)).toBe(true);
    expect(deriveVaultAuth(PRF_OTHER).vaultId).not.toBe(a.vaultId);
  });

  it("isVaultId accepts only 64 lowercase hex characters", () => {
    expect(isVaultId("a".repeat(64))).toBe(true);
    expect(isVaultId("A".repeat(64))).toBe(false);
    expect(isVaultId("a".repeat(63))).toBe(false);
    expect(isVaultId("../../etc/passwd")).toBe(false);
    expect(isVaultId(null)).toBe(false);
  });
});

describe("encryptVault / decryptVault", () => {
  const key = deriveVaultKey(PRF_VAULT);
  const { vaultId } = deriveVaultAuth(PRF_AUTH);
  const plaintext = JSON.stringify(addVaultEntry(emptyVault(), entry("job_1", 1)));

  it("round-trips, and the same PRF output on another device decrypts it", () => {
    const blob = encryptVault(key, plaintext, vaultId, 1);
    expect(blob.version).toBe(1);
    expect(blob.ciphertext).not.toContain("prompt");
    expect(decryptVault(deriveVaultKey(new Uint8Array(PRF_VAULT)), blob, vaultId)).toBe(plaintext);
  });

  it("fails closed for the wrong key or the wrong vault", () => {
    const blob = encryptVault(key, plaintext, vaultId, 1);
    expectCode(() => decryptVault(deriveVaultKey(PRF_OTHER), blob, vaultId), "DECRYPT_FAILED");
    expectCode(() => decryptVault(key, blob, "b".repeat(64)), "DECRYPT_FAILED");
  });

  it("binds the version: an old ciphertext relabelled as newer does not decrypt", () => {
    const blob = encryptVault(key, plaintext, vaultId, 3);
    expectCode(() => decryptVault(key, { ...blob, version: 4 }, vaultId), "DECRYPT_FAILED");
  });

  it("detects tampering", () => {
    const blob = encryptVault(key, plaintext, vaultId, 1);
    const ct = fromBase64Url(blob.ciphertext)!;
    ct[3] = ct[3]! ^ 0x80;
    expectCode(() => decryptVault(key, { ...blob, ciphertext: toBase64Url(ct) }, vaultId), "DECRYPT_FAILED");
    expectCode(() => decryptVault(key, { ...blob, iv: "short" }, vaultId), "INVALID_ENVELOPE");
  });

  it("refuses a non-positive version", () => {
    expectCode(() => encryptVault(key, plaintext, vaultId, 0), "INVALID_ENVELOPE");
    expectCode(() => encryptVault(key, plaintext, vaultId, 1.5), "INVALID_ENVELOPE");
  });
});

describe("signed writes", () => {
  const key = deriveVaultKey(PRF_VAULT);
  const auth = deriveVaultAuth(PRF_AUTH);
  const blob = encryptVault(key, "{}", auth.vaultId, 1);

  it("a write signed by the vault-auth key verifies", () => {
    const write = signVaultWrite(auth.seed, auth.vaultId, blob);
    expect(verifyVaultWrite(auth.vaultId, write)).toEqual({ ok: true });
  });

  it("is the plain RFC 8032 signature a Mera Ed25519 session produces", () => {
    const write = signVaultWrite(auth.seed, auth.vaultId, blob);
    const sig = fromBase64Url(write.signature)!;
    expect(sig).toHaveLength(64);
    expect(bytesToHex(ed25519.getPublicKey(auth.seed))).toBe(bytesToHex(fromBase64Url(write.publicKey)!));
  });

  it("a signature for one vault, version or payload is worthless for any other", () => {
    const write = signVaultWrite(auth.seed, auth.vaultId, blob);
    const other = deriveVaultAuth(PRF_OTHER);
    expect(verifyVaultWrite(other.vaultId, write).ok).toBe(false); // key doesn't hash to that id
    expect(verifyVaultWrite(auth.vaultId, { ...write, version: 2 }).ok).toBe(false); // replay at a new version
    const reencrypted = encryptVault(key, '{"entries":[]}', auth.vaultId, 1);
    expect(verifyVaultWrite(auth.vaultId, { ...write, ciphertext: reencrypted.ciphertext }).ok).toBe(false);
    expect(verifyVaultWrite(auth.vaultId, { ...write, iv: reencrypted.iv }).ok).toBe(false);
  });

  it("someone else's key cannot write to this vault, even with a valid signature of its own", () => {
    const intruder = deriveVaultAuth(PRF_OTHER);
    const forged = signVaultWrite(intruder.seed, auth.vaultId, blob);
    const check = verifyVaultWrite(auth.vaultId, forged);
    expect(check.ok).toBe(false);
    expect(check.ok ? "" : check.reason).toMatch(/does not hash/);
  });

  it("names what is malformed", () => {
    const write = signVaultWrite(auth.seed, auth.vaultId, blob);
    const reason = (value: unknown, id = auth.vaultId) => {
      const check = verifyVaultWrite(id, value as never);
      return check.ok ? "ok" : check.reason;
    };
    expect(reason(write, "nope")).toMatch(/vault id/);
    expect(reason(null)).toMatch(/object/);
    expect(reason({ ...write, version: 0 })).toMatch(/version/);
    expect(reason({ ...write, iv: "AAAA" })).toMatch(/iv/);
    expect(reason({ ...write, ciphertext: "***" })).toMatch(/ciphertext/);
    expect(reason({ ...write, publicKey: "AAAA" })).toMatch(/publicKey/);
    expect(reason({ ...write, signature: "AAAA" })).toMatch(/signature/);
  });
});

describe("vault contents", () => {
  it("keeps entries newest first and updates in place", () => {
    let vault = emptyVault();
    vault = addVaultEntry(vault, entry("job_a", 100));
    vault = addVaultEntry(vault, entry("job_b", 200));
    vault = addVaultEntry(vault, entry("job_a", 100, { title: "renamed" }));
    expect(vault.entries.map((e) => e.jobId)).toEqual(["job_b", "job_a"]);
    expect(vault.entries[1]?.title).toBe("renamed");
  });

  it("merges two devices' histories without losing either side", () => {
    const deviceA = addVaultEntry(emptyVault(), entry("job_a", 100));
    const deviceB = addVaultEntry(addVaultEntry(emptyVault(), entry("job_b", 300)), entry("job_c", 200));
    expect(mergeVaults(deviceA, deviceB).entries.map((e) => e.jobId)).toEqual(["job_b", "job_c", "job_a"]);
  });

  it("caps the history, dropping the oldest", () => {
    let vault = emptyVault();
    for (let i = 0; i < VAULT_MAX_ENTRIES + 5; i += 1) vault = addVaultEntry(vault, entry(`job_${i}`, i));
    expect(vault.entries).toHaveLength(VAULT_MAX_ENTRIES);
    expect(vault.entries.at(-1)?.jobId).toBe("job_5");
  });

  it("parses defensively, dropping rows that are not entries", () => {
    const json = JSON.stringify({ v: 1, entries: [entry("job_ok", 1), { jobId: 5 }, null, "x", { jobId: "j", prompt: "p" }] });
    expect(parseVaultContents(json).entries.map((e) => e.jobId)).toEqual(["job_ok"]);
    expect(parseVaultContents("{}").entries).toEqual([]);
    expectCode(() => parseVaultContents("not json"), "INVALID_ENVELOPE");
  });
});
