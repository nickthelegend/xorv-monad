/**
 * Claude Code adapter.
 *
 *   claude -p "<prompt>" --output-format stream-json --verbose
 *          --permission-mode <mode> [--model <model>]
 *
 * The stream-json surface (`system/init`, `assistant`, `result`) is stable
 * across recent Claude Code releases; the parser lives in stream-json.ts,
 * shared with the Qwen Code adapter, which speaks the same dialect.
 */

import type { AdapterKind } from "@xorv/protocol";
import {
  clampResult,
  cliAvailable,
  runChild,
  safeMode,
  type JobAdapter,
  type RunInput,
} from "./base.js";
import { handleStreamJsonLine } from "./stream-json.js";

export class ClaudeCodeAdapter implements JobAdapter {
  readonly kind: AdapterKind = "claude-code";
  readonly installHint = "npm i -g @anthropic-ai/claude-code, then run `claude` once to sign in";

  private readonly bin = process.env.XORV_CLAUDE_BIN || "claude";

  async available(): Promise<boolean> {
    return cliAvailable(this.bin);
  }

  async run(input: RunInput): Promise<string> {
    const args = [
      "-p",
      input.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      // Edits are confined to the job's scratch cwd. In safe mode we forbid the
      // filesystem and shell outright and keep only text generation.
      "--permission-mode",
      safeMode() ? "plan" : "acceptEdits",
    ];
    if (input.model) args.push("--model", input.model);

    let finalText = "";
    let errorText = "";

    const result = await runChild({
      adapter: this.kind,
      cmd: this.bin,
      args,
      cwd: input.cwd,
      signal: input.signal,
      onLine: (line) => {
        const outcome = handleStreamJsonLine(line, input, "claude");
        if (outcome.text !== null) finalText = outcome.text;
        if (outcome.error) errorText = outcome.error;
        if (outcome.costUsd !== null) {
          input.emit({ kind: "status", text: `provider cost $${outcome.costUsd.toFixed(4)}` });
          input.onCost?.(outcome.costUsd);
        }
      },
    });

    if (errorText) throw new Error(errorText);
    if (result.code !== 0 && !finalText) {
      throw new Error(`claude exited ${result.code}: ${result.stderr.slice(-400)}`);
    }
    if (!finalText.trim()) {
      throw new Error("claude produced no output");
    }
    return clampResult(finalText);
  }
}
