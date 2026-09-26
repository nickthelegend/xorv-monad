/**
 * The sponsor-model adapters (qwen, kimi, hunyuan), against a scripted SSE
 * endpoint.
 *
 * Nothing here touches the network or needs a key: `fetch` is injected, and
 * the stream is built chunk by chunk the way the providers send it — reasoning
 * deltas first, then the answer, then a usage record on a final chunk with no
 * choices. What matters is what a buyer sees: the reasoning in the job log as
 * it happens, the full answer as the result, and a cost the operator can
 * compare against their price.
 */

import os from "node:os";
import { describe, expect, it } from "vitest";
import type { JobEvent } from "@xorv/protocol";
import { HostedModelAdapter, HunyuanAdapter, KimiAdapter, QwenAdapter } from "../src/adapters/hosted.js";
import { tokenPrice, usageCostUsd } from "../src/adapters/pricing.js";

type Call = { url: string; init: RequestInit; body: Record<string, unknown> | null };

function sse(chunks: unknown[], opts: { crlf?: boolean; done?: boolean } = {}): string {
  const nl = opts.crlf ? "\r\n" : "\n";
  const frames = chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}${nl}${nl}`);
  if (opts.done !== false) frames.push(`data: [DONE]${nl}${nl}`);
  return frames.join("");
}

const delta = (d: Record<string, unknown>) => ({ choices: [{ index: 0, delta: d }] });

/** A fetch that answers /models and /chat/completions from a script, recording every call. */
function scriptedFetch(opts: {
  stream?: string;
  models?: number | Error;
  chatStatus?: number;
  chatBody?: string;
  /** Split the stream into this many byte-ish pieces, to exercise reassembly. */
  pieces?: number;
}) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, init, body });
    if (url.endsWith("/models")) {
      if (opts.models instanceof Error) throw opts.models;
      return new Response("{}", { status: opts.models ?? 200 });
    }
    if (opts.chatStatus && opts.chatStatus !== 200) {
      return new Response(opts.chatBody ?? "", { status: opts.chatStatus });
    }
    const text = opts.stream ?? "";
    const pieces = Math.max(1, opts.pieces ?? 1);
    const size = Math.ceil(text.length / pieces);
    const encoder = new TextEncoder();
    const body2 = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < text.length; i += size) controller.enqueue(encoder.encode(text.slice(i, i + size)));
        controller.close();
      },
    });
    return new Response(body2, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function runInput(over: Partial<Parameters<HostedModelAdapter["run"]>[0]> = {}) {
  const events: Array<Omit<JobEvent, "at">> = [];
  const costs: number[] = [];
  return {
    events,
    costs,
    input: {
      prompt: "What is 2+2?",
      cwd: os.tmpdir(),
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      emit: (e: Omit<JobEvent, "at">) => events.push(e),
      onCost: (usd: number) => costs.push(usd),
      ...over,
    },
  };
}

const QWEN_ENV = { XORV_QWEN_API_KEY: "sk-test-qwen" };

describe("streaming a job", () => {
  it("streams reasoning and answer into job events and returns the full answer", async () => {
    const { fetch, calls } = scriptedFetch({
      stream: sse([
        delta({ reasoning_content: "The user wants " }),
        delta({ reasoning_content: "simple arithmetic." }),
        delta({ content: "2 + 2 " }),
        delta({ content: "= 4" }),
        { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 } },
      ]),
      pieces: 7,
    });
    const adapter = new QwenAdapter({ fetch, env: QWEN_ENV, flushMs: 0 });
    const { input, events, costs } = runInput();

    const result = await adapter.run(input);

    expect(result).toBe("2 + 2 = 4");
    expect(events.filter((e) => e.kind === "reasoning").map((e) => e.text).join("")).toBe(
      "The user wants simple arithmetic.",
    );
    expect(events.filter((e) => e.kind === "message").map((e) => e.text).join("")).toBe("2 + 2 = 4");
    // Reasoning streams before the answer, as the provider sent it.
    const firstReasoning = events.findIndex((e) => e.kind === "reasoning");
    const firstMessage = events.findIndex((e) => e.kind === "message");
    expect(firstReasoning).toBeLessThan(firstMessage);

    // qwen3.8-max at $2 / $6 per million: 1000 in + 2000 out = $0.014.
    expect(costs).toHaveLength(1);
    expect(costs[0]).toBeCloseTo(0.014, 10);
    expect(events.some((e) => e.kind === "status" && e.text.includes("3000 tokens · provider cost $0.0140"))).toBe(true);

    const [call] = calls;
    expect(call!.url).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect((call!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-qwen");
    expect(call!.body).toMatchObject({
      model: "qwen3.8-max",
      stream: true,
      stream_options: { include_usage: true },
      enable_thinking: true,
      messages: [{ role: "user", content: "What is 2+2?" }],
    });
  });

  it("tolerates CRLF framing and keep-alive comments", async () => {
    const stream = `: keep-alive\r\n\r\n${sse([delta({ content: "ok" })], { crlf: true })}`;
    const { fetch } = scriptedFetch({ stream, pieces: 5 });
    const { input } = runInput();
    await expect(new QwenAdapter({ fetch, env: QWEN_ENV }).run(input)).resolves.toBe("ok");
  });

  it("uses a pinned model and each preset's own endpoint, key and body", async () => {
    const kimi = scriptedFetch({ stream: sse([delta({ content: "hi" })]) });
    await new KimiAdapter({ fetch: kimi.fetch, env: { MOONSHOT_API_KEY: "sk-moon" } }).run(runInput().input);
    expect(kimi.calls[0]!.url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(kimi.calls[0]!.body).toMatchObject({ model: "kimi-k3", reasoning_effort: "high" });

    const hy = scriptedFetch({ stream: sse([delta({ content: "hi" })]) });
    await new HunyuanAdapter({ fetch: hy.fetch, env: { TOKENHUB_API_KEY: "sk-th" } }).run(runInput({ model: "hy3" }).input);
    expect(hy.calls[0]!.url).toBe("https://tokenhub-intl.tencentcloudmaas.com/v1/chat/completions");
    expect(hy.calls[0]!.body).toMatchObject({ model: "hy3" });
    expect(hy.calls[0]!.body).not.toHaveProperty("enable_thinking");
    expect(hy.calls[0]!.body).not.toHaveProperty("reasoning_effort");
  });

  it("honours a base URL override, so a key from another region works", async () => {
    const { fetch, calls } = scriptedFetch({ stream: sse([delta({ content: "hi" })]) });
    await new QwenAdapter({
      fetch,
      env: { DASHSCOPE_API_KEY: "sk-us", XORV_QWEN_BASE_URL: "https://dashscope-us.aliyuncs.com/compatible-mode/v1/" },
    }).run(runInput().input);
    expect(calls[0]!.url).toBe("https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions");
  });

  it("batches a torrent of tiny deltas into a few readable events", async () => {
    const tokens = Array.from({ length: 400 }, (_, i) => delta({ content: `w${i} ` }));
    const { fetch } = scriptedFetch({ stream: sse(tokens) });
    const { input, events } = runInput();
    const result = await new QwenAdapter({ fetch, env: QWEN_ENV, flushMs: 60_000 }).run(input);
    const messages = events.filter((e) => e.kind === "message");
    expect(messages.length).toBeLessThan(10);
    expect(messages.map((e) => e.text).join("")).toBe(result);
  });

  it("stops streaming an enormous chain of thought, but still returns the answer", async () => {
    const huge = Array.from({ length: 30 }, () => delta({ reasoning_content: "x".repeat(1_000) }));
    const { fetch } = scriptedFetch({ stream: sse([...huge, delta({ content: "answer" })]) });
    const { input, events } = runInput();
    await expect(new QwenAdapter({ fetch, env: QWEN_ENV, flushMs: 0 }).run(input)).resolves.toBe("answer");
    const streamed = events.filter((e) => e.kind === "reasoning").reduce((n, e) => n + e.text.length, 0);
    expect(streamed).toBeLessThanOrEqual(16_000);
    expect(events.every((e) => e.text.length <= 2_000)).toBe(true);
    expect(events.some((e) => e.kind === "status" && /reasoning continues/.test(e.text))).toBe(true);
  });

  it("reports no cost when the stream carries no usage — unknown is not free", async () => {
    const { fetch } = scriptedFetch({ stream: sse([delta({ content: "hi" })]) });
    const { input, costs } = runInput();
    await new QwenAdapter({ fetch, env: QWEN_ENV }).run(input);
    expect(costs).toEqual([]);
  });
});

describe("failing a job", () => {
  it("refuses to run without a key, naming both variables", async () => {
    const { fetch, calls } = scriptedFetch({});
    await expect(new KimiAdapter({ fetch, env: {} }).run(runInput().input)).rejects.toThrow(
      /XORV_KIMI_API_KEY or MOONSHOT_API_KEY/,
    );
    expect(calls).toHaveLength(0);
  });

  it("surfaces the provider's error message and status", async () => {
    const { fetch } = scriptedFetch({
      chatStatus: 401,
      chatBody: JSON.stringify({ error: { message: "Incorrect API key provided", code: "invalid_api_key" } }),
    });
    await expect(new QwenAdapter({ fetch, env: QWEN_ENV }).run(runInput().input)).rejects.toThrow(
      /401.*Incorrect API key/,
    );
  });

  it("fails on an error delivered mid-stream instead of treating it as the end", async () => {
    const { fetch } = scriptedFetch({
      stream: sse([delta({ content: "partial" }), { error: { message: "quota exhausted" } }], { done: false }),
    });
    await expect(new QwenAdapter({ fetch, env: QWEN_ENV }).run(runInput().input)).rejects.toThrow(/quota exhausted/);
  });

  it("fails an empty answer rather than selling nothing", async () => {
    const { fetch } = scriptedFetch({ stream: sse([delta({ reasoning_content: "hmm" })]) });
    await expect(new QwenAdapter({ fetch, env: QWEN_ENV }).run(runInput().input)).rejects.toThrow(/empty answer/);
  });

  it("reports a cancelled job as cancelled", async () => {
    const controller = new AbortController();
    const fetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as typeof globalThis.fetch;
    const promise = new QwenAdapter({ fetch, env: QWEN_ENV }).run(runInput({ signal: controller.signal }).input);
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow(/cancelled or timed out/);
  });
});

describe("available()", () => {
  it("is false with no key, without touching the network", async () => {
    const { fetch, calls } = scriptedFetch({});
    expect(await new QwenAdapter({ fetch, env: {} }).available()).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("is true when the endpoint accepts the key", async () => {
    const { fetch, calls } = scriptedFetch({ models: 200 });
    expect(await new QwenAdapter({ fetch, env: QWEN_ENV }).available()).toBe(true);
    expect(calls[0]!.url).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models");
    expect(calls[0]!.init.signal).toBeDefined();
  });

  it("is false when the endpoint rejects the key — every job would fail", async () => {
    for (const status of [401, 403]) {
      const { fetch } = scriptedFetch({ models: status });
      expect(await new KimiAdapter({ fetch, env: { MOONSHOT_API_KEY: "bad" } }).available()).toBe(false);
    }
  });

  it("trusts a present key when the endpoint simply has no /models", async () => {
    const { fetch } = scriptedFetch({ models: 404 });
    expect(await new HunyuanAdapter({ fetch, env: { TOKENHUB_API_KEY: "sk" } }).available()).toBe(true);
  });

  it("is false when the endpoint is unreachable", async () => {
    const { fetch } = scriptedFetch({ models: new Error("getaddrinfo ENOTFOUND") });
    expect(await new QwenAdapter({ fetch, env: QWEN_ENV }).available()).toBe(false);
  });

  it("tells the operator which variables to set", () => {
    expect(new QwenAdapter().installHint).toMatch(/XORV_QWEN_API_KEY or DASHSCOPE_API_KEY.*qwen3\.8-max/);
    expect(new KimiAdapter().installHint).toMatch(/kimi-k3/);
    expect(new HunyuanAdapter().installHint).toMatch(/hy4-preview/);
  });
});

describe("pricing", () => {
  it("prices the sponsor models from their published rates", () => {
    expect(tokenPrice("qwen3.8-max")).toEqual({ input: 2, output: 6 });
    expect(tokenPrice("kimi-k3")).toEqual({ input: 3, output: 15 });
    expect(tokenPrice("hy4-preview")).toEqual({ input: 0.834, output: 2.501 });
  });

  it("prices a dated snapshot as its family, and an unknown model as unknown", () => {
    expect(tokenPrice("qwen3.8-max-0902")).toEqual({ input: 2, output: 6 });
    expect(tokenPrice("llama3.1")).toBeNull();
    expect(usageCostUsd("llama3.1", { prompt_tokens: 1, completion_tokens: 1 })).toBeNull();
  });

  it("reads OpenAI- and Anthropic-style usage alike", () => {
    expect(usageCostUsd("kimi-k3", { prompt_tokens: 1_000_000, completion_tokens: 0 })).toBe(3);
    expect(usageCostUsd("kimi-k3", { input_tokens: 0, output_tokens: 1_000_000 })).toBe(15);
    expect(usageCostUsd("kimi-k3", { prompt_tokens: 10 })).toBeNull();
  });
});
