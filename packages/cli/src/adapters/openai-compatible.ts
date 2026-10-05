/**
 * OpenAI-compatible endpoint adapter.
 *
 * The escape hatch that makes Xorv's supply side open-ended: anything speaking
 * `POST /v1/chat/completions` can be sold on the network — Ollama, LM Studio,
 * vLLM, OpenRouter, together.ai, a company's internal gateway. That covers
 * local GPUs and hosted quota alike without needing a bespoke adapter each.
 *
 * Configured entirely from the environment, because the base URL and key belong
 * to the operator and should never end up in a config file that gets shared:
 *
 *   XORV_OPENAI_BASE_URL   default http://localhost:11434/v1  (Ollama)
 *   XORV_OPENAI_API_KEY    optional; sent as a bearer token when set
 *   XORV_OPENAI_MODEL      default model when the capability pins none
 *
 * Two hosted models get their own named adapters on the same code, so a
 * provider can sell them as what they are rather than as "an endpoint":
 *
 *   kimi   Moonshot's Kimi        MOONSHOT_API_KEY   (base https://api.moonshot.ai/v1)
 *   qwen   Alibaba's Qwen         DASHSCOPE_API_KEY  (base: your Model Studio workspace URL)
 */

import type { AdapterKind } from "@xorv/protocol";
import { clampResult, type JobAdapter, type RunInput } from "./base.js";

interface ChatChoice {
  message?: { content?: string | null };
  delta?: { content?: string | null };
  finish_reason?: string | null;
}

interface ChatResponse {
  choices?: ChatChoice[];
  error?: { message?: string };
  model?: string;
}

/** Where an OpenAI-compatible endpoint lives and how it is configured. */
export interface EndpointProfile {
  kind: AdapterKind;
  /** Base URL env var, then its default. */
  baseUrlEnv: string;
  defaultBaseUrl: string | null;
  /** API key env var(s), first one set wins. */
  keyEnvs: string[];
  /** Model env var, then its default. */
  modelEnv: string;
  defaultModel: string;
  /** Extra request-body fields this endpoint expects (e.g. Qwen's thinking switch). */
  extraBody?: Record<string, unknown>;
  installHint: string;
  /** Hosted endpoints need a key to be usable at all; a local server may not. */
  keyRequired: boolean;
}

export const OPENAI_COMPATIBLE: EndpointProfile = {
  kind: "openai-compatible",
  baseUrlEnv: "XORV_OPENAI_BASE_URL",
  defaultBaseUrl: "http://localhost:11434/v1",
  keyEnvs: ["XORV_OPENAI_API_KEY"],
  modelEnv: "XORV_OPENAI_MODEL",
  defaultModel: "llama3.1",
  installHint: "set XORV_OPENAI_BASE_URL (e.g. http://localhost:11434/v1 for Ollama) and XORV_OPENAI_MODEL",
  keyRequired: false,
};

/** Moonshot's Kimi (https://platform.moonshot.ai). OpenAI-compatible chat completions. */
export const KIMI: EndpointProfile = {
  kind: "kimi",
  baseUrlEnv: "XORV_KIMI_BASE_URL",
  defaultBaseUrl: "https://api.moonshot.ai/v1",
  keyEnvs: ["MOONSHOT_API_KEY", "XORV_KIMI_API_KEY"],
  modelEnv: "XORV_KIMI_MODEL",
  defaultModel: "kimi-k2.6",
  installHint: "set MOONSHOT_API_KEY (platform.moonshot.ai); optionally XORV_KIMI_MODEL (default kimi-k2.6)",
  keyRequired: true,
};

/**
 * Alibaba's Qwen through Model Studio's OpenAI-compatible mode. Endpoints are
 * workspace- and region-scoped, so the base URL is the operator's own
 * (…/compatible-mode/v1); the key is region-specific too.
 */
export const QWEN: EndpointProfile = {
  kind: "qwen",
  baseUrlEnv: "XORV_QWEN_BASE_URL",
  defaultBaseUrl: "https://maas.qwencloudapi.com/compatible-mode/v1",
  keyEnvs: ["DASHSCOPE_API_KEY", "XORV_QWEN_API_KEY"],
  modelEnv: "XORV_QWEN_MODEL",
  defaultModel: "qwen3.8-max",
  extraBody: { enable_thinking: false },
  installHint:
    "set DASHSCOPE_API_KEY and XORV_QWEN_BASE_URL (your Model Studio …/compatible-mode/v1 URL); optionally XORV_QWEN_MODEL (default qwen3.8-max)",
  keyRequired: true,
};

export class OpenAiCompatibleAdapter implements JobAdapter {
  readonly kind: AdapterKind;
  readonly installHint: string;

  constructor(private readonly profile: EndpointProfile = OPENAI_COMPATIBLE) {
    this.kind = profile.kind;
    this.installHint = profile.installHint;
  }

  private get baseUrl(): string {
    return (process.env[this.profile.baseUrlEnv]?.trim() || this.profile.defaultBaseUrl || "").replace(/\/+$/, "");
  }

  private get apiKey(): string | null {
    for (const name of this.profile.keyEnvs) {
      const value = process.env[name]?.trim();
      if (value) return value;
    }
    return null;
  }

  private get defaultModel(): string {
    return process.env[this.profile.modelEnv]?.trim() || this.profile.defaultModel;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async available(): Promise<boolean> {
    if (!this.baseUrl) return false;
    if (this.profile.keyRequired && !this.apiKey) return false;
    try {
      // `/models` is the one endpoint essentially every compatible server
      // implements, and it costs no tokens to answer.
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(4_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async run(input: RunInput): Promise<string> {
    const model = input.model || this.defaultModel;
    input.emit({ kind: "status", text: `calling ${model} at ${this.baseUrl}` });

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)]),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: input.prompt }],
        stream: false,
        ...this.profile.extraBody,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`upstream returned ${res.status}: ${body.slice(0, 300)}`);
    }

    const body = (await res.json()) as ChatResponse;
    if (body.error?.message) throw new Error(body.error.message);

    const text = body.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new Error("upstream returned an empty completion");

    input.emit({ kind: "message", text });
    return clampResult(text);
  }
}
