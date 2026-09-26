/**
 * The broker's public HTTP API, as a buyer sees it.
 *
 * The plugin gets no privileged access: it uses the same routes the web app,
 * the Xorv CLI and the MCP server use, and the wire shapes are the ones
 * `@xorv/protocol` exports (`PublicProvider`, `QuoteResponse`, `PublicJob`,
 * `NetworkInfo`). `fetch` is injectable so every command is tested against a
 * scripted broker with no network.
 */

import type { AdapterKind, JobEvent, NetworkInfo, PaymentRecord, PublicJob, PublicProvider, QuoteResponse } from "@xorv/protocol";
import { BROKER_URL_ENV } from "./config.js";
import { XorvPluginError, errorMessage } from "./errors.js";
import { readSse, type SseFrame } from "./sse.js";

export type FetchLike = typeof globalThis.fetch;

/** Plain reads should answer quickly; a quote may wait on the broker's AI screen and router. */
const READ_TIMEOUT_MS = 15_000;
const QUOTE_TIMEOUT_MS = 45_000;

/** `POST /api/quotes` body. */
export interface QuoteRequest {
  prompt: string;
  adapter?: AdapterKind | null;
  /** Ceiling in micro-USD; the broker only matches providers at or under it. */
  maxPriceUsdMicros: number;
  title?: string | null;
}

/** `POST /api/jobs/:quoteId` success body, after the x402 payment settled. */
export interface PaidJobResponse {
  jobId: string;
  status: string;
  provider: { id: string; label: string; address?: string };
  capability: string;
  priceUsdMicros: number;
  priceLabel: string;
  payment: PaymentRecord | null;
  cancelToken?: string;
  cancelUrl?: string;
  streamUrl?: string;
  jobUrl?: string;
}

/** One `GET /api/leaderboard` row — only the fields the plugin shows. */
export interface LeaderboardRow {
  providerId: string | null;
  label: string;
  address: string;
  agentId: string | null;
  jobsTotal: number;
  jobsOk: number;
  successRate: number | null;
  ratingsCount: number;
  /** Mean buyer rating on the 0–100 ERC-8004 scale. */
  avgRating: number | null;
  reputation: { feedbackCount: number; feedbackAvg: number | null; verifiedScore: number | null } | null;
}

/** `GET /api/jobs/:id/rating?value=` — the EIP-712 rating the payer is asked to sign. */
export interface RatingRequest {
  jobId: string;
  value: number;
  /** Unix seconds after which the relayed signature is refused on-chain. */
  deadline: number;
  /** The address that paid for the job — the only one allowed to rate it. */
  signer: string;
  agentId: string;
  feedbackURI: string;
  feedbackHash: string;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  };
}

/** `POST /api/jobs/:id/rate` success body. */
export interface RatingReceipt {
  ok: true;
  jobId: string;
  value: number;
  txHash: string;
  explorerUrl: string;
  feedbackURI: string;
  feedbackHash: string;
}

/** A parsed frame of `GET /api/jobs/:id/stream`. */
export type JobStreamEvent =
  | { type: "snapshot" | "job" | "done"; job: PublicJob }
  | { type: "event"; event: JobEvent };

export class BrokerClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: { baseUrl: string; fetch?: FetchLike }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  url(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  /** The URL a quote is paid at. Built from our own base URL, never from the quote's `payUrl`. */
  payUrl(quoteId: string): string {
    return this.url(`/api/jobs/${encodeURIComponent(quoteId)}`);
  }

  jobUrl(jobId: string): string {
    return this.url(`/api/jobs/${encodeURIComponent(jobId)}`);
  }

  get fetch(): FetchLike {
    return this.fetchImpl;
  }

  network(): Promise<NetworkInfo> {
    return this.json<NetworkInfo>("/api/network");
  }

  async providers(): Promise<PublicProvider[]> {
    const body = await this.json<{ providers?: PublicProvider[] }>("/api/providers");
    return Array.isArray(body.providers) ? body.providers : [];
  }

  /**
   * Reputation per provider — indexer-backed when the broker has Envio
   * configured, in-memory otherwise. Optional: an older broker without the
   * route (or a failing indexer) just means the listing shows no ratings.
   */
  async leaderboard(limit = 100): Promise<LeaderboardRow[] | null> {
    try {
      const body = await this.json<{ providers?: LeaderboardRow[] }>(`/api/leaderboard?limit=${limit}`);
      return Array.isArray(body.providers) ? body.providers : null;
    } catch {
      return null;
    }
  }

  quote(request: QuoteRequest): Promise<QuoteResponse> {
    return this.json<QuoteResponse>(
      "/api/quotes",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) },
      QUOTE_TIMEOUT_MS,
    );
  }

  async job(jobId: string): Promise<PublicJob> {
    const body = await this.json<{ job: PublicJob }>(`/api/jobs/${encodeURIComponent(jobId)}`);
    return body.job;
  }

  /**
   * Follow a job over SSE until the broker sends `done` (or the stream ends).
   * Frames that fail to parse are skipped rather than killing the watch: the
   * poll fallback in `watchJob` will pick up whatever they carried.
   */
  async *stream(jobId: string, signal?: AbortSignal): AsyncGenerator<JobStreamEvent> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(`/api/jobs/${encodeURIComponent(jobId)}/stream`), {
        headers: { accept: "text/event-stream" },
        signal,
      });
    } catch (err) {
      throw this.unreachable(err);
    }
    if (!res.ok || !res.body) {
      throw new XorvPluginError(
        "XORV_BROKER_ERROR",
        `the broker refused the job stream (HTTP ${res.status})`,
        "The job can still be read with its job URL.",
      );
    }
    for await (const frame of readSse(res.body, signal)) {
      const parsed = parseStreamFrame(frame);
      if (parsed) yield parsed;
    }
  }

  ratingRequest(jobId: string, value: number): Promise<RatingRequest> {
    return this.json<RatingRequest>(`/api/jobs/${encodeURIComponent(jobId)}/rating?value=${value}`);
  }

  submitRating(jobId: string, body: { value: number; deadline: number; signature: string }): Promise<RatingReceipt> {
    return this.json<RatingReceipt>(
      `/api/jobs/${encodeURIComponent(jobId)}/rate`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      QUOTE_TIMEOUT_MS,
    );
  }

  /** GET/POST a JSON route; any non-2xx becomes an `XORV_BROKER_ERROR` carrying the broker's own message. */
  private async json<T>(path: string, init: RequestInit = {}, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        ...init,
        headers: { accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw this.unreachable(err);
    }
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!res.ok) throw brokerHttpError(res.status, body, path);
    if (body === null || typeof body !== "object") {
      throw new XorvPluginError(
        "XORV_BROKER_ERROR",
        `the broker answered ${path} with something that is not JSON`,
        `Check that ${this.baseUrl} is a Xorv broker (GET /api/network should answer).`,
      );
    }
    return body as T;
  }

  private unreachable(err: unknown): XorvPluginError {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return new XorvPluginError(
      "XORV_BROKER_UNREACHABLE",
      timedOut
        ? `the Xorv broker at ${this.baseUrl} did not answer in time`
        : `could not reach the Xorv broker at ${this.baseUrl}: ${errorMessage(err)}`,
      `Start a broker (pnpm broker) or point the plugin at one with --broker <url> or ${BROKER_URL_ENV}.`,
    );
  }
}

/** Turn a broker error response into something an agent can act on. */
export function brokerHttpError(status: number, body: unknown, path: string): XorvPluginError {
  const message =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : `HTTP ${status}`;
  if (path.startsWith("/api/quotes") && status === 503) {
    return new XorvPluginError(
      "XORV_NO_PROVIDERS",
      message,
      "Raise --max, drop --adapter, or try again when a provider is online (mm xorv providers).",
    );
  }
  if (path.startsWith("/api/quotes") && status === 422) {
    return new XorvPluginError("XORV_QUOTE_REFUSED", message, "Rephrase the prompt; the broker's safety screen refused it.");
  }
  if (/^\/api\/jobs\/[^/]+\/(rating|rate)(\?|$)/.test(path) && status !== 404 && status < 500) {
    // "already rated", "not finished yet", "provider has no agent identity",
    // "not the payer": all final answers about this job, not transport trouble.
    return new XorvPluginError("XORV_RATING_REFUSED", `the broker will not record this rating: ${message}`, hintForStatus(status));
  }
  return new XorvPluginError("XORV_BROKER_ERROR", `the broker refused ${path.split("?")[0]}: ${message}`, hintForStatus(status));
}

function hintForStatus(status: number): string {
  if (status === 404) return "Check the id; quotes expire after five minutes and must be requested again.";
  if (status === 409) return "The job or quote is not in a state that allows this; read the message above.";
  if (status === 429) return "The broker is rate limiting; wait a minute and retry.";
  if (status >= 500) return "The broker had a problem; retry shortly.";
  return "Read the broker's message above.";
}

function parseStreamFrame(frame: SseFrame): JobStreamEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  if (frame.event === "event") return { type: "event", event: data as JobEvent };
  if (frame.event === "snapshot" || frame.event === "job" || frame.event === "done") {
    return { type: frame.event, job: data as PublicJob };
  }
  return null;
}
