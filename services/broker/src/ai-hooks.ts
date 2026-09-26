/**
 * Where the AI roles plug into the job loop.
 *
 * Three sponsor models take a turn on every job — Hunyuan screens the prompt
 * before any provider sees it, Qwen picks an adapter when the buyer didn't,
 * Kimi scores the result and writes it to ERC-8004 as reputation feedback. The
 * implementations live elsewhere (and are switched on per role with
 * XORV_SCREENER / XORV_ROUTER / XORV_VERIFIER); the broker only knows these
 * shapes and calls them at fixed points:
 *
 *   POST /api/quotes   screen → route → match → freeze the quote
 *   job completed      verify (fire-and-forget; never delays the buyer)
 *
 * Every hook is optional, bounded by a timeout, and fails *open*: an AI role
 * that is down or slow degrades the job to what it would have been without
 * that role, and never blocks a quote or a result. A broker with no hooks
 * installed behaves exactly as the plain price matcher.
 */

import type {
  AdapterKind,
  AiRoleInfo,
  JobRequest,
  JobRouting,
  JobScreening,
  JobVerification,
} from "@xorv/protocol";
import type { StoredJob } from "./jobs.js";

export interface JobScreener {
  info: AiRoleInfo;
  /** A `block` verdict refuses the quote; anything else lets it through. */
  screen(request: JobRequest): Promise<JobScreening>;
}

export interface JobRouter {
  info: AiRoleInfo;
  /**
   * Suggest an adapter for a request that didn't name one. Returning a
   * routing with `adapter: null` (or throwing) leaves the choice to price.
   */
  route(request: JobRequest, available: AdapterKind[]): Promise<JobRouting | null>;
}

export interface JobVerifier {
  info: AiRoleInfo;
  /** Score a finished job; the result is stored on it as `verification`. */
  verify(job: StoredJob): Promise<JobVerification | null>;
}

export interface AiHooks {
  screener?: JobScreener;
  router?: JobRouter;
  verifier?: JobVerifier;
}

/** How long a quote waits on an AI role before carrying on without it. */
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
