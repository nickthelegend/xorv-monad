/**
 * Monad's block pipeline, as `monadNewHeads` reports it.
 *
 * Monad's RPC sends the same block several times as it moves through
 * consensus: `Proposed` (speculatively executed), `Voted` (about one slot
 * later), `Finalized` (two slots, irreversible) and `Verified` (state root
 * agreed, three blocks after finality). Each message carries a `blockId`,
 * because two competing proposals can share a height, and no abandonment
 * event is ever sent: when one proposal at height N finalizes, every other
 * `blockId` seen at N is dead and has to be dropped here.
 *
 * This module is the state machine only: messages in, a short ordered list of
 * blocks out, each with the milliseconds every state took on the viewer's
 * clock from the first time that proposal was seen. Pure, so it is tested
 * without a socket.
 */

export const COMMIT_STATES = ["Proposed", "Voted", "Finalized", "Verified"] as const;
export type CommitState = (typeof COMMIT_STATES)[number];

export interface HeadMessage {
  blockId: string;
  commitState: string;
  /** Hex block number, as the RPC sends it. */
  number: string;
  hash?: string;
}

export interface TrackedBlock {
  blockId: string;
  number: number;
  hash: string | null;
  /** When this proposal was first seen (viewer's clock, ms). */
  seenAt: number;
  /** The latest state reached. */
  state: CommitState;
  /** Ms from first sight to each state, for the states actually observed. */
  ms: Partial<Record<CommitState, number>>;
}

export interface Pipeline {
  blocks: TrackedBlock[];
  /** How many proposals were dropped because another one finalized at their height. */
  dropped: number;
}

export const EMPTY_PIPELINE: Pipeline = { blocks: [], dropped: 0 };

const RANK: Record<CommitState, number> = { Proposed: 0, Voted: 1, Finalized: 2, Verified: 3 };

function isState(value: string): value is CommitState {
  return (COMMIT_STATES as readonly string[]).includes(value);
}

/**
 * Apply one `monadNewHeads` message. Keeps the newest `keep` heights. A block
 * first seen already past `Proposed` (we joined mid-flight) is kept but gets
 * no timings for the states it skipped, so it never fakes a measurement.
 */
export function applyHead(pipeline: Pipeline, msg: HeadMessage, now: number, keep = 16): Pipeline {
  if (!isState(msg.commitState)) return pipeline;
  const number = Number.parseInt(msg.number, 16);
  if (!Number.isFinite(number)) return pipeline;
  const state = msg.commitState;

  let blocks = pipeline.blocks;
  let dropped = pipeline.dropped;
  const existing = blocks.find((b) => b.blockId === msg.blockId);
  if (existing) {
    if (RANK[state] <= RANK[existing.state]) return pipeline;
    const updated: TrackedBlock = {
      ...existing,
      hash: msg.hash ?? existing.hash,
      state,
      ms: existing.ms.Proposed === 0 ? { ...existing.ms, [state]: Math.round(now - existing.seenAt) } : existing.ms,
    };
    blocks = blocks.map((b) => (b.blockId === msg.blockId ? updated : b));
  } else {
    blocks = [
      ...blocks,
      { blockId: msg.blockId, number, hash: msg.hash ?? null, seenAt: now, state, ms: state === "Proposed" ? { Proposed: 0 } : {} },
    ];
  }

  // A finalized proposal kills every other proposal at its height.
  if (state === "Finalized" || state === "Verified") {
    const before = blocks.length;
    blocks = blocks.filter((b) => b.number !== number || b.blockId === msg.blockId);
    dropped += before - blocks.length;
  }

  const heights = [...new Set(blocks.map((b) => b.number))].sort((a, b) => b - a).slice(0, keep);
  const floor = heights[heights.length - 1] ?? 0;
  blocks = blocks.filter((b) => b.number >= floor).sort((a, b) => a.number - b.number || a.seenAt - b.seenAt);
  return { blocks, dropped };
}

/** Median ms to reach `state`, over blocks we watched from `Proposed`; null before any. */
export function medianMs(pipeline: Pipeline, state: Exclude<CommitState, "Proposed">): number | null {
  const values = pipeline.blocks.map((b) => b.ms[state]).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  if (values.length === 0) return null;
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid]! : Math.round((values[mid - 1]! + values[mid]!) / 2);
}

/** The newest block number seen in each state (for "latest / safe / finalized" style readouts). */
export function headOf(pipeline: Pipeline, state: CommitState): number | null {
  const atLeast = pipeline.blocks.filter((b) => RANK[b.state] >= RANK[state]).map((b) => b.number);
  return atLeast.length ? Math.max(...atLeast) : null;
}
