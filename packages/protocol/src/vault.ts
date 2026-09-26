/**
 * The private-job history vault.
 *
 * A buyer's private jobs are unreadable to everyone else — including, by
 * design, the broker's public job list, which shows them only as "private".
 * So the buyer needs their own record of what they asked and where the answer
 * is: job ids, titles, prompts, timestamps. That record is this vault. It is
 * encrypted on the buyer's device with a key from their passkey, stored on the
 * broker as ciphertext, and fetched back on any device the passkey syncs to.
 *
 * Two PRF namespaces make it work (see sealed.ts for the derivation):
 *
 *  - `xorv:vault:v1` → an AES-256-GCM key. Encrypts the history.
 *  - `xorv:vault-auth:v1` → an Ed25519 key. Its public key's hash *is* the
 *    vault id, and its signature authorizes every write. The broker checks
 *    the signature and the id, never holds a secret, and so cannot overwrite a
 *    vault it doesn't own — nor can anyone who merely knows the id.
 *
 * The vault id is self-certifying: no account, no registration, no
 * trust-on-first-use. A fresh browser that unlocks the same passkey derives
 * the same Ed25519 key, hence the same id, and simply asks for it.
 *
 * ## Versions
 *
 * Every write names its version, and the broker accepts only `current + 1`.
 * That makes a replayed old write useless (its version is stale) and turns two
 * devices writing at once into a clean 409 the loser resolves by re-reading
 * and merging. The version is also inside the ciphertext's additional data,
 * so a server that relabels an old ciphertext with a new version number
 * produces something that no longer decrypts. What a malicious server *can*
 * still do is serve an older, genuine version — the client notices only if it
 * has already seen a newer one this session. That limit is stated in
 * docs/PRIVATE_JOBS.md rather than papered over.
 */

import { gcm } from "@noble/ciphers/aes.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { PRF_NAMESPACES, SealedError, fromBase64Url, toBase64Url } from "./sealed.js";

/**
 * Largest vault ciphertext the broker keeps, in decoded bytes. A history entry
 * is a prompt plus a few ids, so this holds hundreds of jobs; the cap exists
 * so an unauthenticated-looking PUT can't turn the broker into free storage.
 */
export const VAULT_MAX_CIPHERTEXT_BYTES = 192 * 1024;

/** Entries kept in the history; the oldest fall off first. */
export const VAULT_MAX_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function derive(prfOutput: Uint8Array, label: string, purpose: string): Uint8Array {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.length !== 32) {
    throw new SealedError("INVALID_KEY", "a PRF output is exactly 32 bytes");
  }
  return hkdf(sha256, prfOutput, utf8ToBytes(label), utf8ToBytes(`${label}/${purpose}`), 32);
}

/** The AES-256-GCM vault key from the `xorv:vault:v1` PRF output. Memory only. */
export function deriveVaultKey(prfOutput: Uint8Array): Uint8Array {
  return derive(prfOutput, PRF_NAMESPACES.vault, "aes-256-gcm");
}

export interface VaultAuthKeys {
  /** Ed25519 32-byte secret seed (RFC 8032). Memory only — hand it to a Mera signing session. */
  seed: Uint8Array;
  publicKey: Uint8Array;
  /** The vault's id: see `vaultIdFor`. */
  vaultId: string;
}

/** The vault-auth key from the `xorv:vault-auth:v1` PRF output, and the vault id it names. */
export function deriveVaultAuth(prfOutput: Uint8Array): VaultAuthKeys {
  const seed = derive(prfOutput, PRF_NAMESPACES.vaultAuth, "ed25519");
  const publicKey = ed25519.getPublicKey(seed);
  return { seed, publicKey, vaultId: vaultIdFor(publicKey) };
}

/** A vault id: lowercase hex of sha-256("xorv:vault-id:v1" ‖ 0x00 ‖ Ed25519 public key). */
export function vaultIdFor(publicKey: Uint8Array): string {
  return bytesToHex(sha256(concatBytes(utf8ToBytes("xorv:vault-id:v1"), new Uint8Array([0]), publicKey)));
}

export function isVaultId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

// ---------------------------------------------------------------------------
// Ciphertext
// ---------------------------------------------------------------------------

/** What the broker stores for a vault, and all it ever sees. */
export interface VaultCiphertext {
  /** AES-256-GCM ciphertext with its tag, base64url. */
  ciphertext: string;
  /** 12-byte nonce, base64url. Fresh per write. */
  iv: string;
  /** 1 for the first write, then exactly one more per write. */
  version: number;
}

function vaultContext(vaultId: string, version: number): Uint8Array {
  return utf8ToBytes(`${PRF_NAMESPACES.vault}\u0000${vaultId}\u0000${version}`);
}

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new SealedError("INVALID_ENVELOPE", "a vault version is a positive integer");
  }
}

/** Encrypt the vault's plaintext for `version`, bound to this vault id. */
export function encryptVault(key: Uint8Array, plaintext: string, vaultId: string, version: number): VaultCiphertext {
  assertVersion(version);
  if (key.length !== 32) throw new SealedError("INVALID_KEY", "a vault key is 32 bytes");
  const iv = randomBytes(12);
  const ct = gcm(key, iv, vaultContext(vaultId, version)).encrypt(utf8ToBytes(plaintext));
  return { ciphertext: toBase64Url(ct), iv: toBase64Url(iv), version };
}

/** Decrypt a vault fetched from the broker. Throws `DECRYPT_FAILED` for a wrong key, id, version or altered byte. */
export function decryptVault(key: Uint8Array, blob: VaultCiphertext, vaultId: string): string {
  assertVersion(blob.version);
  const iv = fromBase64Url(blob.iv);
  const ct = fromBase64Url(blob.ciphertext);
  if (!iv || iv.length !== 12 || !ct || ct.length < 16) {
    throw new SealedError("INVALID_ENVELOPE", "vault ciphertext or nonce is malformed");
  }
  let plaintext: Uint8Array;
  try {
    plaintext = gcm(key, iv, vaultContext(vaultId, blob.version)).decrypt(ct);
  } catch {
    throw new SealedError("DECRYPT_FAILED", "this vault was not encrypted with this key, or it was altered");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}

// ---------------------------------------------------------------------------
// Authorized writes
// ---------------------------------------------------------------------------

/** `PUT /api/vaults/:id` body. */
export interface VaultWrite extends VaultCiphertext {
  /** Ed25519 signature over `vaultWriteMessage`, base64url (64 bytes). */
  signature: string;
  /** The vault-auth public key, base64url (32 bytes); its hash must be the vault id. */
  publicKey: string;
}

/**
 * The exact bytes a vault write signs.
 *
 * A context line, the id, the version, the nonce, and a digest of the
 * ciphertext — so the signature covers everything the broker will store, and
 * a signature for one vault, version or payload is worthless for any other.
 */
export function vaultWriteMessage(fields: { vaultId: string; version: number; iv: string; ciphertext: string }): Uint8Array {
  const digest = bytesToHex(sha256(utf8ToBytes(fields.ciphertext)));
  return utf8ToBytes(`xorv:vault-write:v1\n${fields.vaultId}\n${fields.version}\n${fields.iv}\n${digest}`);
}

/**
 * Sign a write with a raw seed. The app signs through a Mera Ed25519 signing
 * session instead (same RFC 8032 signature, key zeroed when the session ends);
 * this is for Node callers and tests.
 */
export function signVaultWrite(seed: Uint8Array, vaultId: string, blob: VaultCiphertext): VaultWrite {
  const publicKey = ed25519.getPublicKey(seed);
  const signature = ed25519.sign(vaultWriteMessage({ vaultId, ...blob }), seed);
  return { ...blob, signature: toBase64Url(signature), publicKey: toBase64Url(publicKey) };
}

export type VaultWriteCheck = { ok: true } | { ok: false; reason: string };

/**
 * Everything the broker checks before storing a write, except the version
 * sequence (which needs its own state). Pure, so the rule is testable and the
 * same one runs anywhere.
 */
export function verifyVaultWrite(vaultId: string, write: Partial<VaultWrite> | null | undefined): VaultWriteCheck {
  if (!isVaultId(vaultId)) return { ok: false, reason: "a vault id is 64 lowercase hex characters" };
  if (!write || typeof write !== "object") return { ok: false, reason: "body must be a JSON object" };
  const { ciphertext, iv, version, signature, publicKey } = write;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    return { ok: false, reason: "version must be a positive integer" };
  }
  const ivBytes = typeof iv === "string" ? fromBase64Url(iv) : null;
  if (!ivBytes || ivBytes.length !== 12) return { ok: false, reason: "iv must be 12 bytes of base64url" };
  const ctBytes = typeof ciphertext === "string" ? fromBase64Url(ciphertext) : null;
  if (!ctBytes || ctBytes.length < 16) return { ok: false, reason: "ciphertext must be base64url AES-GCM output" };
  const pub = typeof publicKey === "string" ? fromBase64Url(publicKey) : null;
  if (!pub || pub.length !== 32) return { ok: false, reason: "publicKey must be a 32-byte Ed25519 key in base64url" };
  if (vaultIdFor(pub) !== vaultId) return { ok: false, reason: "publicKey does not hash to this vault id" };
  const sig = typeof signature === "string" ? fromBase64Url(signature) : null;
  if (!sig || sig.length !== 64) return { ok: false, reason: "signature must be 64 bytes of base64url" };
  let valid = false;
  try {
    valid = ed25519.verify(sig, vaultWriteMessage({ vaultId, version, iv: iv!, ciphertext: ciphertext! }), pub);
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: "signature does not verify for this vault, version and payload" };
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

/** One private job, as the buyer's own history remembers it. */
export interface PrivateJobEntry {
  jobId: string;
  title: string | null;
  /** The prompt as the buyer wrote it. Public views redact it; this is the buyer's copy. */
  prompt: string;
  /** Epoch ms the job was bought. */
  createdAt: number;
  priceUsdMicros?: number | null;
  providerLabel?: string | null;
  /** The inbox key the result was sealed to — tells a future `v2` inbox which key to use. */
  encryptTo?: string | null;
}

/** The decrypted vault. */
export interface PrivateVault {
  v: 1;
  /** Newest first. */
  entries: PrivateJobEntry[];
}

export function emptyVault(): PrivateVault {
  return { v: 1, entries: [] };
}

function asEntry(raw: unknown): PrivateJobEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.jobId !== "string" || !r.jobId || typeof r.prompt !== "string" || typeof r.createdAt !== "number") {
    return null;
  }
  return {
    jobId: r.jobId,
    title: typeof r.title === "string" ? r.title : null,
    prompt: r.prompt,
    createdAt: r.createdAt,
    priceUsdMicros: typeof r.priceUsdMicros === "number" ? r.priceUsdMicros : null,
    providerLabel: typeof r.providerLabel === "string" ? r.providerLabel : null,
    encryptTo: typeof r.encryptTo === "string" ? r.encryptTo : null,
  };
}

/** Parse decrypted vault JSON, dropping anything that isn't an entry rather than failing the whole history. */
export function parseVaultContents(json: string): PrivateVault {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SealedError("INVALID_ENVELOPE", "vault plaintext is not JSON");
  }
  const entries = Array.isArray((raw as { entries?: unknown })?.entries) ? (raw as { entries: unknown[] }).entries : [];
  return { v: 1, entries: entries.map(asEntry).filter((e): e is PrivateJobEntry => e !== null) };
}

/**
 * Merge two histories (this device's and whatever a concurrent write left on
 * the broker): union by job id, newest first, capped. Merging rather than
 * last-writer-wins is what makes a 409 from two devices harmless.
 */
export function mergeVaults(a: PrivateVault, b: PrivateVault): PrivateVault {
  const byId = new Map<string, PrivateJobEntry>();
  for (const entry of [...b.entries, ...a.entries]) byId.set(entry.jobId, { ...byId.get(entry.jobId), ...entry });
  const entries = [...byId.values()].sort((x, y) => y.createdAt - x.createdAt).slice(0, VAULT_MAX_ENTRIES);
  return { v: 1, entries };
}

/** Add (or update) one entry. */
export function addVaultEntry(vault: PrivateVault, entry: PrivateJobEntry): PrivateVault {
  return mergeVaults({ v: 1, entries: [entry] }, vault);
}
