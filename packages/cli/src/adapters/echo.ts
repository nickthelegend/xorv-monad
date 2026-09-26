/**
 * Echo adapter — the one that always works.
 *
 * It exists so the whole path (quote → 402 → sign → settle → dispatch → stream
 * → receipt) can be exercised on a machine with no agent CLI installed and no
 * subscription at all. Every other adapter depends on someone else's binary
 * being present and logged in; this one depends on nothing, which makes it the
 * right default for `xorv init` on a fresh machine and for CI.
 *
 * It is priced like the toy it is, and labelled as a test capability wherever
 * it shows up, so nobody mistakes it for real capacity.
 */

import type { AdapterKind } from "@xorv/protocol";
import type { JobAdapter, RunInput } from "./base.js";

export class EchoAdapter implements JobAdapter {
  readonly kind: AdapterKind = "echo";
  readonly installHint = "built in — nothing to install";

  async available(): Promise<boolean> {
    return true;
  }

  async run(input: RunInput): Promise<string> {
    input.emit({ kind: "status", text: "echo adapter engaged" });

    const words = input.prompt.trim().split(/\s+/);
    // A short, interruptible pause so the live stream visibly streams rather
    // than snapping to done — and so cancellation has something to cancel.
    for (const step of ["reading the prompt", "composing a reply", "finishing up"]) {
      if (input.signal.aborted) throw new Error("cancelled");
      input.emit({ kind: "status", text: step });
      await sleep(220, input.signal);
    }

    const reply = [
      `Echo from a Xorv provider node.`,
      ``,
      `You asked (${words.length} word${words.length === 1 ? "" : "s"}):`,
      `> ${input.prompt.trim().slice(0, 800)}`,
      ``,
      `This job was matched to a live provider, paid for in a real on-chain`,
      `transfer over x402, and executed here. Swap this capability for`,
      `claude-code, codex, grok or an OpenAI-compatible endpoint to sell actual`,
      `model capacity — the payment path is identical.`,
    ].join("\n");

    input.emit({ kind: "message", text: reply });
    return reply;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });
}
