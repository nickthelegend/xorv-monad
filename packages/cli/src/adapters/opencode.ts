/**
 * OpenCode adapter.
 *
 *   opencode run "<prompt>"
 *
 * OpenCode prints its answer to stdout as prose rather than as a structured
 * stream, so this adapter reports the answer and no step events. Same principle
 * as the Grok adapter: report what the CLI actually tells us.
 */

import type { AdapterKind } from "@xorv/protocol";
import { clampResult, cliAvailable, runChild, type JobAdapter, type RunInput } from "./base.js";

export class OpenCodeAdapter implements JobAdapter {
  readonly kind: AdapterKind = "opencode";
  readonly installHint = "npm i -g opencode-ai, then configure a provider";

  private readonly bin = process.env.XORV_OPENCODE_BIN || "opencode";

  async available(): Promise<boolean> {
    return cliAvailable(this.bin);
  }

  async run(input: RunInput): Promise<string> {
    const args = ["run"];
    if (input.model) args.push("--model", input.model);
    args.push(input.prompt);

    input.emit({ kind: "status", text: "opencode started" });

    const result = await runChild({
      cmd: this.bin,
      args,
      cwd: input.cwd,
      signal: input.signal,
      onLine: (line) => {
        // Stream progress so the poster sees motion; the full stdout is the
        // answer, assembled below.
        if (line.trim()) input.emit({ kind: "message", text: line.slice(0, 500) });
      },
    });

    const text = result.stdout.trim();
    if (result.code !== 0 && !text) {
      throw new Error(`opencode exited ${result.code}: ${result.stderr.slice(-400)}`);
    }
    if (!text) throw new Error("opencode produced no output");
    return clampResult(text);
  }
}
