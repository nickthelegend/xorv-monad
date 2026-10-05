/**
 * Codex adapter.
 *
 *   codex exec --json --skip-git-repo-check -C <dir> -s <sandbox> "<prompt>"
 *
 * The CLI ships inside the desktop app as well as on PATH, so `available()`
 * checks both — a Mac with Codex.app installed and nothing on PATH is the
 * common case, and refusing to find it there would be wrong.
 */

import os from "node:os";
import path from "node:path";
import type { AdapterKind } from "@xorv/protocol";
import {
  clampResult,
  cliAvailable,
  firstExisting,
  runChild,
  safeMode,
  stderrSummary,
  type JobAdapter,
  type RunInput,
} from "./base.js";
import { detectSandbox } from "../sandbox.js";

/**
 * Codex's own sandbox mode for the shell commands it runs.
 *
 * On macOS Codex contains those commands with seatbelt, and seatbelt cannot be
 * applied from inside a process already running under a profile: with Xorv's
 * active, every command failed with `sandbox_apply: Operation not permitted`
 * (exit 71). So under Xorv's profile Codex's own layer is off and ours is the
 * boundary — writes confined to the job directory, credentials unreadable.
 * Safe mode stays read-only either way; commands failing is what it asks for.
 */
function codexSandboxMode(): string {
  if (safeMode()) return "read-only";
  return process.platform === "darwin" && detectSandbox() === "seatbelt" ? "danger-full-access" : "workspace-write";
}

function codexBin(): string | null {
  if (process.env.XORV_CODEX_BIN) return process.env.XORV_CODEX_BIN;
  const bundled = firstExisting([
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(os.homedir(), "Applications/Codex.app/Contents/Resources/codex"),
  ]);
  return bundled ?? "codex";
}

export class CodexAdapter implements JobAdapter {
  readonly kind: AdapterKind = "codex";
  readonly installHint = "npm i -g @openai/codex, or install Codex.app and sign in once";

  async available(): Promise<boolean> {
    const bin = codexBin();
    return bin ? cliAvailable(bin) : false;
  }

  async run(input: RunInput): Promise<string> {
    const bin = codexBin();
    if (!bin) throw new Error("codex CLI not found");

    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      input.cwd,
      "-s",
      codexSandboxMode(),
    ];
    if (input.model) args.push("-m", input.model);
    args.push(input.prompt);

    let finalText = "";
    let failure = "";

    const result = await runChild({
      cmd: bin,
      args,
      cwd: input.cwd,
      signal: input.signal,
      adapter: this.kind,
      onLine: (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return;
        }

        if (event.type === "item.completed" || event.type === "item.started") {
          const item = (event.item ?? {}) as Record<string, unknown>;
          const itemType = String(item.type ?? "");
          if (itemType === "agent_message" && typeof item.text === "string") {
            finalText = item.text;
            input.emit({ kind: "message", text: item.text });
          } else if (itemType === "reasoning" && typeof item.text === "string") {
            input.emit({ kind: "reasoning", text: item.text.slice(0, 2_000) });
          } else if (itemType === "command_execution" && event.type === "item.completed") {
            input.emit({ kind: "tool_call", text: `shell: ${String(item.command ?? "").slice(0, 140)}` });
          } else if (itemType === "file_change") {
            for (const change of (item.changes ?? []) as Array<{ path?: string; kind?: string }>) {
              input.emit({ kind: "file_edit", text: `${change.kind ?? "change"} ${change.path ?? ""}` });
            }
          }
        } else if (event.type === "thread.started") {
          input.emit({ kind: "status", text: "codex thread started" });
        } else if (event.type === "error" || event.type === "turn.failed") {
          const nested = (event.error ?? {}) as Record<string, unknown>;
          failure = String(nested.message ?? event.message ?? "codex error");
          input.emit({ kind: "error", text: failure });
        }
      },
    });

    if (result.code !== 0 && !finalText) {
      // Codex says why it stopped — a spent quota, a rejected login — in a JSON
      // event. stderr tends to end in unrelated warnings (a malformed skill file
      // elsewhere on the machine), which is what a buyer saw instead of
      // "You've hit your usage limit". It stays as the fallback.
      throw new Error(failure ? `codex: ${failure}` : `codex exited ${result.code}: ${stderrSummary(result.stderr)}`);
    }
    if (!finalText.trim()) throw new Error("codex produced no output");
    return clampResult(finalText);
  }
}
