/**
 * Leash (https://github.com/iamrobertmoore/leash): an owner gives an agent key
 * a daily dollar cap, the sellers it may pay and an expiry, held on Monad by
 * LeashHub. One free view call reads it.
 *
 * Optional. The broker reads it only when a buyer names its agent key in
 * `X-Leash-Agent`, and then refuses before the buyer is asked to pay if the
 * owner revoked the key, the leash expired, this provider is not one of its
 * sellers, or the job would take it over today's cap. A key with no leash is
 * served as before.
 */

import { parseAbi, type Address } from "viem";
import { MONAD_MAINNET, MONAD_TESTNET, publicClientFor } from "@xorv/protocol";

/** LeashHub per network. The mainnet hub is source-verified on MonadVision. */
const LEASH_HUB: Record<string, Address> = {
  [MONAD_MAINNET]: "0x64a489074dd6a4b3b977e5f635a178366a8c12c3",
  [MONAD_TESTNET]: "0x8b427106c04e66dfc6e8d58fa4de0478a54f510a",
};

const LEASH_HUB_ABI = parseAbi([
  "function check(address agent, address seller, uint256 amount) view returns (uint8 status, uint256 remainingToday, uint64 expiry, uint256 agentId, address account)",
]);

/** LeashHub's status codes, in order. */
const LEASH_STATUS = ["OK", "UNKNOWN_AGENT", "REVOKED", "EXPIRED", "SELLER_NOT_ALLOWED", "OVER_CAP"] as const;

export interface LeashVerdict {
  agent: string;
  status: (typeof LEASH_STATUS)[number];
  /** Dollars the agent may still spend today, in USD micros (Leash amounts are 6-decimal dollars). */
  remainingTodayUsdMicros: number;
  /** Unix seconds; 0 when the agent has no leash. */
  expiry: number;
  /** The agent's ERC-8004 id, as the leash records it. */
  agentId: string;
}

/** Would `agent` be allowed to pay `seller` this many USD micros right now? */
export type LeashCheck = (agent: string, seller: string, usdMicros: number) => Promise<LeashVerdict>;

/** A leash that exists and says no. An agent with no leash at all is not refused. */
export function leashRefuses(verdict: LeashVerdict): boolean {
  return verdict.status !== "OK" && verdict.status !== "UNKNOWN_AGENT";
}

/** Reads LeashHub on the broker's network, or null where Leash is not deployed. */
export function chainLeash(network: string): LeashCheck | null {
  const hub = LEASH_HUB[network];
  if (!hub) return null;
  const client = publicClientFor(network);
  return async (agent, seller, usdMicros) => {
    const [status, remaining, expiry, agentId] = await client.readContract({
      address: hub,
      abi: LEASH_HUB_ABI,
      functionName: "check",
      args: [agent as Address, seller as Address, BigInt(usdMicros)],
    });
    const name = LEASH_STATUS[status];
    if (!name) throw new Error(`unknown leash status ${status}`);
    return { agent, status: name, remainingTodayUsdMicros: Number(remaining), expiry: Number(expiry), agentId: agentId.toString() };
  };
}
