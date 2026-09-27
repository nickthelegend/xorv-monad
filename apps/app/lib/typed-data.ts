/**
 * EIP-712 payloads, made safe to hand to a wallet SDK.
 *
 * viem carries every `uint256` / `int128` as a bigint: the x402 exact scheme
 * builds `TransferWithAuthorization` with `value`, `validAfter` and
 * `validBefore` as bigints, and a rating's `value` and `deadline` are bigints
 * too. viem's own JSON-RPC path serializes those itself. Privy does not: its
 * embedded-wallet provider passes the object through untouched to its sign
 * modal, which renders the payload with a bare `JSON.stringify` — and
 * `JSON.stringify` throws on a bigint. The throw happens during render, so
 * React unmounts the whole app and the click that was meant to pay (or rate)
 * ends on Next's "Application error" page with nothing signed.
 *
 * `toWalletTypedData` returns the same payload in the form every
 * `eth_signTypedData_v4` implementation agrees on:
 *
 *  1. **No bigints.** Integer fields go as decimal strings, which EIP-712
 *     encoders (viem, ethers, eth-sig-util) accept for integer types.
 *     `domain.chainId` stays a number: viem only puts `chainId` into the
 *     domain type when it is a number or a bigint, so a string would silently
 *     drop it and sign a different digest.
 *  2. **An explicit `EIP712Domain`.** Privy derives the domain type from
 *     `Object.entries(domain)` — key *insertion* order — when the payload has
 *     none, and some wallets treat a missing entry as an empty domain. Both
 *     produce a valid signature over the wrong digest. The canonical order
 *     (name, version, chainId, verifyingContract, salt), derived from the
 *     fields actually present, removes the guesswork.
 *
 * The digest is unchanged, so the signature is byte-for-byte the one viem
 * produces over the original (test/typed-data.test.ts proves it for both the
 * x402 authorization and the rating).
 */

import { getTypesForEIP712Domain, type TypedDataDomain } from "viem";
import { toJsonSafe } from "@xorv/protocol/web";

/** The loosely-typed payload x402 and the rating flow hand a signer. */
export interface TypedDataInput {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** The same payload with nothing `JSON.stringify` can choke on. */
export interface WalletTypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export function toWalletTypedData(input: TypedDataInput): WalletTypedData {
  // Any EIP712Domain the caller sent is replaced by the canonical one below.
  const rest = Object.fromEntries(Object.entries(input.types).filter(([name]) => name !== "EIP712Domain"));
  const domain = toJsonSafe(input.domain) as Record<string, unknown>;
  if (domain.chainId !== undefined && domain.chainId !== null) domain.chainId = Number(domain.chainId);
  return {
    domain,
    types: {
      EIP712Domain: getTypesForEIP712Domain({ domain: input.domain as TypedDataDomain }) as Array<{ name: string; type: string }>,
      ...(toJsonSafe(rest) as Record<string, Array<{ name: string; type: string }>>),
    },
    primaryType: input.primaryType,
    message: toJsonSafe(input.message) as Record<string, unknown>,
  };
}

/**
 * Wrap a wallet SDK's `signTypedData` so it only ever sees JSON-safe typed
 * data. Used for Privy (embedded and external wallets alike).
 */
export function jsonSafeSigner<TSig>(sign: (typedData: WalletTypedData) => Promise<TSig>) {
  return (typedData: TypedDataInput): Promise<TSig> => sign(toWalletTypedData(typedData));
}
