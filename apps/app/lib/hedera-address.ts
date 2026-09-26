/**
 * Turning a wallet address into a Hedera account.
 *
 * Hedera has two names for the same thing and they are not interchangeable:
 *
 *  - **`0.0.12345`** — the account id, what the ledger and every Hedera tool use.
 *  - **`0xabc…`** — a 20-byte EVM address, what a wallet shows you.
 *
 * An account created through the EVM (by receiving HBAR at an address derived
 * from an ECDSA key) is reachable by *both*, but the mapping only exists once
 * the account has been created on-ledger. Before that first funding the address
 * is a valid destination and the account id simply does not exist yet — which
 * is exactly the state a new Privy user is in, and the reason this module
 * returns a status rather than a string.
 *
 * There are also **long-zero** addresses: `0x` + 12 zero bytes + the account
 * number in hex, which is what the mirror node reports for accounts created
 * natively rather than through the EVM. Those can be decoded locally with no
 * network call at all.
 */

import { mirrorNodeUrl } from "@xorv/protocol";

export type Resolution =
  | { status: "resolved"; accountId: string; evmAddress: string; createdVia: "evm" | "native" }
  | { status: "not-created"; evmAddress: string }
  | { status: "error"; evmAddress: string; message: string };

/**
 * Decode a long-zero address without touching the network.
 *
 * `0x0000000000000000000000000000000000964678` is shard 0, realm 0, account
 * 0x964678 = 9848440. Recognising this locally saves a mirror-node round trip
 * for every natively-created account.
 */
export function decodeLongZero(evmAddress: string): string | null {
  const hex = evmAddress.toLowerCase().replace(/^0x/, "");
  if (hex.length !== 40) return null;
  // The first 24 nibbles (12 bytes) must be zero for this to be a long-zero.
  if (!/^0{24}/.test(hex)) return null;
  const num = BigInt(`0x${hex.slice(24)}`);
  if (num === 0n) return null;
  return `0.0.${num.toString()}`;
}

/** Is this a syntactically valid 20-byte EVM address? */
export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/**
 * Resolve an EVM address to its Hedera account id.
 *
 * Tries the local decode first, then the Mirror Node. A 404 is not an error —
 * it is the ordinary state of an address that has never received anything, and
 * the UI needs to tell that user to fund it rather than showing them a failure.
 */
export async function resolveHederaAccount(
  network: string,
  evmAddress: string,
  signal?: AbortSignal,
): Promise<Resolution> {
  const address = evmAddress.trim();
  if (!isEvmAddress(address)) {
    return { status: "error", evmAddress: address, message: "not a valid EVM address" };
  }

  const local = decodeLongZero(address);
  if (local) {
    return { status: "resolved", accountId: local, evmAddress: address, createdVia: "native" };
  }

  try {
    const res = await fetch(`${mirrorNodeUrl(network)}/api/v1/accounts/${address}`, {
      signal: signal ?? AbortSignal.timeout(12_000),
    });
    if (res.status === 404) return { status: "not-created", evmAddress: address };
    if (!res.ok) {
      return { status: "error", evmAddress: address, message: `mirror node → ${res.status}` };
    }
    const body = (await res.json()) as { account?: string };
    if (!body.account) return { status: "not-created", evmAddress: address };
    return {
      status: "resolved",
      accountId: body.account,
      evmAddress: address,
      createdVia: "evm",
    };
  } catch (err) {
    return {
      status: "error",
      evmAddress: address,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Shorten an address for chrome: `0x0000…4678`. */
export function shortAddress(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}
