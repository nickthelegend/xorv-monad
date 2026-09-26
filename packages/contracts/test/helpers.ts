import type { HardhatViemHelpers } from "@nomicfoundation/hardhat-viem/types";
import { type Address, type Hex, type LocalAccount, type WalletClient, keccak256, toHex } from "viem";

import { deployErc8004 } from "../scripts/lib/erc8004-local.js";

export { deployErc8004 };

/** Same value as XorvLedger.NO_AGENT: a provider with no ERC-8004 identity. */
export const NO_AGENT = 2n ** 256n - 1n;
/** JobState.agentId for NO_AGENT jobs (the uint64 sentinel stored on-chain). */
export const NO_AGENT_ID = 2n ** 64n - 1n;

/** keccak256 of UTF-8 text, the way the broker derives jobId / providerId / request and result hashes. */
export const textHash = (text: string): Hex => keccak256(toHex(text));

/** The EIP-712 Rating type, field for field as RATING_TYPEHASH spells it. */
export const RATING_TYPES = {
  Rating: [
    { name: "jobId", type: "bytes32" },
    { name: "value", type: "int128" },
    { name: "tag2", type: "string" },
    { name: "endpoint", type: "string" },
    { name: "feedbackURI", type: "string" },
    { name: "feedbackHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface Rating {
  jobId: Hex;
  value: bigint;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: Hex;
  deadline: bigint;
}

export interface JobReceipt {
  jobId: Hex;
  agentId: bigint;
  buyer: Address;
  payTo: Address;
  amount: bigint;
  paymentTx: Hex;
  requestHash: Hex;
  resultHash: Hex;
  durationMs: number;
  ok: boolean;
}

export function ratingTypedData(chainId: number, ledger: Address, rating: Rating) {
  return {
    domain: { name: "XorvLedger", version: "1", chainId, verifyingContract: ledger },
    types: RATING_TYPES,
    primaryType: "Rating" as const,
    message: rating,
  };
}

/** A receipt as the broker would build it for job `n`; override any field. */
export function makeReceipt(n: number | string, fields: Partial<JobReceipt> & Pick<JobReceipt, "buyer" | "payTo" | "agentId">): JobReceipt {
  return {
    jobId: textHash(`job-${n}`),
    amount: 250_000n, // 0.25 USDC
    paymentTx: textHash(`settlement-${n}`),
    requestHash: textHash(`prompt ${n}`),
    resultHash: textHash(`result ${n}`),
    durationMs: 42_000,
    ok: true,
    ...fields,
  };
}

export function makeRating(jobId: Hex, fields: Partial<Rating> = {}): Rating {
  return {
    jobId,
    value: 92n,
    tag2: "claude-code",
    endpoint: "https://broker.xorv.xyz/api/jobs",
    feedbackURI: `https://broker.xorv.xyz/feedback/${jobId}.json`,
    feedbackHash: textHash(`{"jobId":"${jobId}","value":92}`),
    deadline: 2n ** 40n, // far future unless a test says otherwise
    ...fields,
  };
}

/** Registers an ERC-8004 agent from `owner` (its agentWallet defaults to `owner`) and returns its id. */
export async function registerAgent(
  viem: HardhatViemHelpers,
  identity: Awaited<ReturnType<typeof deployErc8004>>["identity"],
  owner: WalletClient,
  agentURI: string,
): Promise<bigint> {
  const publicClient = await viem.getPublicClient();
  const account = owner.account;
  if (account === undefined) throw new Error("wallet client has no account");
  const { result } = await publicClient.simulateContract({
    address: identity.address,
    abi: identity.abi,
    functionName: "register",
    args: [agentURI],
    account,
  });
  const hash = await identity.write.register([agentURI], { account });
  await publicClient.waitForTransactionReceipt({ hash });
  return result;
}

/** Signs a rating as `signer` (a viem local account or a Hardhat wallet client). */
export async function signRating(
  signer: LocalAccount | WalletClient,
  chainId: number,
  ledger: Address,
  rating: Rating,
): Promise<Hex> {
  const typedData = ratingTypedData(chainId, ledger, rating);
  if (signer.type === "local") return (signer as LocalAccount).signTypedData(typedData);
  const client = signer as WalletClient;
  if (client.account === undefined) throw new Error("wallet client has no account");
  return client.signTypedData({ ...typedData, account: client.account });
}
