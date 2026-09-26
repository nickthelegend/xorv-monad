/**
 * The MetaMask signer adapter: what it sends to `ctx.walletExecutor`, and
 * whether what comes back is a valid EIP-3009 authorization.
 */

import { ExactEvmScheme } from "@x402/evm/exact/client";
import { authorizationTypes } from "@x402/evm";
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { verifyTypedData, type Hex } from "viem";
import { XorvPluginError } from "../src/lib/errors.js";
import {
  executorSigner,
  signTypedDataWithWallet,
  signatureFromResult,
  toWalletTypedData,
  type TypedDataInput,
} from "../src/lib/executor.js";
import { OTHER, PAYER, PROVIDER_ADDRESS, USDC, fakeMetaMask } from "./helpers.js";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:10143",
  asset: USDC.address,
  amount: "10000",
  payTo: PROVIDER_ADDRESS,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
};

const authTypedData = (): TypedDataInput => ({
  domain: { name: "USDC", version: "2", chainId: 10143, verifyingContract: USDC.address },
  types: authorizationTypes as unknown as Record<string, unknown>,
  primaryType: "TransferWithAuthorization",
  message: {
    from: PAYER.address,
    to: PROVIDER_ADDRESS,
    value: 10_000n,
    validAfter: 0n,
    validBefore: 1_900_000_000n,
    nonce: `0x${"11".repeat(32)}`,
  },
});

describe("toWalletTypedData", () => {
  it("spells out EIP712Domain and carries no bigints", () => {
    const wire = toWalletTypedData(authTypedData());
    expect(wire.types.EIP712Domain).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ]);
    expect(wire.types.TransferWithAuthorization).toEqual(authorizationTypes.TransferWithAuthorization);
    expect(wire.domain.chainId).toBe(10143);
    expect(wire.message.value).toBe("10000");
    expect(wire.message.validBefore).toBe("1900000000");
    expect(() => JSON.stringify(wire)).not.toThrow();
  });
});

describe("executorSigner (x402 ClientEvmSigner over MetaMask)", () => {
  it("produces a valid EIP-3009 TransferWithAuthorization through x402's exact scheme", async () => {
    const mm = fakeMetaMask();
    const signer = executorSigner({
      executor: mm.executor,
      address: PAYER.address,
      chainId: 10143,
      describe: () => "Xorv: pay 0.0100 USDC",
    });
    const before = Math.floor(Date.now() / 1000);
    const result = await new ExactEvmScheme(signer).createPaymentPayload(2, requirements);
    const payload = result.payload as {
      authorization: { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex };
      signature: Hex;
    };

    // Shape: a 65-byte ECDSA signature and a complete authorization.
    expect(payload.signature).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(payload.authorization.from).toBe(PAYER.address);
    expect(payload.authorization.to).toBe(PROVIDER_ADDRESS);
    expect(payload.authorization.value).toBe("10000");
    expect(payload.authorization.validAfter).toBe("0");
    expect(Number(payload.authorization.validBefore)).toBeGreaterThanOrEqual(before + 300);
    expect(payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/i);

    // Validity: it verifies against Monad USDC's EIP-712 domain, as the facilitator checks it.
    const valid = await verifyTypedData({
      address: PAYER.address,
      domain: { name: "USDC", version: "2", chainId: 10143, verifyingContract: USDC.address },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        ...payload.authorization,
        value: BigInt(payload.authorization.value),
        validAfter: BigInt(payload.authorization.validAfter),
        validBefore: BigInt(payload.authorization.validBefore),
      },
      signature: payload.signature,
    });
    expect(valid).toBe(true);

    // What MetaMask was asked: typed data on Monad testnet, with a human intent.
    expect(mm.requests).toHaveLength(1);
    expect(mm.requests[0]).toMatchObject({ kind: "typed-data", chainId: 10143, intent: { action: "custom", summary: "Xorv: pay 0.0100 USDC" } });
    expect(mm.requests[0]!.typedData.primaryType).toBe("TransferWithAuthorization");
  });

  it("refuses a signature made by a different wallet than the named payer", async () => {
    const mm = fakeMetaMask({ account: OTHER });
    const errors: unknown[] = [];
    const signer = executorSigner({ executor: mm.executor, address: PAYER.address, chainId: 10143, onError: (e) => errors.push(e) });
    await expect(signer.signTypedData(authTypedData())).rejects.toMatchObject({ code: "XORV_SIGNER_MISMATCH" });
    expect(errors).toHaveLength(1);
  });

  it("would be wrong without EIP712Domain: a literal JSON-RPC signer hashes an empty domain", async () => {
    // Send the typed data the naive way (no EIP712Domain) and the recovery check catches it.
    const mm = fakeMetaMask();
    const naive = async (req: Parameters<typeof mm.executor>[0]) => {
      const { EIP712Domain: _drop, ...types } = req.typedData.types;
      return mm.executor({ ...req, typedData: { ...req.typedData, types } });
    };
    const signer = executorSigner({ executor: naive, address: PAYER.address, chainId: 10143 });
    await expect(signer.signTypedData(authTypedData())).rejects.toMatchObject({ code: "XORV_SIGNER_MISMATCH" });
  });
});

describe("signTypedDataWithWallet", () => {
  it("refuses typed data for another chain before asking MetaMask", async () => {
    const mm = fakeMetaMask();
    await expect(signTypedDataWithWallet(mm.executor, { chainId: 143, typedData: authTypedData() })).rejects.toMatchObject({
      code: "XORV_UNSUPPORTED_NETWORK",
    });
    expect(mm.requests).toHaveLength(0);
  });

  it("maps a host refusal (policy block) to XORV_SIGNATURE_DENIED and keeps its hint", async () => {
    const err = Object.assign(new Error("blocked by policy"), { code: "POLICY_VIOLATION", hint: "Add the recipient to your allowlist." });
    const mm = fakeMetaMask({ throws: err });
    await expect(signTypedDataWithWallet(mm.executor, { chainId: 10143, typedData: authTypedData() })).rejects.toMatchObject({
      code: "XORV_SIGNATURE_DENIED",
      hint: "Add the recipient to your allowlist.",
    });
  });
});

describe("signatureFromResult", () => {
  it("explains denied, expired and pending requests", () => {
    expect(() => signatureFromResult({ status: "DENIED", failureDescription: "rejected in app" })).toThrow(/DENIED: rejected in app/);
    try {
      signatureFromResult({ status: "EXPIRED" });
    } catch (err) {
      expect(err).toBeInstanceOf(XorvPluginError);
      expect((err as XorvPluginError).hint).toMatch(/approval window/);
    }
    expect(() => signatureFromResult({ status: "AWAITING_MFA", pendingJob: { pollingId: "poll_1" } })).toThrow(
      expect.objectContaining({ code: "XORV_SIGNATURE_PENDING", hint: expect.stringContaining("mm wallet requests watch poll_1") }),
    );
  });
});
