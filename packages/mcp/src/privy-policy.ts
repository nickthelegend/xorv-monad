/**
 * The Privy policy an Xorv agent wallet runs under.
 *
 * Privy evaluates a wallet's policy inside its signing enclave on every
 * request; a request no ALLOW rule matches is denied. So the policy is the
 * agent's real spending limit — not a promise the MCP server makes about its
 * own behaviour, but a rule enforced by the party holding the key.
 *
 * Two rules, both `eth_signTypedData_v4` (the only method the wallet ever
 * needs — it never sends a transaction, since the x402 facilitator pays gas):
 *
 *  1. **Pay for jobs.** An EIP-3009 `TransferWithAuthorization` whose domain
 *     is USDC on this chain (`chainId`, `verifyingContract`) and whose `value`
 *     is at most the cap. Optionally, only to an allow-list of payees.
 *  2. **Rate jobs** (when the XorvLedger address is known). Any typed data
 *     whose domain is the ledger on this chain — which in practice means a
 *     `Rating`, the only struct XorvLedger verifies. No money moves.
 *
 * What a typed-data policy cannot do is count: the cap is **per signature**.
 * Privy's rolling-window aggregations cover transaction signing, not EIP-712,
 * so the cumulative bound lives client-side (`XORV_SESSION_BUDGET_USD`, and
 * the per-job `XORV_MAX_PRICE`). README.md says so to anyone relying on it.
 *
 * Addresses are matched with `in` over both the checksummed and lowercase
 * spellings: the domain's `verifyingContract` arrives in whatever case the
 * 402 carried it, and a policy that silently failed to match on case would
 * deny every payment (or, written the other way, allow nothing it meant to).
 */

import { getAddress, parseUnits } from "viem";
import { formatUsdc, networkConfig, normalizeAddress } from "@xorv/protocol";

/** EIP-3009 `TransferWithAuthorization`, exactly as USDC and x402's exact scheme define it. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/** A policy condition in Privy's wire format (the subset used here). */
export type PolicyCondition =
  | {
      field_source: "ethereum_typed_data_domain";
      field: "chainId" | "verifyingContract";
      operator: "eq" | "in";
      value: string | string[];
    }
  | {
      field_source: "ethereum_typed_data_message";
      field: string;
      operator: "eq" | "in" | "lte";
      value: string | string[];
      typed_data: { primary_type: string; types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES };
    };

export interface PolicyRule {
  name: string;
  method: "eth_signTypedData_v4";
  action: "ALLOW";
  conditions: PolicyCondition[];
}

export interface AgentPolicy {
  chain_type: "ethereum";
  name: string;
  version: "1.0";
  rules: PolicyRule[];
}

/** Both spellings Privy might see an address in. */
function addressVariants(address: string): string[] {
  const checksummed = getAddress(address);
  return [...new Set([checksummed, checksummed.toLowerCase()])];
}

/** Parse "0.50" / "$1" into USDC smallest units, refusing zero, negatives and sub-unit precision. */
export function parseCapUsdc(raw: string, decimals = 6): bigint {
  const cleaned = raw.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) throw new Error(`--cap-usdc must be a dollar amount like 0.50, got "${raw}"`);
  const [, frac = ""] = cleaned.split(".");
  if (frac.length > decimals) throw new Error(`--cap-usdc has more than ${decimals} decimals: "${raw}"`);
  const units = parseUnits(cleaned, decimals);
  if (units <= 0n) throw new Error("--cap-usdc must be greater than zero");
  return units;
}

export function buildAgentPolicy(opts: {
  network: string;
  /** Per-signature cap, in USDC smallest units. */
  capUnits: bigint;
  /** Restrict payments to these payees (provider addresses). Empty/absent = any payee. */
  payTo?: string[];
  /** XorvLedger address; enables the rating rule. */
  ledger?: string | null;
  name?: string;
}): AgentPolicy {
  const cfg = networkConfig(opts.network);
  if (opts.capUnits <= 0n) throw new Error("the per-signature cap must be greater than zero");
  const chainId = String(cfg.chainId);
  const twa = { primary_type: "TransferWithAuthorization", types: TRANSFER_WITH_AUTHORIZATION_TYPES };

  const payConditions: PolicyCondition[] = [
    { field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: chainId },
    {
      field_source: "ethereum_typed_data_domain",
      field: "verifyingContract",
      operator: "in",
      value: addressVariants(cfg.usdc.address),
    },
    {
      field_source: "ethereum_typed_data_message",
      field: "value",
      operator: "lte",
      value: opts.capUnits.toString(),
      typed_data: twa,
    },
  ];
  const payees = (opts.payTo ?? []).map((a) => normalizeAddress(a));
  if (payees.length > 0) {
    payConditions.push({
      field_source: "ethereum_typed_data_message",
      field: "to",
      operator: "in",
      value: payees.flatMap(addressVariants),
      typed_data: twa,
    });
  }

  const rules: PolicyRule[] = [
    {
      // Short names: they show up in Privy's dashboard, and the conditions
      // below are the actual rule.
      name: `x402 USDC <= ${formatUsdc(opts.capUnits)} per payment`,
      method: "eth_signTypedData_v4",
      action: "ALLOW",
      conditions: payConditions,
    },
  ];
  if (opts.ledger) {
    rules.push({
      name: "XorvLedger job ratings",
      method: "eth_signTypedData_v4",
      action: "ALLOW",
      conditions: [
        { field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: chainId },
        {
          field_source: "ethereum_typed_data_domain",
          field: "verifyingContract",
          operator: "in",
          value: addressVariants(normalizeAddress(opts.ledger)),
        },
      ],
    });
  }

  return {
    chain_type: "ethereum",
    name: opts.name ?? `xorv-agent-${cfg.label}`,
    version: "1.0",
    rules,
  };
}
