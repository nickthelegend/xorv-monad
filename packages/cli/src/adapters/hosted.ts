/**
 * Hosted sponsor models: Qwen 3.8 Max, Kimi K3 and Hunyuan hy4.
 *
 *   POST {base}/chat/completions  (stream: true, OpenAI dialect)
 *
 * All three providers speak OpenAI chat completions, so the adapters are one
 * class over the protocol's presets (`LLM_PRESETS`): base URL, key variables
 * and default model come from there, and the SSE reader is `streamChat`, shared
 * with the broker's router/screener/verifier roles.
 *
 * These run in-process with no tools, so they are safe by construction — there
 * is no child process for a hostile prompt to steer and no filesystem it can
 * reach. What they add over the plain `openai-compatible` adapter is what makes
 * them worth buying: the model's reasoning streams into the job log live (Qwen
 * and Kimi both stream `reasoning_content` before the answer), and the token
 * usage on the final chunk becomes a dollar cost, so `xorv test` can tell an
 * operator whether their price covers it.
 *
 * Keys come from the environment only (`XORV_QWEN_API_KEY` / `DASHSCOPE_API_KEY`,
 * `XORV_KIMI_API_KEY` / `MOONSHOT_API_KEY`, `XORV_HUNYUAN_API_KEY` /
 * `TOKENHUB_API_KEY`) and never reach a job's environment: nothing here spawns,
 * and the sandbox allowlist does not carry them.
 */

import {
  LLM_PRESETS,
  resolvePreset,
  streamChat,
  type AdapterKind,
  type LlmPresetKind,
  type LlmUsage,
  type ResolvedLlmPreset,
} from "@xorv/protocol";
import { clampResult, type EmitEvent, type JobAdapter, type RunInput } from "./base.js";
import { usageCostUsd } from "./pricing.js";

type FetchLike = typeof globalThis.fetch;

export interface HostedAdapterOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: FetchLike;
  /** Where to read keys and overrides from; defaults to `process.env`, read per call. */
  env?: Record<string, string | undefined>;
  /** Batch streamed text into job events at most this often (ms). */
  flushMs?: number;
}

/** How long `available()` waits on `GET /models` before calling it unreachable. */
const PROBE_TIMEOUT_MS = 4_000;

/**
 * Per-kind body fields for the streaming call.
 *
 * Qwen 3.8 thinks by default; saying so explicitly keeps the reasoning stream
 * on if the provider's default ever flips. Kimi K3 always thinks and defaults
 * to `max` effort, which can sit silent for minutes on a hard prompt — `high`
 * is the better trade for a paid job with a deadline. TokenHub's hy4 thinking
 * switch is undocumented, so it gets nothing rather than a guess.
 */
const STREAM_BODY: Record<LlmPresetKind, Record<string, unknown>> = {
  qwen: { enable_thinking: true },
  kimi: { reasoning_effort: "high" },
  hunyuan: {},
};

export class HostedModelAdapter implements JobAdapter {
  readonly kind: AdapterKind;
  readonly installHint: string;
  private readonly preset: LlmPresetKind;
  private readonly opts: HostedAdapterOptions;

  constructor(preset: LlmPresetKind, opts: HostedAdapterOptions = {}) {
    this.preset = preset;
    this.kind = preset;
    this.opts = opts;
    const p = LLM_PRESETS[preset];
    this.installHint = `set ${p.keyEnvs.join(" or ")} (${p.label}, ${p.defaultModel}); override the endpoint with ${p.baseUrlEnv}`;
  }

  private resolved(): ResolvedLlmPreset {
    return resolvePreset(this.preset, this.opts.env ?? process.env);
  }

  private get fetchImpl(): FetchLike {
    return this.opts.fetch ?? globalThis.fetch;
  }

  /**
   * A key is set, and the endpoint doesn't reject it.
   *
   * `GET /models` is cheap and needs no tokens. A 401/403 is the one answer
   * that means "every job would fail", so it is the one that marks the adapter
   * unavailable; any other non-2xx (TokenHub may not serve `/models` at all)
   * says nothing about the key, so a present key is trusted. An unreachable
   * endpoint is unavailable — a node should not advertise capacity it cannot
   * reach.
   */
  async available(): Promise<boolean> {
    const preset = this.resolved();
    if (!preset.apiKey) return false;
    try {
      const res = await this.fetchImpl(`${preset.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${preset.apiKey}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return true;
      return res.status !== 401 && res.status !== 403;
    } catch {
      return false;
    }
  }

  async run(input: RunInput): Promise<string> {
    const preset = this.resolved();
    if (!preset.apiKey) {
      throw new Error(`${preset.label} is not configured: set ${LLM_PRESETS[this.preset].keyEnvs.join(" or ")}`);
    }
    const model = input.model || preset.model;
    input.emit({ kind: "status", text: `calling ${model} (${preset.label})` });

    const log = new StreamLog(input.emit, this.opts.flushMs ?? 500);
    let text = "";
    let usage: LlmUsage | null = null;

    try {
      for await (const delta of streamChat({
        preset,
        model,
        messages: [{ role: "user", content: input.prompt }],
        body: STREAM_BODY[this.preset],
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)]),
        fetch: this.opts.fetch,
      })) {
        if (delta.kind === "reasoning") {
          log.push("reasoning", delta.text);
        } else if (delta.kind === "text") {
          text += delta.text;
          log.push("message", delta.text);
        } else if (delta.kind === "usage") {
          usage = delta.usage;
        }
        // No tools are offered, so tool-call fragments would be a provider
        // quirk; there is nothing to run them with, and they are ignored.
      }
    } catch (err) {
      log.flush();
      if (isAbort(err) || input.signal.aborted) throw new Error("job was cancelled or timed out");
      throw err;
    }
    log.flush();

    if (usage) this.reportCost(model, usage, input);
    if (!text.trim()) throw new Error(`${preset.label} returned an empty answer`);
    return clampResult(text);
  }

  /**
   * Turn the final usage record into a dollar cost. A stream that ended with
   * no usage is "cost unknown", not zero, and reports nothing.
   */
  private reportCost(model: string, usage: LlmUsage, input: RunInput): void {
    const cost = usageCostUsd(model, usage.raw);
    const tokens = usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    if (cost === null) {
      if (tokens) input.emit({ kind: "status", text: `${tokens} tokens` });
      return;
    }
    input.emit({ kind: "status", text: `${tokens} tokens · provider cost $${cost.toFixed(4)}` });
    input.onCost?.(cost);
  }
}

export class QwenAdapter extends HostedModelAdapter {
  constructor(opts: HostedAdapterOptions = {}) {
    super("qwen", opts);
  }
}

export class KimiAdapter extends HostedModelAdapter {
  constructor(opts: HostedAdapterOptions = {}) {
    super("kimi", opts);
  }
}

export class HunyuanAdapter extends HostedModelAdapter {
  constructor(opts: HostedAdapterOptions = {}) {
    super("hunyuan", opts);
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Total characters of each kind streamed into the job log before it goes quiet. */
const STREAM_BUDGET = 16_000;
/** Largest single event, so one flush can't be a wall of text. */
const MAX_EVENT = 2_000;

/**
 * Batches token deltas into readable job events.
 *
 * A model streams a few characters per chunk; one job event per chunk would
 * put thousands of fragments on the wire and in the broker's job record.
 * Deltas are grouped and flushed on a time or size threshold (or when the
 * stream switches from reasoning to answer), and each kind stops streaming
 * after a budget — the full answer is in the result regardless, and a
 * 50k-character chain of thought is not something anyone reads live.
 */
class StreamLog {
  private kind: "reasoning" | "message" | null = null;
  private buffer = "";
  private lastFlush = Date.now();
  private readonly sent = { reasoning: 0, message: 0 };
  private readonly muted = { reasoning: false, message: false };

  constructor(
    private readonly emit: EmitEvent,
    private readonly flushMs: number,
  ) {}

  push(kind: "reasoning" | "message", text: string): void {
    if (this.kind !== kind) this.flush();
    this.kind = kind;
    this.buffer += text;
    if (this.buffer.length >= MAX_EVENT || Date.now() - this.lastFlush >= this.flushMs) this.flush();
  }

  flush(): void {
    const kind = this.kind;
    const text = this.buffer;
    this.buffer = "";
    this.lastFlush = Date.now();
    if (!kind || !text.trim() || this.muted[kind]) return;
    const allowed = text.slice(0, STREAM_BUDGET - this.sent[kind]);
    for (let i = 0; i < allowed.length; i += MAX_EVENT) {
      const chunk = allowed.slice(i, i + MAX_EVENT);
      if (chunk.trim()) this.emit({ kind, text: chunk });
    }
    this.sent[kind] += allowed.length;
    if (this.sent[kind] >= STREAM_BUDGET) {
      this.muted[kind] = true;
      this.emit({
        kind: "status",
        text: kind === "reasoning" ? "reasoning continues (not streamed)" : "answer continues — full text in the result",
      });
    }
  }
}
