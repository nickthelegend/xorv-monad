/**
 * The agent's brain: Kimi (Moonshot) or Qwen (Alibaba Model Studio), both through
 * their OpenAI-compatible chat-completions APIs with tool calling.
 *
 *   kimi  MOONSHOT_API_KEY   https://api.moonshot.ai/v1                    kimi-k2.6
 *   qwen  DASHSCOPE_API_KEY  XORV_QWEN_BASE_URL (…/compatible-mode/v1)      qwen3.8-max
 *
 * XORV_AGENT_BASE_URL / XORV_AGENT_MODEL override either, which is also how the
 * tests point the agent at a local server.
 *
 * Fixtures, for running without a key — and labelled as such everywhere they're used:
 *
 *   XORV_AGENT_FIXTURE=path.json   FIXTURE MODE: replay recorded model responses in order
 *                                  instead of calling the API. Everything after the brain
 *                                  (MCP, broker, escrow, chain) stays real.
 *   XORV_AGENT_RECORD=path.json    record every live request/response pair to a fixture.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type Brain = "kimi" | "qwen";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A chat message as the API takes it. Assistant turns are passed back verbatim:
 * Kimi's reasoning models need their `reasoning_content` on the next request. */
export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface BrainConfig {
  brain: Brain;
  /** Set in fixture mode: responses come from this file, not the API. */
  fixture?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraBody: Record<string, unknown>;
}

export function brainConfig(brain: Brain, env: NodeJS.ProcessEnv = process.env): BrainConfig {
  const fixture = env.XORV_AGENT_FIXTURE?.trim();
  if (fixture) {
    const recorded = loadFixture(fixture);
    if (recorded.brain !== brain) throw new Error(`fixture ${fixture} was recorded with ${recorded.brain}, not ${brain}`);
    return { brain, fixture, baseUrl: "fixture", apiKey: "", model: recorded.model, extraBody: {} };
  }
  if (brain === "kimi") {
    const apiKey = env.MOONSHOT_API_KEY?.trim() || env.XORV_KIMI_API_KEY?.trim() || "";
    if (!apiKey) throw new Error("set MOONSHOT_API_KEY (platform.moonshot.ai) to use Kimi as the agent's brain");
    return {
      brain,
      baseUrl: (env.XORV_AGENT_BASE_URL || env.XORV_KIMI_BASE_URL || "https://api.moonshot.ai/v1").replace(/\/+$/, ""),
      apiKey,
      model: env.XORV_AGENT_MODEL || env.XORV_KIMI_MODEL || "kimi-k2.6",
      extraBody: {},
    };
  }
  const apiKey = env.DASHSCOPE_API_KEY?.trim() || env.XORV_QWEN_API_KEY?.trim() || "";
  if (!apiKey) throw new Error("set DASHSCOPE_API_KEY (Alibaba Model Studio) to use Qwen as the agent's brain");
  return {
    brain,
    baseUrl: (
      env.XORV_AGENT_BASE_URL ||
      env.XORV_QWEN_BASE_URL ||
      "https://maas.qwencloudapi.com/compatible-mode/v1"
    ).replace(/\/+$/, ""),
    apiKey,
    model: env.XORV_AGENT_MODEL || env.XORV_QWEN_MODEL || "qwen3.8-max",
    // Thinking on: the agent plans spending, which is exactly what it's for.
    extraBody: { enable_thinking: true },
  };
}

export interface Completion {
  message: Extract<Message, { role: "assistant" }>;
  finishReason: string | null;
}

/** A recorded conversation with a real model: the raw API responses, in order. */
export interface Fixture {
  brain: Brain;
  model: string;
  /** Where it came from: "recorded" from a live API, or "authored" from the documented format. */
  source: "recorded" | "authored";
  note?: string;
  responses: Array<Record<string, unknown>>;
}

export function loadFixture(path: string): Fixture {
  const f = JSON.parse(readFileSync(path, "utf8")) as Fixture;
  if (!Array.isArray(f.responses) || f.responses.length === 0) throw new Error(`fixture ${path} has no responses`);
  return f;
}

/** Replay position per fixture file, so one process can run several agents. */
const replayed = new Map<string, number>();

function parseCompletion(config: BrainConfig, body: Record<string, unknown>): Completion {
  const typed = body as {
    choices?: Array<{ message?: Completion["message"]; finish_reason?: string | null }>;
    error?: { message?: string };
  };
  if (typed.error?.message) throw new Error(`${config.brain}: ${typed.error.message}`);
  const choice = typed.choices?.[0];
  if (!choice?.message) throw new Error(`${config.brain} returned no message`);
  return { message: { ...choice.message, role: "assistant" }, finishReason: choice.finish_reason ?? null };
}

/** One chat-completions round trip. */
export async function complete(
  config: BrainConfig,
  messages: Message[],
  tools: ToolSpec[],
  signal?: AbortSignal,
): Promise<Completion> {
  if (config.fixture) {
    const fixture = loadFixture(config.fixture);
    const i = replayed.get(config.fixture) ?? 0;
    const body = fixture.responses[i];
    if (!body) throw new Error(`fixture ${config.fixture} ran out after ${i} responses`);
    replayed.set(config.fixture, i + 1);
    return parseCompletion(config, body);
  }
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    signal: signal ?? AbortSignal.timeout(180_000),
    body: JSON.stringify({ model: config.model, messages, tools, tool_choice: "auto", ...config.extraBody }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${config.brain} answered ${res.status}: ${raw.slice(0, 300)}`);
  const body = JSON.parse(raw) as Record<string, unknown>;
  record(config, body);
  return parseCompletion(config, body);
}

/** XORV_AGENT_RECORD: keep each live response, so a real run becomes a replayable fixture. */
function record(config: BrainConfig, body: Record<string, unknown>): void {
  const path = process.env.XORV_AGENT_RECORD?.trim();
  if (!path) return;
  const fixture: Fixture = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Fixture)
    : { brain: config.brain, model: config.model, source: "recorded", note: `recorded ${new Date().toISOString()}`, responses: [] };
  fixture.responses.push(body);
  writeFileSync(path, JSON.stringify(fixture, null, 2));
}
