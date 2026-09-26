/**
 * The few broker HTTP calls the MCP server makes, with one timeout policy and
 * one way of turning a non-2xx into an error message.
 *
 * Wire shapes (`QuoteResponse`, `PublicJob`, …) come from `@xorv/protocol`, so
 * this server reads exactly what the broker writes instead of keeping a
 * hand-copied interface that drifts.
 */

import type { PublicJob } from "@xorv/protocol";

/** How long any single broker request may take before the tool gives up on it. */
export const BROKER_TIMEOUT_MS = 20_000;

export class BrokerError extends Error {
  constructor(
    message: string,
    /** HTTP status, or null when the broker could not be reached at all. */
    readonly status: number | null,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export interface BrokerReply<T> {
  status: number;
  ok: boolean;
  body: T;
}

export interface BrokerClient {
  readonly url: string;
  getJson<T>(path: string): Promise<T>;
  /** POST JSON; resolves for any HTTP status so callers can read error bodies. */
  postJson<T>(path: string, body: unknown): Promise<BrokerReply<T>>;
  getJob(jobId: string): Promise<PublicJob>;
}

/** The `error` a broker put in a JSON body, when it did. */
export function brokerErrorText(body: unknown): string | null {
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return null;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 300) };
  }
}

export function brokerClient(url: string, fetchImpl: typeof fetch = globalThis.fetch): BrokerClient {
  const base = url.replace(/\/+$/, "");

  const request = async (path: string, init: RequestInit): Promise<{ res: Response; body: unknown }> => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(BROKER_TIMEOUT_MS) });
    } catch (err) {
      const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      throw new BrokerError(`Could not reach the Xorv broker at ${base}: ${cause}`, null);
    }
    return { res, body: await readBody(res) };
  };

  const client: BrokerClient = {
    url: base,
    async getJson<T>(path: string): Promise<T> {
      const { res, body } = await request(path, { method: "GET" });
      if (!res.ok) {
        throw new BrokerError(`${path} → ${res.status}${brokerErrorText(body) ? `: ${brokerErrorText(body)}` : ""}`, res.status, body);
      }
      return body as T;
    },
    async postJson<T>(path: string, payload: unknown): Promise<BrokerReply<T>> {
      const { res, body } = await request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: res.status, ok: res.ok, body: body as T };
    },
    async getJob(jobId: string): Promise<PublicJob> {
      const { job } = await client.getJson<{ job: PublicJob }>(`/api/jobs/${encodeURIComponent(jobId)}`);
      return job;
    },
  };
  return client;
}
