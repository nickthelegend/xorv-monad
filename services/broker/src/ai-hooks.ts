/**
 * Where the AI roles plug into the job loop.
 *
 * Three sponsor models take a turn on every job — Hunyuan screens the prompt
 * before any provider sees it, Qwen reads Monad with its tools and picks the
 * provider when the buyer chose "Auto", Kimi scores the result and writes it to ERC-8004 as reputation
 * feedback. The implementations live in src/ai/ (switched on per role with
 * XORV_SCREENER / XORV_ROUTER / XORV_VERIFIER and the provider's key); the
 * broker only knows these shapes and calls them at fixed points:
 *
 *   POST /api/quotes   screen → route → match → freeze the quote
 *   job completed      verify → giveFeedback (fire-and-forget; never delays the buyer)
 *
 * Every hook is optional and bounded by its own deadline. The router and the
 * verifier fail *open* — a role that is down or slow degrades the job to what
 * it would have been without it. The screener fails open by default too, but
 * says so on the record; with `XORV_SCREENER_FAIL=closed` a screen that can't
 * answer refuses the quote instead. A broker with no hooks installed behaves
 * exactly as the plain price matcher.
 */

import type { JobRequest } from "@xorv/protocol";
import type { StoredJob } from "./jobs.js";
import type { FeedbackSink } from "./ai/feedback.js";
import type { RouterData } from "./ai/router-tools.js";
import type {
  AiRoleName,
  AiRoleReport,
  EnabledRoleInfo,
  RouteCandidate,
  RoutingRecord,
  ScreenFailMode,
  ScreeningRecord,
  VerificationRecord,
} from "./ai/types.js";

interface Role {
  /** What `/api/network` reports under `ai` (the protocol's `AiRoleInfo`, plus detail). */
  readonly info: EnabledRoleInfo;
  /** The role's own deadline; the broker's safety-net timeout sits just past it. */
  readonly timeoutMs: number;
}

export interface JobScreener extends Role {
  readonly failMode: ScreenFailMode;
  /**
   * A `block` verdict refuses the quote. Implementations don't throw: a screen
   * that can't answer returns the fail-mode verdict marked `unavailable`.
   */
  screen(request: JobRequest): Promise<ScreeningRecord>;
}

export interface JobRouter extends Role {
  /**
   * Pick the provider (and with it the adapter) for a request that didn't
   * name one, from the live candidates under the buyer's ceiling, reading
   * `data` with its tools. A record with `providerId` and `adapter` null (a
   * fallback), a null, or a throw all leave the choice to the matcher. A
   * record with only `adapter` set (an older router) picks the adapter and
   * leaves the node to the matcher.
   */
  route(request: JobRequest, candidates: RouteCandidate[], data?: RouterData | null): Promise<RoutingRecord | null>;
}

export interface JobVerifier extends Role {
  /** Score a finished job; the result is stored on it as `verification`. Null = no verdict. */
  verify(job: StoredJob): Promise<VerificationRecord | null>;
  /** Where scores go on-chain as ERC-8004 feedback; null keeps them off-chain. */
  readonly feedback?: FeedbackSink | null;
}

export interface AiHooks {
  screener?: JobScreener;
  router?: JobRouter;
  verifier?: JobVerifier;
  /** Every role's state, on or off, for `/api/network` → `aiRoles`. */
  report?: () => Record<AiRoleName, AiRoleReport>;
}

/** Headroom past a role's own deadline before the broker stops waiting for it regardless. */
export const AI_HOOK_GRACE_MS = 1_000;

/** Used when a hook doesn't state its own deadline. */
export const AI_HOOK_TIMEOUT_MS = 8_000;

/** Run a hook with a timeout; any failure resolves to null (fail open). */
export async function withHookTimeout<T>(
  label: string,
  run: () => Promise<T>,
  timeoutMs = AI_HOOK_TIMEOUT_MS,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[broker] ${label} timed out after ${timeoutMs}ms — continuing without it`);
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    console.warn(`[broker] ${label} failed — continuing without it: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A hook's safety-net deadline: its own timeout plus grace. */
export function hookDeadline(role: { timeoutMs?: number } | undefined): number {
  return role?.timeoutMs ? role.timeoutMs + AI_HOOK_GRACE_MS : AI_HOOK_TIMEOUT_MS;
}
