/**
 * Claude Code adapter.
 *
 *   claude -p "<prompt>" --output-format stream-json --verbose
 *          --permission-mode <mode> [--model <model>]
 *
 * The stream-json surface (`system/init`, `assistant`, `result`) is stable
 * across recent Claude Code releases; each line is one JSON object, and
 * anything that doesn't parse is skipped rather than failing the job — a stray
 * banner line on stdout should not cost the provider a payment.
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
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return;
        }
        const text = this.handleEvent(event, input);
        if (text !== null) finalText = text;
        const err = event.type === "result" && event.is_error ? String(event.result ?? "") : "";
        if (err) errorText = err;
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

  /** Returns the assistant text when this event carried one, else null. */
  private handleEvent(event: Record<string, unknown>, input: RunInput): string | null {
    const type = event.type as string | undefined;

    if (type === "system" && (event as { subtype?: string }).subtype === "init") {
      input.emit({ kind: "status", text: "claude session started" });
      return null;
    }

    if (type === "assistant") {
      const message = event.message as
        | { content?: Array<Record<string, unknown>>; model?: string }
        | undefined;
      let latest: string | null = null;
      for (const block of message?.content ?? []) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          latest = block.text;
          input.emit({ kind: "message", text: block.text });
        } else if (
          block.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking.trim()
        ) {
          input.emit({ kind: "reasoning", text: block.thinking.slice(0, 2_000) });
        } else if (block.type === "tool_use") {
          const name = String(block.name ?? "tool");
          const args = (block.input ?? {}) as Record<string, unknown>;
          input.emit({ kind: "tool_call", text: summarize(name, args) });
          const file = args.file_path ?? args.notebook_path;
          if (file && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) {
            input.emit({ kind: "file_edit", text: String(file) });
          }
        }
      }
      return latest;
    }

    if (type === "result") {
      const cost = event.total_cost_usd;
      if (typeof cost === "number") {
        input.emit({ kind: "status", text: `provider cost $${cost.toFixed(4)}` });
        input.onCost?.(cost);
      }
      // `result` carries the final answer even when no assistant block did.
      const text = event.result;
      if (typeof text === "string" && text.trim() && !event.is_error) return text;
    }

    return null;
  }
}

function summarize(name: string, args: Record<string, unknown>): string {
  const interesting = args.file_path ?? args.command ?? args.pattern ?? args.url ?? args.prompt ?? "";
  return `${name}: ${String(interesting).replace(/\s+/g, " ").slice(0, 140)}`;
}
