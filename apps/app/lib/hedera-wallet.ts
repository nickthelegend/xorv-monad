/**
 * Paying for a job with a Hedera-native wallet.
 *
 * This is the piece Privy could not do, and the reason it could not is worth
 * stating precisely: Privy signs **EVM RLP transactions**. Hedera's x402
 * `exact` scheme needs a signature over a **native protobuf
 * TransferTransaction**. Those are different bytes over a different structure,
 * so no amount of chain configuration bridges them — Hedera's EVM relay is a
 * different surface from the one x402 settles on. HashPack, Blade and Kabila
 * sign the native transaction, which is why the browser can pay at all now.
 *
 * ## The shape of the thing
 *
 * `@x402/hedera` asks for a `ClientHederaSigner`, which is only two members:
 * an account id, and `createPartiallySignedTransferTransaction()` returning
 * base64. `createClientHederaSigner(id, privateKey)` is the library's own
 * implementation for when you hold the key. This module is a second one for
 * when a wallet holds it.
 *
 * **Base64 is the entire interface.** That matters more than it looks: the
 * transaction is protobuf, so it does not matter which SDK produced the bytes.
 * The rest of Xorv uses `@hiero-ledger/sdk`; this file uses `@hashgraph/sdk`,
 * because that is what `hedera-wallet-connect` type-checks its `Transaction`
 * against. They are the same library under two names, and the two never meet —
 * only the string crosses the boundary.
 *
 * ## Why construction is separate from signing
 *
 * `buildTransferTransaction` is pure and exported on its own. A browser
 * extension cannot be driven from a test runner, so the wallet click is the
 * one link that can only be verified by hand. Everything up to it — the
 * transfer pair, the fee-payer transaction id, the freeze — is checked by
 * signing the identical transaction with a local key and settling it against
 * the real facilitator. If that passes, the only thing left untested is
 * whether HashPack signs correctly, which is its job and not ours.
 */

import {
  AccountId,
  Hbar,
  TokenId,
  TransactionId,
  TransferTransaction,
  Client,
  type Transaction,
} from "@hashgraph/sdk";

/** The subset of x402's `PaymentRequirements` this needs. */
export interface TransferRequirements {
  network: string;
  /** `"0.0.0"` means HBAR; anything else is an HTS token id. */
  asset: string;
  amount: string;
  payTo: string;
  extra?: { feePayer?: unknown } | null;
}

/** HBAR is spelled `0.0.0` in the scheme, the same way x402 spells it. */
function isHbar(asset: string): boolean {
  return asset === "0.0.0";
}

function clientFor(network: string): Client {
  return network === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet();
}

/**
 * Build the exact transaction the scheme expects, frozen and ready to sign.
 *
 * Mirrors `@x402/hedera`'s own client signer. The one line that surprises
 * people is the transaction id:
 *
 *     TransactionId.generate(feePayer)
 *
 * The id belongs to the **facilitator**, not the buyer. That is the whole
 * fee-payer model — the account that pays the network fee owns the
 * transaction, so a buyer holding nothing but a stablecoin can still transact.
 * Generate it for the buyer instead and the buyer is charged gas, which is the
 * exact failure this project exists to avoid.
 *
 * @throws if `extra.feePayer` is missing, or the amount is not positive.
 */
export function buildTransferTransaction(
  requirements: TransferRequirements,
  payerAccountId: string,
): TransferTransaction {
  const feePayer = requirements.extra?.feePayer;
  if (typeof feePayer !== "string" || feePayer.length === 0) {
    throw new Error("feePayer is required in paymentRequirements.extra for Hedera exact");
  }

  const amount = BigInt(requirements.amount);
  if (amount <= 0n) throw new Error("amount must be greater than zero");

  const payer = AccountId.fromString(payerAccountId);
  const payTo = AccountId.fromString(requirements.payTo);
  const tx = new TransferTransaction();

  if (isHbar(requirements.asset)) {
    tx.addHbarTransfer(payer, Hbar.fromTinybars((-amount).toString()));
    tx.addHbarTransfer(payTo, Hbar.fromTinybars(amount.toString()));
  } else {
    const token = TokenId.fromString(requirements.asset);
    tx.addTokenTransfer(token, payer, -amount);
    tx.addTokenTransfer(token, payTo, amount);
  }

  tx.setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));

  const client = clientFor(requirements.network);
  try {
    // Freeze against exactly ONE node, and this is load-bearing.
    //
    // A default freeze picks several candidate nodes, producing one signable
    // body per node. `DAppSigner.signTransaction` builds its body from
    // `nodeAccountIds[0]` only, gets a signature for that body back from the
    // wallet, and then merges that single signature into *every* transaction
    // in the list. The signature is therefore valid for the first node and
    // invalid for all the others — and the facilitator, verifying whichever
    // body it happens to read, rejects the payment with
    // `invalid_exact_hedera_payload_signature_invalid: payer … did not sign`.
    //
    // With one node there is one body, so the signature the wallet returns is
    // the signature for the transaction that gets submitted.
    // `client.network` is a plain endpoint -> AccountId record, not a Map.
    const node = Object.values(client.network as Record<string, AccountId | string>)[0];
    if (node !== undefined) {
      tx.setNodeAccountIds([node instanceof AccountId ? node : AccountId.fromString(String(node))]);
    }

    // Freezing binds the body — node id, transaction id, transfers — so the
    // signature covers something that can no longer change. The facilitator's
    // `verifyPayerSignature` checks against the frozen body, so a transaction
    // signed before freezing is rejected rather than silently wrong.
    tx.freezeWith(client);
  } finally {
    client.close();
  }
  return tx;
}

/**
 * Anything that can add a signature to a frozen transaction.
 *
 * HashPack's `DAppSigner.signTransaction` already has this shape, so a wallet
 * satisfies it directly. A local-key signer also satisfies it, which is what
 * makes the path testable without an extension.
 */
export type TransactionSigner = <T extends Transaction>(transaction: T) => Promise<T>;

/**
 * An x402 `ClientHederaSigner` whose signature comes from a wallet.
 *
 * Structurally identical to what `@x402/hedera` exports, so it drops straight
 * into `new ExactHederaScheme(signer)`. Deliberately not typed as that import:
 * this file must not pull `@hiero-ledger/sdk` into the browser bundle
 * alongside `@hashgraph/sdk`, which is the same protobuf machinery twice.
 */
export function createWalletHederaSigner(accountId: string, signTransaction: TransactionSigner) {
  const parsed = AccountId.fromString(accountId).toString();
  return {
    accountId: parsed,
    async createPartiallySignedTransferTransaction(
      requirements: TransferRequirements,
    ): Promise<string> {
      const frozen = buildTransferTransaction(requirements, parsed);
      const signed = await signTransaction(frozen);
      // Base64, not hex: this goes into the x402 payload as a JSON string.
      return Buffer.from(signed.toBytes()).toString("base64");
    },
  };
}
