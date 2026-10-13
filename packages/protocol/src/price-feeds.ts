/**
 * Chainlink Data Feeds on Monad: what a dollar of USDC and a MON are worth.
 *
 * Xorv prices every job in USDC and calls it dollars. The USDC/USD feed checks
 * that claim: the broker stops quoting when USDC is off its peg, rather than
 * selling "$0.02" jobs for something worth less. MON/USD turns the gas the
 * facilitator pays into dollars on the speed receipt.
 *
 * Feed addresses come from Chainlink's directory. Monad testnet has five feeds
 * (8 decimals, 24 h heartbeat) and no MON/USD, so MON is priced from mainnet,
 * and the receipt says so. These are plain `eth_call`s; nothing is written.
 */
import type { PublicClient } from "viem";
import { MONAD_MAINNET, MONAD_TESTNET } from "./chains.js";

export const AGGREGATOR_V3_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
  },
  { type: "function", name: "decimals", inputs: [], outputs: [{ name: "", type: "uint8" }], stateMutability: "view" },
] as const;

export interface FeedSpec {
  pair: string;
  network: string;
  address: `0x${string}`;
  decimals: number;
  /** The feed's own heartbeat: past this, the answer is stale. */
  heartbeatSeconds: number;
}

export const CHAINLINK_FEEDS = {
  usdcUsd: {
    pair: "USDC/USD",
    network: MONAD_TESTNET,
    address: "0x39820e7965e29DC86b94F20eD04e9c5cCf9aFf95",
    decimals: 8,
    heartbeatSeconds: 86_400,
  },
  monUsd: {
    pair: "MON/USD",
    network: MONAD_MAINNET,
    address: "0xBcD78f76005B7515837af6b50c7C52BCf73822fb",
    decimals: 8,
    heartbeatSeconds: 86_400,
  },
} as const satisfies Record<string, FeedSpec>;

export interface FeedReading {
  pair: string;
  network: string;
  feed: string;
  /** The answer as a decimal number of dollars. */
  price: number;
  /** When Chainlink last updated it, in ms since the epoch. */
  updatedAt: number;
  /** Older than the heartbeat (plus a little grace) as of `readAt`. */
  stale: boolean;
  readAt: number;
}

/** Grace on top of the heartbeat before a reading counts as stale. */
const STALE_GRACE_SECONDS = 3_600;

export async function readFeed(client: Pick<PublicClient, "readContract">, spec: FeedSpec, now = Date.now()): Promise<FeedReading> {
  const [, answer, , updatedAt] = (await client.readContract({
    address: spec.address,
    abi: AGGREGATOR_V3_ABI,
    functionName: "latestRoundData",
  })) as readonly [bigint, bigint, bigint, bigint, bigint];
  if (answer <= 0n) throw new Error(`Chainlink ${spec.pair} returned a non-positive answer`);
  const updatedMs = Number(updatedAt) * 1000;
  return {
    pair: spec.pair,
    network: spec.network,
    feed: spec.address,
    price: Number(answer) / 10 ** spec.decimals,
    updatedAt: updatedMs,
    stale: now - updatedMs > (spec.heartbeatSeconds + STALE_GRACE_SECONDS) * 1000,
    readAt: now,
  };
}

/** How far USDC may sit from $1 before the broker stops quoting: 2%. */
export const USDC_PEG_TOLERANCE = 0.02;

/**
 * Is USDC worth a dollar? A stale reading is not evidence of a depeg, so it
 * does not block; it is reported as stale instead.
 */
export function pegCheck(reading: FeedReading, tolerance = USDC_PEG_TOLERANCE): { ok: boolean; deviation: number; reason: string | null } {
  const deviation = Math.abs(reading.price - 1);
  if (reading.stale) return { ok: true, deviation, reason: null };
  if (deviation > tolerance) {
    return {
      ok: false,
      deviation,
      reason: `USDC is off its peg: Chainlink USDC/USD reads $${reading.price.toFixed(4)}, more than ${(tolerance * 100).toFixed(0)}% from $1`,
    };
  }
  return { ok: true, deviation, reason: null };
}

/** MON spent on gas, in dollars at a MON/USD reading. */
export function monToUsd(monWei: bigint, reading: Pick<FeedReading, "price">): number {
  return (Number(monWei) / 1e18) * reading.price;
}
