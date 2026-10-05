#!/usr/bin/env node
/**
 * Xorv as an MCP server.
 *
 * This is the part of the story x402 was actually invented for: an agent that
 * needs work done finds capacity, pays for it, and gets the result — without a
 * human opening a browser, creating an account, or pasting a card number. The
 * agent holds an EVM key, the network quotes a price, the payment settles on
 * Arbitrum in about a second, and the job runs on a stranger's machine.
 *
 * The agent never broadcasts a transaction and needs no ETH. It signs an
 * EIP-3009 authorization and a facilitator relays it — which is what makes an
 * autonomous wallet holding nothing but USDG (or USDC) a workable thing to give
 * a model.
 *
 * Point any MCP client at it:
 *
 *   claude mcp add xorv -- npx -y @xorv/mcp
 *
 * Configuration is environment-only, because an MCP server is launched by
 * another program and has no terminal to prompt at:
 *
 *   XORV_BROKER_URL   broker to buy from (default http://localhost:8402)
 *   XORV_PAYER_KEY    the private key that pays for jobs (the address is
 *                     derived from it — there is nothing else to configure)
 *   XORV_NETWORK      default eip155:421614 (Arbitrum Sepolia); the broker's
 *                     own network wins once it is known
 *   XORV_RPC_URL      optional RPC override, for reading the payer's balances
 *   XORV_MAX_USD      hard ceiling per job, default 0.05 — see below
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { toClientEvmSigner } from "@x402/evm";
import { erc20Abi, getAddress } from "viem";
import {
  DEFAULT_NETWORK,
  accountFor,
  choosePaymentAsset,
  explorerTx,
  formatUsd,
  onlyAssetPolicy,
  parseUsd,
  readClient,
  registerXorvPaymentSchemes,
  type EscrowRecord,
} from "@xorv/protocol";

const BROKER_URL = (process.env.XORV_BROKER_URL ?? "http://localhost:8402").replace(/\/+$/, "");
let NETWORK = process.env.XORV_NETWORK?.trim() || DEFAULT_NETWORK;

/** Adopt the broker's network, so signatures bind to the chain it settles on. */
async function syncNetwork(): Promise<void> {
  try {
    const info = await getJson<{ network?: string; explorer?: string }>("/api/network");
    if (info.network?.startsWith("eip155:")) NETWORK = info.network;
    // Links point where the broker's do (a local node's viewer, say).
    if (info.explorer && /^https?:\/\//.test(info.explorer) && !process.env.XORV_EXPLORER_URL) {
      process.env.XORV_EXPLORER_URL = info.explorer;
    }
  } catch {
    /* keep the configured one; the quote will say if the broker is down */
  }
}
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
    address: string;
    capability: string;
    adapter: string;
    model: string | null;
    stats: { jobsCompleted: number; jobsFailed: number };
  };
  /** One row per stablecoin the broker accepts, USDG first. */
  accepts: Array<{ asset: string; amount: string; symbol?: string }>;
  /** Present when the broker pays jobs into XorvEscrow rather than straight to the provider. */
  escrow?: { address: string; jobId: string; deadline: number } | null;
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
  receiptTxHash: string | null;
  payment: {
    transactionHash: string;
    explorerUrl: string;
    asset: string;
    scheme?: string;
    escrow?: EscrowRecord;
  } | null;
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

/**
 * Build a paying fetch, narrowed to one stablecoin.
 *
 * Throws when no key is configured — read-only still works.
 */
function payingClient(asset: string) {
  if (!PAYER_KEY) {
    throw new Error(
      "No payer configured. Set XORV_PAYER_KEY in this MCP server's environment to let it buy jobs.",
    );
  }
  const payer = accountFor(PAYER_KEY);
  const client = new x402Client();
  // Registered as the `eip155:*` wildcard rather than one named network, which
  // `registerExactEvmScheme` does when `networks` is omitted.
  //
  // This is a correctness fix, not a shortcut. Pinning the client to a network
  // read from *local* config means a buyer can only pay a broker that happens
  // to match their own node's configuration — and the failure is baffling:
  // the 402 arrives correctly, the requirements are valid, and the client
  // refuses with "no network/scheme registered" while naming two networks that
  // look fine in isolation. A buyer should be able to pay whatever the broker
  // quotes.
  //
  // Nothing is lost by widening it. The EIP-712 domain binds the signature to a
  // specific chain id and verifying contract, so an authorization signed for one
  // network cannot be replayed on another, and the price ceiling still applies.
  //
  // Both schemes, escrow first: the agent's money waits in XorvEscrow until
  // the job delivers, and comes back if it doesn't.
  registerXorvPaymentSchemes(client, toClientEvmSigner(payer, readClient(NETWORK)));
  // The 402 offers every stablecoin the broker accepts (USDG first). Pay in
  // the one chosen from the payer's balances, not blindly the first.
  client.registerPolicy(onlyAssetPolicy(asset));
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
          address: string;
          region: string | null;
          capabilities: Array<{ displayName: string; adapter: string; priceUsdMicros: number }>;
          stats: { jobsCompleted: number; jobsFailed: number };
        }>;
      }>("/api/providers");

      const live = providers.filter((p) => p.status !== "offline");
      if (live.length === 0) {
        return text(
          "No providers are online right now. Anyone can run one from source: `git clone https://github.com/nickthelegend/xorv-arbitrum && cd xorv-arbitrum && pnpm install && pnpm build`, then `node packages/cli/dist/index.js init` and `… start`.",
        );
      }

      const lines = live.map((p) => {
        const caps = p.capabilities
          .map((c) => `${c.displayName} (${c.adapter}) ${formatUsd(c.priceUsdMicros)}/job`)
          .join(", ");
        return `- ${p.label} [${p.status}]${p.region ? ` · ${p.region}` : ""} — ${caps} · ${p.stats.jobsCompleted} jobs done, ${p.stats.jobsFailed} failed · pays to ${p.address}`;
      });
      return text(`${live.length} provider(s) live on ${NETWORK}:\n${lines.join("\n")}`);
    } catch (err) {
      return fail(`Could not reach the Xorv broker at ${BROKER_URL}: ${String(err)}`);
    }
  },
);

server.tool(
  "xorv_network_status",
  "Show the Xorv network's overall state: how many providers are live, how many jobs have settled, the facilitator, and the on-chain audit log carrying the public record.",
  {},
  async () => {
    try {
      const info = await getJson<{
        network: string;
        facilitator: { description: string; feePayer: string };
        stablecoins?: Array<{ symbol: string; address: string }>;
        log: { address: string; url: string } | null;
        stats: {
          providersLive: number;
          jobsTotal: number;
          jobsCompleted: number;
          paidUsdMicros: number;
        };
      }>("/api/network");


      return text(
        [
          `Network: ${info.network}`,
          `Facilitator: ${info.facilitator.description} (ETH gas paid by ${info.facilitator.feePayer} — buyers need none)`,
          `Payable in: ${(info.stablecoins ?? []).map((t) => `${t.symbol} ${t.address}`).join(", ") || "unknown"}`,
          `Providers live: ${info.stats.providersLive}`,
          `Jobs: ${info.stats.jobsCompleted} completed of ${info.stats.jobsTotal}`,
          `Settled: ${formatUsd(info.stats.paidUsdMicros)}`,
          `Audit log (public, on chain): ${info.log ? `${info.log.address} — ${info.log.url}` : "not configured"}`,
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
        body: JSON.stringify({
          prompt,
          adapter: adapter ?? null,
          maxPriceUsdMicros: ceiling,
        }),
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
          quote.escrow
            ? `Payment is held in the XorvEscrow contract ${quote.escrow.address} and released to ${quote.provider.address} when the result is delivered — refunded if it isn't, by anyone after ${new Date(quote.escrow.deadline * 1000).toISOString()}. The broker never holds it.`
            : `Payment goes directly to ${quote.provider.address} — the broker never holds it.`,
          `Payable in: ${quote.accepts.map((a) => `${a.symbol ?? a.asset} (${a.amount} units)`).join(" or ")}. You need no ETH — the facilitator relays and pays the gas.`,
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
  `Run an AI job on the Xorv network and PAY FOR IT with a real on-chain transfer. This spends money — at most ${formatUsd(MAX_USD_MICROS)} per call. The job runs on someone else's machine using their AI subscription. The payment is held in an on-chain escrow and released to them when the result is delivered, or refunded to you if it isn't. Pays in the broker's default stablecoin (USDG on Arbitrum) unless told otherwise. Returns the result plus explorer links proving the deposit and the release or refund.`,
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
    token: z
      .string()
      .optional()
      .describe("Stablecoin to pay with: USDG or USDC. Omit to pay with the first one the payer holds enough of (USDG first)."),
  },
  async ({ prompt, adapter, max_usd, token }) => {
    const ceiling = Math.min(max_usd ? parseUsd(max_usd) : MAX_USD_MICROS, MAX_USD_MICROS);
    if (!PAYER_KEY) {
      return fail("No payer configured. Set XORV_PAYER_KEY in this MCP server's environment to let it buy jobs.");
    }

    try {
      // 1. Quote — so the price is pinned and we can refuse it before paying.
      const quoteRes = await fetch(`${BROKER_URL}/api/quotes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          adapter: adapter ?? null,
          maxPriceUsdMicros: ceiling,
        }),
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

      // 2. Pick the stablecoin: the one asked for, else the first affordable.
      await syncNetwork();
      const payer = accountFor(PAYER_KEY).address;
      const balances = await payerBalances(payer, quote.accepts);
      const chosen = choosePaymentAsset(quote.accepts, { balances, preferred: token ?? null });
      if (!chosen) {
        return fail(
          `The broker does not accept ${token}. It offers: ${quote.accepts.map((a) => a.symbol ?? a.asset).join(", ")}.`,
        );
      }
      const symbol = chosen.symbol ?? "stablecoin";
      const { paidFetch, httpClient } = payingClient(chosen.asset);

      // 3. Pay. The 402 dance happens inside paidFetch.
      const payRes = await paidFetch(`${BROKER_URL}/api/jobs/${quote.quoteId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const paid = (await payRes.json()) as { jobId?: string; error?: string };
      if (!payRes.ok || !paid.jobId) {
        return fail(
          `Payment failed (${payRes.status}): ${paid.error ?? `the payer may hold too little ${symbol} — try the token parameter with another stablecoin`}`,
        );
      }
      const settlement = httpClient.getPaymentSettleResponse((n) => payRes.headers.get(n));

      // 4. Wait for the answer.
      const job = await pollUntilDone(paid.jobId, 10 * 60_000);

      const escrow = job.payment?.escrow;
      if (job.status !== "completed") {
        const refund = escrow?.refundTx
          ? ` The ${symbol} was refunded from escrow: ${explorerTx(NETWORK, escrow.refundTx)}`
          : escrow
            ? ` The ${symbol} is in escrow and refundable after ${new Date(escrow.deadline * 1000).toISOString()}.`
            : "";
        return fail(`Job ${job.status}: ${job.error ?? "no result"}.${refund}`);
      }

      const proof = settlement?.transaction
        ? `\n\n---\nPaid ${quote.priceLabel} in ${symbol} to ${quote.provider.label} (${quote.provider.address})\n${
            escrow ? "Escrowed" : "Transaction"
          }: ${explorerTx(NETWORK, settlement.transaction)}${
            escrow?.releaseTx ? `\nReleased to the provider: ${explorerTx(NETWORK, escrow.releaseTx)}` : ""
          }${
            job.receiptTxHash
              ? `\nOn-chain receipt: ${explorerTx(NETWORK, job.receiptTxHash)}`
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
          job.payment ? `Payment: ${job.payment.explorerUrl}` : "Payment: not settled",
          job.payment?.escrow
            ? `Escrow: ${job.payment.escrow.state}${
                job.payment.escrow.releaseTx ? ` — ${explorerTx(NETWORK, job.payment.escrow.releaseTx)}` : ""
              }${job.payment.escrow.refundTx ? ` — ${explorerTx(NETWORK, job.payment.escrow.refundTx)}` : ""}`
            : "",
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
 * The payer's balance in each offered stablecoin, keyed by lowercase address.
 * A token whose balance can't be read is left out — treated as payable.
 */
async function payerBalances(
  payer: string,
  accepts: QuoteResponse["accepts"],
): Promise<Record<string, bigint>> {
  const client = readClient(NETWORK);
  const out: Record<string, bigint> = {};
  await Promise.all(
    accepts.map(async (a) => {
      try {
        out[a.asset.toLowerCase()] = (await client.readContract({
          address: getAddress(a.asset),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [getAddress(payer)],
        })) as bigint;
      } catch {
        /* unknown */
      }
    }),
  );
  return out;
}

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
        // Give the receipt and the escrow release (or refund) a moment, so the
        // proof links are in the answer rather than promised.
        let settled = job;
        for (let i = 0; i < 8; i++) {
          const moving = settled.payment?.escrow?.state === "funded";
          if (!moving && settled.receiptTxHash) break;
          await new Promise((r) => setTimeout(r, 2_000));
          settled = (await getJson<{ job: JobView }>(`/api/jobs/${jobId}`)).job;
        }
        return settled;
      }
    } catch {
      // Transient broker blip; keep polling until the deadline.
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return last ?? { id: jobId, status: "timed out", result: null, error: "timed out waiting for the provider", resultHash: null, priceLabel: null, providerLabel: null, receiptTxHash: null, payment: null };
}

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr, never stdout: stdout is the JSON-RPC channel and anything else on it
// corrupts the protocol.
console.error(`[xorv-mcp] ready — broker ${BROKER_URL}, network ${NETWORK}, cap ${formatUsd(MAX_USD_MICROS)}/job`);
