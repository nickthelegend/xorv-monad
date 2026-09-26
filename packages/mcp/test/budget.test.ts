import { describe, expect, it } from "vitest";
import { BudgetExceededError, SessionBudget } from "../src/budget.js";

describe("SessionBudget", () => {
  it("holds a reservation until it is committed or released", () => {
    const budget = new SessionBudget(50_000);
    const r = budget.reserve(10_000);
    expect(budget.heldUsdMicros).toBe(10_000);
    expect(budget.remainingUsdMicros()).toBe(40_000);
    r.commit();
    expect(budget.heldUsdMicros).toBe(0);
    expect(budget.spentUsdMicros).toBe(10_000);
    expect(budget.paidJobs).toBe(1);
    expect(budget.remainingUsdMicros()).toBe(40_000);

    budget.reserve(20_000).release();
    expect(budget.remainingUsdMicros()).toBe(40_000);
    expect(budget.paidJobs).toBe(1);
  });

  it("refuses a reservation that would overrun what is left, and says what is left", () => {
    const budget = new SessionBudget(15_000);
    budget.reserve(10_000).commit();
    expect(() => budget.reserve(10_000)).toThrow(BudgetExceededError);
    expect(() => budget.reserve(10_000)).toThrow(/only \$0\.0050 of the \$0\.0150 session budget is left/);
    expect(() => budget.reserve(10_000)).toThrow(/XORV_SESSION_BUDGET_USD/);
    // An exact fit is fine.
    expect(() => budget.reserve(5_000)).not.toThrow();
  });

  it("counts in-flight holds, so concurrent payments cannot share the same headroom", () => {
    const budget = new SessionBudget(15_000);
    const first = budget.reserve(10_000);
    expect(() => budget.reserve(10_000)).toThrow(/in flight/);
    first.release();
    expect(() => budget.reserve(10_000)).not.toThrow();
  });

  it("treats commit and release as once-only", () => {
    const budget = new SessionBudget(50_000);
    const r = budget.reserve(10_000);
    r.commit();
    r.commit();
    r.release();
    expect(budget.spentUsdMicros).toBe(10_000);
    expect(budget.heldUsdMicros).toBe(0);
    expect(budget.paidJobs).toBe(1);
  });

  it("has no cap when configured as unlimited", () => {
    const budget = new SessionBudget(null);
    expect(budget.remainingUsdMicros()).toBe(Number.POSITIVE_INFINITY);
    budget.reserve(1_000_000_000).commit();
    expect(budget.describe()).toMatch(/no session budget/);
  });

  it("describes itself for tool output", () => {
    const budget = new SessionBudget(500_000);
    budget.reserve(10_000).commit();
    expect(budget.describe()).toBe("$0.0100 of $0.5000 session budget spent (1 paid job); $0.4900 left");
  });

  it("rejects a nonsensical limit or amount", () => {
    expect(() => new SessionBudget(0)).toThrow();
    expect(() => new SessionBudget(-5)).toThrow();
    expect(() => new SessionBudget(100).reserve(-1)).toThrow();
  });
});
