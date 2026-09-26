/**
 * `xorv run "<prompt>"` — the buyer side.
 *
 * Posts a job, pays for it with a real on-chain transfer over x402, watches it
 * execute on a stranger's machine, and prints the answer plus a HashScan link.
 * The whole protocol, end to end, in one command and about four seconds.
 *
 * This is also the honest test of the network: it uses the same public HTTP
 * surface and the same `@x402/*` client any third party would, with no
 * privileged access to the broker.
 */

import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";
import {
  HBAR_ASSET_ID,
  formatDuration,
  formatHbar,
  formatUsd,
  hashscanTx,
  networkLabel,
  parsePrivateKey,
  parseUsd,
  type AdapterKind,
} from "@xorv/protocol";
import { loadConfig } from "../config.js";
import * as ui from "../ui.js";

interface RunOptions {
  broker?: string;
  max?: string;
  adapter?: string;
  account?: string;
  key?: string;
  hbar?: boolean;
  yes?: boolean;
  json?: boolean;
}

interface QuoteResponse {
  quoteId: string;
  payUrl: string;
  priceUsdMicros: number;
  priceLabel: string;
  expiresAt: number;
  provider: {
    id: string;
    label: string;
    accountId: string;
    accountUrl: string;
    capability: string;
    adapter: string;
    model: string | null;
    stats: { jobsCompleted: number; jobsFailed: number };
  };
  accepts: Array<{ asset: string; amount: string }>;
}

/**
 * Leave the process, having flushed stdout.
 *
 * `createClientHederaSigner` builds a Hedera SDK client internally and does not
 * hand it back, and that client holds gRPC channels open — so a `xorv run` that
 * has printed its answer and settled its payment would otherwise sit there
 * forever with nothing left to do. There is no handle to close, so the honest
 * fix is to exit deliberately once the work is genuinely finished.
 */
async function exitAfterFlush(code: number): Promise<never> {
  await new Promise<void>((resolve) => {
    if (process.stdout.write("")) resolve();
    else process.stdout.once("drain", () => resolve());
  });
  process.exit(code);
}

/**
 * Fail in whatever shape the caller asked for.
 *
 * `--json` is a contract: a machine is parsing this. Printing prose on the
 * error path breaks every caller that succeeded in parsing the happy path —
 * including the Claude Code skill, which shells out to this exact command.
 */
async function failOut(
  json: boolean | undefined,
  stage: string,
  err: unknown,
  hints: string[] = [],
): Promise<never> {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    console.log(JSON.stringify({ status: "failed", stage, error: message, hints }, null, 2));
  } else {
    ui.blank();
    for (const hint of hints) ui.muted(`  ${hint}`);
  }
  await exitAfterFlush(1);
  throw new Error("unreachable");
}

export async function runCommand(prompt: string, opts: RunOptions): Promise<void> {
  const config = loadConfig();
  const brokerUrl = (
    opts.broker ??
    process.env.XORV_BROKER_URL ??
    config?.brokerUrl ??
    "http://localhost:8402"
  ).replace(/\/+$/, "");

  // The buyer's account. Falls back to the node's own payout account, which is
  // handy for a solo demo but means you'd be paying yourself — called out below.
  const accountId = opts.account ?? process.env.XORV_PAYER_ID ?? config?.accountId ?? "";
  const rawKey = opts.key ?? process.env.XORV_PAYER_KEY ?? config?.privateKey ?? "";
  const network = config?.network ?? "hedera:testnet";

  if (!accountId || !rawKey) {
    ui.bad("no payer account — pass --account and --key, or set XORV_PAYER_ID / XORV_PAYER_KEY");
    process.exitCode = 1;
    return;
  }

  if (!opts.json) console.log(ui.banner("post a job"));

  // -- 1. quote -------------------------------------------------------------

  const maxPrice = parseUsd(opts.max ?? "0.05");
  const quoteSpin = opts.json ? null : ui.spinner("finding a live provider…");

  let quote: QuoteResponse;
  try {
    const res = await fetch(`${brokerUrl}/api/quotes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        adapter: (opts.adapter as AdapterKind | undefined) ?? null,
        maxPriceUsdMicros: maxPrice,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json()) as QuoteResponse & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `broker returned ${res.status}`);
    quote = body;
  } catch (err) {
    if (!opts.json) quoteSpin?.fail(`no quote: ${err instanceof Error ? err.message : String(err)}`);
    await failOut(opts.json, "quote", err, [
      "no live provider matched that request under your price ceiling",
      "check with: xorv status",
    ]);
    return;
  }
  quoteSpin?.succeed(`matched ${ui.c.bold(quote.provider.label)}`);

  const hbarOption = quote.accepts.find((a) => a.asset === HBAR_ASSET_ID);
  const usdcOption = quote.accepts.find((a) => a.asset !== HBAR_ASSET_ID);
  const payingHbar = Boolean(opts.hbar && hbarOption);

  if (!opts.json) {
    ui.blank();
    console.log(
      ui.box(
        ui.kv([
          ["provider", `${ui.c.bold(quote.provider.label)} ${ui.c.muted(`· ${quote.provider.stats.jobsCompleted} jobs done`)}`],
          ["running", `${quote.provider.capability}${quote.provider.model ? ui.c.muted(` · ${quote.provider.model}`) : ""}`],
          ["price", ui.c.money(ui.c.bold(quote.priceLabel))],
          [
            "paying in",
            payingHbar
              ? `${ui.c.bold("HBAR")} ${ui.c.muted(hbarOption ? `(${formatHbar(hbarOption.amount)})` : "")}`
              : `${ui.c.bold("USDC")} ${ui.c.muted(usdcOption ? `(${usdcOption.amount} units)` : "")}`,
          ],
          ["goes to", `${quote.provider.accountId} ${ui.c.muted("— straight to the provider, not the broker")}`],
          ["from", accountId],
        ]),
        { title: "quote" },
      ),
    );
    if (accountId === quote.provider.accountId) {
      ui.blank();
      ui.warn("payer and provider are the same account — you're paying yourself");
    }
    ui.blank();
  }

  if (!opts.yes && !opts.json) {
    const go = await ui.confirm(`pay ${ui.c.money(quote.priceLabel)} and run it?`, true);
    if (!go) {
      ui.info("cancelled — nothing was paid");
      return;
    }
    ui.blank();
  }

  // -- 2. pay ---------------------------------------------------------------

  const signer = createClientHederaSigner(accountId, parsePrivateKey(rawKey) as PrivateKey, {
    network,
  });
  const client = new x402Client().register("hedera:*", new ExactHederaScheme(signer));

  // Narrow the server's `accepts` to the asset the buyer asked for. The policy
  // must never return an empty list — that would leave the client with nothing
  // to pay with and fail a request the server was willing to serve — so an
  // unavailable preference falls back to whatever was offered.
  client.registerPolicy((_version, requirements) => {
    const preferred = payingHbar
      ? requirements.filter((r) => r.asset === HBAR_ASSET_ID)
      : requirements.filter((r) => r.asset !== HBAR_ASSET_ID);
    return preferred.length > 0 ? preferred : requirements;
  });

  const paidFetch = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);
  const paySpin = opts.json ? null : ui.spinner("signing the transfer and settling on Hedera…");

  // Seeded rather than left definite-assigned: the catch below exits the
  // process, but that's an `await` of a never-returning call, which TypeScript's
  // flow analysis doesn't treat as terminal.
  let jobId = "";
  let settleTx: string | null = null;
  try {
    const res = await paidFetch(`${brokerUrl}/api/jobs/${quote.quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { jobId?: string; error?: string };
    if (!res.ok || !body.jobId) {
      throw new Error(body.error ?? `broker returned ${res.status}`);
    }
    jobId = body.jobId;
    settleTx = readSettlementTx(httpClient, res);
  } catch (err) {
    if (!opts.json) paySpin?.fail(`payment failed: ${err instanceof Error ? err.message : String(err)}`);
    await failOut(opts.json, "payment", err, [
      "common causes: the payer holds no USDC, isn't associated with the token,",
      "or is the same account as the provider (you can't pay yourself)",
      "check with: xorv wallet",
    ]);
  }

  paySpin?.succeed(`paid ${ui.c.money(quote.priceLabel)} — job ${ui.c.bold(jobId)}`);
  if (settleTx && !opts.json) {
    ui.ok(`${ui.glyph.chain()} settled on ${networkLabel(network)}`);
    ui.muted(`  ${hashscanTx(network, settleTx)}`);
  }

  // -- 3. watch -------------------------------------------------------------

  if (!opts.json) {
    ui.blank();
    ui.heading("running");
  }

  const started = Date.now();
  let final = await watchJob(brokerUrl, jobId, opts.json ?? false);

  if (final?.status === "completed") {
    const spin = opts.json ? null : ui.spinner("waiting for the HCS receipt to reach consensus…");
    final = await awaitReceipt(brokerUrl, jobId, final);
    if (final?.receiptConsensusAt) spin?.succeed("receipt on the Hedera receipts topic");
    else spin?.stop();
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          jobId,
          quote,
          settlementTransaction: settleTx,
          hashscan: settleTx ? hashscanTx(network, settleTx) : null,
          status: final?.status,
          result: final?.result,
          error: final?.error,
          durationMs: Date.now() - started,
        },
        null,
        2,
      ),
    );
    await exitAfterFlush(final?.status === "completed" ? 0 : 1);
  }

  ui.blank();
  if (final?.status === "completed") {
    console.log(
      ui.box([final.result ?? ""], {
        title: `result · ${formatDuration(Date.now() - started)}`,
        color: ui.BRAND.mint,
      }),
    );
    ui.blank();
    console.log(
      ui.box(
        ui.kv([
          ["paid", ui.c.money(quote.priceLabel)],
          ["to", `${quote.provider.label} ${ui.c.muted(quote.provider.accountId)}`],
          ["tx", settleTx ? ui.c.accent(settleTx) : ui.c.muted("—")],
          ["hashscan", settleTx ? ui.c.muted(hashscanTx(network, settleTx)) : ui.c.muted("—")],
          ["result sha256", ui.c.muted((final.resultHash ?? "").slice(0, 32) + "…")],
          [
            "hcs receipt",
            final.receiptConsensusAt
              ? ui.c.muted(hashscanTx(network, final.receiptConsensusAt))
              : ui.c.muted("publishing…"),
          ],
        ]),
        { title: "receipt", color: ui.BRAND.azure },
      ),
    );
  } else {
    ui.bad(`job ${final?.status ?? "unknown"}: ${final?.error ?? "no result"}`);
  }
  ui.blank();
  await exitAfterFlush(final?.status === "completed" ? 0 : 1);
}

interface JobView {
  status: string;
  result?: string | null;
  error?: string | null;
  resultHash?: string | null;
  receiptConsensusAt?: string | null;
}

/**
 * Follow the job's server-sent event stream to completion.
 *
 * Parsed by hand rather than with EventSource, which Node still doesn't expose
 * on the global in every supported version — and a hand-rolled reader is a
 * dozen lines against a dependency and a polyfill.
 */
async function watchJob(brokerUrl: string, jobId: string, quiet: boolean): Promise<JobView | null> {
  const res = await fetch(`${brokerUrl}/api/jobs/${jobId}/stream`, {
    headers: { Accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last: JobView | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const eventLine = frame.split("\n").find((l) => l.startsWith("event:"));
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const name = eventLine?.slice(6).trim();
      let payload: unknown;
      try {
        payload = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }

      if (name === "event" && !quiet) {
        const event = payload as { kind: string; text: string };
        printEvent(event.kind, event.text);
      } else if (name === "job" || name === "snapshot" || name === "done") {
        last = payload as JobView;
        // Terminal on the snapshot too: the job can finish before this stream
        // is even opened, and waiting for a `done` that already fired would
        // hang the command forever.
        if (name === "done" || last.status === "completed" || last.status === "failed") {
          reader.cancel().catch(() => {});
          return last;
        }
      }
    }
  }
  return last;
}

function printEvent(kind: string, text: string): void {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return;
  const line = clean.slice(0, ui.width() - 6);
  switch (kind) {
    case "tool_call":
      console.log(`  ${ui.c.accent("⚙")} ${ui.c.muted(line)}`);
      break;
    case "file_edit":
      console.log(`  ${ui.c.warn("✎")} ${ui.c.muted(line)}`);
      break;
    case "reasoning":
      console.log(`  ${ui.c.muted("…")} ${ui.c.muted(line)}`);
      break;
    case "error":
      console.log(`  ${ui.glyph.bad()} ${ui.c.bad(line)}`);
      break;
    case "message":
      console.log(`  ${ui.c.accent("▸")} ${line}`);
      break;
    default:
      console.log(`  ${ui.glyph.dot()} ${ui.c.muted(line)}`);
  }
}

/**
 * Pull the settled Hedera transaction id off the response.
 *
 * Goes through the protocol client's own reader rather than base64-decoding the
 * header by hand: the header's name and encoding are x402's to change, and a
 * hand-rolled parser that silently returns null on a format change would show
 * "—" where the on-chain proof should be.
 */
function readSettlementTx(httpClient: x402HTTPClient, res: Response): string | null {
  try {
    const settlement = httpClient.getPaymentSettleResponse((name) => res.headers.get(name));
    return settlement?.transaction ?? null;
  } catch {
    return null;
  }
}

/**
 * Wait for the broker's HCS receipt to reach consensus.
 *
 * The receipt is written after settlement, so a fast job outruns it. Polling
 * briefly here means the command's final output carries the audit link instead
 * of "publishing…", and giving up quietly after the window keeps a slow topic
 * from holding the terminal.
 */
async function awaitReceipt(
  brokerUrl: string,
  jobId: string,
  current: JobView | null,
  timeoutMs = 25_000,
): Promise<JobView | null> {
  if (current?.receiptConsensusAt) return current;
  const deadline = Date.now() + timeoutMs;
  let latest = current;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try {
      const res = await fetch(`${brokerUrl}/api/jobs/${jobId}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { job: JobView };
      latest = body.job;
      if (latest.receiptConsensusAt) return latest;
    } catch {
      /* keep trying until the deadline */
    }
  }
  return latest;
}
