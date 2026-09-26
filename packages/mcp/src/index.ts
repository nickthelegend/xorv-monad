#!/usr/bin/env node
/**
 * Xorv as an MCP server.
 *
 * This is the part of the story x402 was actually invented for: an agent that
 * needs work done finds capacity, pays for it, and gets the result — without a
 * human opening a browser, creating an account, or pasting a card number. The
 * agent holds a Hedera key, the network quotes a price, the payment settles in
 * about three seconds, and the job runs on a stranger's machine.
 *
 * Point any MCP client at it:
 *
 *   claude mcp add xorv -- npx -y @xorv/mcp
 *
 * Configuration is environment-only, because an MCP server is launched by
 * another program and has no terminal to prompt at:
 *
 *   XORV_BROKER_URL   broker to buy from (default http://localhost:8402)
 *   XORV_PAYER_ID     Hedera account that pays for jobs
 *   XORV_PAYER_KEY    its private key
 *   XORV_NETWORK      default hedera:testnet
 *   XORV_MAX_USD      hard ceiling per job, default 0.05 — see below
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import {
  HBAR_ASSET_ID,
  formatUsd,
  hashscanTx,
  parsePrivateKey,
  parseUsd,
} from "@xorv/protocol";

const BROKER_URL = (process.env.XORV_BROKER_URL ?? "http://localhost:8402").replace(/\/+$/, "");
const NETWORK = process.env.XORV_NETWORK ?? "hedera:testnet";
const PAYER_ID = process.env.XORV_PAYER_ID?.trim();
const PAYER_KEY = process.env.XORV_PAYER_KEY?.trim();

/**
 * A hard spending ceiling per job.
 *
 * An MCP server is driven by a model, and a model that can spend without a
 * bound is a model that can empty an account through a loop it didn't mean to
 * write. The tool schema lets the caller ask for less than this; nothing lets
 * it ask for more.
 */
const MAX_USD_MICROS = parseUsd(process.env.XORV_MAX_USD ?? "0.05");

interface QuoteResponse {
  quoteId: string;
  priceUsdMicros: number;
  priceLabel: string;
  expiresAt: number;
  provider: {
    id: string;
    label: string;
    accountId: string;
    capability: string;
    adapter: string;
    model: string | null;
    stats: { jobsCompleted: number; jobsFailed: number };
  };
  accepts: Array<{ asset: string; amount: string }>;
  error?: string;
}

interface JobView {
  id: string;
  status: string;
  result: string | null;
  error: string | null;
  resultHash: string | null;
  priceLabel: string | null;
  providerLabel: string | null;
  receiptConsensusAt: string | null;
  payment: { transactionId: string; hashscanUrl: string; asset: string } | null;
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** Build a paying fetch. Throws when no key is configured — read-only still works. */
function payingClient(preferHbar: boolean) {
  if (!PAYER_ID || !PAYER_KEY) {
    throw new Error(
      "No payer configured. Set XORV_PAYER_ID and XORV_PAYER_KEY in this MCP server's environment to let it buy jobs.",
    );
  }
  const signer = createClientHederaSigner(PAYER_ID, parsePrivateKey(PAYER_KEY), {
    network: NETWORK,
  });
  const client = new x402Client().register("hedera:*", new ExactHederaScheme(signer));
  client.registerPolicy((_v, requirements) => {
    const preferred = preferHbar
      ? requirements.filter((r) => r.asset === HBAR_ASSET_ID)
      : requirements.filter((r) => r.asset !== HBAR_ASSET_ID);
    return preferred.length > 0 ? preferred : requirements;
  });
  return { paidFetch: wrapFetchWithPayment(fetch, client), httpClient: new x402HTTPClient(client) };
}

const server = new McpServer({ name: "xorv", version: "0.1.0" });

// ---------------------------------------------------------------------------
// Read-only tools — no key needed
// ---------------------------------------------------------------------------

server.tool(
  "xorv_list_providers",
  "List the AI providers currently live on the Xorv network, what models they run, and what they charge per job. Use this before buying to see what capacity is available.",
  {},
  async () => {
    try {
      const { providers } = await getJson<{
        providers: Array<{
          label: string;
          status: string;
          accountId: string;
          region: string | null;
          capabilities: Array<{ displayName: string; adapter: string; priceUsdMicros: number }>;
          stats: { jobsCompleted: number; jobsFailed: number };
        }>;
      }>("/api/providers");

      const live = providers.filter((p) => p.status !== "offline");
      if (live.length === 0) {
        return text(
          "No providers are online right now. Anyone can start one with `npm i -g @xorv/cli && xorv init && xorv start`.",
        );
      }

      const lines = live.map((p) => {
        const caps = p.capabilities
          .map((c) => `${c.displayName} (${c.adapter}) ${formatUsd(c.priceUsdMicros)}/job`)
          .join(", ");
        return `- ${p.label} [${p.status}]${p.region ? ` · ${p.region}` : ""} — ${caps} · ${p.stats.jobsCompleted} jobs done, ${p.stats.jobsFailed} failed · pays to ${p.accountId}`;
      });
      return text(`${live.length} provider(s) live on ${NETWORK}:\n${lines.join("\n")}`);
    } catch (err) {
      return fail(`Could not reach the Xorv broker at ${BROKER_URL}: ${String(err)}`);
    }
  },
);

server.tool(
  "xorv_network_status",
  "Show the Xorv network's overall state: how many providers are live, how many jobs have settled, the facilitator, and the Hedera Consensus Service topics carrying the public audit trail.",
  {},
  async () => {
    try {
      const info = await getJson<{
        network: string;
        facilitator: { description: string; feePayer: string };
        usdc: string;
        topics: Record<string, { id: string; url: string } | null>;
        stats: {
          providersLive: number;
          jobsTotal: number;
          jobsCompleted: number;
          paidUsdMicros: number;
        };
      }>("/api/network");

      const topics = Object.entries(info.topics)
        .map(([kind, t]) => `  ${kind}: ${t ? `${t.id} — ${t.url}` : "not configured"}`)
        .join("\n");

      return text(
        [
          `Network: ${info.network}`,
          `Facilitator: ${info.facilitator.description} (gas paid by ${info.facilitator.feePayer})`,
          `USDC token: ${info.usdc}`,
          `Providers live: ${info.stats.providersLive}`,
          `Jobs: ${info.stats.jobsCompleted} completed of ${info.stats.jobsTotal}`,
          `Settled: ${formatUsd(info.stats.paidUsdMicros)}`,
          `Audit topics (public, on Hedera):`,
          topics,
        ].join("\n"),
      );
    } catch (err) {
      return fail(`Could not reach the Xorv broker at ${BROKER_URL}: ${String(err)}`);
    }
  },
);

server.tool(
  "xorv_quote",
  "Get a price for a job WITHOUT paying for it. Returns which provider would run it and what it would cost. Use this to check the price before calling xorv_run_job.",
  {
    prompt: z.string().min(1).describe("The job to price."),
    adapter: z
      .string()
      .optional()
      .describe("Require a specific adapter: claude-code, codex, grok, opencode, openai-compatible."),
    max_usd: z.number().positive().optional().describe("Most you'd pay, in US dollars."),
  },
  async ({ prompt, adapter, max_usd }) => {
    const ceiling = Math.min(max_usd ? parseUsd(max_usd) : MAX_USD_MICROS, MAX_USD_MICROS);
    try {
      const res = await fetch(`${BROKER_URL}/api/quotes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, adapter: adapter ?? null, maxPriceUsdMicros: ceiling }),
        signal: AbortSignal.timeout(20_000),
      });
      const quote = (await res.json()) as QuoteResponse;
      if (!res.ok) return fail(quote.error ?? `Broker returned ${res.status}`);

      return text(
        [
          `Quote ${quote.quoteId} (expires in ${Math.round((quote.expiresAt - Date.now()) / 1000)}s)`,
          `Price: ${quote.priceLabel}`,
          `Provider: ${quote.provider.label} running ${quote.provider.capability}${quote.provider.model ? ` (${quote.provider.model})` : ""}`,
          `Track record: ${quote.provider.stats.jobsCompleted} completed, ${quote.provider.stats.jobsFailed} failed`,
          `Payment goes directly to ${quote.provider.accountId} — the broker never holds it.`,
          `Payable in: ${quote.accepts.map((a) => (a.asset === HBAR_ASSET_ID ? "HBAR" : "USDC")).join(" or ")}`,
        ].join("\n"),
      );
    } catch (err) {
      return fail(`Quote failed: ${String(err)}`);
    }
  },
);

// ---------------------------------------------------------------------------
// The paying tool
// ---------------------------------------------------------------------------

server.tool(
  "xorv_run_job",
  `Run an AI job on the Xorv network and PAY FOR IT with a real on-chain transfer. This spends money — at most ${formatUsd(MAX_USD_MICROS)} per call. The job runs on someone else's machine using their AI subscription, and they are paid directly. Returns the result plus a HashScan link proving the payment.`,
  {
    prompt: z.string().min(1).describe("The job to run."),
    adapter: z
      .string()
      .optional()
      .describe("Require a specific adapter: claude-code, codex, grok, opencode, openai-compatible."),
    max_usd: z
      .number()
      .positive()
      .optional()
      .describe(`Most to pay in US dollars. Capped at ${formatUsd(MAX_USD_MICROS)} regardless.`),
    pay_with: z.enum(["usdc", "hbar"]).optional().describe("Which asset to pay in. Default usdc."),
  },
  async ({ prompt, adapter, max_usd, pay_with }) => {
    const ceiling = Math.min(max_usd ? parseUsd(max_usd) : MAX_USD_MICROS, MAX_USD_MICROS);

    let paidFetch: typeof fetch;
    let httpClient: x402HTTPClient;
    try {
      const built = payingClient(pay_with === "hbar");
      paidFetch = built.paidFetch as typeof fetch;
      httpClient = built.httpClient;
    } catch (err) {
      return fail(String(err instanceof Error ? err.message : err));
    }

    try {
      // 1. Quote — so the price is pinned and we can refuse it before paying.
      const quoteRes = await fetch(`${BROKER_URL}/api/quotes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, adapter: adapter ?? null, maxPriceUsdMicros: ceiling }),
        signal: AbortSignal.timeout(20_000),
      });
      const quote = (await quoteRes.json()) as QuoteResponse;
      if (!quoteRes.ok) return fail(quote.error ?? `No quote: broker returned ${quoteRes.status}`);

      // Belt and braces: the ceiling is enforced here too, not only server-side.
      if (quote.priceUsdMicros > ceiling) {
        return fail(
          `Refusing to pay ${quote.priceLabel}, which is over the ${formatUsd(ceiling)} limit.`,
        );
      }

      // 2. Pay. The 402 dance happens inside paidFetch.
      const payRes = await paidFetch(`${BROKER_URL}/api/jobs/${quote.quoteId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const paid = (await payRes.json()) as { jobId?: string; error?: string };
      if (!payRes.ok || !paid.jobId) {
        return fail(
          `Payment failed (${payRes.status}): ${paid.error ?? "the payer may hold no USDC, or not be associated with the token"}`,
        );
      }
      const settlement = httpClient.getPaymentSettleResponse((n) => payRes.headers.get(n));

      // 3. Wait for the answer.
      const job = await pollUntilDone(paid.jobId, 10 * 60_000);

      if (job.status !== "completed") {
        return fail(`Job ${job.status}: ${job.error ?? "no result"}`);
      }

      const proof = settlement?.transaction
        ? `\n\n---\nPaid ${quote.priceLabel} to ${quote.provider.label} (${quote.provider.accountId})\nTransaction: ${hashscanTx(NETWORK, settlement.transaction)}${
            job.receiptConsensusAt
              ? `\nHCS receipt: ${hashscanTx(NETWORK, job.receiptConsensusAt)}`
              : ""
          }`
        : "";

      return text(`${job.result ?? ""}${proof}`);
    } catch (err) {
      return fail(`Job failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "xorv_get_job",
  "Look up a Xorv job by id — its status, result, and the on-chain payment record.",
  { job_id: z.string().describe("The job id, e.g. job_TwzS96BhAx81.") },
  async ({ job_id }) => {
    try {
      const { job } = await getJson<{ job: JobView }>(`/api/jobs/${job_id}`);
      return text(
        [
          `Job ${job.id} — ${job.status}`,
          `Provider: ${job.providerLabel ?? "unassigned"}`,
          `Price: ${job.priceLabel ?? "—"}`,
          job.payment ? `Payment: ${job.payment.hashscanUrl}` : "Payment: not settled",
          job.resultHash ? `Result sha256: ${job.resultHash}` : "",
          "",
          job.result ?? job.error ?? "(no result yet)",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (err) {
      return fail(`Could not read job ${job_id}: ${String(err)}`);
    }
  },
);

/**
 * Poll a job to completion.
 *
 * Polling rather than SSE: an MCP tool call is a request/response, there is no
 * one watching a stream, and a 2s poll against a job that takes seconds to
 * minutes is not worth a streaming client's failure modes.
 */
async function pollUntilDone(jobId: string, timeoutMs: number): Promise<JobView> {
  const deadline = Date.now() + timeoutMs;
  let last: JobView | null = null;
  while (Date.now() < deadline) {
    try {
      const { job } = await getJson<{ job: JobView }>(`/api/jobs/${jobId}`);
      last = job;
      if (job.status === "completed" || job.status === "failed") {
        // Give the HCS receipt a moment so the proof link is in the answer.
        if (job.status === "completed" && !job.receiptConsensusAt) {
          await new Promise((r) => setTimeout(r, 4_000));
          const { job: withReceipt } = await getJson<{ job: JobView }>(`/api/jobs/${jobId}`);
          return withReceipt;
        }
        return job;
      }
    } catch {
      // Transient broker blip; keep polling until the deadline.
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return last ?? { id: jobId, status: "timed out", result: null, error: "timed out waiting for the provider", resultHash: null, priceLabel: null, providerLabel: null, receiptConsensusAt: null, payment: null };
}

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr, never stdout: stdout is the JSON-RPC channel and anything else on it
// corrupts the protocol.
console.error(`[xorv-mcp] ready — broker ${BROKER_URL}, network ${NETWORK}, cap ${formatUsd(MAX_USD_MICROS)}/job`);
