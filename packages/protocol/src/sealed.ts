/**
 * Private jobs: results sealed to the buyer's passkey.
 *
 * A private job's result is encrypted on the provider's machine, before it
 * leaves, to an X25519 public key the buyer derived from their passkey. The
 * broker stores and serves only that envelope, the XorvLedger receipt's
 * `resultHash` commits to the envelope bytes, and the only thing that can open
 * it is the same passkey — on this device or any other the passkey syncs to.
 *
 * ## Where the key material comes from
 *
 * The buyer's passkey evaluates the WebAuthn PRF extension (through Mera,
 * `@category-labs/mera`) once per *namespace*. Each namespace has its own PRF
 * salt — `sha256(label)`, because the PRF wants exactly 32 bytes — so each
 * yields an unrelated 32-byte output, and each output is then stretched with
 * HKDF-SHA256 under the same label into exactly one typed key:
 *
 *   passkey ─PRF(sha256("xorv:inbox:v1"))──────► HKDF ─► X25519 inbox keypair
 *           ─PRF(sha256("xorv:vault:v1"))──────► HKDF ─► AES-256-GCM vault key
 *           ─PRF(sha256("xorv:vault-auth:v1"))─► HKDF ─► Ed25519 vault-auth key
 *
 * Separate PRF salts rather than one PRF output fanned out through HKDF: the
 * namespaces are then isolated by the authenticator itself. Handing one
 * namespace's output to a component (say, an agent that only needs to read
 * results) reveals nothing about the others, and a future namespace can be
 * added without touching the keys that already protect data.
 *
 * The PRF output is a deterministic function of (credential, rpId, salt), so
 * a synced passkey reproduces every key on a second device. Nothing here is
 * ever persisted: callers keep derived keys in memory and zero them on lock.
 *
 * ## The envelope
 *
 * ECIES over X25519: a fresh ephemeral keypair per result, ECDH with the
 * buyer's inbox key, HKDF-SHA256 (salt = ephemeral ‖ recipient public key,
 * info = "xorv:result:v1" ‖ 0x00 ‖ jobId) into an AES-256-GCM key, and the same
 * info bytes as additional data. Binding the job id means an envelope cannot
 * be replayed as the result of a different job — it simply fails to open.
 *
 * Browser- and Node-safe: pure JS from the audited noble libraries, no
 * `node:crypto`, no WebCrypto (so sealing is synchronous on the provider and
 * the same code runs in a Next.js bundle).
 */

import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/**
 * The PRF namespaces Xorv evaluates on the buyer's passkey. The label is both
 * the PRF salt preimage and the HKDF salt, and it is versioned so a key can be
 * rotated by introducing `v2` next to it rather than by re-encrypting in place.
 */
export const PRF_NAMESPACES = {
  /** X25519 keypair that private-job results are sealed to. */
  inbox: "xorv:inbox:v1",
  /** AES-256-GCM key for the encrypted private-job history. */
  vault: "xorv:vault:v1",
  /** Ed25519 key whose public-key hash names the vault and whose signatures authorize writes. */
  vaultAuth: "xorv:vault-auth:v1",
} as const;

export type PrfNamespace = keyof typeof PRF_NAMESPACES;

/** Every namespace, in the order an "unlock everything" flow asks for them. */
export const PRF_NAMESPACE_ORDER: readonly PrfNamespace[] = ["inbox", "vault", "vaultAuth"];

/**
 * The 32-byte PRF salt for a namespace: `sha256(utf8(label))`.
 *
 * WebAuthn hashes it once more with its own context string before the
 * authenticator sees it, so these salts cannot collide with a raw CTAP
 * `hmac-secret` use of the same credential.
 */
export function prfSaltFor(namespace: PrfNamespace): Uint8Array {
  return sha256(utf8ToBytes(PRF_NAMESPACES[namespace]));
}

/** HKDF-SHA256 from one namespace's PRF output into one 32-byte key for one purpose. */
function deriveFromPrf(prfOutput: Uint8Array, namespace: PrfNamespace, purpose: string): Uint8Array {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.length !== 32) {
    throw new SealedError("INVALID_KEY", "a PRF output is exactly 32 bytes");
  }
  const label = PRF_NAMESPACES[namespace];
  return hkdf(sha256, prfOutput, utf8ToBytes(label), utf8ToBytes(`${label}/${purpose}`), 32);
}

// ---------------------------------------------------------------------------
// Errors and encoding
// ---------------------------------------------------------------------------

export type SealedErrorCode = "INVALID_ENVELOPE" | "INVALID_KEY" | "DECRYPT_FAILED";

/** Everything in this module throws this, with a code a UI can switch on. */
export class SealedError extends Error {
  readonly code: SealedErrorCode;
  constructor(code: SealedErrorCode, message: string) {
    super(message);
    this.name = "SealedError";
    this.code = code;
  }
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_INDEX = new Map([...B64URL].map((ch, i) => [ch, i]));

/** Bytes → canonical unpadded base64url (RFC 4648 §5), the encoding WebAuthn and Mera use. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * Canonical unpadded base64url → bytes, or null.
 *
 * Strict on purpose: padding, `+`/`/`, whitespace and non-zero trailing bits
 * are all refused, so one key has exactly one spelling — which is what lets
 * the broker compare and store `encryptTo` as a plain string.
 */
export function fromBase64Url(text: string): Uint8Array | null {
  if (typeof text !== "string" || text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const ch of text) {
    const v = B64URL_INDEX.get(ch);
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero, or two strings would decode to the same bytes.
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  return out;
}

function decodeField(value: unknown, name: string, check: (length: number) => boolean): Uint8Array {
  const bytes = typeof value === "string" ? fromBase64Url(value) : null;
  if (!bytes || !check(bytes.length)) {
    throw new SealedError("INVALID_ENVELOPE", `${name} is not valid base64url of the right length`);
  }
  return bytes;
}

/**
 * A short, human-comparable fingerprint of a public key: the first 8 bytes of
 * its sha-256, grouped. The cross-device check is "do both screens show the
 * same fingerprint?" — so it is shown next to every public key the app derives.
 */
export function keyFingerprint(key: Uint8Array): string {
  const hex = bytesToHex(sha256(key).subarray(0, 8));
  return hex.match(/.{4}/g)!.join("·");
}

// ---------------------------------------------------------------------------
// The inbox: X25519 keys results are sealed to
// ---------------------------------------------------------------------------

export interface InboxKeys {
  /** X25519 secret scalar. Memory only; zero it on lock. */
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  /** `publicKey` as canonical base64url — the `JobRequest.encryptTo` value. */
  encryptTo: string;
}

/** The inbox keypair from the `xorv:inbox:v1` PRF output. Deterministic: same passkey, same keys. */
export function deriveInboxKeys(prfOutput: Uint8Array): InboxKeys {
  const secretKey = deriveFromPrf(prfOutput, "inbox", "x25519");
  const publicKey = x25519.getPublicKey(secretKey);
  return { secretKey, publicKey, encryptTo: toBase64Url(publicKey) };
}

/** A fixed scalar for the low-order check below; any non-zero scalar will do. */
const PROBE_SCALAR = sha256(utf8ToBytes("xorv:encrypt-to:probe"));

/**
 * Decode and vet an `encryptTo` value: canonical base64url of 32 bytes that is
 * a usable X25519 public key.
 *
 * "Usable" rules out the low-order points, for which every shared secret is
 * all zeros — sealing to one would produce an envelope anyone can open. noble
 * refuses such points in `getSharedSecret`, so a probe multiplication is the
 * check.
 */
export function decodeEncryptTo(value: unknown): Uint8Array {
  const bytes = typeof value === "string" ? fromBase64Url(value) : null;
  if (!bytes || bytes.length !== 32) {
    throw new SealedError("INVALID_KEY", "encryptTo must be a 32-byte X25519 public key in unpadded base64url");
  }
  try {
    x25519.getSharedSecret(PROBE_SCALAR, bytes);
  } catch {
    throw new SealedError("INVALID_KEY", "encryptTo is a low-order X25519 point, which would seal to no one");
  }
  return bytes;
}

/** True when `value` is an `encryptTo` a provider can seal to. */
export function isValidEncryptTo(value: unknown): value is string {
  try {
    decodeEncryptTo(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The sealed-result envelope
// ---------------------------------------------------------------------------

export const SEALED_RESULT_VERSION = 1;
export const SEALED_RESULT_ALG = "x25519-hkdf-sha256-aes256gcm";

/** What a private job's `result` holds: JSON of this shape, and nothing readable. */
export interface SealedResult {
  v: typeof SEALED_RESULT_VERSION;
  alg: typeof SEALED_RESULT_ALG;
  /** Ephemeral X25519 public key, base64url (32 bytes). */
  epk: string;
  /** AES-GCM nonce, base64url (12 bytes). */
  iv: string;
  /** AES-GCM ciphertext with its 16-byte tag, base64url. */
  ct: string;
}

/** HKDF info and GCM additional data: the context string, a separator, the job id. */
function resultContext(jobId: string): Uint8Array {
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new SealedError("INVALID_ENVELOPE", "a sealed result is bound to a non-empty job id");
  }
  return concatBytes(utf8ToBytes("xorv:result:v1"), new Uint8Array([0]), utf8ToBytes(jobId));
}

function contentKey(shared: Uint8Array, epk: Uint8Array, recipient: Uint8Array, jobId: string): Uint8Array {
  return hkdf(sha256, shared, concatBytes(epk, recipient), resultContext(jobId), 32);
}

/**
 * Seal a job's result to the buyer's inbox key. Returns the envelope as the
 * JSON string that travels as the job's `result`.
 *
 * Runs on the provider node, the moment the adapter returns — the plaintext
 * never crosses the wire to the broker.
 */
export function sealResult(encryptTo: string, plaintext: string, jobId: string): string {
  const recipient = decodeEncryptTo(encryptTo);
  const context = resultContext(jobId);
  const ephemeralSecret = x25519.utils.randomSecretKey();
  const epk = x25519.getPublicKey(ephemeralSecret);
  const shared = x25519.getSharedSecret(ephemeralSecret, recipient);
  const key = contentKey(shared, epk, recipient, jobId);
  const iv = randomBytes(12);
  try {
    const ct = gcm(key, iv, context).encrypt(utf8ToBytes(plaintext));
    const envelope: SealedResult = {
      v: SEALED_RESULT_VERSION,
      alg: SEALED_RESULT_ALG,
      epk: toBase64Url(epk),
      iv: toBase64Url(iv),
      ct: toBase64Url(ct),
    };
    return JSON.stringify(envelope);
  } finally {
    ephemeralSecret.fill(0);
    shared.fill(0);
    key.fill(0);
  }
}

/**
 * Parse and shape-check an envelope (a JSON string or an already-parsed
 * object). Throws `INVALID_ENVELOPE`; says nothing about who can open it.
 */
export function parseSealedResult(value: unknown): SealedResult {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      throw new SealedError("INVALID_ENVELOPE", "a sealed result is JSON");
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SealedError("INVALID_ENVELOPE", "a sealed result is a JSON object");
  }
  const r = raw as Record<string, unknown>;
  if (r.v !== SEALED_RESULT_VERSION || r.alg !== SEALED_RESULT_ALG) {
    throw new SealedError("INVALID_ENVELOPE", `unsupported sealed result (want v${SEALED_RESULT_VERSION} ${SEALED_RESULT_ALG})`);
  }
  decodeField(r.epk, "epk", (n) => n === 32);
  decodeField(r.iv, "iv", (n) => n === 12);
  decodeField(r.ct, "ct", (n) => n >= 16);
  // Allowlist, so an envelope stored or re-served never carries extra fields.
  return { v: SEALED_RESULT_VERSION, alg: SEALED_RESULT_ALG, epk: r.epk as string, iv: r.iv as string, ct: r.ct as string };
}

/** True for anything `parseSealedResult` accepts — how the broker and the app tell a private result from plaintext. */
export function isSealedResult(value: unknown): boolean {
  try {
    parseSealedResult(value);
    return true;
  } catch {
    return false;
  }
}

function decryptWithKey(key: Uint8Array, envelope: SealedResult, jobId: string): string {
  const iv = fromBase64Url(envelope.iv)!;
  const ct = fromBase64Url(envelope.ct)!;
  let plaintext: Uint8Array;
  try {
    plaintext = gcm(key, iv, resultContext(jobId)).decrypt(ct);
  } catch {
    // Wrong key, wrong job id and a tampered byte are indistinguishable by
    // design — GCM's tag says only "not authentic".
    throw new SealedError("DECRYPT_FAILED", "this result was not sealed to this key for this job, or it was altered");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}

/**
 * The per-result content key: what `openResult` decrypts with.
 *
 * Revealing it discloses exactly one result. It is an HKDF output, so it says
 * nothing about the inbox secret or any other job's key — which makes it the
 * unit of sharing: a link carrying it (in the URL fragment, never sent to a
 * server) lets one other person read one result, and check it against the
 * on-chain receipt hash, without ever touching the passkey.
 */
export function resultContentKey(inboxSecretKey: Uint8Array, envelope: unknown, jobId: string): Uint8Array {
  const sealed = parseSealedResult(envelope);
  if (!(inboxSecretKey instanceof Uint8Array) || inboxSecretKey.length !== 32) {
    throw new SealedError("INVALID_KEY", "an inbox secret key is 32 bytes");
  }
  const epk = fromBase64Url(sealed.epk)!;
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(inboxSecretKey, epk);
  } catch {
    throw new SealedError("INVALID_ENVELOPE", "the envelope's ephemeral key is not a usable X25519 point");
  }
  try {
    return contentKey(shared, epk, x25519.getPublicKey(inboxSecretKey), jobId);
  } finally {
    shared.fill(0);
  }
}

/** Open a sealed result with the inbox secret key. Throws `DECRYPT_FAILED` for the wrong key, job or bytes. */
export function openResult(inboxSecretKey: Uint8Array, envelope: unknown, jobId: string): string {
  const sealed = parseSealedResult(envelope);
  const key = resultContentKey(inboxSecretKey, sealed, jobId);
  try {
    return decryptWithKey(key, sealed, jobId);
  } finally {
    key.fill(0);
  }
}

/** Open a sealed result with a disclosed per-result content key (see `resultContentKey`). */
export function openResultWithContentKey(contentKeyBytes: Uint8Array | string, envelope: unknown, jobId: string): string {
  const sealed = parseSealedResult(envelope);
  const key = typeof contentKeyBytes === "string" ? fromBase64Url(contentKeyBytes) : contentKeyBytes;
  if (!key || key.length !== 32) throw new SealedError("INVALID_KEY", "a content key is 32 bytes");
  return decryptWithKey(key, sealed, jobId);
}
