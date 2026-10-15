import { describe, expect, it } from "vitest";
import { budgetUse } from "@/components/agent-view";

describe("an agent's budget use", () => {
  it("splits the bar into spent and held-in-escrow, capped at the budget", () => {
    expect(budgetUse({ budgetUsdMicros: 4_000, spentUsdMicros: 1_000, heldUsdMicros: 1_000 })).toEqual({ spentPct: 25, heldPct: 25 });
    expect(budgetUse({ budgetUsdMicros: 1_000, spentUsdMicros: 3_000, heldUsdMicros: 500 })).toEqual({ spentPct: 100, heldPct: 0 });
    expect(budgetUse({ budgetUsdMicros: null, spentUsdMicros: 3_000, heldUsdMicros: 0 })).toBeNull();
  });
});
