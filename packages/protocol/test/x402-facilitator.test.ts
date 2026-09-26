/**
 * The in-process facilitator is what moves the money, so it is exercised end
 * to end against a scripted Monad RPC: a real buyer payload, real EIP-3009
 * signature checks, a real signed `transferWithAuthorization` transaction —
 * with the network replaced by a fake that records every call. That is how we
 * can assert the things that matter on Monad specifically: the gas limit is
 * estimate + headroom (Monad bills the limit), and rejections are logged with
 * a reason instead of disappearing into a bare 402.
 */

import { describe, expect, it, vi } from "vitest";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { eip3009ABI } from "@x402/evm";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseTransaction,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MONAD_FACILITATOR_URL, MONAD_TESTNET } from "../src/chains.js";
import { accountFromKey, sameAddress, withGasHeadroom } from "../src/evm.js";
import {
  SETTLEMENT_CONFIRMATION_TIMEOUT_MS,
  buildFacilitator,
  buildHostedFacilitator,
  buildLocalFacilitator,
  formatPaymentRejection,
  formatSettlementFailure,
  logPaymentRejections,
} from "../src/x402.js";
import { buyerX402Client, usdcAssetAmount } from "../src/x402-client.js";
import { fakeRpc, hex } from "./support/fake-rpc.js";

const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const PROVIDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ESTIMATE = 141_600n;

const TRANSFER_EVENT = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  const price = usdcAssetAmount(MONAD_TESTNET, "10000");
  return {
    scheme: "exact",
    network: MONAD_TESTNET,
    asset: price.asset,
    amount: price.amount,
    payTo: PROVIDER,
    maxTimeoutSeconds: 300,
    extra: price.extra ?? {},
    ...overrides,
  };
}

async function buyerPayload(reqs: PaymentRequirements) {
  const payer = privateKeyToAccount(generatePrivateKey());
  const client = buyerX402Client({ signer: payer, network: MONAD_TESTNET, maxUsdcUnits: "1000000" });
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: "https://broker.xorv.xyz/api/jobs/qte_1" },
    accepts: [reqs],
  };
  return { payer, payload: (await client.createPaymentPayload(paymentRequired)) as PaymentPayload };
}

/** A Monad testnet node with a USDC contract, an EOA payer, and a mempool of one. */
function monadNode() {
  const sent: Hex[] = [];
  const rpc = fakeRpc({
    eth_chainId: () => hex(10143),
    eth_blockNumber: () => hex(1_000),
    eth_getCode: ([address]) => (sameAddress(address as string, USDC) ? "0x6080604052" : "0x"),
    // The pre-settlement simulation of transferWithAuthorization: succeeds.
    eth_call: () => "0x",
    eth_estimateGas: () => hex(ESTIMATE),
    eth_getTransactionCount: () => hex(5),
    eth_maxPriorityFeePerGas: () => hex(2_000_000_000n),
    eth_gasPrice: () => hex(102_000_000_000n),
    eth_getBlockByNumber: () => ({
      number: hex(1_000),
      hash: keccak256("0x01"),
      parentHash: keccak256("0x00"),
      timestamp: hex(1_790_000_000),
      baseFeePerGas: hex(100_000_000_000n),
      gasLimit: hex(150_000_000),
      gasUsed: "0x0",
      transactions: [],
      uncles: [],
      logsBloom: `0x${"0".repeat(512)}`,
      extraData: "0x",
      miner: "0x0000000000000000000000000000000000000000",
      difficulty: "0x0",
      size: "0x0",
      nonce: "0x0000000000000000",
    }),
    eth_sendRawTransaction: ([raw]) => {
      sent.push(raw as Hex);
      return keccak256(raw as Hex);
    },
    eth_getTransactionReceipt: ([hash]) => {
      const raw = sent.find((tx) => keccak256(tx) === hash);
      if (!raw) return null;
      const tx = parseTransaction(raw);
      const { args } = decodeFunctionData({ abi: eip3009ABI, data: tx.data! });
      const [from, to, value] = args as unknown as [Hex, Hex, bigint];
      return {
        transactionHash: hash,
        transactionIndex: "0x0",
        blockHash: keccak256("0x01"),
        blockNumber: hex(1_001),
        from: "0x0000000000000000000000000000000000000000",
        to: USDC,
        cumulativeGasUsed: hex(ESTIMATE),
        gasUsed: hex(ESTIMATE),
        effectiveGasPrice: hex(102_000_000_000n),
        contractAddress: null,
        logsBloom: `0x${"0".repeat(512)}`,
        status: "0x1",
        type: "0x2",
        logs: [
          {
            address: USDC.toLowerCase(),
            topics: encodeEventTopics({ abi: TRANSFER_EVENT, eventName: "Transfer", args: { from, to } }),
            data: encodeAbiParameters([{ type: "uint256" }], [value]),
            blockNumber: hex(1_001),
            blockHash: keccak256("0x01"),
            transactionHash: hash,
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false,
          },
        ],
      };
    },
  });
  return { ...rpc, sent };
}

describe("buildLocalFacilitator", () => {
  it("advertises exact on Monad testnet, signed by its own EOA", async () => {
    const node = monadNode();
    const account = accountFromKey(generatePrivateKey());
    const facilitator = buildLocalFacilitator({ network: MONAD_TESTNET, account, transport: node.transport, log: () => {} });
    const supported = await facilitator.getSupported();
    expect(supported.kinds).toContainEqual(expect.objectContaining({ x402Version: 2, scheme: "exact", network: MONAD_TESTNET }));
    expect(Object.values(supported.signers).flat()).toContain(account.address);
    expect(node.calls).toHaveLength(0); // construction touches nothing
  });

  it("verifies a genuine buyer payload, simulating the transfer on-chain first", async () => {
    const node = monadNode();
    const log = vi.fn();
    const facilitator = buildLocalFacilitator({
      network: MONAD_TESTNET,
      account: accountFromKey(generatePrivateKey()),
      transport: node.transport,
      log,
    });
    const reqs = requirements();
    const { payer, payload } = await buyerPayload(reqs);
    const result = await facilitator.verify(payload, reqs);
    expect(result).toMatchObject({ isValid: true, payer: payer.address });
    expect(log).not.toHaveBeenCalled();
    expect(node.calls.some((c) => c.method === "eth_call")).toBe(true);
  });

  it("logs a rejection with its reason at the point of decision", async () => {
    const node = monadNode();
    const log = vi.fn();
    const facilitator = buildLocalFacilitator({
      network: MONAD_TESTNET,
      account: accountFromKey(generatePrivateKey()),
      transport: node.transport,
      log,
    });
    const { payload } = await buyerPayload(requirements());
    // The server now claims a different payee than the buyer signed for.
    const tampered = requirements({ payTo: "0x00000000219ab540356cBB839Cbe05303d7705Fa" });
    const result = await facilitator.verify(payload, tampered);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/recipient/i);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[x402\] payment rejected: .*payTo=0x00000000219ab540356cBB839Cbe05303d7705Fa/);
  });

  it("settles by sending transferWithAuthorization with gas = estimate + headroom", async () => {
    const node = monadNode();
    const log = vi.fn();
    const account = accountFromKey(generatePrivateKey());
    const facilitator = buildLocalFacilitator({ network: MONAD_TESTNET, account, transport: node.transport, log });
    const reqs = requirements();
    const { payer, payload } = await buyerPayload(reqs);

    const result = await facilitator.settle(payload, reqs);
    expect(log).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, network: MONAD_TESTNET, payer: payer.address });
    expect(node.sent).toHaveLength(1);
    expect(result.transaction).toBe(keccak256(node.sent[0]!));

    const tx = parseTransaction(node.sent[0]!);
    expect(tx.chainId).toBe(10143);
    expect(getAddress(tx.to!)).toBe(USDC);
    // Monad bills the gas limit: exactly estimate × 1.15, never a padded constant.
    expect(tx.gas).toBe(withGasHeadroom(ESTIMATE));
    expect(tx.nonce).toBe(5);
    const { functionName, args } = decodeFunctionData({ abi: eip3009ABI, data: tx.data! });
    expect(functionName).toBe("transferWithAuthorization");
    const [from, to, value] = args as unknown as [string, string, bigint];
    expect(getAddress(from)).toBe(payer.address);
    expect(getAddress(to)).toBe(PROVIDER); // straight to the provider
    expect(value).toBe(10_000n);
  });

  it("reports and logs a settlement that fails verification, without sending anything", async () => {
    const node = monadNode();
    const log = vi.fn();
    const facilitator = buildLocalFacilitator({
      network: MONAD_TESTNET,
      account: accountFromKey(generatePrivateKey()),
      transport: node.transport,
      log,
    });
    const { payload } = await buyerPayload(requirements());
    const result = await facilitator.settle(payload, requirements({ amount: "20000" }));
    expect(result.success).toBe(false);
    expect(node.sent).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[x402\] settlement failed: /));
  });

  it("uses a bounded confirmation timeout", () => {
    expect(SETTLEMENT_CONFIRMATION_TIMEOUT_MS).toBe(30_000);
  });
});

describe("buildFacilitator", () => {
  it("runs in-process by default and reports the gas-paying EOA", () => {
    const account = accountFromKey(generatePrivateKey());
    const choice = buildFacilitator({ network: MONAD_TESTNET, account });
    expect(choice).toMatchObject({ mode: "self", address: account.address, url: null });
    expect(choice.description).toMatch(/self-hosted/);
    expect(buildFacilitator({ mode: "  ", network: MONAD_TESTNET, account }).mode).toBe("self");
  });

  it("refuses self-hosting without a key, naming both fixes", () => {
    expect(() => buildFacilitator({ mode: "self", network: MONAD_TESTNET })).toThrow(/XORV_FACILITATOR_KEY.*XORV_FACILITATOR=hosted/);
    expect(() => buildFacilitator({ network: MONAD_TESTNET, account: null })).toThrow(/needs a funded key/);
  });

  it("maps `hosted` to the facilitator Monad's docs use", () => {
    const choice = buildFacilitator({ mode: "hosted", network: MONAD_TESTNET });
    expect(choice).toMatchObject({ mode: "hosted", address: null, url: MONAD_FACILITATOR_URL });
    expect(choice.description).toBe(`hosted (${MONAD_FACILITATOR_URL})`);
  });

  it("accepts any other facilitator by URL", () => {
    const choice = buildFacilitator({ mode: "https://facilitator.example/x402", network: MONAD_TESTNET });
    expect(choice).toMatchObject({ mode: "hosted", url: "https://facilitator.example/x402" });
  });

  it("refuses a mode that is neither self, hosted nor a URL", () => {
    expect(() => buildFacilitator({ mode: "x402.org", network: MONAD_TESTNET })).toThrow(/must be "self", "hosted" or an http/);
  });

  it("refuses an unsupported network", () => {
    expect(() => buildFacilitator({ mode: "hosted", network: "hedera:testnet" })).toThrow(/unsupported network/);
  });

  it("builds a hosted client pointed at the URL", () => {
    const hosted = buildHostedFacilitator(MONAD_FACILITATOR_URL) as unknown as { url: string };
    expect(hosted.url).toBe(MONAD_FACILITATOR_URL);
  });
});

describe("rejection logging", () => {
  it("formats every detail needed to act on a rejection", () => {
    expect(
      formatPaymentRejection(
        { invalidReason: "invalid_exact_evm_insufficient_balance", invalidMessage: "balance 0", payer: "0xabc" },
        { network: MONAD_TESTNET, asset: USDC, amount: "10000", payTo: PROVIDER },
      ),
    ).toBe(
      `[x402] payment rejected: invalid_exact_evm_insufficient_balance — balance 0 (payer=0xabc, network=${MONAD_TESTNET}, asset=${USDC}, amount=10000, payTo=${PROVIDER})`,
    );
    expect(formatSettlementFailure({ errorReason: "transaction_failed", transaction: "0xdead" })).toBe(
      "[x402] settlement failed: transaction_failed (payer=?, tx=0xdead)",
    );
  });

  it("hooks onAfterVerify, where a hosted facilitator's isValid:false actually arrives", async () => {
    type Hook = (ctx: never) => Promise<unknown>;
    const hooks: Record<string, Hook> = {};
    const server = {
      onAfterVerify: (h: Hook) => ((hooks.afterVerify = h), server),
      onVerifyFailure: (h: Hook) => ((hooks.verifyFailure = h), server),
      onSettleFailure: (h: Hook) => ((hooks.settleFailure = h), server),
    };
    const log = vi.fn();
    logPaymentRejections(server as never, log);
    const reqs = requirements();

    await hooks.afterVerify!({ result: { isValid: true }, requirements: reqs } as never);
    expect(log).not.toHaveBeenCalled();
    await hooks.afterVerify!({ result: { isValid: false, invalidReason: "invalid_signature" }, requirements: reqs } as never);
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/payment rejected: invalid_signature/));
    await hooks.verifyFailure!({ error: new Error("facilitator 503"), requirements: reqs } as never);
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/verify errored: facilitator 503/));
    await hooks.settleFailure!({ error: new Error("reverted"), requirements: reqs } as never);
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/settle errored: reverted/));
  });
});
