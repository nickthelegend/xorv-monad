/**
 * OpenAI-compatible LLM access for the three sponsor models.
 *
 * Qwen 3.8 Max (Alibaba Model Studio), Kimi K3 (Moonshot) and Hunyuan hy4
 * (Tencent TokenHub) all speak the OpenAI chat-completions dialect, so one
 * small client with three presets covers the provider adapters (streaming,
 * reasoning shown live in the job log) *and* the broker's core-loop roles
 * (Qwen routes, Hunyuan screens, Kimi verifies), which need a fast,
 * non-streaming JSON answer.
 *
 * Deliberately no SDK: the OpenAI SDK would pull a large dependency into every
 * package for two HTTP calls, and hides the one thing that differs between
 * these providers — the vendor-specific body fields (`enable_thinking`,
 * `reasoning_effort`) — behind `extra_body`. `fetch` is injectable everywhere
 * so tests run with no network and no keys.
 *
 * Keys are read from the environment only, never from argv (anything on a
 * command line shows up in `ps`), and are paired with a base URL in the preset
 * because a DashScope key only works in the region that issued it.
 */

import { ambientEnv, readEnv } from "./env.js";

export type LlmPresetKind = "qwen" | "kimi" | "hunyuan";

export interface LlmPreset {
  kind: LlmPresetKind;
  /** What the UI shows, e.g. "Qwen 3.8 Max". */
  label: string;
  /** Env var that overrides the base URL. */
  baseUrlEnv: string;
  defaultBaseUrl: string;
  /** Env vars checked for the API key, first set one wins. */
  keyEnvs: readonly string[];
  /** Env var that overrides the model id. */
  modelEnv: string;
  defaultModel: string;
  /**
   * Body fields for the fast JSON calls (`chatJson`): thinking off where the
   * provider allows it. Qwen 3.8 thinks by default and `enable_thinking:false`
   * turns it off; Kimi K3 always thinks, so the most we can do is
   * `reasoning_effort:"low"`; TokenHub's hy4 thinking switch is undocumented.
   */
  fastJsonBody: Readonly<Record<string, unknown>>;
}

export const LLM_PRESETS: Readonly<Record<LlmPresetKind, LlmPreset>> = {
  qwen: {
    kind: "qwen",
    label: "Qwen 3.8 Max",
    baseUrlEnv: "XORV_QWEN_BASE_URL",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keyEnvs: ["XORV_QWEN_API_KEY", "DASHSCOPE_API_KEY"],
    modelEnv: "XORV_QWEN_MODEL",
    defaultModel: "qwen3.8-max",
    fastJsonBody: { enable_thinking: false },
  },
  kimi: {
    kind: "kimi",
    label: "Kimi K3",
    baseUrlEnv: "XORV_KIMI_BASE_URL",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    keyEnvs: ["XORV_KIMI_API_KEY", "MOONSHOT_API_KEY"],
    modelEnv: "XORV_KIMI_MODEL",
    defaultModel: "kimi-k3",
    fastJsonBody: { reasoning_effort: "low" },
  },
  hunyuan: {
    kind: "hunyuan",
    label: "Hunyuan hy4",
    baseUrlEnv: "XORV_HUNYUAN_BASE_URL",
    defaultBaseUrl: "https://tokenhub-intl.tencentcloudmaas.com/v1",
    keyEnvs: ["XORV_HUNYUAN_API_KEY", "TOKENHUB_API_KEY"],
    modelEnv: "XORV_HUNYUAN_MODEL",
    defaultModel: "hy4-preview",
    fastJsonBody: {},
  },
};

/** A preset with its environment applied: where to call, with what, as which model. */
export interface ResolvedLlmPreset {
  kind: LlmPresetKind;
  label: string;
  /** No trailing slash. */
  baseUrl: string;
  /** Null when none of the preset's key variables is set. */
  apiKey: string | null;
  /** Which variable supplied the key, for diagnostics (never the key itself). */
  keyEnv: string | null;
  model: string;
  fastJsonBody: Readonly<Record<string, unknown>>;
}

/** Is `value` one of the preset names? */
export function isLlmPresetKind(value: unknown): value is LlmPresetKind {
  return value === "qwen" || value === "kimi" || value === "hunyuan";
}

/**
 * Apply an environment to a preset. A missing key is reported as `apiKey:
 * null` rather than thrown, so callers can decide between "turn this role
 * off" (the broker) and "fail loudly" (a provider adapter).
 */
export function resolvePreset(
  kind: LlmPresetKind,
  env: Record<string, string | undefined> = ambientEnv(),
): ResolvedLlmPreset {
  const preset = LLM_PRESETS[kind];
  if (!preset) throw new Error(`unknown LLM preset "${String(kind)}" (expected qwen, kimi or hunyuan)`);
  let apiKey: string | null = null;
  let keyEnv: string | null = null;
  for (const name of preset.keyEnvs) {
    const value = readEnv(name, env);
    if (value) {
      apiKey = value;
      keyEnv = name;
      break;
    }
  }
  return {
    kind,
    label: preset.label,
    baseUrl: (readEnv(preset.baseUrlEnv, env) ?? preset.defaultBaseUrl).replace(/\/+$/, ""),
    apiKey,
    keyEnv,
    model: readEnv(preset.modelEnv, env) ?? preset.defaultModel,
    fastJsonBody: preset.fastJsonBody,
  };
}

/** An error from an LLM provider, with the HTTP status or provider code when there was one. */
export class LlmError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  constructor(message: string, opts: { status?: number | null; code?: string | null } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  [key: string]: unknown;
}

/** Token usage, normalized; null fields mean the provider didn't say (not zero). */
export interface LlmUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  /** The provider's usage object verbatim. */
  raw: Record<string, unknown>;
}

export type LlmDelta =
  | { kind: "reasoning"; text: string }
  | { kind: "text"; text: string }
  /** Tool-call fragments: `args` arrive as string pieces to concatenate by `index`. */
  | { kind: "tool"; index: number; id?: string; name?: string; args?: string }
  | { kind: "usage"; usage: LlmUsage };

type FetchLike = typeof globalThis.fetch;

interface CallOptions {
  preset: ResolvedLlmPreset | LlmPresetKind;
  model?: string;
  /** Extra body fields (tools, temperature, vendor switches); override the defaults. */
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: FetchLike;
}

function presetOf(preset: ResolvedLlmPreset | LlmPresetKind): ResolvedLlmPreset {
  return typeof preset === "string" ? resolvePreset(preset) : preset;
}

function requireKey(preset: ResolvedLlmPreset): string {
  if (preset.apiKey) return preset.apiKey;
  throw new LlmError(
    `${preset.label} is not configured: set ${LLM_PRESETS[preset.kind].keyEnvs.join(" or ")}`,
  );
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs !== undefined && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Normalize an OpenAI-style usage object (Qwen, Kimi and TokenHub all send this shape). */
export function normalizeUsage(raw: Record<string, unknown>): LlmUsage {
  const details = raw.completion_tokens_details as Record<string, unknown> | undefined;
  return {
    promptTokens: numberOrNull(raw.prompt_tokens),
    completionTokens: numberOrNull(raw.completion_tokens),
    totalTokens: numberOrNull(raw.total_tokens),
    reasoningTokens: numberOrNull(details?.reasoning_tokens),
    raw,
  };
}

/** Pull a readable message out of an error body, whichever shape the provider used. */
function errorMessage(body: unknown): { message: string | null; code: string | null } {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const inner = record.error;
    if (inner && typeof inner === "object") {
      const e = inner as Record<string, unknown>;
      return {
        message: typeof e.message === "string" ? e.message : JSON.stringify(e),
        code: typeof e.code === "string" ? e.code : typeof e.type === "string" ? e.type : null,
      };
    }
    if (typeof inner === "string") return { message: inner, code: null };
    if (typeof record.message === "string") {
      return { message: record.message, code: typeof record.code === "string" ? record.code : null };
    }
  }
  return { message: null, code: null };
}

async function postChat(
  preset: ResolvedLlmPreset,
  body: Record<string, unknown>,
  opts: CallOptions,
  accept: string,
): Promise<Response> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const res = await doFetch(`${preset.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: accept,
      Authorization: `Bearer ${requireKey(preset)}`,
    },
    body: JSON.stringify(body),
    signal: combinedSignal(opts.signal, opts.timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const { message, code } = errorMessage(parsed);
    throw new LlmError(`${preset.label} → ${res.status}: ${message ?? (text.slice(0, 300) || res.statusText)}`, {
      status: res.status,
      code,
    });
  }
  return res;
}

/**
 * The `data:` payloads of a server-sent-event stream, one per event.
 *
 * Tolerant of the framing differences seen in the wild: CRLF or bare CR line
 * endings (including a CRLF split across two network chunks, which a naive
 * per-chunk replace turns into a spurious blank line), multi-line `data:`
 * fields, `event:`/`id:` lines, and `: keep-alive` comments. A final event
 * with no trailing blank line is still delivered.
 */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let heldCR = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      let text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (heldCR) {
        text = `\r${text}`;
        heldCR = false;
      }
      // A trailing CR may be the first half of a CRLF; decide once the next chunk arrives.
      if (!done && text.endsWith("\r")) {
        heldCR = true;
        text = text.slice(0, -1);
      }
      buffer += text.replace(/\r\n?/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const data = eventData(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (data !== null) yield data;
      }
      if (done) {
        const data = eventData(buffer);
        if (data !== null) yield data;
        return;
      }
    }
  } finally {
    // Stop the upstream body if the consumer bailed early ([DONE], error, break).
    await reader.cancel().catch(() => undefined);
  }
}

function eventData(event: string): string | null {
  const lines = event.split("\n").filter((line) => line.startsWith("data:"));
  if (lines.length === 0) return null;
  return lines.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
}

/**
 * Stream a chat completion as typed deltas: reasoning, answer text, tool-call
 * fragments, and a final usage record.
 *
 * Qwen and Kimi stream their thinking as `delta.reasoning_content` before the
 * answer's `delta.content`; usage arrives once, on the last chunk (with an
 * empty `choices`), when `stream_options.include_usage` is set — which this
 * always sets. A missing usage record means "unknown cost", not zero.
 *
 * Providers report some failures *inside* a 200 stream (quota exhausted,
 * content filter); those arrive as an `error` chunk and are thrown as
 * `LlmError` rather than ending the stream as if it had succeeded.
 */
export async function* streamChat(
  opts: CallOptions & { messages: ChatMessage[] },
): AsyncGenerator<LlmDelta> {
  const preset = presetOf(opts.preset);
  const res = await postChat(
    preset,
    {
      model: opts.model ?? preset.model,
      messages: opts.messages,
      ...opts.body,
      stream: true,
      stream_options: { include_usage: true },
    },
    opts,
    "text/event-stream",
  );
  if (!res.body) throw new LlmError(`${preset.label} returned an empty stream`);

  for await (const data of sseData(res.body)) {
    if (data === "[DONE]") return;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new LlmError(`${preset.label} sent a malformed stream chunk: ${data.slice(0, 200)}`);
    }
    if (chunk.error || (typeof chunk.code === "string" && typeof chunk.message === "string" && !chunk.choices)) {
      const { message, code } = errorMessage(chunk);
      throw new LlmError(`${preset.label} stream error: ${message ?? "unknown"}`, { code });
    }
    if (chunk.usage && typeof chunk.usage === "object") {
      yield { kind: "usage", usage: normalizeUsage(chunk.usage as Record<string, unknown>) };
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const delta = (choices[0] as { delta?: Record<string, unknown> } | undefined)?.delta;
    if (!delta) continue;
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string" && reasoning) yield { kind: "reasoning", text: reasoning };
    if (typeof delta.content === "string" && delta.content) yield { kind: "text", text: delta.content };
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls as Array<Record<string, unknown>>) {
        const fn = call.function as { name?: unknown; arguments?: unknown } | undefined;
        yield {
          kind: "tool",
          index: typeof call.index === "number" ? call.index : 0,
          ...(typeof call.id === "string" ? { id: call.id } : {}),
          ...(typeof fn?.name === "string" ? { name: fn.name } : {}),
          ...(typeof fn?.arguments === "string" ? { args: fn.arguments } : {}),
        };
      }
    }
  }
}

export interface ChatJsonResult<T> {
  data: T;
  /** The model that answered (from the response, falling back to the one asked for). */
  model: string;
  usage: LlmUsage | null;
  /** The raw text content, for audit logs. */
  raw: string;
  latencyMs: number;
}

/** Default for request-path calls: a router that takes longer than this is slower than no router. */
export const CHAT_JSON_TIMEOUT_MS = 15_000;

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  return "";
}

/** Parse a model's JSON answer, forgiving code fences and stray prose around one object. */
export function parseJsonObject(text: string): Record<string, unknown> {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const attempt = (candidate: string): unknown => {
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  };
  let value = attempt(unfenced);
  if (value === undefined) {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) value = attempt(unfenced.slice(start, end + 1));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LlmError(`model did not return a JSON object: ${text.slice(0, 200)}`);
  }
  return value as Record<string, unknown>;
}

/**
 * One non-streaming chat call that must come back as a JSON object — the shape
 * of every broker core-loop role (route, screen, verify).
 *
 * `response_format: {type: "json_object"}` asks for JSON mode, and the system
 * prompt says so too (OpenAI-style JSON mode requires the word "JSON" in the
 * messages, and it is a useful nudge for providers whose JSON mode is loose).
 * Thinking is turned down via the preset's `fastJsonBody`: these calls sit on
 * the request path and a deliberating router is worse than none. `validate`
 * narrows the parsed object to `T` (and should throw on a bad shape) so a
 * caller can fall back to its deterministic path on any failure.
 */
export async function chatJson<T = Record<string, unknown>>(
  opts: CallOptions & {
    system: string;
    user: string;
    /** A compact description of the expected object, e.g. `{"score": 0-100, "pass": boolean}`. */
    schemaHint?: string;
    validate?: (value: Record<string, unknown>) => T;
  },
): Promise<ChatJsonResult<T>> {
  const preset = presetOf(opts.preset);
  const model = opts.model ?? preset.model;
  const system =
    `${opts.system.trim()}\n\nRespond with a single JSON object and nothing else` +
    `${opts.schemaHint ? `, matching this shape: ${opts.schemaHint}` : ""}.`;
  const started = Date.now();
  const res = await postChat(
    preset,
    {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: opts.user },
      ],
      response_format: { type: "json_object" },
      ...preset.fastJsonBody,
      ...opts.body,
      stream: false,
    },
    { ...opts, timeoutMs: opts.timeoutMs ?? CHAT_JSON_TIMEOUT_MS },
    "application/json",
  );
  const body = (await res.json()) as Record<string, unknown>;
  if (body.error) {
    const { message, code } = errorMessage(body);
    throw new LlmError(`${preset.label} error: ${message ?? "unknown"}`, { code });
  }
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
  const raw = messageText(message?.content);
  if (!raw.trim()) throw new LlmError(`${preset.label} returned an empty answer`);
  const parsed = parseJsonObject(raw);
  const data = opts.validate ? opts.validate(parsed) : (parsed as T);
  return {
    data,
    model: typeof body.model === "string" ? body.model : model,
    usage: body.usage && typeof body.usage === "object" ? normalizeUsage(body.usage as Record<string, unknown>) : null,
    raw,
    latencyMs: Date.now() - started,
  };
}
