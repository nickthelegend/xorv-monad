/**
 * The LLM client sits on two hot paths — a provider streaming a paid job, and
 * the broker routing/screening/verifying on every request — so its failure
 * modes are pinned: SSE framing quirks (CRLF, split chunks, keep-alives),
 * errors reported *inside* a 200 stream, usage that arrives on a choice-less
 * final chunk, and JSON answers wrapped in prose. All with an injected fetch:
 * no network, no keys.
 */

import { describe, expect, it } from "vitest";
import {
  CHAT_JSON_TIMEOUT_MS,
  LLM_PRESETS,
  LlmError,
  chatJson,
  isLlmPresetKind,
  normalizeUsage,
  parseJsonObject,
  resolvePreset,
  streamChat,
  type LlmDelta,
  type ResolvedLlmPreset,
} from "../src/llm.js";

const QWEN: ResolvedLlmPreset = resolvePreset("qwen", { XORV_QWEN_API_KEY: "sk-test-qwen" });
const KIMI: ResolvedLlmPreset = resolvePreset("kimi", { MOONSHOT_API_KEY: "sk-test-kimi" });

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** A fetch that answers with a byte stream delivered in exactly the given chunks. */
function sseFetch(chunks: Array<string | Uint8Array>, captured: Captured[] = [], status = 200) {
  const encoder = new TextEncoder();
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        controller.close();
      },
    });
    return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
  };
  return fetchImpl as typeof fetch;
}

function jsonFetch(body: unknown, captured: Captured[] = [], status = 200) {
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return fetchImpl as typeof fetch;
}

async function collect(gen: AsyncGenerator<LlmDelta>): Promise<LlmDelta[]> {
  const out: LlmDelta[] = [];
  for await (const delta of gen) out.push(delta);
  return out;
}

const chunk = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;

describe("presets", () => {
  it("pins the sponsor endpoints, key variables and model ids", () => {
    expect(LLM_PRESETS.qwen).toMatchObject({
      baseUrlEnv: "XORV_QWEN_BASE_URL",
      defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      keyEnvs: ["XORV_QWEN_API_KEY", "DASHSCOPE_API_KEY"],
      defaultModel: "qwen3.8-max",
      fastJsonBody: { enable_thinking: false },
    });
    expect(LLM_PRESETS.kimi).toMatchObject({
      defaultBaseUrl: "https://api.moonshot.ai/v1",
      keyEnvs: ["XORV_KIMI_API_KEY", "MOONSHOT_API_KEY"],
      defaultModel: "kimi-k3",
      fastJsonBody: { reasoning_effort: "low" },
    });
    expect(LLM_PRESETS.hunyuan).toMatchObject({
      defaultBaseUrl: "https://tokenhub-intl.tencentcloudmaas.com/v1",
      keyEnvs: ["XORV_HUNYUAN_API_KEY", "TOKENHUB_API_KEY"],
      defaultModel: "hy4-preview",
    });
    expect(isLlmPresetKind("kimi")).toBe(true);
    expect(isLlmPresetKind("gpt")).toBe(false);
  });

  it("resolves the first key variable that is set, and says which one", () => {
    const both = resolvePreset("qwen", { XORV_QWEN_API_KEY: "sk-xorv", DASHSCOPE_API_KEY: "sk-dash" });
    expect(both).toMatchObject({ apiKey: "sk-xorv", keyEnv: "XORV_QWEN_API_KEY" });
    const fallback = resolvePreset("qwen", { XORV_QWEN_API_KEY: "  ", DASHSCOPE_API_KEY: "sk-dash" });
    expect(fallback).toMatchObject({ apiKey: "sk-dash", keyEnv: "DASHSCOPE_API_KEY" });
  });

  it("reports a missing key as null instead of throwing, so a role can switch itself off", () => {
    const none = resolvePreset("hunyuan", {});
    expect(none).toMatchObject({
      kind: "hunyuan",
      apiKey: null,
      keyEnv: null,
      baseUrl: "https://tokenhub-intl.tencentcloudmaas.com/v1",
      model: "hy4-preview",
    });
  });

  it("applies base-URL and model overrides, stripping trailing slashes", () => {
    const resolved = resolvePreset("kimi", {
      MOONSHOT_API_KEY: "k",
      XORV_KIMI_BASE_URL: "https://api.moonshot.cn/v1/",
      XORV_KIMI_MODEL: "kimi-k2.6",
    });
    expect(resolved.baseUrl).toBe("https://api.moonshot.cn/v1");
    expect(resolved.model).toBe("kimi-k2.6");
  });

  it("reads process.env when no environment is passed", () => {
    const saved = process.env.XORV_HUNYUAN_API_KEY;
    process.env.XORV_HUNYUAN_API_KEY = "sk-from-env";
    try {
      expect(resolvePreset("hunyuan").apiKey).toBe("sk-from-env");
    } finally {
      if (saved === undefined) delete process.env.XORV_HUNYUAN_API_KEY;
      else process.env.XORV_HUNYUAN_API_KEY = saved;
    }
  });

  it("refuses an unknown preset", () => {
    expect(() => resolvePreset("gpt" as never, {})).toThrow(/unknown LLM preset/);
  });
});

describe("streamChat", () => {
  it("posts a streaming request with usage enabled and the bearer key", async () => {
    const captured: Captured[] = [];
    await collect(
      streamChat({
        preset: QWEN,
        messages: [{ role: "user", content: "hi" }],
        body: { enable_thinking: true },
        fetch: sseFetch(["data: [DONE]\n\n"], captured),
      }),
    );
    expect(captured[0]!.url).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect((captured[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-qwen");
    expect((captured[0]!.init.headers as Record<string, string>).Accept).toBe("text/event-stream");
    expect(captured[0]!.body).toEqual({
      model: "qwen3.8-max",
      messages: [{ role: "user", content: "hi" }],
      enable_thinking: true,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("yields reasoning, then text, then usage from a choice-less final chunk", async () => {
    const deltas = await collect(
      streamChat({
        preset: KIMI,
        messages: [{ role: "user", content: "2+2?" }],
        fetch: sseFetch([
          chunk({ role: "assistant", reasoning_content: "Adding " }),
          chunk({ reasoning_content: "two and two." }),
          chunk({ content: "4" }),
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21, completion_tokens_details: { reasoning_tokens: 7 } },
          })}\n\n`,
          "data: [DONE]\n\n",
        ]),
      }),
    );
    expect(deltas).toEqual([
      { kind: "reasoning", text: "Adding " },
      { kind: "reasoning", text: "two and two." },
      { kind: "text", text: "4" },
      {
        kind: "usage",
        usage: {
          promptTokens: 12,
          completionTokens: 9,
          totalTokens: 21,
          reasoningTokens: 7,
          raw: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21, completion_tokens_details: { reasoning_tokens: 7 } },
        },
      },
    ]);
  });

  it("tolerates CRLF framing, keep-alive comments and event lines", async () => {
    const deltas = await collect(
      streamChat({
        preset: QWEN,
        messages: [],
        fetch: sseFetch([
          ": keep-alive\r\n\r\n",
          `event: message\r\ndata: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\r\n\r\n`,
          `data:${JSON.stringify({ choices: [{ delta: { content: "b" } }] })}\r\n\r\n`,
          "data: [DONE]\r\n\r\n",
        ]),
      }),
    );
    expect(deltas).toEqual([
      { kind: "text", text: "a" },
      { kind: "text", text: "b" },
    ]);
  });

  it("handles a CRLF split across network chunks without inventing an event boundary", async () => {
    // A multi-line event: if "\r" | "\n" were normalized per chunk, the first
    // data line would be cut off into its own (unparseable) event.
    const payload = JSON.stringify({ choices: [{ delta: { content: "joined" } }] });
    const half = Math.floor(payload.length / 2);
    const deltas = await collect(
      streamChat({
        preset: QWEN,
        messages: [],
        fetch: sseFetch([`data: ${payload.slice(0, half)}\r`, `\ndata: ${payload.slice(half)}\r\n\r`, "\n", "data: [DONE]\r\n\r\n"]),
      }),
    );
    // SSE joins multi-line data with "\n", which JSON tolerates between tokens.
    expect(deltas).toEqual([{ kind: "text", text: "joined" }]);
  });

  it("reassembles UTF-8 characters split across chunks", async () => {
    const bytes = new TextEncoder().encode(chunk({ content: "héllo ✓ 🚀" }));
    const cut = bytes.indexOf(0xf0) + 2; // in the middle of the rocket's 4 bytes
    const deltas = await collect(
      streamChat({ preset: QWEN, messages: [], fetch: sseFetch([bytes.slice(0, cut), bytes.slice(cut), "data: [DONE]\n\n"]) }),
    );
    expect(deltas).toEqual([{ kind: "text", text: "héllo ✓ 🚀" }]);
  });

  it("stops at [DONE] and ignores anything after it", async () => {
    const deltas = await collect(
      streamChat({
        preset: QWEN,
        messages: [],
        fetch: sseFetch([chunk({ content: "x" }), "data: [DONE]\n\n", chunk({ content: "ghost" })]),
      }),
    );
    expect(deltas).toEqual([{ kind: "text", text: "x" }]);
  });

  it("delivers a final event that has no trailing blank line", async () => {
    const deltas = await collect(
      streamChat({ preset: QWEN, messages: [], fetch: sseFetch([`data: ${JSON.stringify({ choices: [{ delta: { content: "tail" } }] })}`]) }),
    );
    expect(deltas).toEqual([{ kind: "text", text: "tail" }]);
  });

  it("yields tool-call fragments by index", async () => {
    const deltas = await collect(
      streamChat({
        preset: KIMI,
        messages: [],
        fetch: sseFetch([
          chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search", arguments: "" } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"monad"}' } }] }),
          "data: [DONE]\n\n",
        ]),
      }),
    );
    expect(deltas).toEqual([
      { kind: "tool", index: 0, id: "call_1", name: "search", args: "" },
      { kind: "tool", index: 0, args: '{"q":' },
      { kind: "tool", index: 0, args: '"monad"}' },
    ]);
  });

  it("throws on an error reported mid-stream, after yielding what came before", async () => {
    const seen: LlmDelta[] = [];
    const run = async () => {
      for await (const delta of streamChat({
        preset: QWEN,
        messages: [],
        fetch: sseFetch([
          chunk({ content: "partial" }),
          `data: ${JSON.stringify({ error: { message: "Arrearage: account overdue", code: "Arrearage" } })}\n\n`,
          chunk({ content: "never" }),
        ]),
      })) {
        seen.push(delta);
      }
    };
    await expect(run()).rejects.toThrow(/stream error: Arrearage: account overdue/);
    expect(seen).toEqual([{ kind: "text", text: "partial" }]);
    await run().catch((err: unknown) => {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).code).toBe("Arrearage");
    });
  });

  it("throws on a DashScope-style {code, message} error chunk", async () => {
    await expect(
      collect(
        streamChat({
          preset: QWEN,
          messages: [],
          fetch: sseFetch([`data: ${JSON.stringify({ code: "DataInspectionFailed", message: "blocked" })}\n\n`]),
        }),
      ),
    ).rejects.toThrow(/stream error: blocked/);
  });

  it("throws on a malformed chunk rather than guessing", async () => {
    await expect(collect(streamChat({ preset: QWEN, messages: [], fetch: sseFetch(["data: {not json\n\n"]) }))).rejects.toThrow(
      /malformed stream chunk/,
    );
  });

  it("throws on an HTTP error with the provider's message and status", async () => {
    const fetchImpl = jsonFetch({ error: { message: "Incorrect API key provided", code: "invalid_api_key" } }, [], 401);
    const err = await collect(streamChat({ preset: QWEN, messages: [], fetch: fetchImpl })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).message).toBe("Qwen 3.8 Max → 401: Incorrect API key provided");
    expect((err as LlmError).status).toBe(401);
    expect((err as LlmError).code).toBe("invalid_api_key");
  });

  it("refuses to call out without a key, naming the variables to set", async () => {
    const unconfigured = resolvePreset("kimi", {});
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("");
    }) as unknown as typeof fetch;
    await expect(collect(streamChat({ preset: unconfigured, messages: [], fetch: fetchImpl }))).rejects.toThrow(
      /Kimi K3 is not configured: set XORV_KIMI_API_KEY or MOONSHOT_API_KEY/,
    );
    expect(called).toBe(false);
  });
});

describe("chatJson", () => {
  const answer = (content: unknown, extra: Record<string, unknown> = {}) => ({
    model: "qwen3.8-max-0902",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
    ...extra,
  });

  it("asks for JSON mode with thinking off (Qwen: enable_thinking=false)", async () => {
    const captured: Captured[] = [];
    const result = await chatJson({
      preset: QWEN,
      system: "You route jobs.",
      user: "Refactor this function",
      schemaHint: '{"adapter": string, "reason": string}',
      fetch: jsonFetch(answer('{"adapter":"claude-code","reason":"coding task"}'), captured),
    });
    expect(result.data).toEqual({ adapter: "claude-code", reason: "coding task" });
    expect(result.model).toBe("qwen3.8-max-0902");
    expect(result.usage).toMatchObject({ promptTokens: 40, completionTokens: 12, totalTokens: 52 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const body = captured[0]!.body;
    expect(body).toMatchObject({
      model: "qwen3.8-max",
      response_format: { type: "json_object" },
      enable_thinking: false,
      stream: false,
    });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toMatch(/^You route jobs\./);
    expect(messages[0]!.content).toMatch(/JSON object.*"adapter": string/);
    expect(messages[1]).toEqual({ role: "user", content: "Refactor this function" });
    expect((captured[0]!.init.headers as Record<string, string>).Accept).toBe("application/json");
  });

  it("turns Kimi's always-on thinking down to low", async () => {
    const captured: Captured[] = [];
    await chatJson({ preset: KIMI, system: "Verify.", user: "…", fetch: jsonFetch(answer('{"score":90}'), captured) });
    expect(captured[0]!.body).toMatchObject({ model: "kimi-k3", reasoning_effort: "low" });
    expect(captured[0]!.url).toBe("https://api.moonshot.ai/v1/chat/completions");
  });

  it("lets the caller override body fields and the model", async () => {
    const captured: Captured[] = [];
    await chatJson({
      preset: QWEN,
      system: "s",
      user: "u",
      model: "qwen3.8-max-0902",
      body: { temperature: 0, enable_thinking: true },
      fetch: jsonFetch(answer("{}"), captured),
    });
    expect(captured[0]!.body).toMatchObject({ model: "qwen3.8-max-0902", temperature: 0, enable_thinking: true });
  });

  it("parses answers wrapped in code fences or prose", async () => {
    const fenced = await chatJson({ preset: QWEN, system: "s", user: "u", fetch: jsonFetch(answer('```json\n{"verdict":"allow"}\n```')) });
    expect(fenced.data).toEqual({ verdict: "allow" });
    const prose = await chatJson({
      preset: QWEN,
      system: "s",
      user: "u",
      fetch: jsonFetch(answer('Sure! Here it is: {"verdict":"block","reason":"exfiltration"} Hope that helps.')),
    });
    expect(prose.data).toEqual({ verdict: "block", reason: "exfiltration" });
  });

  it("accepts array-of-parts message content", async () => {
    const result = await chatJson({
      preset: QWEN,
      system: "s",
      user: "u",
      fetch: jsonFetch(answer([{ type: "text", text: '{"a":' }, { type: "text", text: "1}" }])),
    });
    expect(result.data).toEqual({ a: 1 });
  });

  it("runs the validator, so a bad shape fails where the caller can fall back", async () => {
    const validate = (value: Record<string, unknown>) => {
      if (typeof value.score !== "number") throw new Error("score must be a number");
      return { score: value.score };
    };
    const ok = await chatJson({ preset: KIMI, system: "s", user: "u", validate, fetch: jsonFetch(answer('{"score":77}')) });
    expect(ok.data.score).toBe(77);
    await expect(
      chatJson({ preset: KIMI, system: "s", user: "u", validate, fetch: jsonFetch(answer('{"score":"high"}')) }),
    ).rejects.toThrow(/score must be a number/);
  });

  it("throws LlmError on empty answers, non-JSON answers and error bodies", async () => {
    await expect(chatJson({ preset: QWEN, system: "s", user: "u", fetch: jsonFetch(answer("")) })).rejects.toThrow(/empty answer/);
    await expect(chatJson({ preset: QWEN, system: "s", user: "u", fetch: jsonFetch(answer("I cannot help")) })).rejects.toThrow(
      /did not return a JSON object/,
    );
    await expect(chatJson({ preset: QWEN, system: "s", user: "u", fetch: jsonFetch(answer("[1,2]")) })).rejects.toThrow(
      /did not return a JSON object/,
    );
    await expect(
      chatJson({ preset: QWEN, system: "s", user: "u", fetch: jsonFetch({ error: { message: "model not activated" } }) }),
    ).rejects.toThrow(/model not activated/);
    await expect(
      chatJson({ preset: QWEN, system: "s", user: "u", fetch: jsonFetch("<html>bad gateway</html>", [], 502) }),
    ).rejects.toThrow(/→ 502: <html>bad gateway/);
  });

  it("times out instead of holding the request path hostage", async () => {
    expect(CHAT_JSON_TIMEOUT_MS).toBe(15_000);
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    await expect(chatJson({ preset: QWEN, system: "s", user: "u", timeoutMs: 20, fetch: hanging })).rejects.toThrow(/timed out|abort/i);
  });

  it("honours a caller's abort signal", async () => {
    const controller = new AbortController();
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted by caller")));
      })) as unknown as typeof fetch;
    const pending = chatJson({ preset: QWEN, system: "s", user: "u", signal: controller.signal, fetch: hanging });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted by caller/);
  });
});

describe("helpers", () => {
  it("normalizeUsage keeps unknown fields as null, not zero", () => {
    expect(normalizeUsage({ total_tokens: 5 })).toEqual({
      promptTokens: null,
      completionTokens: null,
      totalTokens: 5,
      reasoningTokens: null,
      raw: { total_tokens: 5 },
    });
  });

  it("parseJsonObject rejects non-objects", () => {
    expect(parseJsonObject(' {"x": true} ')).toEqual({ x: true });
    expect(() => parseJsonObject("null")).toThrow(LlmError);
    expect(() => parseJsonObject("42")).toThrow(/JSON object/);
  });
});
