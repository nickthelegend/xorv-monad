/**
 * Hedera plumbing shared by the broker, the CLI and the setup scripts.
 */

import {
  AccountBalanceQuery,
  AccountId,
  Client,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
} from "@hiero-ledger/sdk";
import { HEDERA_MAINNET_CAIP2, mirrorNodeUrl, usdcTokenId } from "./constants.js";

/**
 * Parse a Hedera private key without making the caller know which curve it is.
 *
 * The Hedera portal hands out `0x`-prefixed ECDSA keys, older tooling and most
 * docs hand out DER-encoded ED25519, and the two parse functions throw on each
 * other's input. Getting this wrong surfaces much later as INVALID_SIGNATURE on
 * a transaction that looks fine, so the guessing happens once, here.
 */
export function parsePrivateKey(raw: string): PrivateKey {
  const key = raw.trim();
  if (!key) throw new Error("empty private key");

  const hex = key.startsWith("0x") ? key.slice(2) : key;
  // A bare 32-byte hex string is an ECDSA secp256k1 key — that's what the
  // portal shows under "HEX Encoded Private Key".
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    try {
      return PrivateKey.fromStringECDSA(key);
    } catch {
      return PrivateKey.fromStringED25519(key);
    }
  }

  // Anything else is DER; let the SDK sniff the OID, and only then fall back.
  const attempts: Array<() => PrivateKey> = [
    () => PrivateKey.fromStringDer(key),
    () => PrivateKey.fromStringED25519(key),
    () => PrivateKey.fromStringECDSA(key),
  ];
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(
    `could not parse private key as DER, ED25519 or ECDSA — tried all three (${errors.join("; ")})`,
  );
}

/** A configured SDK client for a CAIP-2 network. */
export function hederaClient(network: string, accountId: string, key: PrivateKey): Client {
  const client = network === HEDERA_MAINNET_CAIP2 ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(accountId), key);
  // Without this the SDK can sit on a wedged node for minutes; a job quote that
  // hangs is worse than one that fails fast and retries.
  client.setRequestTimeout(30_000);
  return client;
}

/** A read-only client, for balance and mirror-backed lookups. */
export function hederaReadClient(network: string): Client {
  const client = network === HEDERA_MAINNET_CAIP2 ? Client.forMainnet() : Client.forTestnet();
  client.setRequestTimeout(30_000);
  return client;
}

export interface AccountBalances {
  hbarTinybars: string;
  usdcUnits: string;
  /** True when the account has explicitly associated the USDC token. */
  usdcAssociated: boolean;
  /**
   * -1 means unlimited automatic association, 0 means none, n means n slots.
   * See `canReceiveUsdc` for why this matters more than `usdcAssociated`.
   */
  maxAutoAssociations: number;
  /**
   * Can this account actually be paid in USDC right now?
   *
   * Explicit association is only one of two ways to say yes. Since HIP-904 an
   * account can carry automatic association slots, and a token lands in one of
   * those without any prior opt-in. Reporting on `usdcAssociated` alone tells an
   * operator with unlimited auto-association that they can't be paid, and sends
   * them to run a transaction they don't need — which is exactly the wrong
   * advice, and costs them HBAR to follow.
   *
   * This mirrors what `@x402/hedera`'s preflight checks before it will settle.
   */
  canReceiveUsdc: boolean;
}

interface MirrorTokenBalance {
  tokens?: Array<{ token_id: string; balance: number }>;
  balance?: { balance: number; tokens?: Array<{ token_id: string; balance: number }> };
  max_automatic_token_associations?: number;
}

/**
 * Balances via the Mirror Node.
 *
 * Deliberately not `AccountBalanceQuery`: consensus-node balance queries no
 * longer reliably report token associations (the same reason `@x402/hedera`
 * preflights against the Mirror Node), and "is this account associated with
 * USDC?" is the exact question the CLI needs answered before it promises
 * someone they can get paid.
 */
export async function fetchBalances(network: string, accountId: string): Promise<AccountBalances> {
  const token = usdcTokenId(network);
  const url = `${mirrorNodeUrl(network)}/api/v1/accounts/${accountId}?limit=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`mirror node account lookup → ${res.status}`);
  const body = (await res.json()) as MirrorTokenBalance;
  const balance = body.balance;
  const tokens = balance?.tokens ?? body.tokens ?? [];
  const usdc = tokens.find((t) => t.token_id === token);
  const maxAutoAssociations = body.max_automatic_token_associations ?? 0;
  const associated = Boolean(usdc);

  return {
    hbarTinybars: String(balance?.balance ?? 0),
    usdcUnits: String(usdc?.balance ?? 0),
    usdcAssociated: associated,
    maxAutoAssociations,
    // -1 is unlimited; a positive number is slots, and an account can only be
    // holding as many tokens as it has slots used, so any positive value with
    // room left also works.
    canReceiveUsdc:
      associated || maxAutoAssociations === -1 || maxAutoAssociations > tokens.length,
  };
}

/** True when `accountId` can already receive `tokenId`. */
export async function isTokenAssociated(
  network: string,
  accountId: string,
  tokenId: string,
): Promise<boolean> {
  const url = `${mirrorNodeUrl(network)}/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}&limit=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return false;
  const body = (await res.json()) as { tokens?: Array<{ token_id: string }> };
  return Boolean(body.tokens?.some((t) => t.token_id === tokenId));
}

/**
 * Associate a token with the operator account, tolerating "already done".
 *
 * A provider that isn't associated with USDC cannot be paid — the transfer
 * fails at consensus with TOKEN_NOT_ASSOCIATED_TO_ACCOUNT, and x402's preflight
 * rejects the payment before it ever gets that far. So `xorv register` runs
 * this, and re-running it must be harmless.
 */
export async function associateToken(
  client: Client,
  accountId: string,
  tokenId: string,
): Promise<{ associated: boolean; transactionId?: string }> {
  try {
    const tx = await new TokenAssociateTransaction()
      .setAccountId(AccountId.fromString(accountId))
      .setTokenIds([TokenId.fromString(tokenId)])
      .execute(client);
    const receipt = await tx.getReceipt(client);
    if (receipt.status.toString() !== "SUCCESS") {
      throw new Error(`association failed: ${receipt.status.toString()}`);
    }
    return { associated: true, transactionId: tx.transactionId?.toString() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
      return { associated: true };
    }
    throw err;
  }
}

/** HBAR balance in tinybars, straight from a consensus node. */
export async function hbarBalance(client: Client, accountId: string): Promise<string> {
  const balance = await new AccountBalanceQuery()
    .setAccountId(AccountId.fromString(accountId))
    .execute(client);
  return balance.hbars.toTinybars().toString();
}

/** Cheap shape check so a typo'd account id fails at config time, not on-chain. */
export function isAccountId(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value.trim());
}
