/**
 * Passkey (WebAuthn) signatures, verified by Monad itself.
 *
 * Monad has P256VERIFY (EIP-7951, the RIP-7212 interface) as a precompile at
 * 0x0100: 160 bytes in (`hash ‖ r ‖ s ‖ x ‖ y`), 32 bytes out (`…01`) when the
 * signature is valid, nothing otherwise, for 6,900 gas. A passkey signs with
 * P-256, so any contract (or any `eth_call`) can check that a passkey holder
 * signed something, with no library and no off-chain verifier.
 *
 * A WebAuthn assertion signs `authenticatorData ‖ sha256(clientDataJSON)`, and
 * the signature comes DER-encoded. These helpers turn an assertion into the
 * precompile's input, normalise `s` to the low half (P-256 signatures are
 * malleable; the precompile accepts both, but contracts should store one), and
 * run the check against a chain.
 */
import { p256 } from "@noble/curves/nist.js";
import { concatHex, hexToBytes, sha256, toHex, type Hex, type PublicClient } from "viem";

export const P256_VERIFY = "0x0000000000000000000000000000000000000100" as const;

/** The P-256 group order, n. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** Split a DER-encoded ECDSA signature (WebAuthn's format) into r and s, with s in the low half. */
export function derToRs(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  const expect = (byte: number) => {
    if (der[i] !== byte) throw new Error(`not a DER ECDSA signature (byte ${i})`);
    i += 1;
  };
  const length = (): number => {
    const first = der[i++]!;
    if (first < 0x80) return first;
    let len = 0;
    for (let k = 0; k < (first & 0x7f); k++) len = (len << 8) | der[i++]!;
    return len;
  };
  const integer = (): bigint => {
    expect(0x02);
    const len = length();
    const bytes = der.slice(i, i + len);
    i += len;
    return BigInt(toHex(bytes));
  };
  expect(0x30);
  length();
  const r = integer();
  let s = integer();
  if (s > N / 2n) s = N - s;
  return { r, s };
}

/** The 32-byte digest a WebAuthn assertion's signature covers: sha256(authenticatorData ‖ sha256(clientDataJSON)). */
export function webauthnDigest(authenticatorData: Uint8Array, clientDataJSON: Uint8Array): Hex {
  return sha256(concatHex([toHex(authenticatorData), sha256(clientDataJSON)]));
}

/** The precompile's 160-byte input. */
export function p256Input(p: { hash: Hex; r: bigint; s: bigint; x: bigint; y: bigint }): Hex {
  return concatHex([p.hash, toHex(p.r, { size: 32 }), toHex(p.s, { size: 32 }), toHex(p.x, { size: 32 }), toHex(p.y, { size: 32 })]);
}

/** Ask the chain's P256VERIFY precompile whether (r, s) is the key (x, y)'s signature over `hash`. */
export async function p256VerifyOnChain(client: PublicClient, p: { hash: Hex; r: bigint; s: bigint; x: bigint; y: bigint }): Promise<boolean> {
  const { data } = await client.call({ to: P256_VERIFY, data: p256Input(p) });
  return data !== undefined && data !== "0x" && BigInt(data) === 1n;
}

/** Verify a WebAuthn assertion from a passkey whose public key is (x, y), on chain. */
export async function verifyPasskeyAssertion(
  client: PublicClient,
  a: { authenticatorData: Uint8Array; clientDataJSON: Uint8Array; signature: Uint8Array; x: bigint; y: bigint },
): Promise<boolean> {
  const { r, s } = derToRs(a.signature);
  return p256VerifyOnChain(client, { hash: webauthnDigest(a.authenticatorData, a.clientDataJSON), r, s, x: a.x, y: a.y });
}

/** One WebAuthn assertion, as navigator.credentials.get() returns it. */
export interface PasskeyAssertion {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  /** DER-encoded ECDSA signature. */
  signature: Uint8Array;
}

/**
 * A passkey's public key from the SubjectPublicKeyInfo that
 * `AuthenticatorAttestationResponse.getPublicKey()` returns at creation: for
 * P-256 (COSE alg -7) it ends in the uncompressed point 0x04 ‖ x ‖ y.
 */
export function spkiToXY(spki: Uint8Array): { x: bigint; y: bigint } {
  const point = spki.slice(spki.length - 65);
  if (spki.length < 65 || point[0] !== 0x04) throw new Error("not an uncompressed P-256 public key");
  return { x: BigInt(toHex(point.slice(1, 33))), y: BigInt(toHex(point.slice(33, 65))) };
}

/** Check an assertion against a public key locally (no chain), as P256VERIFY would. */
export function verifyPasskeyLocally(a: PasskeyAssertion, key: { x: bigint; y: bigint }): boolean {
  const { r, s } = derToRs(a.signature);
  const sig = hexToBytes(concatHex([toHex(r, { size: 32 }), toHex(s, { size: 32 })]));
  const pub = hexToBytes(concatHex(["0x04", toHex(key.x, { size: 32 }), toHex(key.y, { size: 32 })]));
  return p256.verify(sig, hexToBytes(webauthnDigest(a.authenticatorData, a.clientDataJSON)), pub, { prehash: false, lowS: false });
}

/**
 * Recover a passkey's public key from two of its assertions.
 *
 * WebAuthn only hands out a passkey's public key when it is created. For a
 * passkey made before anyone kept it, ECDSA key recovery gets it back: one
 * signature yields two candidate keys, and the one that also verifies a
 * second, independent assertion is the passkey's. Null if no candidate
 * verifies both (two different passkeys, or a damaged assertion).
 */
export function recoverPasskeyKey(first: PasskeyAssertion, second: PasskeyAssertion): { x: bigint; y: bigint } | null {
  const { r, s } = derToRs(first.signature);
  const digest = hexToBytes(webauthnDigest(first.authenticatorData, first.clientDataJSON));
  const compact = hexToBytes(concatHex([toHex(r, { size: 32 }), toHex(s, { size: 32 })]));
  for (const bit of [0, 1]) {
    try {
      const point = p256.Signature.fromBytes(compact, "compact").addRecoveryBit(bit).recoverPublicKey(digest).toAffine();
      const key = { x: point.x, y: point.y };
      if (verifyPasskeyLocally(first, key) && verifyPasskeyLocally(second, key)) return key;
    } catch {
      // no point for this recovery bit
    }
  }
  return null;
}
