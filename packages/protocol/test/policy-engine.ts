/**
 * Privy's policy engine, re-implemented for tests by its documented rules: all
 * conditions in a rule must hold, any DENY wins, and no matching rule is a
 * DENY. It lets the tests check `operatorPolicy` against real calldata and a
 * real chain without a Privy app. It is not used by the product.
 */
import { type AbiFunction, type Hex, decodeFunctionData } from "viem";
import type { PolicyCondition, PolicyRule, PrivyPolicy } from "../src/privy.js";


export interface PolicyTx {
  chainId: number;
  to: string | null | undefined;
  value?: bigint | string | null;
  data?: Hex | null;
}

export type PolicyVerdict = { allowed: true; rule: string } | { allowed: false; reason: string };

function asBig(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
  return null;
}

function compare(actual: unknown, operator: PolicyCondition["operator"], expected: string | string[]): boolean {
  if (actual === undefined || actual === null) return false;
  if (operator === "in") {
    return (Array.isArray(expected) ? expected : [expected]).some((e) => compare(actual, "eq", e));
  }
  if (Array.isArray(expected)) return false;
  const a = asBig(actual);
  const e = asBig(expected);
  if (a !== null && e !== null && !(typeof actual === "string" && actual.length === 42)) {
    switch (operator) {
      case "eq": return a === e;
      case "gt": return a > e;
      case "gte": return a >= e;
      case "lt": return a < e;
      case "lte": return a <= e;
    }
  }
  // Addresses and names: equality only, case-insensitive for hex.
  return operator === "eq" && String(actual).toLowerCase() === expected.toLowerCase();
}

function conditionHolds(c: PolicyCondition, tx: PolicyTx): boolean {
  if (c.field_source === "ethereum_transaction") {
    const actual = c.field === "chain_id" ? tx.chainId : c.field === "to" ? tx.to : c.field === "value" ? (tx.value ?? 0n) : undefined;
    return compare(actual, c.operator, c.value);
  }
  if (!tx.data || !c.abi) return false;
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: c.abi, data: tx.data }) as typeof decoded;
  } catch {
    return false; // calldata this ABI doesn't describe can't satisfy it
  }
  if (c.field === "function_name") return compare(decoded.functionName, c.operator, c.value);
  const [fn, param] = c.field.split(".");
  if (fn !== decoded.functionName || !param) return false;
  const inputs = (c.abi.find((i) => i.type === "function" && i.name === fn) as AbiFunction | undefined)?.inputs ?? [];
  const at = inputs.findIndex((i) => i.name === param);
  return at >= 0 && compare(decoded.args[at], c.operator, c.value);
}

/** Privy's documented evaluation: ANDed conditions, any DENY wins, no match is a DENY. */
export function evaluatePolicy(policy: PrivyPolicy, method: PolicyRule["method"], tx: PolicyTx): PolicyVerdict {
  const matched = policy.rules.filter((r) => r.method === method && r.conditions.every((c) => conditionHolds(c, tx)));
  const deny = matched.find((r) => r.action === "DENY");
  if (deny) return { allowed: false, reason: `denied by rule "${deny.name}"` };
  const allow = matched.find((r) => r.action === "ALLOW");
  if (allow) return { allowed: true, rule: allow.name };
  return { allowed: false, reason: `no rule in policy "${policy.name}" allows it` };
}

export class PolicyDeniedError extends Error {
  constructor(readonly verdict: Extract<PolicyVerdict, { allowed: false }>, readonly tx: PolicyTx) {
    super(`Policy engine (test) refused a transaction to ${tx.to ?? "nowhere"}: ${verdict.reason}`);
    this.name = "PolicyDeniedError";
  }
}

