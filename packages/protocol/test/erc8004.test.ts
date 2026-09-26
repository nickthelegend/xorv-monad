/**
 * ERC-8004 files are read by strangers — 8004scan, other marketplaces, anyone
 * auditing a rating — so their shape is protocol, and a feedback file's
 * keccak256 is committed on-chain, so its bytes must be reproducible.
 */

import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, getAddress, keccak256, stringToBytes } from "viem";
import { MONAD_MAINNET, MONAD_TESTNET } from "../src/chains.js";
import {
  ERC8004_REGISTRATION_TYPE,
  IDENTITY_ABI,
  REPUTATION_ABI,
  agentOwner,
  agentRegistryId,
  buildAgentRegistration,
  buildFeedbackFile,
  feedbackFileHash,
  getAgentWallet,
  reputationSummary,
  serializeFeedbackFile,
} from "../src/erc8004.js";
import { publicClientFor } from "../src/evm.js";
import { fakeRpc } from "./support/fake-rpc.js";

const LEDGER = "0x1234567890AbcdEF1234567890aBcdef12345678";
const BUYER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const WALLET = "0x00000000219ab540356cBB839Cbe05303d7705Fa";

describe("agentRegistryId", () => {
  it("is eip155:<chainId>:<identity registry>", () => {
    expect(agentRegistryId(MONAD_TESTNET)).toBe("eip155:10143:0x8004A818BFB912233c491871b3d84c89A494BD9e");
    expect(agentRegistryId(MONAD_MAINNET)).toBe("eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
  });
});

describe("buildAgentRegistration", () => {
  const services = [
    { name: "web", endpoint: "https://app.xorv.xyz/providers/prv_1" },
    { name: "xorv-jobs", endpoint: "https://broker.xorv.xyz/api/quotes", version: "1" },
  ];

  it("produces a registration-v1 file that declares x402 and reputation trust", () => {
    const file = buildAgentRegistration({
      network: MONAD_TESTNET,
      agentId: "42",
      name: "xorv-node-7f3a (Claude Code)",
      description: "Rents idle Claude Code capacity; pay per job in USDC via x402 on Monad.",
      image: "https://app.xorv.xyz/nodes/7f3a.png",
      services,
    });
    expect(file).toEqual({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "xorv-node-7f3a (Claude Code)",
      description: "Rents idle Claude Code capacity; pay per job in USDC via x402 on Monad.",
      image: "https://app.xorv.xyz/nodes/7f3a.png",
      services: [
        { name: "web", endpoint: "https://app.xorv.xyz/providers/prv_1" },
        { name: "xorv-jobs", endpoint: "https://broker.xorv.xyz/api/quotes", version: "1" },
      ],
      x402Support: true,
      active: true,
      registrations: [{ agentId: 42, agentRegistry: "eip155:10143:0x8004A818BFB912233c491871b3d84c89A494BD9e" }],
      supportedTrust: ["reputation"],
    });
    expect(file.type).toBe(ERC8004_REGISTRATION_TYPE);
  });

  it("has no registrations until the agent id is known, and no image unless given", () => {
    const file = buildAgentRegistration({ network: MONAD_MAINNET, name: "n", description: "d", services: [], active: false });
    expect(file.registrations).toEqual([]);
    expect(file.active).toBe(false);
    expect("image" in file).toBe(false);
  });

  it("accepts numeric and bigint ids", () => {
    const file = buildAgentRegistration({ network: MONAD_MAINNET, agentId: 10_259n, name: "n", description: "d", services: [] });
    expect(file.registrations[0]!.agentId).toBe(10_259);
  });
});

describe("buildFeedbackFile", () => {
  const base = {
    network: MONAD_TESTNET,
    agentId: "42",
    clientAddress: LEDGER.toLowerCase(),
    createdAt: "2026-10-05T12:00:00Z",
    value: 92,
    tag1: "starred",
    tag2: "claude-code",
    endpoint: "https://broker.xorv.xyz/api/jobs",
  };

  it("carries the spec's MUST fields plus an x402 proofOfPayment", () => {
    const file = buildFeedbackFile({
      ...base,
      payment: {
        from: BUYER.toLowerCase(),
        to: WALLET,
        txHash: `0x${"ab".repeat(32)}`,
        amount: 250_000n,
      },
      reasoning: "Completed the task; tests passed",
      mcpTool: "xorv_run_job",
      xorv: { jobIdHash: "0x01" },
    });
    expect(file).toEqual({
      agentRegistry: "eip155:10143:0x8004A818BFB912233c491871b3d84c89A494BD9e",
      agentId: 42,
      clientAddress: `eip155:10143:${LEDGER}`,
      createdAt: "2026-10-05T12:00:00.000Z",
      value: 92,
      valueDecimals: 0,
      tag1: "starred",
      tag2: "claude-code",
      endpoint: "https://broker.xorv.xyz/api/jobs",
      proofOfPayment: {
        fromAddress: BUYER,
        toAddress: WALLET,
        chainId: "10143",
        txHash: `0x${"ab".repeat(32)}`,
        amount: "250000",
        currency: "USDC",
        protocol: "x402",
      },
      reasoning: "Completed the task; tests passed",
      mcp: { tool: "xorv_run_job" },
      xorv: { jobIdHash: "0x01" },
    });
  });

  it("omits optional fields that were not provided", () => {
    const file = buildFeedbackFile({ network: MONAD_MAINNET, agentId: 1, clientAddress: LEDGER, value: 0, tag1: "xorv-job" });
    expect(Object.keys(file).sort()).toEqual(
      ["agentId", "agentRegistry", "clientAddress", "createdAt", "tag1", "value", "valueDecimals"].sort(),
    );
    expect(file.clientAddress).toBe(`eip155:143:${LEDGER}`);
    expect(Date.parse(file.createdAt)).not.toBeNaN();
  });

  it("refuses non-integer values and invalid dates", () => {
    expect(() => buildFeedbackFile({ ...base, value: 92.5 })).toThrow(/integer/);
    expect(() => buildFeedbackFile({ ...base, createdAt: "not a date" })).toThrow(/createdAt/);
  });

  it("serializes canonically, so the on-chain hash matches the served bytes however the object was built", () => {
    const file = buildFeedbackFile(base);
    const reordered = Object.fromEntries(Object.entries(file).reverse()) as typeof file;
    expect(serializeFeedbackFile(reordered)).toBe(serializeFeedbackFile(file));
    const json = serializeFeedbackFile(file);
    expect(json.startsWith('{"agentId":42,"agentRegistry":')).toBe(true);
    expect(feedbackFileHash(file)).toBe(keccak256(stringToBytes(json)));
    expect(feedbackFileHash({ ...file, value: 91 })).not.toBe(feedbackFileHash(file));
  });
});

describe("registry reads", () => {
  function identityChain(wallet: string, owner: string) {
    return fakeRpc({
      eth_call: ([tx]) => {
        const call = tx as { to: string; data: `0x${string}` };
        expect(getAddress(call.to)).toBe("0x8004A818BFB912233c491871b3d84c89A494BD9e");
        const { functionName, args } = decodeFunctionData({ abi: IDENTITY_ABI, data: call.data });
        expect(args).toEqual([42n]);
        const value = functionName === "getAgentWallet" ? wallet : owner;
        return encodeAbiParameters([{ type: "address" }], [value as `0x${string}`]);
      },
    });
  }

  it("reads an agent's wallet and owner from the Identity Registry", async () => {
    const { transport } = identityChain(WALLET.toLowerCase(), BUYER.toLowerCase());
    const client = publicClientFor(MONAD_TESTNET, { transport });
    expect(await getAgentWallet(MONAD_TESTNET, 42, { client })).toBe(WALLET);
    expect(await agentOwner(MONAD_TESTNET, "42", { client })).toBe(BUYER);
  });

  it("reports a cleared wallet (zero address, e.g. after an NFT transfer) as null", async () => {
    const { transport } = identityChain("0x0000000000000000000000000000000000000000", BUYER);
    const client = publicClientFor(MONAD_TESTNET, { transport });
    expect(await getAgentWallet(MONAD_TESTNET, 42n, { client })).toBeNull();
  });

  it("summarizes reputation from the listed clients, filtered by tag", async () => {
    const { transport, calls } = fakeRpc({
      eth_call: ([tx]) => {
        const call = tx as { to: string; data: `0x${string}` };
        expect(getAddress(call.to)).toBe("0x8004B663056A597Dffe9eCcC1965A193B7388713");
        const { functionName, args } = decodeFunctionData({ abi: REPUTATION_ABI, data: call.data });
        expect(functionName).toBe("getSummary");
        expect(args).toEqual([42n, [LEDGER], "starred", ""]);
        return encodeAbiParameters(
          [{ type: "uint64" }, { type: "int128" }, { type: "uint8" }],
          [3n, 8_733n, 2],
        );
      },
    });
    const client = publicClientFor(MONAD_TESTNET, { transport });
    const summary = await reputationSummary(MONAD_TESTNET, 42, [LEDGER.toLowerCase()], { client, tag1: "starred" });
    expect(summary).toEqual({ count: 3, summaryValue: "8733", summaryValueDecimals: 2, average: 87.33 });
    expect(calls).toHaveLength(1);
  });

  it("short-circuits an empty client list instead of calling getSummary (which reverts on it)", async () => {
    const { transport, calls } = fakeRpc({});
    const client = publicClientFor(MONAD_TESTNET, { transport });
    expect(await reputationSummary(MONAD_TESTNET, 42, [], { client })).toEqual({
      count: 0,
      summaryValue: "0",
      summaryValueDecimals: 0,
      average: null,
    });
    expect(calls).toHaveLength(0);
  });

  it("uses the v2.0.0 feedback ABI (int128 value + uint8 decimals, no feedbackAuth)", () => {
    const give = REPUTATION_ABI.find((i) => i.type === "function" && i.name === "giveFeedback")!;
    expect(give.inputs.map((i) => i.type)).toEqual([
      "uint256", "int128", "uint8", "string", "string", "string", "string", "bytes32",
    ]);
  });
});
