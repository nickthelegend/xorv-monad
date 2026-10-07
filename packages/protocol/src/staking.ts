/**
 * Monad's native staking, read from the staking precompile at 0x1000.
 *
 * Monad's validator set, epochs and stake live in a precompile, not a
 * contract. Its "views" must be reached with CALL (STATICCALL and
 * DELEGATECALL revert), so the ABI marks them nonpayable; a JSON-RPC
 * `eth_call` works. There is no code at 0x1000 on a fork, so these reads are
 * always made against a real Monad network.
 *
 * Xorv reads it to show the network that settles its payments: the current
 * epoch, the validator proposing blocks right now and its stake, and the size
 * of the consensus set. It holds no MON to delegate, so it has no write path.
 *
 * ABI from Monad's own `@monad-crypto/viem` (0.0.3).
 */
import type { PublicClient } from "viem";

export const STAKING_PRECOMPILE = "0x0000000000000000000000000000000000001000" as const;

export const STAKING_ABI = [
  {
    type: "function",
    name: "getEpoch",
    inputs: [],
    outputs: [
      { name: "epoch", type: "uint64" },
      { name: "inEpochDelayPeriod", type: "bool" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getProposerValId",
    inputs: [],
    outputs: [{ name: "val_id", type: "uint64" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getValidator",
    inputs: [{ name: "validatorId", type: "uint64" }],
    outputs: [
      { name: "authAddress", type: "address" },
      { name: "flags", type: "uint64" },
      { name: "stake", type: "uint256" },
      { name: "accRewardPerToken", type: "uint256" },
      { name: "commission", type: "uint256" },
      { name: "unclaimedRewards", type: "uint256" },
      { name: "consensusStake", type: "uint256" },
      { name: "consensusCommission", type: "uint256" },
      { name: "snapshotStake", type: "uint256" },
      { name: "snapshotCommission", type: "uint256" },
      { name: "secpPubkey", type: "bytes" },
      { name: "blsPubkey", type: "bytes" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getConsensusValidatorSet",
    inputs: [{ name: "startIndex", type: "uint32" }],
    outputs: [
      { name: "isDone", type: "bool" },
      { name: "nextIndex", type: "uint32" },
      { name: "valIds", type: "uint64[]" },
    ],
    stateMutability: "nonpayable",
  },
] as const;

export interface StakingSnapshot {
  epoch: number;
  inEpochDelayPeriod: boolean;
  proposer: {
    id: number;
    authAddress: string;
    /** Wei of MON. */
    stake: string;
    consensusStake: string;
    /** Commission as a fraction of 1e18 (Monad's fixed-point unit). */
    commission: string;
  } | null;
  /** Validators in the active consensus set (counted across pages). */
  consensusSetSize: number;
  readAt: number;
}

async function call<T>(client: PublicClient, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await client.readContract({ address: STAKING_PRECOMPILE, abi: STAKING_ABI, functionName, args } as never)) as T;
}

/** The validator set's size, following the precompile's pagination (bounded). */
async function consensusSetSize(client: PublicClient): Promise<number> {
  let start = 0;
  let total = 0;
  for (let page = 0; page < 10; page++) {
    const [isDone, nextIndex, valIds] = await call<[boolean, number, readonly bigint[]]>(client, "getConsensusValidatorSet", [start]);
    total += valIds.length;
    if (isDone || valIds.length === 0) break;
    start = nextIndex;
  }
  return total;
}

export async function readStaking(client: PublicClient): Promise<StakingSnapshot> {
  const [[epoch, inDelay], proposerId, size] = await Promise.all([
    call<[bigint, boolean]>(client, "getEpoch"),
    call<bigint>(client, "getProposerValId"),
    consensusSetSize(client),
  ]);
  const v = await call<readonly [string, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, string, string]>(
    client,
    "getValidator",
    [proposerId],
  ).catch(() => null);
  return {
    epoch: Number(epoch),
    inEpochDelayPeriod: inDelay,
    proposer: v
      ? { id: Number(proposerId), authAddress: v[0], stake: v[2].toString(), consensusStake: v[6].toString(), commission: v[4].toString() }
      : null,
    consensusSetSize: size,
    readAt: Date.now(),
  };
}
