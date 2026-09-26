/**
 * The broker's public HTTP API, as a buyer (or anyone) reaches it.
 *
 * Deliberately thin: the harness talks to the broker exactly the way the
 * apps and third parties do, with plain fetch and the protocol's x402 client,
 * and no import from services/broker.
 */

import { wrapFetchWithPayment } from "@x402/fetch";
import { buyerX402Client, networkConfig, type PublicJob, type QuoteResponse } from "@xorv/protocol";
import type { PrivateKeyAccount } from "viem";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface Api {
  base: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  /** A request whose status the caller wants to see, error or not. */
  raw(path: string, init?: RequestInit): Promise<{ status: number; body: unknown; text: string; headers: Headers }>;
}

export function brokerApi(base: string): Api {
  const raw = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(60_000) });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, text, headers: res.headers };
  };
  const call = async <T>(path: string, init: RequestInit): Promise<T> => {
    const res = await raw(path, init);
    if (res.status < 200 || res.status >= 300) {
      const error = (res.body as { error?: string } | null)?.error;
      throw new ApiError(`${init.method ?? "GET"} ${path} → ${res.status}${error ? `: ${error}` : ""}`, res.status, res.body);
    }
    return res.body as T;
  };
  return {
    base,
    raw,
    get: (path) => call(path, { method: "GET" }),
    post: (path, body) =>
      call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  };
}

export async function getJob(api: Api, jobId: string): Promise<PublicJob> {
  return (await api.get<{ job: PublicJob }>(`/api/jobs/${jobId}`)).job;
}

/**
 * Pay for a quote over x402 the way `xorv run` does: sign an EIP-3009 USDC
 * authorization for exactly the frozen quote (payee, amount, token, chain)
 * and nothing else, and let the broker's facilitator settle it.
 */
export async function payQuote(opts: {
  quote: QuoteResponse;
  buyer: PrivateKeyAccount;
  network: string;
}): Promise<{ jobId: string; status: number; body: Record<string, unknown> }> {
  const client = buyerX402Client({
    signer: opts.buyer,
    network: opts.network,
    maxUsdcUnits: opts.quote.usdcAmount,
    expect: {
      payTo: opts.quote.provider.address,
      amount: opts.quote.usdcAmount,
      network: opts.network,
      asset: networkConfig(opts.network).usdc.address,
    },
  });
  const paidFetch = wrapFetchWithPayment(globalThis.fetch, client);
  const res = await paidFetch(opts.quote.payUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.jobId !== "string") {
    throw new ApiError(`paying ${opts.quote.payUrl} → ${res.status}: ${String(body.error ?? "no job id")}`, res.status, body);
  }
  return { jobId: body.jobId, status: res.status, body };
}

/** Poll a job until it is completed or failed. */
export async function waitForJob(api: Api, jobId: string, timeoutMs = 120_000): Promise<PublicJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getJob(api, jobId);
    if (job.status === "completed" || job.status === "failed") return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} is still ${job.status} after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
