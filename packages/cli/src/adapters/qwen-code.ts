/**
 * Qwen Code adapter — Alibaba's agentic coding CLI, driving Qwen 3.8 Max.
 *
 *   qwen -p "<prompt>" --auth-type openai -o stream-json
 *        --approval-mode <yolo|plan> --max-wall-time <n>s [-m <model>]
 *
 * Where the `qwen` HTTP adapter sells answers, this sells agentic work: the
 * CLI reads, edits and runs things inside the job directory. Its stream-json
 * output is Claude-Code-shaped (`system` / `assistant` / `result`), so it goes
 * through the same parser as the Claude Code adapter.
 *
 * Credentials. Qwen's OAuth free tier is gone (April 2026), and the CLI's main
 * model reads `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` — not
 * `DASHSCOPE_API_KEY`. So the node copies the Qwen preset's key, endpoint and
 * model into exactly those three variables, in this child's environment only
 * (see `agentCredentials`). The key is never put on argv (`--openai-api-key`
 * would show it to anyone running `ps`), and never allowlisted for other jobs.
 *
 * Budgets. `--max-wall-time` is set just under the job's own deadline so the
 * CLI stops itself and says why (exit 55) before the node has to kill it;
 * exit 53 is its turn limit. Both are a clean, explained failure — the job is
 * reassigned at no extra charge — rather than a half-finished answer sold as a
 * whole one.
 *
 * Safe mode maps to `--approval-mode plan`: the model can read and reason but
 * every write or shell call is refused.
 */

import type { AdapterKind } from "@xorv/protocol";
import { agentCredentials } from "../credentials.js";
import type { SandboxTier } from "../sandbox.js";
import {
  agentEnv,
  clampResult,
  cliAvailable,
  runChild,
  safeMode,
  type JobAdapter,
  type RunInput,
} from "./base.js";
import { usageCostUsd } from "./pricing.js";
import { handleStreamJsonLine } from "./stream-json.js";

/** Qwen Code's documented exit codes for a run that ran out of budget. */
export const QWEN_EXIT_TURN_LIMIT = 53;
export const QWEN_EXIT_BUDGET = 55;

export interface QwenCodeOptions {
  /** The `qwen` executable; defaults to XORV_QWEN_CODE_BIN, then `qwen` on PATH. */
  bin?: string;
  /** Arguments placed before Qwen's own — lets tests run a script through `node`. */
  binArgs?: string[];
  /** Force a containment tier (tests); defaults to the strongest available. */
  sandbox?: SandboxTier;
}

/**
 * The wall-clock budget to hand the CLI: a few seconds under the job deadline,
 * so Qwen reports its own budget stop instead of being SIGKILLed mid-write.
 */
export function qwenWallTime(timeoutMs: number): string {
  const seconds = Math.floor(timeoutMs / 1000);
  return `${Math.max(1, seconds - Math.min(10, Math.floor(seconds / 10)))}s`;
}

export class QwenCodeAdapter implements JobAdapter {
  readonly kind: AdapterKind = "qwen-code";
  readonly installHint =
    "npm i -g @qwen-code/qwen-code (Node ≥ 22), then set XORV_QWEN_API_KEY or DASHSCOPE_API_KEY";

  private readonly opts: QwenCodeOptions;

  constructor(opts: QwenCodeOptions = {}) {
    this.opts = opts;
  }

  private get bin(): string {
    return this.opts.bin ?? (process.env.XORV_QWEN_CODE_BIN?.trim() || "qwen");
  }

  private get binArgs(): string[] {
    return this.opts.binArgs ?? [];
  }

  /** Installed *and* keyed: a qwen binary with no key fails every paid job. */
  async available(): Promise<boolean> {
    if (!agentCredentials(this.kind).OPENAI_API_KEY) return false;
    return cliAvailable(this.bin, [...this.binArgs, "--version"]);
  }

  async run(input: RunInput): Promise<string> {
    const creds = agentCredentials(this.kind);
    if (!creds.OPENAI_API_KEY) {
      throw new Error("Qwen Code has no model key: set XORV_QWEN_API_KEY or DASHSCOPE_API_KEY");
    }
    const model = input.model || creds.OPENAI_MODEL || "";

    const args = [
      ...this.binArgs,
      "-p",
      input.prompt,
      "--auth-type",
      "openai",
      "-o",
      "stream-json",
      "--approval-mode",
      safeMode() ? "plan" : "yolo",
      "--max-wall-time",
      qwenWallTime(input.timeoutMs),
    ];
    if (input.model) args.push("-m", input.model);

    let finalText = "";
    let errorText = "";
    let usage: Record<string, unknown> | null = null;

    const result = await runChild({
      cmd: this.bin,
      args,
      cwd: input.cwd,
      signal: input.signal,
      sandbox: this.opts.sandbox,
      // Explicit env rather than `adapter:` so a pinned model reaches the CLI
      // through OPENAI_MODEL as well as -m; the credentials are the same ones.
      env: agentEnv({ ...creds, ...(model ? { OPENAI_MODEL: model } : {}) }),
      onLine: (line) => {
        const outcome = handleStreamJsonLine(line, input, "qwen");
        if (outcome.text !== null) finalText = outcome.text;
        if (outcome.error) errorText = outcome.error;
        if (outcome.usage) usage = outcome.usage;
      },
    });

    if (result.code === QWEN_EXIT_TURN_LIMIT || result.code === QWEN_EXIT_BUDGET) {
      const which = result.code === QWEN_EXIT_TURN_LIMIT ? "turn limit" : "wall-time / tool-call budget";
      throw new Error(`qwen stopped at its ${which} (exit ${result.code}) before finishing the job`);
    }
    if (errorText) throw new Error(errorText);
    if (result.code !== 0 && !finalText) {
      throw new Error(`qwen exited ${result.code}: ${result.stderr.slice(-400)}`);
    }
    if (!finalText.trim()) throw new Error("qwen produced no output");

    if (usage) {
      // Qwen Code reports tokens, never dollars; price them at the model's rate.
      const cost = usageCostUsd(model, usage);
      if (cost !== null) {
        input.emit({ kind: "status", text: `provider cost $${cost.toFixed(4)}` });
        input.onCost?.(cost);
      }
    }
    return clampResult(finalText);
  }
}
