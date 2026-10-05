import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import {
  evaluatePolicy,
  operatorPolicy,
  privySender,
  signerFromEnv,
  type PrivyApi,
  type PrivySignerEnv,
} from "../src/privy.js";
import { XORV_ESCROW_ABI } from "../src/xorv-escrow.abi.js";
import { XORV_LOG_ABI } from "../src/xorv-log.abi.js";

const NET = "eip155:10143";
const ESCROW = "0x00000000000000000000000000000000000E5c20";
const LOG = "0x0000000000000000000000000000000000001060";
const TOKEN = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const policy = operatorPolicy({ network: NET, escrow: ESCROW, log: LOG, tokens: [TOKEN] });
const JOB = `0x${"11".repeat(32)}` as Hex;

const release = encodeFunctionData({ abi: XORV_ESCROW_ABI, functionName: "release", args: [JOB, JOB] });
const pause = encodeFunctionData({ abi: XORV_ESCROW_ABI, functionName: "pause", args: [] });
const append = encodeFunctionData({ abi: XORV_LOG_ABI, functionName: "append", args: [3, JOB, "{}"] });
const transfer = encodeFunctionData({
  abi: parseAbi(["function transfer(address to, uint256 amount)"]),
  functionName: "transfer",
  args: ["0x000000000000000000000000000000000000dEaD", 1n],
});

describe("operatorPolicy", () => {
  it("is one ALLOW rule per call the broker makes, in Privy's documented format", () => {
    expect(policy).toMatchObject({ version: "1.0", chain_type: "ethereum", name: "xorv-operator-10143" });
    expect(policy.rules.map((r) => r.name)).toEqual([
      "escrow.fund on 10143",
      "escrow.release on 10143",
      "escrow.refund on 10143",
      "escrow.reassign on 10143",
      "escrow.cancel on 10143",
      "log.append on 10143",
      "token.transferWithAuthorization on 10143",
    ]);
    for (const rule of policy.rules) {
      expect(rule).toMatchObject({ method: "eth_sendTransaction", action: "ALLOW" });
      expect(rule.conditions.map((c) => `${c.field_source}:${c.field}:${c.operator}`)).toEqual([
        "ethereum_transaction:chain_id:eq",
        "ethereum_transaction:to:eq",
        "ethereum_transaction:value:lte",
        "ethereum_calldata:function_name:eq",
      ]);
      // Calldata conditions must carry an ABI, and only the allowed function's.
      const abi = rule.conditions[3]!.abi!;
      expect(new Set(abi.map((i) => ("name" in i ? i.name : "")))).toEqual(new Set([rule.conditions[3]!.value]));
    }
  });
});

describe("evaluatePolicy (the mock's stand-in for Privy's engine)", () => {
  const tx = (to: string, data: Hex | null, extra: { value?: bigint; chainId?: number } = {}) => ({
    chainId: extra.chainId ?? 10143,
    to,
    data,
    value: extra.value ?? 0n,
  });

  it("allows the broker's own calls", () => {
    expect(evaluatePolicy(policy, "eth_sendTransaction", tx(ESCROW, release))).toEqual({ allowed: true, rule: "escrow.release on 10143" });
    expect(evaluatePolicy(policy, "eth_sendTransaction", tx(LOG.toLowerCase(), append))).toEqual({ allowed: true, rule: "log.append on 10143" });
  });

  it("denies the escrow's admin functions, even though the operator may own it", () => {
    expect(evaluatePolicy(policy, "eth_sendTransaction", tx(ESCROW, pause)).allowed).toBe(false);
  });

  it("denies moving MON, other chains, other contracts and other token functions", () => {
    expect(evaluatePolicy(policy, "eth_sendTransaction", tx(ESCROW, release, { value: 1n })).allowed).toBe(false);
    expect(evaluatePolicy(policy, "eth_sendTransaction", tx("0x000000000000000000000000000000000000dEaD", null, { value: 10n ** 18n })).allowed).toBe(false);
    expect(evaluatePolicy(policy, "eth_sendTransaction", tx(ESCROW, release, { chainId: 143 })).allowed).toBe(false);
    expect(evaluatePolicy(policy, "eth_sendTransaction", tx("0x000000000000000000000000000000000000bEEF", release)).allowed).toBe(false);
    expect(evaluatePolicy(policy, "eth_sendTransaction", tx(TOKEN, transfer)).allowed).toBe(false);
    expect(evaluatePolicy(policy, "eth_signTransaction", tx(ESCROW, release)).allowed).toBe(false);
  });

  it("lets a DENY rule win over an ALLOW", () => {
    const withDeny = {
      ...policy,
      rules: [
        ...policy.rules,
        {
          name: "freeze",
          method: "eth_sendTransaction" as const,
          action: "DENY" as const,
          conditions: [{ field_source: "ethereum_transaction" as const, field: "chain_id", operator: "eq" as const, value: "10143" }],
        },
      ],
    };
    expect(evaluatePolicy(withDeny, "eth_sendTransaction", tx(ESCROW, release))).toEqual({ allowed: false, reason: 'denied by rule "freeze"' });
  });

  it("compares calldata parameters numerically, as Privy's hex values are written", () => {
    const capped = {
      ...policy,
      rules: [
        {
          name: "small appends only",
          method: "eth_sendTransaction" as const,
          action: "ALLOW" as const,
          conditions: [{ field_source: "ethereum_calldata" as const, field: "append.kind", operator: "lte" as const, value: "0x2", abi: policy.rules[5]!.conditions[3]!.abi }],
        },
      ],
    };
    const kind = (k: number) => encodeFunctionData({ abi: XORV_LOG_ABI, functionName: "append", args: [k, JOB, ""] });
    expect(evaluatePolicy(capped, "eth_sendTransaction", tx(LOG, kind(2))).allowed).toBe(true);
    expect(evaluatePolicy(capped, "eth_sendTransaction", tx(LOG, kind(3))).allowed).toBe(false);
  });
});

describe("signerFromEnv", () => {
  it("defaults to the local key and names every missing Privy value at once", () => {
    expect(signerFromEnv({})).toEqual({ mode: "key" });
    expect(signerFromEnv({ XORV_SIGNER: "privy-mock" })).toEqual({ mode: "privy-mock" });
    expect(() => signerFromEnv({ XORV_SIGNER: "privy", PRIVY_APP_ID: "app" })).toThrow(
      /PRIVY_APP_SECRET, XORV_PRIVY_WALLET_ID, XORV_PRIVY_WALLET_ADDRESS/,
    );
    const s = signerFromEnv({
      XORV_SIGNER: "privy",
      PRIVY_APP_ID: "app",
      PRIVY_APP_SECRET: "secret",
      XORV_PRIVY_WALLET_ID: "w1",
      XORV_PRIVY_WALLET_ADDRESS: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
    });
    expect(s.privy).toMatchObject({ walletId: "w1", sponsor: true, walletAddress: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" });
  });
});

describe("privySender", () => {
  const env: PrivySignerEnv = {
    appId: "app",
    appSecret: "secret",
    walletId: "wallet_1",
    walletAddress: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    sponsor: true,
    authorizationKey: null,
  };

  it("sends a sponsored eth_sendTransaction on the network's CAIP-2 and returns the hash", async () => {
    const calls: unknown[] = [];
    const api: PrivyApi = {
      async sendTransaction(walletId, input) {
        calls.push({ walletId, input });
        return { hash: `0x${"ab".repeat(32)}` };
      },
      transactionHash: async () => ({ hash: null, status: "pending" }),
    };
    const hash = await privySender(NET, env, api)({ to: ESCROW, data: release });
    expect(hash).toBe(`0x${"ab".repeat(32)}`);
    expect(calls).toEqual([
      {
        walletId: "wallet_1",
        input: {
          caip2: "eip155:10143",
          params: { transaction: { to: ESCROW, data: release, value: "0x0", chain_id: 10143 } },
          sponsor: true,
        },
      },
    ]);
  });

  it("waits on Privy's transaction record when a sponsored send has no hash yet", async () => {
    let polls = 0;
    const api: PrivyApi = {
      sendTransaction: async () => ({ transaction_id: "tx_1" }),
      async transactionHash() {
        polls += 1;
        return polls < 3 ? { hash: null, status: "pending" } : { hash: `0x${"cd".repeat(32)}`, status: "broadcasted" };
      },
    };
    expect(await privySender(NET, env, api, { pollMs: 1 })({ to: ESCROW, data: release })).toBe(`0x${"cd".repeat(32)}`);
    expect(polls).toBe(3);
  });

  it("surfaces a failed sponsored transaction instead of waiting out the timeout", async () => {
    const api: PrivyApi = {
      sendTransaction: async () => ({ transaction_id: "tx_2" }),
      transactionHash: async () => ({ hash: null, status: "execution_reverted" }),
    };
    await expect(privySender(NET, env, api, { pollMs: 1 })({ to: ESCROW, data: release })).rejects.toThrow(/tx_2 ended execution_reverted/);
  });

  it("passes the authorization key when the wallet has an owner", async () => {
    let seen: unknown;
    const api: PrivyApi = {
      async sendTransaction(_w, input) {
        seen = input.authorization_context;
        return { hash: "0x01" };
      },
      transactionHash: async () => ({ hash: null, status: "pending" }),
    };
    await privySender(NET, { ...env, authorizationKey: "wallet-auth:abc" }, api)({ to: ESCROW, data: release });
    expect(seen).toEqual({ authorization_private_keys: ["wallet-auth:abc"] });
  });
});
