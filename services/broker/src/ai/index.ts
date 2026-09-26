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
 */

import { LLM_PRESETS, networkConfig, resolvePreset, type LlmPresetKind } from "@xorv/protocol";
import type { PrivateKeyAccount, Transport } from "viem";
import type { AiRoleConfig } from "../config.js";
import type { AiHooks } from "../ai-hooks.js";
import { RoleClient } from "./client.js";
import { ReputationWriter, VERIFIED_TAG1, type FeedbackSink } from "./feedback.js";
import { QwenRouter, ROUTE_TIMEOUT_MS } from "./router.js";
import { HunyuanScreener, SCREEN_TIMEOUT_MS } from "./screener.js";
import { KimiVerifier, VERIFY_TIMEOUT_MS } from "./verifier.js";
import type { AiRoleName, AiRoleReport, ScreenFailMode, VerifierFeedbackReport } from "./types.js";

export { RoleClient, AiRoleError, invalid } from "./client.js";
export { HunyuanScreener, SCREEN_TIMEOUT_MS } from "./screener.js";
export { QwenRouter, ROUTE_TIMEOUT_MS, candidateTable } from "./router.js";
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

const ROLES: Record<AiRoleName, { provider: LlmPresetKind; env: string; timeoutMs: number }> = {
  screener: { provider: "hunyuan", env: "XORV_SCREENER", timeoutMs: SCREEN_TIMEOUT_MS },
  router: { provider: "qwen", env: "XORV_ROUTER", timeoutMs: ROUTE_TIMEOUT_MS },
  verifier: { provider: "kimi", env: "XORV_VERIFIER", timeoutMs: VERIFY_TIMEOUT_MS },
};

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
    return new RoleClient({ role, preset, timeoutMs: spec.timeoutMs, fetch: opts.fetch });
  };

  const screenerClient = clientFor("screener");
  const routerClient = clientFor("router");
  const verifierClient = clientFor("verifier");

  const screener = screenerClient ? new HunyuanScreener({ client: screenerClient, failMode, log }) : undefined;
  const router = routerClient ? new QwenRouter({ client: routerClient }) : undefined;
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
      timeoutMs: spec.timeoutMs,
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
        screener: { ...report("screener", screenerClient), failMode },
        router: report("router", routerClient),
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
