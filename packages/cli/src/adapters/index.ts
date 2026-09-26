/**
 * Adapter registry — the one place agent kinds are wired up.
 */

import type { AdapterKind } from "@xorv/protocol";
import type { JobAdapter } from "./base.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import { EchoAdapter } from "./echo.js";
import { GrokAdapter } from "./grok.js";
import { OpenAiCompatibleAdapter } from "./openai-compatible.js";
import { OpenCodeAdapter } from "./opencode.js";

const factories: Record<AdapterKind, () => JobAdapter> = {
  "claude-code": () => new ClaudeCodeAdapter(),
  codex: () => new CodexAdapter(),
  grok: () => new GrokAdapter(),
  opencode: () => new OpenCodeAdapter(),
  "openai-compatible": () => new OpenAiCompatibleAdapter(),
  echo: () => new EchoAdapter(),
};

export function createAdapter(kind: AdapterKind): JobAdapter {
  const factory = factories[kind];
  if (!factory) throw new Error(`unknown adapter "${kind}"`);
  return factory();
}

export function allAdapters(): JobAdapter[] {
  return (Object.keys(factories) as AdapterKind[]).map((kind) => createAdapter(kind));
}

/** Probe every adapter concurrently — used by `xorv init` and `xorv doctor`. */
export async function detectAvailable(): Promise<
  Array<{ adapter: JobAdapter; available: boolean }>
> {
  const adapters = allAdapters();
  const results = await Promise.all(
    adapters.map(async (adapter) => ({
      adapter,
      available: await adapter.available().catch(() => false),
    })),
  );
  return results;
}

export type { JobAdapter, RunInput } from "./base.js";
