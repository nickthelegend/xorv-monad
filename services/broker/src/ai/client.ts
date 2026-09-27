/**
 * The one client every AI role talks through.
 *
 * A thin layer over the protocol's `chatJson` (OpenAI-compatible, JSON mode,
 * thinking turned down per preset) that adds what a role on the request path
 * needs and a library call doesn't know about:
 *
 *  - a hard per-role deadline. `chatJson` aborts the fetch on its own
 *    timeout, but a quote must not depend on every `fetch` implementation
 *    honouring an abort signal, so the call is also raced against a timer;
 *  - strict validation — the role's `validate` narrows the parsed object or
 *    throws, and every failure is classified as `timeout`, `error` (the
 *    provider failed) or `invalid` (the model answered, badly), which is what
 *    a role's fallback records;
 *  - latency and failure counters, which /api/network reports per role;
 *  - key hygiene: the API key only ever goes into the Authorization header of
 *    a request to the preset's own base URL, and is scrubbed from any error
 *    text before that text is logged, stored or served (some providers echo
 *    a masked or even whole key back in their 401 body).
 */

import { LlmError, chatJson, type ResolvedLlmPreset } from "@xorv/protocol";
import type { AiRoleName, EnabledRoleInfo, RoleStats } from "./types.js";

type FetchLike = typeof globalThis.fetch;

export type AiFailureKind = "timeout" | "error" | "invalid";

/** A role call that failed, classified for the role's fallback. */
export class AiRoleError extends Error {
  readonly kind: AiFailureKind;
  constructor(kind: AiFailureKind, message: string) {
    super(message);
    this.name = "AiRoleError";
    this.kind = kind;
  }
}

/** Throw from a `validate` callback: the model answered, but not with something usable. */
export function invalid(message: string): never {
  throw new AiRoleError("invalid", message);
}

export interface RoleClientOptions {
  role: AiRoleName;
  /** A resolved preset with an API key (the factory never builds a client without one). */
  preset: ResolvedLlmPreset;
  timeoutMs: number;
  fetch?: FetchLike;
  /** Extra body fields for this role, on top of the preset's fast-JSON defaults. */
  body?: Record<string, unknown>;
}

export interface RoleCall<T> {
  system: string;
  user: string;
  schemaHint: string;
  validate: (value: Record<string, unknown>) => T;
}

export interface RoleResult<T> {
  data: T;
  /** The model that answered, as the provider named it. */
  model: string;
  ms: number;
}

export class RoleClient {
  readonly role: AiRoleName;
  readonly preset: ResolvedLlmPreset;
  readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly body: Record<string, unknown> | undefined;
  private readonly stats: RoleStats = {
    calls: 0,
    ok: 0,
    failed: 0,
    timeouts: 0,
    lastMs: null,
    avgMs: null,
    lastError: null,
    lastAt: null,
  };

  constructor(opts: RoleClientOptions) {
    if (!opts.preset.apiKey) throw new Error(`${opts.preset.label} has no API key; the ${opts.role} can't be enabled`);
    this.role = opts.role;
    this.preset = opts.preset;
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetch;
    this.body = opts.body;
  }

  get info(): EnabledRoleInfo {
    return {
      by: this.preset.kind,
      model: this.preset.model,
      enabled: true,
      provider: this.preset.kind,
      label: this.preset.label,
      timeoutMs: this.timeoutMs,
    };
  }

  snapshot(): RoleStats {
    return { ...this.stats };
  }

  /** One JSON call under the role's deadline. Throws `AiRoleError`; never hangs past the deadline. */
  async json<T>(call: RoleCall<T>): Promise<RoleResult<T>> {
    const started = Date.now();
    this.stats.calls += 1;
    this.stats.lastAt = started;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new AiRoleError("timeout", `${this.preset.label} did not answer within ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([
        chatJson<T>({
          preset: this.preset,
          system: call.system,
          user: call.user,
          schemaHint: call.schemaHint,
          validate: call.validate,
          body: this.body,
          signal: controller.signal,
          timeoutMs: this.timeoutMs,
          fetch: this.fetchImpl,
        }),
        deadline,
      ]);
      const ms = Date.now() - started;
      this.stats.ok += 1;
      this.stats.lastMs = ms;
      this.stats.avgMs = Math.round(((this.stats.avgMs ?? 0) * (this.stats.ok - 1) + ms) / this.stats.ok);
      return { data: result.data, model: clip(result.model || this.preset.model, 80), ms };
    } catch (err) {
      const failure = this.classify(err);
      this.stats.failed += 1;
      if (failure.kind === "timeout") this.stats.timeouts += 1;
      this.stats.lastMs = Date.now() - started;
      // lastError is served on the public /api/network. The failure message
      // can carry the model's own words (an "invalid" answer is quoted back,
      // up to 200 characters, and a validator names the value it got), and a
      // model that saw a private job's prompt can echo it. So only a fixed
      // description goes public; the full message stays in the thrown error.
      this.stats.lastError = this.publicFailure(failure, err);
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A failure in words that never include the model's output or the provider's error text. */
  private publicFailure(failure: AiRoleError, cause: unknown): string {
    if (failure.kind === "timeout") return `timeout: ${this.preset.label} did not answer within ${this.timeoutMs}ms`;
    if (failure.kind === "invalid") return `invalid: ${this.preset.label} answered with something other than the expected JSON`;
    const status = cause instanceof LlmError && cause.status !== null ? ` (HTTP ${cause.status})` : "";
    return `error: the call to ${this.preset.label} failed${status}`;
  }

  /** Scrub the key out of anything that might be shown. */
  redact(text: string): string {
    const key = this.preset.apiKey;
    let out = key && key.length >= 6 ? text.split(key).join("[redacted]") : text;
    // Belt and braces for a provider that echoes a *different* key shape
    // (say, a masked prefix plus the tail): anything bearer-looking goes.
    out = out.replace(/\b(sk|ak|tk)-[A-Za-z0-9_\-*]{12,}/g, "[redacted]");
    return clip(out, 300);
  }

  private classify(err: unknown): AiRoleError {
    if (err instanceof AiRoleError) return new AiRoleError(err.kind, this.redact(err.message));
    const name = (err as { name?: unknown } | null)?.name;
    if (name === "AbortError" || name === "TimeoutError") {
      return new AiRoleError("timeout", `${this.preset.label} did not answer within ${this.timeoutMs}ms`);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof LlmError && err.status === null && /JSON object|empty answer/i.test(message)) {
      return new AiRoleError("invalid", this.redact(message));
    }
    return new AiRoleError("error", this.redact(message));
  }
}

/** Trim to at most `max` characters, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Cut a long input for a prompt, saying so, so the model knows it isn't seeing everything. */
export function truncateForModel(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[… ${text.length - max} more characters not shown]`;
}

/**
 * Put untrusted text between tags a model is told to treat as data.
 *
 * A closing tag inside the text would end the data early and let whatever
 * follows read as instructions, so any occurrence of it is defanged first.
 */
export function fenced(tag: string, text: string): string {
  const closing = new RegExp(`</\\s*${tag}\\s*>`, "gi");
  return `<${tag}>\n${text.replace(closing, `</ ${tag}_>`)}\n</${tag}>`;
}
