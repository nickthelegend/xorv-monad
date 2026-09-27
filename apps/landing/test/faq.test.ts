import { describe, expect, it } from "vitest";
import { FAQ } from "@/lib/faq";

/*
 * The FAQ makes claims about what the chain records, and a judge can check
 * them against XorvLedger. When a provider fails mid-job the broker reassigns
 * the job (jobs.ts `reassign` sets it back to "assigned", which is not
 * terminal), so no receipt is written for the failure: the job gets one
 * receipt for its final outcome, without an agent identity. Only the broker's
 * in-memory matcher stats count the failure.
 */

function answer(question: RegExp): string {
  const item = FAQ.find((entry) => question.test(entry.q));
  if (!item) throw new Error(`no FAQ entry matches ${question}`);
  return item.a;
}

describe("FAQ", () => {
  it("does not claim a reassigned job's failure is recorded on-chain", () => {
    const a = answer(/fails or disappears mid-job/);
    expect(a).not.toMatch(/recorded on-chain as a failed receipt/i);
    expect(a).toMatch(/exactly one receipt/i);
    expect(a).toMatch(/without an agent identity/i);
    expect(a).toMatch(/matcher/);
  });
});
