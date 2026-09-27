/**
 * Turn the broker's AI configuration into installed roles.
 *
 * Each role is switched independently (`XORV_SCREENER`, `XORV_ROUTER`,
 * `XORV_VERIFIER`) and needs its provider's key:
 *
 *   auto (default)  on when the key is set, off otherwise
 *   hunyuan|qwen|kimi  asked for explicitly — still off without a key, but
 *                      the boot log says so loudly instead of quietly
 *   off             off
 *
 * A missing key is never fatal: the broker boots, the role reports itself off
 * with the variable to set (`/api/network` → `aiRoles`), and quotes and jobs
 * run exactly as they would without it. Keys come from the preset's own
 * variables (XORV_QWEN_API_KEY / DASHSCOPE_API_KEY, XORV_KIMI_API_KEY /
 * MOONSHOT_API_KEY, XORV_HUNYUAN_API_KEY / TOKENHUB_API_KEY) and are sent
 * nowhere but the preset's base URL.
 *
 * Tuning (all optional; a bad value logs and keeps the default):
 *
 *   XORV_ROUTER_TIMEOUT_MS        the router's whole budget, every turn and tool (15000)
 *   XORV_ROUTER_MAX_TURNS         model turns per route (4)
 *   XORV_ROUTER_MAX_TOOLS         lookups per route, select_provider not counted (6)
 *   XORV_ROUTER_THINKING          on | off: Qwen thinking while it routes (on)
 *   XORV_ROUTER_THINKING_BUDGET   reasoning tokens per turn (256)
 *   XORV_SCREENER_TIMEOUT_MS      the Hunyuan screen's deadline (8000)
 *   XORV_SCREENER_REASONING       low | high | provider: TokenHub reasoning_effort (low)
 */

import { LLM_PRESETS, networkConfig, resolvePreset, type LlmPresetKind } from "@xorv/protocol";
import type { PrivateKeyAccount, Transport } from "viem";
import type { AiRoleConfig } from "../config.js";
import type { AiHooks } from "../ai-hooks.js";
import { RoleClient } from "./client.js";
import { ReputationWriter, VERIFIED_TAG1, type FeedbackSink } from "./feedback.js";
import {
  QwenRouter,
  ROUTE_BUDGET_MS,
  ROUTE_MAX_TOOL_CALLS,
  ROUTE_MAX_TURNS,
  ROUTE_THINKING_BUDGET,
} from "./router.js";
import { HunyuanScreener, SCREEN_REASONING, SCREEN_TIMEOUT_MS, screenerBody, type ScreenReasoning } from "./screener.js";
import { KimiVerifier, VERIFY_TIMEOUT_MS } from "./verifier.js";
import type { AiRoleName, AiRoleReport, ScreenFailMode, VerifierFeedbackReport } from "./types.js";

export { RoleClient, AiRoleError, invalid } from "./client.js";
export { HunyuanScreener, SCREEN_REASONING, SCREEN_TIMEOUT_MS, screenerBody, type ScreenReasoning } from "./screener.js";
export {
  QwenRouter,
  ROUTE_BUDGET_MS,
  ROUTE_MAX_TOOL_CALLS,
  ROUTE_MAX_TURNS,
  ROUTE_THINKING_BUDGET,
  ROUTE_TIMEOUT_MS,
  ROUTE_TOOL_TIMEOUT_MS,
  parseSelect,
} from "./router.js";
export {
  LIST_CANDIDATES_MAX_ROWS,
  NOT_A_CANDIDATE,
  ROUTER_TOOLS_SPEC,
  runReadTool,
  type CandidateRef,
  type Erc8004Read,
  type IndexerStatsRead,
  type ReceiptsRead,
  type RouterData,
  type TrustRead,
} from "./router-tools.js";
export { ROUTER_DATA_CACHE_MS, ROUTER_RECEIPT_SCAN, createRouterData, type RouterDataOptions } from "./router-data.js";
export {
  REPUTATION_PRIOR,
  ReputationBook,
  reputationScore,
  type ReputationEntry,
  type ReputationJob,
} from "./reputation-book.js";
export { KimiVerifier, VERIFY_TIMEOUT_MS, isPrivate, verifiable } from "./verifier.js";
export {
  ReputationWriter,
  VERIFIED_TAG1,
  giveFeedbackArgs,
  verificationFeedback,
  verificationURI,
  type FeedbackSink,
  type GiveFeedbackInput,
} from "./feedback.js";
export * from "./types.js";

const ROLES: Record<AiRoleName, { provider: LlmPresetKind; env: string }> = {
  screener: { provider: "hunyuan", env: "XORV_SCREENER" },
  router: { provider: "qwen", env: "XORV_ROUTER" },
  verifier: { provider: "kimi", env: "XORV_VERIFIER" },
};

/** The router's loop settings, from the environment. */
export interface RouterSettings {
  budgetMs: number;
  maxTurns: number;
  maxToolCalls: number;
  thinking: boolean;
  thinkingBudget: number;
}

/** The screen's settings, from the environment. */
export interface ScreenerSettings {
  timeoutMs: number;
  reasoning: ScreenReasoning;
}

function intSetting(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  range: { min: number; max: number },
  log: (line: string) => void,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    log(`[broker] ${name}=${raw} is not a whole number from ${range.min} to ${range.max}; using ${fallback}`);
    return fallback;
  }
  return value;
}

export function routerSettings(
  env: Record<string, string | undefined>,
  log: (line: string) => void = () => {},
): RouterSettings {
  const thinkingRaw = env.XORV_ROUTER_THINKING?.trim().toLowerCase();
  let thinking = true;
  if (thinkingRaw) {
    if (["off", "false", "0", "no"].includes(thinkingRaw)) thinking = false;
    else if (!["on", "true", "1", "yes"].includes(thinkingRaw)) {
      log(`[broker] XORV_ROUTER_THINKING=${thinkingRaw} is not on or off; thinking stays on`);
    }
  }
  return {
    budgetMs: intSetting(env, "XORV_ROUTER_TIMEOUT_MS", ROUTE_BUDGET_MS, { min: 1_000, max: 120_000 }, log),
    maxTurns: intSetting(env, "XORV_ROUTER_MAX_TURNS", ROUTE_MAX_TURNS, { min: 2, max: 8 }, log),
    maxToolCalls: intSetting(env, "XORV_ROUTER_MAX_TOOLS", ROUTE_MAX_TOOL_CALLS, { min: 1, max: 16 }, log),
    thinking,
    thinkingBudget: intSetting(env, "XORV_ROUTER_THINKING_BUDGET", ROUTE_THINKING_BUDGET, { min: 64, max: 8_192 }, log),
  };
}

export function screenerSettings(
  env: Record<string, string | undefined>,
  log: (line: string) => void = () => {},
): ScreenerSettings {
  const raw = env.XORV_SCREENER_REASONING?.trim().toLowerCase();
  let reasoning: ScreenReasoning = SCREEN_REASONING;
  if (raw) {
    if (raw === "low" || raw === "high" || raw === "provider") reasoning = raw;
    else log(`[broker] XORV_SCREENER_REASONING=${raw} is not low, high or provider; using ${SCREEN_REASONING}`);
  }
  return {
    timeoutMs: intSetting(env, "XORV_SCREENER_TIMEOUT_MS", SCREEN_TIMEOUT_MS, { min: 500, max: 60_000 }, log),
    reasoning,
  };
}

export interface CreateAiHooksOptions {
  ai: AiRoleConfig;
  network: string;
  /**
   * The EOA that writes verifier scores to ERC-8004 (XORV_VERIFIER_KEY,
   * falling back to the operator key). Null keeps scores off-chain.
   */
  verifierAccount: PrivateKeyAccount | null;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injected into every model call (tests). */
  fetch?: typeof globalThis.fetch;
  /** Replaces the on-chain feedback writer (tests); `null` forces scores off-chain. */
  feedback?: FeedbackSink | null;
  rpcUrl?: string;
  transport?: Transport;
  log?: (line: string) => void;
}

/** Build the enabled roles, plus a report covering all three for /api/network and the boot banner. */
export function createAiHooks(opts: CreateAiHooksOptions): AiHooks {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const failMode: ScreenFailMode = opts.ai.screenerFail ?? "open";
  const reasons: Partial<Record<AiRoleName, string>> = {};
  const routing = routerSettings(env, log);
  const screening = screenerSettings(env, log);
  const timeouts: Record<AiRoleName, number> = {
    screener: screening.timeoutMs,
    router: routing.budgetMs,
    verifier: VERIFY_TIMEOUT_MS,
  };
  const bodies: Partial<Record<AiRoleName, Record<string, unknown>>> = {
    screener: screenerBody(screening.reasoning),
  };

  const clientFor = (role: AiRoleName): RoleClient | null => {
    const spec = ROLES[role];
    const selection = opts.ai[role];
    const preset = resolvePreset(spec.provider, env);
    if (selection === "off") {
      reasons[role] = `switched off (${spec.env}=off)`;
      return null;
    }
    if (!preset.apiKey) {
      reasons[role] = `no API key — set ${LLM_PRESETS[spec.provider].keyEnvs.join(" or ")}`;
      if (selection !== "auto") {
        log(`[broker] ${spec.env}=${selection} but ${reasons[role]}; the ${role} is OFF`);
      }
      return null;
    }
    return new RoleClient({ role, preset, timeoutMs: timeouts[role], fetch: opts.fetch, body: bodies[role] });
  };

  const screenerClient = clientFor("screener");
  const routerClient = clientFor("router");
  const verifierClient = clientFor("verifier");

  const screener = screenerClient ? new HunyuanScreener({ client: screenerClient, failMode, log }) : undefined;
  const router = routerClient
    ? new QwenRouter({
        client: routerClient,
        maxTurns: routing.maxTurns,
        maxToolCalls: routing.maxToolCalls,
        thinking: routing.thinking,
        thinkingBudget: routing.thinkingBudget,
        log,
      })
    : undefined;
  let feedback: FeedbackSink | null = null;
  let feedbackReason: string | null = null;
  if (verifierClient) {
    if (opts.feedback !== undefined) {
      feedback = opts.feedback;
      feedbackReason = feedback ? null : "on-chain feedback disabled";
    } else if (opts.verifierAccount) {
      feedback = new ReputationWriter({
        network: opts.network,
        account: opts.verifierAccount,
        rpcUrl: opts.rpcUrl,
        transport: opts.transport,
        log: (line) => console.error(`[broker] ${line}`),
      });
    } else {
      feedbackReason = "no verifier key — set XORV_VERIFIER_KEY or XORV_OPERATOR_KEY to write scores to ERC-8004";
    }
  }
  const verifier = verifierClient ? new KimiVerifier({ client: verifierClient, feedback, log }) : undefined;

  const reputationRegistry = networkConfig(opts.network).erc8004.reputation;
  const report = (role: AiRoleName, client: RoleClient | null): AiRoleReport => {
    const spec = ROLES[role];
    const preset = client?.preset ?? resolvePreset(spec.provider, env);
    return {
      enabled: client !== null,
      provider: spec.provider,
      label: preset.label,
      model: preset.model,
      timeoutMs: timeouts[role],
      reason: client ? null : (reasons[role] ?? "off"),
      stats: client ? client.snapshot() : null,
    };
  };

  return {
    screener,
    router,
    verifier,
    report: () => {
      const counts = feedback?.counts() ?? { published: 0, failed: 0, lastError: null };
      const verifierFeedback: VerifierFeedbackReport = {
        onChain: feedback !== null,
        address: feedback?.address ?? null,
        reputationRegistry: feedback?.reputationRegistry ?? reputationRegistry,
        tag1: VERIFIED_TAG1,
        published: counts.published,
        failed: counts.failed,
        lastError: counts.lastError,
        reason: verifierClient ? feedbackReason : "the verifier is off",
      };
      return {
        screener: { ...report("screener", screenerClient), failMode, reasoning: screening.reasoning },
        router: {
          ...report("router", routerClient),
          agent: {
            maxTurns: routing.maxTurns,
            maxToolCalls: routing.maxToolCalls,
            thinking: routing.thinking,
            thinkingBudget: routing.thinking ? routing.thinkingBudget : null,
          },
        },
        verifier: { ...report("verifier", verifierClient), feedback: verifierFeedback },
      };
    },
  };
}

/** One line per role for the boot banner. */
export function describeAiRoles(hooks: AiHooks): string[] {
  const reports = hooks.report?.();
  if (!reports) return ["off"];
  return (Object.entries(reports) as Array<[AiRoleName, AiRoleReport]>).map(([role, r]) => {
    if (!r.enabled) return `${role.padEnd(8)} off — ${r.reason}`;
    const extra =
      role === "screener"
        ? ` (fail ${r.failMode})`
        : role === "verifier"
          ? r.feedback?.onChain
            ? ` → ERC-8004 feedback from ${r.feedback.address}`
            : ` (scores stay off-chain: ${r.feedback?.reason})`
          : "";
    return `${role.padEnd(8)} ${r.label} · ${r.model}${extra}`;
  });
}
