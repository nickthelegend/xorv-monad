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
import { concatHex, sha256, toHex, type Hex, type PublicClient } from "viem";

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
