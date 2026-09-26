/**
 * The Claude-Code-style `stream-json` dialect, parsed once.
 *
 * Claude Code and Qwen Code both print one JSON object per line: a `system`
 * event when the session starts, `assistant` events carrying content blocks
 * (text, thinking, tool_use), and a final `result`. They differ only at the
 * edges — the start subtype (`init` vs `session_start`), how an error result
 * carries its message (`result` vs `error.message`), and whether a dollar cost
 * or only token usage comes back — so one parser with those edges handled
 * keeps the two adapters from drifting apart.
 *
 * Anything that doesn't parse is skipped rather than failing the job: a stray
 * banner line on stdout should not cost the provider a payment.
 */

import type { RunInput } from "./base.js";

/** What one line told us, beyond the events it already emitted. */
export interface StreamLineOutcome {
  /** Assistant (or final result) text carried by this line. */
  text: string | null;
  /** A terminal error the CLI reported in-band. */
  error: string | null;
  /** The final `result` event's token usage, when it had one. */
  usage: Record<string, unknown> | null;
  /** The final `result` event's dollar cost, when the CLI reports one. */
  costUsd: number | null;
  /** True for the terminal `result` event. */
  final: boolean;
}

const NOTHING: StreamLineOutcome = { text: null, error: null, usage: null, costUsd: null, final: false };

/** Parse one stdout line; emits job events for it and reports the rest. */
export function handleStreamJsonLine(line: string, input: RunInput, label: string): StreamLineOutcome {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return NOTHING;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return NOTHING;
  }
  return handleStreamJsonEvent(event, input, label);
}

export function handleStreamJsonEvent(
  event: Record<string, unknown>,
  input: RunInput,
  label: string,
): StreamLineOutcome {
  const type = event.type as string | undefined;
  const subtype = (event as { subtype?: unknown }).subtype;

  if (type === "system" && (subtype === "init" || subtype === "session_start")) {
    input.emit({ kind: "status", text: `${label} session started` });
    return NOTHING;
  }

  if (type === "assistant") {
    const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
    let latest: string | null = null;
    for (const block of message?.content ?? []) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        latest = block.text;
        input.emit({ kind: "message", text: block.text });
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        input.emit({ kind: "reasoning", text: block.thinking.slice(0, 2_000) });
      } else if (block.type === "tool_use") {
        const name = String(block.name ?? "tool");
        const args = (block.input ?? {}) as Record<string, unknown>;
        input.emit({ kind: "tool_call", text: summarize(name, args) });
        const file = args.file_path ?? args.notebook_path ?? args.absolute_path;
        if (file && ["Edit", "Write", "MultiEdit", "NotebookEdit", "edit", "write_file", "replace"].includes(name)) {
          input.emit({ kind: "file_edit", text: String(file) });
        }
      }
    }
    return { ...NOTHING, text: latest };
  }

  if (type === "result") {
    const cost = typeof event.total_cost_usd === "number" ? event.total_cost_usd : null;
    const usage = event.usage && typeof event.usage === "object" ? (event.usage as Record<string, unknown>) : null;
    if (event.is_error) {
      const inner = event.error as { message?: unknown } | undefined;
      const message =
        (typeof event.result === "string" && event.result.trim()) ||
        (typeof inner?.message === "string" && inner.message) ||
        `${label} reported an error${typeof subtype === "string" ? ` (${subtype})` : ""}`;
      return { text: null, error: message, usage, costUsd: cost, final: true };
    }
    // `result` carries the final answer even when no assistant block did.
    const text = typeof event.result === "string" && event.result.trim() ? event.result : null;
    return { text, error: null, usage, costUsd: cost, final: true };
  }

  return NOTHING;
}

function summarize(name: string, args: Record<string, unknown>): string {
  const interesting =
    args.file_path ?? args.absolute_path ?? args.command ?? args.pattern ?? args.url ?? args.prompt ?? "";
  return `${name}: ${String(interesting).replace(/\s+/g, " ").slice(0, 140)}`;
}
