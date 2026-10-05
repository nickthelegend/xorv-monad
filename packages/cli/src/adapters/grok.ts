/**
 * Grok Code adapter.
 *
 *   grok -p "<prompt>" --output-format json --cwd <dir> --permission-mode <mode>
 *
 * Grok's headless turn is a black box with an answer at the end: the JSON
 * result carries `text` and `thought`, and no tool or file events. So this
 * adapter streams reasoning and the answer, and emits no tool_call events —
 * because there are none to be had, not because it isn't looking. Inferring
 * edits by diffing the directory would put guesses in the job log wearing the
 * same clothes as facts.
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
  type JobAdapter,
  type RunInput,
} from "./base.js";

function grokBin(): string | null {
  if (process.env.XORV_GROK_BIN) return process.env.XORV_GROK_BIN;
  const bundled = firstExisting([
    path.join(os.homedir(), ".grok/bin/grok"),
    "/usr/local/bin/grok",
  ]);
  return bundled ?? "grok";
}

interface GrokResult {
  text?: string;
  thought?: string;
  stopReason?: string;
  error?: string;
  message?: string;
}

export class GrokAdapter implements JobAdapter {
  readonly kind: AdapterKind = "grok";
  readonly installHint = "install the Grok CLI from x.ai and sign in once";

  async available(): Promise<boolean> {
    const bin = grokBin();
    return bin ? cliAvailable(bin) : false;
  }

  async run(input: RunInput): Promise<string> {
    const bin = grokBin();
    if (!bin) throw new Error("grok CLI not found");

    const args = [
      "-p",
      input.prompt,
      "--output-format",
      "json",
      "--cwd",
      input.cwd,
      // Driven headless with no TTY to ask, every mode other than
      // bypassPermissions ends the turn as Cancelled and writes nothing.
      "--permission-mode",
      safeMode() ? "default" : "bypassPermissions",
    ];
    if (input.model) args.push("--model", input.model);

    const result = await runChild({
      cmd: bin,
      args,
      cwd: input.cwd,
      signal: input.signal,
    });

    const raw = result.stdout.trim();
    if (!raw) {
      throw new Error(`grok produced no output (exit ${result.code}): ${result.stderr.slice(-300)}`);
    }

    let parsed: GrokResult;
    try {
      // Grok sometimes prefixes a banner line; take the last JSON object.
      const start = raw.lastIndexOf("{");
      parsed = JSON.parse(start >= 0 ? raw.slice(start) : raw) as GrokResult;
    } catch {
      throw new Error(`grok returned unparseable output: ${raw.slice(0, 300)}`);
    }

    if (parsed.error) throw new Error(parsed.error);
    if (parsed.thought?.trim()) {
      input.emit({ kind: "reasoning", text: parsed.thought.slice(0, 2_000) });
    }
    if (!parsed.text?.trim()) {
      throw new Error(`grok ended with ${parsed.stopReason ?? "no text"}`);
    }
    input.emit({ kind: "message", text: parsed.text });
    return clampResult(parsed.text);
  }
}
