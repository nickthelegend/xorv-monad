/**
 * The session budget: a cumulative spending cap for one MCP server process.
 *
 * Three ceilings stack up in front of every payment:
 *
 *   1. the quote — the broker is asked only for providers under the ceiling;
 *   2. the per-job cap (`XORV_MAX_PRICE`) — enforced again here on the quote
 *      and as x402's per-payment spend control, so a broker that ignores the
 *      request still cannot overcharge;
 *   3. this budget (`XORV_SESSION_BUDGET_USD`) — the total across calls.
 *
 * The third exists because nothing else can provide it. A Privy policy caps
 * each *signature* (`TransferWithAuthorization.value <= cap`), but Privy's
 * rolling-window aggregations apply to transaction signing only, not to the
 * EIP-712 typed data an x402 payment is. So a model stuck in a loop could
 * collect one in-policy signature after another; this is what stops it.
 *
 * Money is reserved *before* signing and settled after:
 *
 *   - `reserve` fails fast when the price would overrun what is left, and
 *     holds the amount so two concurrent tool calls cannot both squeeze into
 *     the same remaining headroom;
 *   - `commit` makes it spent;
 *   - `release` hands it back, used only when we *know* no money moved (the
 *     quote was refused, nothing was signed, or the settlement was rejected).
 *     When in doubt — a signed payment whose response never arrived — the
 *     reservation is committed. Over-counting a budget is an inconvenience;
 *     under-counting it is the failure this exists to prevent.
 *
 * In-process by design: restarting the MCP server resets it, the same way
 * restarting a session does. It bounds a runaway session, not a lifetime.
 */

import { formatUsd } from "@xorv/protocol";

export interface Reservation {
  readonly amountUsdMicros: number;
  commit(): void;
  release(): void;
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class SessionBudget {
  private spentMicros = 0;
  private heldMicros = 0;
  private jobs = 0;

  /** `limitUsdMicros` null means no cumulative cap. */
  constructor(readonly limitUsdMicros: number | null) {
    if (limitUsdMicros !== null && (!Number.isFinite(limitUsdMicros) || limitUsdMicros <= 0)) {
      throw new Error(`session budget must be a positive micro-USD amount or null, got ${String(limitUsdMicros)}`);
    }
  }

  /** Settled spend so far, in micro-USD. */
  get spentUsdMicros(): number {
    return this.spentMicros;
  }

  /** Amount held by payments in flight. */
  get heldUsdMicros(): number {
    return this.heldMicros;
  }

  /** Paid jobs committed this session. */
  get paidJobs(): number {
    return this.jobs;
  }

  /** What can still be reserved; `Infinity` when there is no cap. */
  remainingUsdMicros(): number {
    if (this.limitUsdMicros === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.limitUsdMicros - this.spentMicros - this.heldMicros);
  }

  /**
   * Hold `amountUsdMicros` for a payment about to be signed.
   *
   * Throws `BudgetExceededError` when it does not fit. Commit or release the
   * returned reservation exactly once; later calls are no-ops, so a `finally`
   * that releases after a commit is safe.
   */
  reserve(amountUsdMicros: number): Reservation {
    if (!Number.isFinite(amountUsdMicros) || amountUsdMicros < 0) {
      throw new Error(`cannot reserve ${String(amountUsdMicros)} micro-USD`);
    }
    const remaining = this.remainingUsdMicros();
    if (amountUsdMicros > remaining) {
      throw new BudgetExceededError(
        `this job costs ${formatUsd(amountUsdMicros)} but only ${formatUsd(remaining)} of the ${formatUsd(this.limitUsdMicros ?? 0)} ` +
          `session budget is left (${formatUsd(this.spentMicros)} spent${this.heldMicros > 0 ? `, ${formatUsd(this.heldMicros)} in flight` : ""}). ` +
          "Raise XORV_SESSION_BUDGET_USD and restart the MCP server if more spending is intended.",
      );
    }
    this.heldMicros += amountUsdMicros;
    let open = true;
    return {
      amountUsdMicros,
      commit: () => {
        if (!open) return;
        open = false;
        this.heldMicros -= amountUsdMicros;
        this.spentMicros += amountUsdMicros;
        this.jobs += 1;
      },
      release: () => {
        if (!open) return;
        open = false;
        this.heldMicros -= amountUsdMicros;
      },
    };
  }

  /** "$0.1200 of $0.50 spent (3 jobs)" — or the unlimited equivalent. */
  describe(): string {
    const jobs = `${this.jobs} paid job${this.jobs === 1 ? "" : "s"}`;
    if (this.limitUsdMicros === null) return `${formatUsd(this.spentMicros)} spent this session (${jobs}); no session budget`;
    return `${formatUsd(this.spentMicros)} of ${formatUsd(this.limitUsdMicros)} session budget spent (${jobs}); ${formatUsd(this.remainingUsdMicros())} left`;
  }
}
