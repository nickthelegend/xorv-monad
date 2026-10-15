/**
 * ERC-8004 identity and the payout wallet, through viem's real encode/decode
 * path against a scripted RPC — no chain, no network.
 *
 * Registration is the one thing in Xorv a provider pays gas for, and the one
 * place a wrong answer is permanent: an identity bound to the wrong address,
 * or an agent id misread from the receipt, is a node whose receipts never
 * bind. So the tests follow the transaction all the way: the calldata that is
 * signed, the gas budget checked against the balance, and the id read back
 * from the `Registered` event.
 */

import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  zeroAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { IDENTITY_ABI } from "@xorv/protocol";
import { stripAnsi as stripAnsiSafe } from "../src/ui.js";
import { fakeRpc, hex } from "./support/fake-rpc.js";
import {
  agentUri,
  checkRegisterGas,
  isLocalUri,
  readIdentity,
  registerAgent,
  uriExposesNodeId,
} from "../src/commands/identity.js";
import { walletRows } from "../src/commands/wallet.js";

const NETWORK = "eip155:10143";
const IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(KEY);
const PAYOUT = account.address;
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
/** providerIdFor("node1") — the CLI keys the URI by the public provider id. */
const URI = "https://broker.example.test/agents/prv_VBvElEwGrAJJ.json";

const ESTIMATE = 246_000n;
const BASE_FEE = 100_000_000_000n; // 100 gwei
const TIP = 2_000_000_000n;

const block = () => ({
  number: hex(1_000),
  hash: keccak256("0x01"),
  parentHash: keccak256("0x00"),
  timestamp: hex(1_790_000_000),
  baseFeePerGas: hex(BASE_FEE),
  gasLimit: hex(150_000_000),
  gasUsed: "0x0",
  transactions: [],
  uncles: [],
  logsBloom: `0x${"0".repeat(512)}`,
  extraData: "0x",
  miner: zeroAddress,
  difficulty: "0x0",
  size: "0x0",
  nonce: "0x0000000000000000",
});

/** A node that accepts register(agentURI) and mints agent `agentId` to the sender. */
function chain(opts: { balance?: bigint; agentId?: bigint; revert?: boolean } = {}) {
  const sent: Hex[] = [];
  const rpc = fakeRpc({
    eth_chainId: () => hex(10143),
    eth_blockNumber: () => hex(1_001),
    eth_getBalance: () => hex(opts.balance ?? 10n ** 18n),
    eth_estimateGas: () => hex(ESTIMATE),
    eth_getTransactionCount: () => hex(0),
    eth_maxPriorityFeePerGas: () => hex(TIP),
    eth_gasPrice: () => hex(BASE_FEE + TIP),
    eth_getBlockByNumber: () => block(),
    eth_sendRawTransaction: ([raw]) => {
      sent.push(raw as Hex);
      return keccak256(raw as Hex);
    },
    eth_getTransactionReceipt: ([hash]) => {
      const raw = sent.find((tx) => keccak256(tx) === hash);
      if (!raw) return null;
      const tx = parseTransaction(raw);
      const { args } = decodeFunctionData({ abi: IDENTITY_ABI, data: tx.data! });
      const uri = (args as readonly [string])[0];
      return {
        transactionHash: hash,
        transactionIndex: "0x0",
        blockHash: keccak256("0x01"),
        blockNumber: hex(1_001),
        from: PAYOUT.toLowerCase(),
        to: IDENTITY.toLowerCase(),
        cumulativeGasUsed: hex(ESTIMATE),
        gasUsed: hex(ESTIMATE),
        effectiveGasPrice: hex(BASE_FEE + TIP),
        contractAddress: null,
        logsBloom: `0x${"0".repeat(512)}`,
        status: opts.revert ? "0x0" : "0x1",
        type: "0x2",
        logs: opts.revert
          ? []
          : [
              {
                address: IDENTITY.toLowerCase(),
                topics: encodeEventTopics({
                  abi: IDENTITY_ABI,
                  eventName: "Registered",
                  args: { agentId: opts.agentId ?? 7n, owner: PAYOUT },
                }),
                data: encodeAbiParameters([{ type: "string" }], [uri]),
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

/** A node that answers the registry's views for one agent. */
function registryReads(state: { owner: string; wallet: string; uri?: string }) {
  return fakeRpc({
    eth_chainId: () => hex(10143),
    eth_call: ([call]) => {
      const { to, data } = call as { to: string; data: Hex };
      expect(to.toLowerCase()).toBe(IDENTITY.toLowerCase());
      const { functionName } = decodeFunctionData({ abi: IDENTITY_ABI, data });
      if (functionName === "ownerOf") return encodeFunctionResult({ abi: IDENTITY_ABI, functionName, result: state.owner as Hex });
      if (functionName === "getAgentWallet") return encodeFunctionResult({ abi: IDENTITY_ABI, functionName, result: state.wallet as Hex });
      if (functionName === "tokenURI") return encodeFunctionResult({ abi: IDENTITY_ABI, functionName, result: state.uri ?? URI });
      throw new Error(`unexpected call ${functionName}`);
    },
  });
}

describe("agentURI", () => {
  it("points at the broker's registration file, keyed by the provider id — never the node id", () => {
    // The node id reclaims this node's broker slot; an agent URI is public
    // forever, so only the one-way provider id may appear in it.
    expect(agentUri("https://broker.example.test/", "node1")).toBe(URI);
    expect(agentUri("https://broker.example.test/", "node1")).not.toContain("node1");
  });

  it("recognises an older agent URI that published the node id", () => {
    expect(uriExposesNodeId("https://broker.example.test/agents/node1.json", "node1")).toBe(true);
    expect(uriExposesNodeId(URI, "node1")).toBe(false);
    expect(uriExposesNodeId(null, "node1")).toBe(false);
  });

  it("flags a URI nobody else can resolve before it goes on-chain for good", () => {
    expect(isLocalUri("http://localhost:8402/agents/n.json")).toBe(true);
    expect(isLocalUri("http://127.0.0.1:8402/agents/n.json")).toBe(true);
    expect(isLocalUri(URI)).toBe(false);
  });
});

describe("checkRegisterGas", () => {
  it("budgets the padded gas limit at the max fee — Monad bills the limit", async () => {
    const node = chain({ balance: 10n ** 18n });
    const check = await checkRegisterGas({ network: NETWORK, account: PAYOUT, agentURI: URI, client: { transport: node.transport } });
    // 246k + 15% headroom, rounded up.
    expect(check.gas).toBe(282_900n);
    expect(check.costWei).toBeGreaterThan(check.gas * BASE_FEE);
    expect(check.enough).toBe(true);
    const estimate = node.calls.find((c) => c.method === "eth_estimateGas")!;
    const { functionName, args } = decodeFunctionData({ abi: IDENTITY_ABI, data: (estimate.params[0] as { data: Hex }).data });
    expect(functionName).toBe("register");
    expect(args).toEqual([URI]);
  });

  it("says when the balance cannot cover it", async () => {
    const node = chain({ balance: 1_000n });
    const check = await checkRegisterGas({ network: NETWORK, account: PAYOUT, agentURI: URI, client: { transport: node.transport } });
    expect(check.enough).toBe(false);
    expect(check.balanceWei).toBe(1_000n);
  });
});

describe("registerAgent", () => {
  it("sends register(agentURI) to the Identity Registry and reads the id from the Registered event", async () => {
    const node = chain({ agentId: 1234n });
    const { agentId, txHash } = await registerAgent({
      network: NETWORK,
      account,
      agentURI: URI,
      gas: 282_900n,
      client: { transport: node.transport },
    });
    expect(agentId).toBe("1234");
    expect(node.sent).toHaveLength(1);
    expect(txHash).toBe(keccak256(node.sent[0]!));

    const tx = parseTransaction(node.sent[0]!);
    expect(tx.to?.toLowerCase()).toBe(IDENTITY.toLowerCase());
    expect(tx.chainId).toBe(10143);
    expect(tx.gas).toBe(282_900n);
    const { functionName, args } = decodeFunctionData({ abi: IDENTITY_ABI, data: tx.data! });
    expect(functionName).toBe("register");
    expect(args).toEqual([URI]);
  });

  it("fails loudly when the transaction reverts, with the explorer link", async () => {
    const node = chain({ revert: true });
    await expect(
      registerAgent({ network: NETWORK, account, agentURI: URI, gas: 282_900n, client: { transport: node.transport } }),
    ).rejects.toThrow(/reverted.*testnet\.monadvision\.com\/tx\/0x/);
  });
});

describe("readIdentity", () => {
  it("confirms an agent whose wallet and owner are the payout address", async () => {
    const node = registryReads({ owner: PAYOUT, wallet: PAYOUT });
    const state = await readIdentity({ network: NETWORK, agentId: "7", payout: PAYOUT.toLowerCase(), client: { transport: node.transport } });
    expect(state).toMatchObject({ agentId: "7", owner: PAYOUT, wallet: PAYOUT, uri: URI, walletMatches: true, ownerMatches: true });
  });

  it("catches an agent wallet that is not the payout address", async () => {
    const node = registryReads({ owner: PAYOUT, wallet: OTHER });
    const state = await readIdentity({ network: NETWORK, agentId: "7", payout: PAYOUT, client: { transport: node.transport } });
    expect(state.walletMatches).toBe(false);
    expect(state.wallet).toBe(OTHER);
  });

  it("reads a cleared wallet (the NFT was transferred) as none, never as a match", async () => {
    const node = registryReads({ owner: OTHER, wallet: zeroAddress });
    const state = await readIdentity({ network: NETWORK, agentId: "7", payout: PAYOUT, client: { transport: node.transport } });
    expect(state.wallet).toBeNull();
    expect(state.walletMatches).toBe(false);
    expect(state.ownerMatches).toBe(false);
  });
});

describe("walletRows", () => {
  const rows = (over: Record<string, unknown> = {}, balances = { monWei: "0", usdcUnits: "2500000" }) =>
    Object.fromEntries(
      walletRows({ network: NETWORK, address: PAYOUT, privateKey: "", agentId: null, ...over }, balances).map(([k, v]) => [
        k,
        stripAnsiSafe(v),
      ]),
    );

  it("shows USDC as what jobs pay in, and zero MON as fine", () => {
    const r = rows();
    expect(r.usdc).toContain("$2.50");
    expect(r.mon).toMatch(/0 MON.*none needed to earn/);
  });

  it("links the address and the USDC token on the explorer, and the testnet faucets", () => {
    const r = rows();
    expect(r.explorer).toBe(`https://testnet.monadvision.com/address/${PAYOUT}`);
    expect(r.token).toContain("https://testnet.monadvision.com/token/0x534b2f3A21130d7a60830c2Df862319e593943A3");
    expect(r.faucets).toContain("https://faucet.circle.com");
    expect(r.faucets).toContain("https://faucet.monad.xyz");
  });

  it("says plainly when there is no key on the machine", () => {
    expect(rows().key).toMatch(/address-only/);
    expect(rows({ privateKey: KEY }).key).toMatch(/stored locally/);
  });

  it("shows no faucets on mainnet — there are none", () => {
    const r = Object.fromEntries(
      walletRows({ network: "eip155:143", address: PAYOUT, privateKey: "", agentId: "9" }, { monWei: "0", usdcUnits: "0" }),
    );
    expect(r.faucets).toBeUndefined();
    expect(stripAnsiSafe(r.identity!)).toBe("agent #9");
  });
});
