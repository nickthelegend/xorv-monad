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

export class OpenAiCompatibleAdapter implements JobAdapter {
  readonly kind: AdapterKind = "openai-compatible";
  readonly installHint =
    "set XORV_OPENAI_BASE_URL (e.g. http://localhost:11434/v1 for Ollama) and XORV_OPENAI_MODEL";

  private get baseUrl(): string {
    return (process.env.XORV_OPENAI_BASE_URL || "http://localhost:11434/v1").replace(/\/+$/, "");
  }

  private get apiKey(): string | null {
    return process.env.XORV_OPENAI_API_KEY?.trim() || null;
  }

  private get defaultModel(): string {
    return process.env.XORV_OPENAI_MODEL?.trim() || "llama3.1";
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async available(): Promise<boolean> {
    try {
      // `/models` is the one endpoint essentially every compatible server
      // implements, and it needs no tokens to answer.
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
