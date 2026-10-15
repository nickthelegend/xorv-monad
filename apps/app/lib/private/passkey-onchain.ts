/**
 * The buyer's passkey, verified by Monad itself.
 *
 * Mera derives the private-job keys from the passkey's PRF output, but it
 * never hands out the passkey's public key, and an on-chain signature check
 * needs one. So the app runs Mera's WebAuthn ceremonies through its own client
 * (the same requests Mera's browser client makes) that also keeps:
 *  - the public key, from `getPublicKey()` when a passkey is created here;
 *  - every unlock's signed assertion.
 * A passkey created before this existed gets its key back by ECDSA recovery
 * from two of its assertions (`recoverPasskeyKey`).
 *
 * Like everything else in private jobs, nothing is written to browser
 * storage: the keys and assertions live in this tab's memory. That is enough,
 * because one unlock asks the passkey once per key namespace, which gives the
 * two assertions recovery needs. With a key known, the newest unlock can be
 * checked by Monad's P256VERIFY precompile at 0x0100 with an `eth_call`
 * (read-only).
 */
import type { WebAuthnClient } from "@category-labs/mera";
import { createPublicClient, http, type PublicClient } from "viem";
import { recoverPasskeyKey, spkiToXY, verifyPasskeyAssertion, viemChain, type PasskeyAssertion } from "@xorv/protocol/web";
import { CHAIN_CONFIG, NETWORK } from "@/lib/network";

export interface PasskeyKeyRecord {
  /** Hex coordinates of the P-256 public key, or null until it is known. */
  x: string | null;
  y: string | null;
  source: "created" | "recovered" | null;
  /** The newest unlock's assertion (base64url fields), for the on-chain check. */
  last: StoredAssertion | null;
  /** An earlier assertion, kept only while the key is still unknown (for recovery). */
  previous: StoredAssertion | null;
}

interface StoredAssertion {
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  at: number;
}

/** Unpadded base64url, the encoding Mera uses for credential ids. */
export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function toAssertion(a: StoredAssertion): PasskeyAssertion {
  return { authenticatorData: fromB64url(a.authenticatorData), clientDataJSON: fromB64url(a.clientDataJSON), signature: fromB64url(a.signature) };
}

// ---------------------------------------------------------------------------
// The registry (pure functions over a plain object, so they are testable)
// ---------------------------------------------------------------------------

export type Registry = Record<string, PasskeyKeyRecord>;

const EMPTY: PasskeyKeyRecord = { x: null, y: null, source: null, last: null, previous: null };

export function recordCreated(registry: Registry, credentialId: string, spki: Uint8Array): Registry {
  const { x, y } = spkiToXY(spki);
  return { ...registry, [credentialId]: { ...(registry[credentialId] ?? EMPTY), x: `0x${x.toString(16)}`, y: `0x${y.toString(16)}`, source: "created" } };
}

/** Keep an unlock's assertion; with two and no key yet, recover the key from them. */
export function recordAssertion(registry: Registry, credentialId: string, a: StoredAssertion): Registry {
  const record = registry[credentialId] ?? EMPTY;
  if (record.x && record.y) return { ...registry, [credentialId]: { ...record, last: a, previous: null } };
  const earlier = record.last;
  if (earlier) {
    const key = recoverPasskeyKey(toAssertion(earlier), toAssertion(a));
    if (key) {
      return {
        ...registry,
        [credentialId]: { x: `0x${key.x.toString(16)}`, y: `0x${key.y.toString(16)}`, source: "recovered", last: a, previous: null },
      };
    }
  }
  return { ...registry, [credentialId]: { ...record, last: a, previous: earlier } };
}

/** This tab's registry: memory only, gone on reload (private jobs never persist key material). */
let memory: Registry = {};

export function loadRegistry(): Registry {
  return memory;
}

function saveRegistry(registry: Registry): void {
  memory = registry;
  window.dispatchEvent(new Event("xorv-passkey-keys"));
}

// ---------------------------------------------------------------------------
// The WebAuthn client Mera runs through
// ---------------------------------------------------------------------------

/**
 * Mera's browser client, plus capture. Same `navigator.credentials` requests
 * (PRF extension, resident key, user verification), so Mera's behaviour and
 * error handling are unchanged; this only also reads the public key at
 * creation and the assertion at each unlock.
 */
export const capturingWebAuthnClient: WebAuthnClient = {
  async createCredential(request) {
    const credential = (await navigator.credentials.create({
      publicKey: {
        rp: request.rp,
        user: request.user,
        challenge: request.challenge,
        pubKeyCredParams: request.algorithms.map((alg) => ({ type: "public-key" as const, alg })),
        ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
        attestation: request.attestation,
        authenticatorSelection: { residentKey: request.residentKey, requireResidentKey: true, userVerification: request.userVerification },
        extensions: { prf: { eval: { first: request.prfSalt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error("WebAuthn returned no usable public key credential");
    const response = credential.response as AuthenticatorAttestationResponse;
    const prf = (credential.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: BufferSource } } }).prf;
    const rawId = new Uint8Array(credential.rawId);
    const spki = typeof response.getPublicKey === "function" ? response.getPublicKey() : null;
    if (spki && response.getPublicKeyAlgorithm?.() === -7) {
      try {
        saveRegistry(recordCreated(loadRegistry(), b64url(rawId), new Uint8Array(spki)));
      } catch {
        // not a P-256 key we can read: recovery from unlocks will fill it in
      }
    }
    const first = prf?.results?.first;
    const transports = typeof response.getTransports === "function" ? (response.getTransports() as never) : undefined;
    return {
      credentialId: rawId,
      ...(transports !== undefined ? { transports } : {}),
      prfEnabled: prf?.enabled === true,
      ...(first ? { prfOutput: new Uint8Array(first instanceof ArrayBuffer ? first : (first as ArrayBufferView).buffer) } : {}),
    };
  },

  async getCredential(request) {
    const allow = request.allowCredential;
    const credential = (await navigator.credentials.get({
      publicKey: {
        rpId: request.rpId,
        challenge: request.challenge,
        ...(request.timeout !== undefined ? { timeout: request.timeout } : {}),
        userVerification: request.userVerification,
        extensions: { prf: { eval: { first: request.prfSalt } } } as AuthenticationExtensionsClientInputs,
        ...(allow
          ? { allowCredentials: [{ id: allow.credentialId, type: "public-key" as const, ...(allow.transports ? { transports: allow.transports as AuthenticatorTransport[] } : {}) }] }
          : {}),
      },
    })) as PublicKeyCredential | null;
    if (!credential) throw new Error("WebAuthn returned no usable public key credential");
    const response = credential.response as AuthenticatorAssertionResponse;
    const rawId = new Uint8Array(credential.rawId);
    saveRegistry(
      recordAssertion(loadRegistry(), b64url(rawId), {
        authenticatorData: b64url(new Uint8Array(response.authenticatorData)),
        clientDataJSON: b64url(new Uint8Array(response.clientDataJSON)),
        signature: b64url(new Uint8Array(response.signature)),
        at: Date.now(),
      }),
    );
    const first = (credential.getClientExtensionResults() as { prf?: { results?: { first?: BufferSource } } }).prf?.results?.first;
    return {
      credentialId: rawId,
      ...(first ? { prfOutput: new Uint8Array(first instanceof ArrayBuffer ? first : (first as ArrayBufferView).buffer) } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface OnChainCheck {
  ok: boolean;
  blockNumber: number;
  at: number;
}

/**
 * Ask Monad's P256VERIFY precompile (0x0100) whether the passkey's newest
 * unlock was signed by its registered key. Always the real network's RPC: a
 * read-only `eth_call`, never a transaction.
 */
export async function verifyOnMonad(record: PasskeyKeyRecord, client?: PublicClient): Promise<OnChainCheck> {
  if (!record.x || !record.y || !record.last) throw new Error("no registered key or unlock to check yet");
  const c = client ?? (createPublicClient({ chain: viemChain(NETWORK), transport: http(CHAIN_CONFIG.rpcUrl) }) as PublicClient);
  const [ok, blockNumber] = await Promise.all([
    verifyPasskeyAssertion(c, { ...toAssertion(record.last), x: BigInt(record.x), y: BigInt(record.y) }),
    c.getBlockNumber().then(Number),
  ]);
  return { ok, blockNumber, at: Date.now() };
}
