/**
 * ERC-8004 ("Trustless Agents") — identity and reputation for provider nodes.
 *
 * Each provider can hold an agent identity: an ERC-721 on the canonical
 * Identity Registry whose `agentWallet` is the address it is paid at. That is
 * what lets XorvLedger refuse a receipt whose `payTo` is not the agent's
 * verified wallet, and what makes reputation *portable* — a provider's score
 * lives in the public Reputation Registry, readable by any marketplace, not in
 * our database.
 *
 * Reputation entries reach the registry two ways, both from addresses that are
 * never the agent's owner (the registry rejects self-feedback):
 *
 *  - a buyer's rating, relayed by XorvLedger (`clientAddress == ledger`), and
 *  - the Kimi verifier's score, submitted from the broker's verifier EOA.
 *
 * Each entry points at an off-chain feedback file whose keccak256 is committed
 * on-chain, carrying an x402 `proofOfPayment` — so "this rating came from
 * someone who actually paid" is checkable, not claimed.
 *
 * Deployed version on Monad is 2.0.0 (`int128 value` + `uint8 valueDecimals`,
 * no `feedbackAuth`). Libraries written against the older `uint8 score` ABI
 * will not match these contracts.
 */

import { zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { networkConfig } from "./chains.js";
import { publicClientFor, normalizeAddress } from "./evm.js";
import { canonicalJson } from "./json.js";
import { textHash } from "./ledger.js";

/** The minimal Identity Registry surface Xorv uses. */
export const IDENTITY_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "isAuthorizedOrOwner",
    stateMutability: "view",
    inputs: [
      { name: "spender", type: "address" },
      { name: "agentId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getVersion",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "event",
    name: "Registered",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "URIUpdated",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "newURI", type: "string", indexed: false },
      { name: "updatedBy", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

/** The minimal Reputation Registry surface Xorv uses. */
export const REPUTATION_ABI = [
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getSummary",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddresses", type: "address[]" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
    ],
    outputs: [
      { name: "count", type: "uint64" },
      { name: "summaryValue", type: "int128" },
      { name: "summaryValueDecimals", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "readFeedback",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddress", type: "address" },
      { name: "feedbackIndex", type: "uint64" },
    ],
    outputs: [
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "isRevoked", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getLastIndex",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddress", type: "address" },
    ],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "getClients",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "getIdentityRegistry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getVersion",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "event",
    name: "NewFeedback",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "clientAddress", type: "address", indexed: true },
      { name: "feedbackIndex", type: "uint64", indexed: false },
      { name: "value", type: "int128", indexed: false },
      { name: "valueDecimals", type: "uint8", indexed: false },
      { name: "indexedTag1", type: "string", indexed: true },
      { name: "tag1", type: "string", indexed: false },
      { name: "tag2", type: "string", indexed: false },
      { name: "endpoint", type: "string", indexed: false },
      { name: "feedbackURI", type: "string", indexed: false },
      { name: "feedbackHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "FeedbackRevoked",
    anonymous: false,
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "clientAddress", type: "address", indexed: true },
      { name: "feedbackIndex", type: "uint64", indexed: true },
    ],
  },
] as const;

/** The `type` every ERC-8004 registration file declares. */
export const ERC8004_REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

type AgentId = string | number | bigint;
type ReadOptions = { client?: PublicClient };

/**
 * The wallet an agent is paid at, or null when none is set.
 *
 * The registry clears `agentWallet` on every NFT transfer (the new owner must
 * re-verify), and a cleared wallet reads as the zero address. Surfacing that
 * as null makes "refuse to route to this agent" the obvious branch rather
 * than a zero address that happens to pass a truthiness check.
 */
export async function getAgentWallet(
  network: string,
  agentId: AgentId,
  opts: ReadOptions = {},
): Promise<Address | null> {
  const client = opts.client ?? publicClientFor(network);
  const wallet = await client.readContract({
    address: networkConfig(network).erc8004.identity,
    abi: IDENTITY_ABI,
    functionName: "getAgentWallet",
    args: [BigInt(agentId)],
  });
  return wallet === zeroAddress ? null : normalizeAddress(wallet);
}

/** The owner of an agent NFT. Reverts (throws) for an agent id that doesn't exist. */
export async function agentOwner(
  network: string,
  agentId: AgentId,
  opts: ReadOptions = {},
): Promise<Address> {
  const client = opts.client ?? publicClientFor(network);
  const owner = await client.readContract({
    address: networkConfig(network).erc8004.identity,
    abi: IDENTITY_ABI,
    functionName: "ownerOf",
    args: [BigInt(agentId)],
  });
  return normalizeAddress(owner);
}

/** The CAIP-style registry id used in registration and feedback files: `eip155:<chainId>:<identity>`. */
export function agentRegistryId(network: string): string {
  const cfg = networkConfig(network);
  return `eip155:${cfg.chainId}:${cfg.erc8004.identity}`;
}

/**
 * Agent ids are sequential from 0 (Monad mainnet is around 10k), so they fit a
 * JSON number — which is what the spec's examples use. Refuse the absurd case
 * rather than emit a silently rounded id.
 */
function agentIdNumber(agentId: AgentId): number {
  const value = typeof agentId === "number" ? agentId : Number(BigInt(agentId));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`agent id ${String(agentId)} is not representable as a JSON number`);
  }
  return value;
}

export interface AgentService {
  /** Free-form per the spec: "web", "MCP", "A2A", or Xorv's own "xorv-jobs". */
  name: string;
  endpoint: string;
  version?: string;
}

export interface AgentRegistrationFile {
  type: typeof ERC8004_REGISTRATION_TYPE;
  name: string;
  description: string;
  image?: string;
  services: AgentService[];
  x402Support: true;
  active: boolean;
  registrations: Array<{ agentId: number; agentRegistry: string }>;
  supportedTrust: ["reputation"];
}

/**
 * The registration file an agent's `agentURI` resolves to (the broker serves
 * it at `/agents/<providerId>.json`).
 *
 * `x402Support: true` because every Xorv provider is paid over x402;
 * `supportedTrust: ["reputation"]` because that is the trust model we
 * actually back — adding "crypto-economic" would claim staking we don't have.
 * `registrations` is empty until the agent id is known, which is the normal
 * state between serving the URI and seeing the `Registered` event.
 */
export function buildAgentRegistration(input: {
  network: string;
  agentId?: AgentId | null;
  name: string;
  description: string;
  image?: string | null;
  services: AgentService[];
  active?: boolean;
}): AgentRegistrationFile {
  const file: AgentRegistrationFile = {
    type: ERC8004_REGISTRATION_TYPE,
    name: input.name,
    description: input.description,
    services: input.services.map((s) => ({
      name: s.name,
      endpoint: s.endpoint,
      ...(s.version ? { version: s.version } : {}),
    })),
    x402Support: true,
    active: input.active ?? true,
    registrations:
      input.agentId === null || input.agentId === undefined || input.agentId === ""
        ? []
        : [{ agentId: agentIdNumber(input.agentId), agentRegistry: agentRegistryId(input.network) }],
    supportedTrust: ["reputation"],
  };
  if (input.image) file.image = input.image;
  return file;
}

export interface ProofOfPayment {
  fromAddress: string;
  toAddress: string;
  /** Decimal chain id as a string, per the spec's example. */
  chainId: string;
  txHash: string;
  /** Smallest units, integer string. */
  amount: string;
  currency: "USDC";
  protocol: "x402";
}

export interface FeedbackFile {
  agentRegistry: string;
  agentId: number;
  /** `eip155:<chainId>:<address that called giveFeedback>`. */
  clientAddress: string;
  /** ISO-8601. */
  createdAt: string;
  value: number;
  valueDecimals: number;
  tag1: string;
  tag2?: string;
  endpoint?: string;
  proofOfPayment?: ProofOfPayment;
  reasoning?: string;
  mcp?: { tool: string };
  /** Xorv's own provenance block: job id hash, request/result hashes, buyer signature. */
  xorv?: Record<string, unknown>;
}

/**
 * An ERC-8004 feedback file.
 *
 * `clientAddress` is whoever submits `giveFeedback`: the XorvLedger for a
 * relayed buyer rating, the verifier EOA for a Kimi score. `payment` becomes
 * the spec's `proofOfPayment` with the x402 extras 8004scan recommends
 * (`amount`, `currency`, `protocol`) — the strongest form is when `toAddress`
 * is the agent's verified wallet, which XorvLedger already guarantees.
 *
 * Serve it with `serializeFeedbackFile` and commit `feedbackFileHash`: both
 * use canonical JSON, so the hash a reader recomputes from the served bytes
 * matches the one on-chain regardless of how the object was built.
 */
export function buildFeedbackFile(input: {
  network: string;
  agentId: AgentId;
  clientAddress: string;
  createdAt?: Date | number | string;
  value: number;
  valueDecimals?: number;
  tag1: string;
  tag2?: string | null;
  endpoint?: string | null;
  payment?: { from: string; to: string; txHash: string; amount: string | bigint } | null;
  reasoning?: string | null;
  mcpTool?: string | null;
  xorv?: Record<string, unknown> | null;
}): FeedbackFile {
  const cfg = networkConfig(input.network);
  const createdAt =
    input.createdAt === undefined ? new Date() : new Date(input.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new Error(`invalid createdAt: ${String(input.createdAt)}`);
  if (!Number.isInteger(input.value)) throw new Error(`feedback value must be an integer, got ${input.value}`);

  const file: FeedbackFile = {
    agentRegistry: agentRegistryId(input.network),
    agentId: agentIdNumber(input.agentId),
    clientAddress: `eip155:${cfg.chainId}:${normalizeAddress(input.clientAddress)}`,
    createdAt: createdAt.toISOString(),
    value: input.value,
    valueDecimals: input.valueDecimals ?? 0,
    tag1: input.tag1,
  };
  if (input.tag2) file.tag2 = input.tag2;
  if (input.endpoint) file.endpoint = input.endpoint;
  if (input.payment) {
    file.proofOfPayment = {
      fromAddress: normalizeAddress(input.payment.from),
      toAddress: normalizeAddress(input.payment.to),
      chainId: String(cfg.chainId),
      txHash: input.payment.txHash,
      amount: String(input.payment.amount),
      currency: "USDC",
      protocol: "x402",
    };
  }
  if (input.reasoning) file.reasoning = input.reasoning;
  if (input.mcpTool) file.mcp = { tool: input.mcpTool };
  if (input.xorv) file.xorv = input.xorv;
  return file;
}

/** The exact bytes to serve for a feedback file (canonical JSON). */
export function serializeFeedbackFile(file: FeedbackFile): string {
  return canonicalJson(file);
}

/** keccak256 of `serializeFeedbackFile(file)` — the `feedbackHash` committed on-chain. */
export function feedbackFileHash(file: FeedbackFile): Hex {
  return textHash(serializeFeedbackFile(file));
}

export interface ReputationSummary {
  count: number;
  /** Raw `int128` average, scaled by `summaryValueDecimals`, as a decimal string. */
  summaryValue: string;
  summaryValueDecimals: number;
  /** `summaryValue / 10^decimals` as a number, or null with no feedback. */
  average: number | null;
}

/**
 * The registry's own average over feedback from `clients`.
 *
 * `getSummary` reverts on an empty client list (the spec's Sybil guard — an
 * unfiltered average is exactly what a Sybil attack games), so an empty list
 * short-circuits to "no feedback" instead of a revert. Pass `[ledger]` for the
 * Xorv-verified, payment-backed score; pass the set of paying buyers for a
 * wider view.
 */
export async function reputationSummary(
  network: string,
  agentId: AgentId,
  clients: string[],
  opts: ReadOptions & { tag1?: string; tag2?: string } = {},
): Promise<ReputationSummary> {
  if (clients.length === 0) {
    return { count: 0, summaryValue: "0", summaryValueDecimals: 0, average: null };
  }
  const client = opts.client ?? publicClientFor(network);
  const [count, summaryValue, decimals] = await client.readContract({
    address: networkConfig(network).erc8004.reputation,
    abi: REPUTATION_ABI,
    functionName: "getSummary",
    args: [BigInt(agentId), clients.map(normalizeAddress), opts.tag1 ?? "", opts.tag2 ?? ""],
  });
  const n = Number(count);
  return {
    count: n,
    summaryValue: summaryValue.toString(),
    summaryValueDecimals: decimals,
    average: n === 0 ? null : Number(summaryValue) / 10 ** decimals,
  };
}
