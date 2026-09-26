/**
 * Signing through MetaMask Agent Wallet.
 *
 * A plugin never sees a key. With the `wallet-submit` capability it gets
 * `ctx.walletExecutor(io, commandId)`, a function that takes a request —
 * `{ kind: "typed-data", chainId, typedData, intent }` here — and routes it
 * through the user's wallet: a server wallet in a TEE (policy, threat scan,
 * Guard Mode 2FA) or a local "bring your own" mnemonic. What comes back is a
 * signature, or a status saying why there isn't one.
 *
 * This module adapts that executor into the two signers Xorv needs:
 *
 *  - `executorSigner` — an x402 `ClientEvmSigner`, so `@x402/evm`'s exact
 *    scheme builds the EIP-3009 `TransferWithAuthorization` exactly as it does
 *    for any other wallet, and MetaMask signs it.
 *  - `signTypedDataWithWallet` — one EIP-712 signature (the buyer's rating).
 *
 * The host's executor types live in `@metamask/agent-sdk`, which the published
 * CLI bundles without its declarations, so the request/result shapes below are
 * written out structurally from the CLI's own `mm wallet sign-typed-data`
 * command (the same call, made by the host itself).
 */

import type { ClientEvmSigner } from "@x402/evm";
import { sameAddress, toJsonSafe } from "@xorv/protocol";
import { getTypesForEIP712Domain, recoverTypedDataAddress, type Address, type Hex, type TypedDataDomain } from "viem";
import { XorvPluginError, errorMessage } from "./errors.js";

/** A human summary attached to the wallet request: shown in the 2FA approval and `mm wallet requests list`. */
export interface WalletIntent {
  action: "custom";
  summary: string;
}

/** EIP-712 typed data as JSON: what `eth_signTypedData_v4` and the wallet backend accept. */
export interface JsonTypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface TypedDataRequest {
  kind: "typed-data";
  chainId: number;
  typedData: JsonTypedData;
  intent?: WalletIntent;
}

/** What the executor resolves with (a subset; the host adds more fields). */
export interface WalletExecutorResult {
  kind?: string;
  /** e.g. SIGNED, AWAITING_MFA, DENIED, EXPIRED, FAILED. */
  status?: string;
  signature?: string;
  failureDescription?: string;
  failureReason?: string;
  pendingJob?: { pollingId?: string } | null;
}

export type WalletExecutor = (
  request: TypedDataRequest,
  options?: { signal?: AbortSignal; noAwait?: boolean },
) => Promise<WalletExecutorResult>;

/** Viem-shaped typed data, as `@x402/evm` and `@xorv/protocol` produce it (bigints allowed). */
export interface TypedDataInput {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Convert viem-shaped typed data into the JSON the wallet signs.
 *
 * Two things matter here:
 *
 *  1. **`EIP712Domain` is spelled out.** A JSON-RPC signer (MetaMask's
 *     `eth-sig-util`) hashes the domain with whatever `types.EIP712Domain`
 *     says, and treats a missing entry as an *empty* domain type — a valid
 *     signature over the wrong digest, which the facilitator then rejects as
 *     `invalid_exact_evm_payload_signature` with no hint why. viem adds the
 *     entry itself when it talks to a JSON-RPC wallet; this does the same,
 *     derived from the fields actually present in the domain.
 *  2. **No bigints.** `value`, `validBefore`, `deadline` … are `uint256`s that
 *     viem carries as bigint; the request crosses a JSON boundary to the
 *     wallet service, so they go as decimal strings (which EIP-712 encoders
 *     accept for integer types). `chainId` stays a number, which the host
 *     compares against the request's chain.
 */
export function toWalletTypedData(input: TypedDataInput): JsonTypedData {
  const { EIP712Domain: _ignored, ...rest } = input.types as Record<string, Array<{ name: string; type: string }>>;
  const domain = toJsonSafe(input.domain) as Record<string, unknown>;
  if (domain.chainId !== undefined) domain.chainId = Number(domain.chainId);
  return {
    domain,
    types: {
      EIP712Domain: getTypesForEIP712Domain({ domain: input.domain as TypedDataDomain }) as Array<{ name: string; type: string }>,
      ...rest,
    },
    primaryType: input.primaryType,
    message: toJsonSafe(input.message) as Record<string, unknown>,
  };
}

/** Pull the signature out of an executor result, or explain why there is none. */
export function signatureFromResult(result: WalletExecutorResult | null | undefined): Hex {
  const signature = result?.signature;
  if (typeof signature === "string" && /^0x[0-9a-fA-F]+$/.test(signature) && signature.length >= 132) {
    return signature as Hex;
  }
  const status = result?.status ?? "UNKNOWN";
  const reason = result?.failureDescription || result?.failureReason || "";
  if (status === "DENIED" || status === "EXPIRED" || status === "FAILED") {
    throw new XorvPluginError(
      "XORV_SIGNATURE_DENIED",
      `MetaMask did not sign (${status}${reason ? `: ${reason}` : ""})`,
      status === "EXPIRED"
        ? "The approval window closed. Run the command again and approve the request promptly."
        : "Nothing was paid. Check the request in the MetaMask app or your wallet policy (mm wallet policy get), then retry.",
    );
  }
  const pollingId = result?.pendingJob?.pollingId;
  throw new XorvPluginError(
    "XORV_SIGNATURE_PENDING",
    `MetaMask has not produced a signature yet (status ${status})${pollingId ? `, request ${pollingId}` : ""}`,
    pollingId
      ? `Approve it (mm wallet requests watch ${pollingId}), then run the command again — nothing was paid.`
      : "Approve the request in the MetaMask app, then run the command again — nothing was paid.",
  );
}

/**
 * Ask the wallet for one EIP-712 signature, under MetaMask policy.
 *
 * The call waits for the request to finish (no `noAwait`), so the host drives
 * any Guard Mode 2FA pause itself — spinner, "[AWAITING_MFA]" notice and all —
 * and hands back the signature once the user approves.
 */
export async function signTypedDataWithWallet(
  executor: WalletExecutor,
  opts: { chainId: number; typedData: TypedDataInput; intent?: string; signal?: AbortSignal },
): Promise<Hex> {
  const typedData = toWalletTypedData(opts.typedData);
  const domainChainId = typedData.domain.chainId;
  if (domainChainId !== undefined && domainChainId !== opts.chainId) {
    // The host refuses this too, but with a less specific message.
    throw new XorvPluginError(
      "XORV_UNSUPPORTED_NETWORK",
      `refusing to sign typed data for chain ${String(domainChainId)} on chain ${opts.chainId}`,
      "The broker and the plugin disagree about the network; check --broker and --chain-id.",
    );
  }
  let result: WalletExecutorResult;
  try {
    result = await executor(
      {
        kind: "typed-data",
        chainId: opts.chainId,
        typedData,
        ...(opts.intent ? { intent: { action: "custom", summary: opts.intent } } : {}),
      },
      { signal: opts.signal },
    );
  } catch (err) {
    if (err instanceof XorvPluginError) throw err;
    // The host throws its own CommandError for policy blocks, auth expiry and
    // the like; keep its message, which already says what to do.
    const code = (err as { code?: unknown })?.code;
    const hint = (err as { hint?: unknown })?.hint;
    throw new XorvPluginError(
      "XORV_SIGNATURE_DENIED",
      `MetaMask refused to sign: ${errorMessage(err)}${typeof code === "string" ? ` (${code})` : ""}`,
      typeof hint === "string" && hint ? hint : "Nothing was paid. Check mm doctor and your wallet policy, then retry.",
    );
  }
  return signatureFromResult(result);
}

/**
 * Check that `signature` over `typedData` was made by `expected`.
 *
 * MetaMask wallets (server wallet and BYOK) are EOAs, so plain ECDSA recovery
 * is the right test. It catches two failures before anything reaches the
 * broker: the active wallet not being the address the authorization names as
 * payer, and a wallet that hashed the typed data differently from viem.
 */
export async function assertSignedBy(typedData: TypedDataInput, signature: Hex, expected: string): Promise<void> {
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: typedData.domain as TypedDataDomain,
      types: typedData.types as Record<string, Array<{ name: string; type: string }>>,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
  } catch (err) {
    throw new XorvPluginError(
      "XORV_SIGNER_MISMATCH",
      `the wallet returned a signature that does not decode: ${errorMessage(err)}`,
      "Nothing was paid. Retry; if it persists, run mm doctor.",
    );
  }
  if (!sameAddress(recovered, expected)) {
    throw new XorvPluginError(
      "XORV_SIGNER_MISMATCH",
      `MetaMask signed as ${recovered}, but the payment names ${expected} as the payer`,
      `Nothing was paid. Select the wallet you meant (mm wallet select) or pass --from ${recovered}.`,
    );
  }
}

/**
 * An x402 `ClientEvmSigner` whose `signTypedData` is MetaMask's executor.
 *
 * `@x402/evm`'s exact scheme calls `signTypedData` with the EIP-3009
 * `TransferWithAuthorization` it built from the 402 (`from` = this address,
 * `to` = payTo, `value` = amount, a random nonce, `validBefore` = now + the
 * quote's timeout). Everything policy-relevant — spend cap, payee, chain,
 * asset — has already been checked by the x402 client's policies before this
 * runs; MetaMask's own policy applies on top.
 *
 * `onError` sees every failure first, because `wrapFetchWithPayment` rewraps
 * errors thrown here into a generic "Failed to create payment payload" and
 * the caller wants the original code back.
 */
export function executorSigner(opts: {
  executor: WalletExecutor;
  address: Address;
  chainId: number;
  describe?: (typedData: TypedDataInput) => string;
  signal?: AbortSignal;
  onError?: (err: unknown) => void;
}): ClientEvmSigner {
  return {
    address: opts.address,
    async signTypedData(typedData) {
      try {
        const signature = await signTypedDataWithWallet(opts.executor, {
          chainId: opts.chainId,
          typedData,
          intent: opts.describe?.(typedData),
          signal: opts.signal,
        });
        await assertSignedBy(typedData, signature, opts.address);
        return signature;
      } catch (err) {
        opts.onError?.(err);
        throw err;
      }
    },
  };
}
