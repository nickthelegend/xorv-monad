/**
 * The transaction a wallet is asked to sign.
 *
 * This is the highest-stakes pure function in the app: get it wrong and either
 * the facilitator rejects the payment, or — worse — it succeeds with the buyer
 * paying the network fee, which is the exact failure Hedera's fee-payer model
 * exists to prevent. The wallet click can't be driven from a test runner, so
 * everything up to it is pinned here, and the whole path was separately settled
 * against the live facilitator with a local key standing in for HashPack.
 */

import { AccountId, PrivateKey, TransferTransaction } from "@hashgraph/sdk";
import { describe, expect, it } from "vitest";
import { buildTransferTransaction, createWalletHederaSigner } from "../lib/hedera-wallet";

const PAYER = "0.0.9848440";
const PROVIDER = "0.0.9848438";
const FACILITATOR = "0.0.9842030";
const USDC = "0.0.429274";

const requirements = (over: Record<string, unknown> = {}) => ({
  network: "hedera:testnet",
  asset: USDC,
  amount: "250000",
  payTo: PROVIDER,
  extra: { feePayer: FACILITATOR },
  ...over,
});

describe("the fee payer owns the transaction", () => {
  it("generates the transaction id for the facilitator, never the buyer", () => {
    // The single most important line in the file. If the id were generated for
    // the payer, the buyer would be charged gas — and a buyer holding only a
    // stablecoin could not transact at all, which is the whole premise.
    const tx = buildTransferTransaction(requirements(), PAYER);
    expect(tx.transactionId?.accountId?.toString()).toBe(FACILITATOR);
    expect(tx.transactionId?.accountId?.toString()).not.toBe(PAYER);
  });

  it("refuses to build without a fee payer rather than defaulting to the buyer", () => {
    expect(() => buildTransferTransaction(requirements({ extra: {} }), PAYER)).toThrow(/feePayer/);
    expect(() => buildTransferTransaction(requirements({ extra: null }), PAYER)).toThrow(/feePayer/);
  });
});

describe("the transfer", () => {
  it("moves the token from buyer to provider, and nothing else", () => {
    const tx = buildTransferTransaction(requirements(), PAYER);
    const byToken = tx.tokenTransfers.get(USDC);
    expect(byToken?.get(PAYER)?.toString()).toBe("-250000");
    expect(byToken?.get(PROVIDER)?.toString()).toBe("250000");
    // No HBAR leg: the facilitator's fee is not part of this transfer.
    expect(tx.hbarTransfers.size).toBe(0);
  });

  it("nets to zero, so the ledger accepts it", () => {
    const tx = buildTransferTransaction(requirements(), PAYER);
    const legs = [...(tx.tokenTransfers.get(USDC)?.values() ?? [])];
    expect(legs.reduce((sum, v) => sum + BigInt(v.toString()), 0n)).toBe(0n);
  });

  it("uses HBAR transfers when the asset is 0.0.0", () => {
    const tx = buildTransferTransaction(requirements({ asset: "0.0.0", amount: "100000000" }), PAYER);
    expect(tx.tokenTransfers.size).toBe(0);
    expect(tx.hbarTransfers.get(PAYER)?.toTinybars().toString()).toBe("-100000000");
    expect(tx.hbarTransfers.get(PROVIDER)?.toTinybars().toString()).toBe("100000000");
  });

  it("rejects a non-positive amount instead of building a no-op transfer", () => {
    expect(() => buildTransferTransaction(requirements({ amount: "0" }), PAYER)).toThrow(/greater than zero/);
    expect(() => buildTransferTransaction(requirements({ amount: "-1" }), PAYER)).toThrow(/greater than zero/);
  });
});

describe("one node, one body", () => {
  it("freezes against exactly one node account", () => {
    // Not cosmetic. A default freeze offers several candidate nodes, so the
    // frozen transaction carries one signable body per node. HashPack's
    // DAppSigner builds its body from nodeAccountIds[0] alone, gets a
    // signature for THAT body, and then merges it into every transaction in
    // the list — valid for the first node, invalid for the rest. The
    // facilitator verifies whichever body it reads and rejects the payment
    // with `invalid_exact_hedera_payload_signature_invalid: payer … did not
    // sign the transaction`.
    const tx = buildTransferTransaction(requirements(), PAYER);
    expect(tx.nodeAccountIds?.length).toBe(1);
  });

  it("serialises to a single transaction, so the signature cannot mismatch", async () => {
    const key = PrivateKey.generateECDSA();
    const signer = createWalletHederaSigner(PAYER, async (tx) => tx.sign(key));
    const base64 = await signer.createPartiallySignedTransferTransaction(requirements());
    const round = TransferTransaction.fromBytes(
      Buffer.from(base64, "base64"),
    ) as TransferTransaction;
    expect(round.nodeAccountIds?.length).toBe(1);
  });
});

describe("freezing", () => {
  it("returns a frozen transaction, since the signature must cover a fixed body", () => {
    // The facilitator verifies the payer's signature against the frozen body.
    // An unfrozen transaction would be signed over something that can still
    // change, and is rejected rather than silently wrong.
    expect(buildTransferTransaction(requirements(), PAYER).isFrozen()).toBe(true);
  });

  it("is signable and serialises to base64 the scheme can carry", async () => {
    const key = PrivateKey.generateECDSA();
    const signer = createWalletHederaSigner(PAYER, async (tx) => tx.sign(key));
    const base64 = await signer.createPartiallySignedTransferTransaction(requirements());

    expect(base64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const round = TransferTransaction.fromBytes(
      Buffer.from(base64, "base64"),
    ) as TransferTransaction;
    expect(round.transactionId?.accountId?.toString()).toBe(FACILITATOR);
    expect(round.tokenTransfers.get(USDC)?.get(PROVIDER)?.toString()).toBe("250000");
  });
});

describe("the signer's shape", () => {
  it("exposes the account id x402 expects, normalised", () => {
    const signer = createWalletHederaSigner(PAYER, async (tx) => tx);
    expect(signer.accountId).toBe(AccountId.fromString(PAYER).toString());
    expect(typeof signer.createPartiallySignedTransferTransaction).toBe("function");
  });

  it("delegates signing rather than holding a key", async () => {
    // The property that makes a wallet possible at all: this module never sees
    // key material, it only asks something else to sign.
    let asked = false;
    const signer = createWalletHederaSigner(PAYER, async (tx) => {
      asked = true;
      return tx;
    });
    await signer.createPartiallySignedTransferTransaction(requirements());
    expect(asked).toBe(true);
  });
});
