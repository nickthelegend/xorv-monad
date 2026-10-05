/**
 * The agent's brain: Kimi (Moonshot) or Qwen (Alibaba Model Studio), both through
 * their OpenAI-compatible chat-completions APIs with tool calling.
 *
 *   kimi  MOONSHOT_API_KEY   https://api.moonshot.ai/v1                    kimi-k2.6
 *   qwen  DASHSCOPE_API_KEY  XORV_QWEN_BASE_URL (…/compatible-mode/v1)      qwen3.8-max
 *
 * XORV_AGENT_BASE_URL / XORV_AGENT_MODEL override either, which is also how the
 * tests point the agent at a local server.
 */

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
  baseUrl: string;
  apiKey: string;
  model: string;
  extraBody: Record<string, unknown>;
}

export function brainConfig(brain: Brain, env: NodeJS.ProcessEnv = process.env): BrainConfig {
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

/** One chat-completions round trip. */
export async function complete(
  config: BrainConfig,
  messages: Message[],
  tools: ToolSpec[],
  signal?: AbortSignal,
): Promise<Completion> {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    signal: signal ?? AbortSignal.timeout(180_000),
    body: JSON.stringify({ model: config.model, messages, tools, tool_choice: "auto", ...config.extraBody }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${config.brain} answered ${res.status}: ${raw.slice(0, 300)}`);
  const body = JSON.parse(raw) as {
    choices?: Array<{ message?: Completion["message"]; finish_reason?: string | null }>;
    error?: { message?: string };
  };
  if (body.error?.message) throw new Error(`${config.brain}: ${body.error.message}`);
  const choice = body.choices?.[0];
  if (!choice?.message) throw new Error(`${config.brain} returned no message`);
  return { message: { ...choice.message, role: "assistant" }, finishReason: choice.finish_reason ?? null };
}
