import { describe, expect, it } from "vitest";
import { EMPTY_PIPELINE, applyHead, headOf, medianMs, type HeadMessage, type Pipeline } from "@/lib/commit-states";

const msg = (n: number, state: string, blockId = `id${n}`): HeadMessage => ({ blockId, commitState: state, number: `0x${n.toString(16)}`, hash: `0xh${n}` });

function run(events: [HeadMessage, number][], keep?: number): Pipeline {
  return events.reduce((p, [m, at]) => applyHead(p, m, at, keep), EMPTY_PIPELINE);
}

describe("Monad commit-state pipeline", () => {
  it("times each block from Proposed through Voted, Finalized and Verified on the viewer's clock", () => {
    const p = run([
      [msg(100, "Proposed"), 1_000],
      [msg(100, "Voted"), 1_300],
      [msg(100, "Finalized"), 1_580],
      [msg(100, "Verified"), 2_500],
    ]);
    expect(p.blocks).toHaveLength(1);
    expect(p.blocks[0]).toMatchObject({ number: 100, state: "Verified", ms: { Proposed: 0, Voted: 300, Finalized: 580, Verified: 1_500 } });
  });

  it("never fakes timings for a block first seen mid-flight", () => {
    const p = run([
      [msg(99, "Voted"), 1_000],
      [msg(99, "Finalized"), 1_300],
    ]);
    expect(p.blocks[0]).toMatchObject({ state: "Finalized", ms: {} });
    expect(medianMs(p, "Finalized")).toBeNull();
  });

  it("drops the competing proposal at a height once another one finalizes (no abandonment event is sent)", () => {
    const p = run([
      [msg(200, "Proposed", "a"), 0],
      [msg(200, "Proposed", "b"), 10],
      [msg(200, "Finalized", "b"), 600],
    ]);
    expect(p.blocks.map((b) => b.blockId)).toEqual(["b"]);
    expect(p.dropped).toBe(1);
  });

  it("ignores a stale or unknown state and keeps only the newest heights", () => {
    let p = run([
      [msg(1, "Proposed"), 0],
      [msg(1, "Finalized"), 600],
    ]);
    p = applyHead(p, msg(1, "Voted"), 700);
    p = applyHead(p, { ...msg(1, "Abandoned") }, 800);
    expect(p.blocks[0]!.state).toBe("Finalized");
    const many = run(Array.from({ length: 20 }, (_, i) => [msg(i + 1, "Proposed"), i * 300] as [HeadMessage, number]), 5);
    expect(many.blocks.map((b) => b.number)).toEqual([16, 17, 18, 19, 20]);
  });

  it("reports medians and the newest head per state", () => {
    const p = run([
      [msg(10, "Proposed"), 0],
      [msg(10, "Voted"), 280],
      [msg(10, "Finalized"), 560],
      [msg(11, "Proposed"), 300],
      [msg(11, "Voted"), 620],
      [msg(12, "Proposed"), 600],
    ]);
    expect(medianMs(p, "Voted")).toBe(300);
    // Browser clocks are fractional; the strip shows whole milliseconds.
    const frac = run([
      [msg(5, "Proposed"), 0.4],
      [msg(5, "Voted"), 287.1],
    ]);
    expect(frac.blocks[0]!.ms.Voted).toBe(287);
    expect(medianMs(p, "Finalized")).toBe(560);
    expect(headOf(p, "Proposed")).toBe(12);
    expect(headOf(p, "Voted")).toBe(11);
    expect(headOf(p, "Finalized")).toBe(10);
  });
});
