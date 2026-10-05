/**
 * `xorv run "<prompt>"` — the buyer side.
 *
 * Posts a job, pays for it with a real on-chain transfer over x402, watches it
 * execute on a stranger's machine, and prints the answer plus an Monadscan link.
 * The whole protocol, end to end, in one command and about four seconds.
 *
 * The buyer never broadcasts a transaction. It signs an EIP-3009
 * authorization — typed data, not a transaction — and the facilitator relays
 * it. So this command works from an address holding nothing but AUSD (or
 * USDC) — no MON at all — which is the entire point.
 *
 * This is also the honest test of the network: it uses the same public HTTP
 * surface and the same `@x402/*` client any third party would, with no
 * privileged access to the broker.
 */

import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { toClientEvmSigner } from "@x402/evm";
import { erc20Abi, getAddress } from "viem";
import {
  DEFAULT_NETWORK,
  accountFor,
  choosePaymentAsset,
  formatDuration,
  formatUnits,
  explorerName,
  explorerTx,
  networkLabel,
  onlyAssetPolicy,
  parseUsd,
  readClient,
  registerXorvPaymentSchemes,
  type AdapterKind,
  type EscrowRecord,
} from "@xorv/protocol";
import { loadConfig } from "../config.js";
import * as ui from "../ui.js";

interface RunOptions {
  broker?: string;
  max?: string;
  adapter?: string;
  account?: string;
  key?: string;
  yes?: boolean;
  json?: boolean;
  /** Stablecoin to pay with, by symbol (AUSD, USDC) or address. */
  token?: string;
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
    address: string;
    addressUrl: string;
    capability: string;
    adapter: string;
    model: string | null;
    stats: { jobsCompleted: number; jobsFailed: number };
  };
  /** One row per stablecoin the broker accepts, in its preference order (AUSD first). */
  accepts: Array<{ asset: string; amount: string; symbol?: string }>;
  /** Set when the broker settles through XorvEscrow: where the money will wait, and until when. */
  escrow?: { address: string; jobId: string; deadline: number; addressUrl?: string } | null;
}

/**
 * Leave the process, having flushed stdout.
 *
 * Less load-bearing than it was. The Hedera client held gRPC channels open with
 * no handle to close them, so a finished `xorv run` would sit there forever;
 * viem's HTTP transport has no such problem. Kept because the streaming job
 * watcher can still have a socket in flight, and because a CLI that exits
 * deliberately beats one that exits because nothing happened to be pending.
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

  // The buyer's key. Falls back to the node's own payout key, which is handy
  // for a solo demo but means you'd be paying yourself — called out below.
  //
  // Only a key: the address is derived from it. The Hedera version took an
  // account id *and* a key and could not check that they belonged together —
  // a mismatched pair produced INVALID_SIGNATURE on settlement and nothing
  // sooner.
  const rawKey = opts.key ?? process.env.XORV_PAYER_KEY ?? config?.privateKey ?? "";
  // The broker's network wins over local config once the quote arrives — see
  // below. This is only the fallback for reading balances before then.
  let network = config?.network ?? DEFAULT_NETWORK;

  if (!rawKey) {
    ui.bad("no payer key — pass --key, or set XORV_PAYER_KEY");
    process.exitCode = 1;
    return;
  }

  let payer;
  try {
    payer = accountFor(rawKey);
  } catch (err) {
    ui.bad(`payer key: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  const payerAddress = payer.address;

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

  // Which network the broker settles on. Signing for any other chain id would
  // produce an authorization the broker's facilitator cannot use.
  network = await brokerNetwork(brokerUrl, network);

  // Which stablecoin to pay with: the one named by --token, otherwise the
  // first one (in the broker's order, AUSD first) this payer can afford.
  const balances = await payerBalances(network, payerAddress, quote.accepts);
  const chosen = choosePaymentAsset(quote.accepts, { balances, preferred: opts.token ?? null });
  if (!chosen) {
    const offered = quote.accepts.map((a) => a.symbol ?? a.asset).join(", ");
    await failOut(opts.json, "quote", new Error(`the broker does not accept ${opts.token} — it offers ${offered}`), [
      `pass --token with one of: ${offered}`,
    ]);
    return;
  }
  const symbol = chosen.symbol ?? "stablecoin";
  const held = balances[chosen.asset.toLowerCase()];

  // Known short before anything is signed: say so and stop. This used to sign
  // and submit anyway, and the buyer read "broker returned 402" with a list of
  // things that might be wrong.
  if (held !== undefined && held < BigInt(chosen.amount)) {
    if (!opts.json) {
      ui.blank();
      ui.bad(`${payerAddress} holds ${formatUnits(held.toString())} ${symbol} — this job costs ${quote.priceLabel}. Nothing was signed.`);
    }
    await failOut(
      opts.json,
      "payment",
      new Error(`${payerAddress} holds ${formatUnits(held.toString())} ${symbol} — this job costs ${quote.priceLabel}`),
      [`send ${symbol} to ${payerAddress} on ${network}`, "check with: xorv wallet"],
    );
    return;
  }

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
            `${ui.c.bold(symbol)} ${ui.c.muted(`(${chosen.amount} units${held !== undefined ? ` · you hold ${formatUnits(held.toString())}` : ""})`)}`,
          ],
          quote.escrow
            ? [
                "goes to",
                `XorvEscrow ${quote.escrow.address} ${ui.c.muted(`— held until the job delivers, then paid to ${quote.provider.address}; refundable if it doesn't`)}`,
              ]
            : ["goes to", `${quote.provider.address} ${ui.c.muted("— straight to the provider, not the broker")}`],
          ["from", payerAddress],
          ["gas", ui.c.muted("none — you need no MON; the facilitator relays and pays the fee")],
        ]),
        { title: "quote" },
      ),
    );
    if (payerAddress.toLowerCase() === quote.provider.address.toLowerCase()) {
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

  // The 402 offers every stablecoin the broker accepts. Narrow it to the one
  // chosen above, so the stock client — which otherwise signs for the first
  // option — pays in the token this payer actually holds. The policy never
  // empties the list, which would fail a request the server was willing to
  // serve.
  const client = new x402Client();
  client.registerPolicy(onlyAssetPolicy(chosen.asset));
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
  // Both schemes: `escrow` (the broker lists it first, so it wins whenever
  // offered — the money waits in XorvEscrow until the job delivers) and the
  // stock `exact`, for a broker that pays providers directly.
  registerXorvPaymentSchemes(client, toClientEvmSigner(payer, readClient(network)));

  const paidFetch = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);
  const paySpin = opts.json
    ? null
    : ui.spinner(`signing a ${symbol} authorization and settling on ${networkLabel(network)}…`);

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
      `common causes: the payer holds no ${symbol} (try --token with another`,
      "stablecoin), or is the same address as the provider (you can't pay yourself)",
      "check with: xorv wallet",
    ]);
  }

  paySpin?.succeed(`paid ${ui.c.money(quote.priceLabel)} in ${symbol} — job ${ui.c.bold(jobId)}`);
  if (settleTx && !opts.json) {
    ui.ok(
      quote.escrow
        ? `${ui.glyph.chain()} held in escrow on ${networkLabel(network)} until the job delivers`
        : `${ui.glyph.chain()} settled on ${networkLabel(network)}`,
    );
    ui.muted(`  ${explorerTx(network, settleTx)}`);
  }

  // -- 3. watch -------------------------------------------------------------

  if (!opts.json) {
    ui.blank();
    ui.heading("running");
  }

  const started = Date.now();
  let final = await watchJob(brokerUrl, jobId, opts.json ?? false);

  if (final?.status === "completed") {
    const spin = opts.json ? null : ui.spinner("waiting for the escrow release and the on-chain receipt…");
    final = await awaitReceipt(brokerUrl, jobId, final);
    const escrow = final?.payment?.escrow;
    if (escrow?.state === "released") spin?.succeed("escrow released to the provider");
    else if (final?.receiptTxHash) spin?.succeed("receipt appended to the on-chain audit log");
    else spin?.stop();
  } else if (final?.payment?.escrow) {
    // A failed job's money comes back: wait for the refund to land so the
    // buyer sees it rather than being told to trust that it will.
    final = await awaitReceipt(brokerUrl, jobId, final);
  }
  const escrow = final?.payment?.escrow ?? null;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          jobId,
          quote,
          paidWith: symbol,
          settlementTransaction: settleTx,
          explorerUrl: settleTx ? explorerTx(network, settleTx) : null,
          escrow: escrow
            ? {
                ...escrow,
                releaseUrl: escrow.releaseTx ? explorerTx(network, escrow.releaseTx) : null,
                refundUrl: escrow.refundTx ? explorerTx(network, escrow.refundTx) : null,
              }
            : null,
          status: final?.status,
          result: final?.result,
          error: final?.error,
          receiptTransaction: final?.receiptTxHash ?? null,
          receiptUrl: final?.receiptTxHash ? explorerTx(network, final.receiptTxHash) : null,
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
          ["paid", `${ui.c.money(quote.priceLabel)} ${ui.c.muted(symbol)}`],
          ["to", `${quote.provider.label} ${ui.c.muted(quote.provider.address)}`],
          ["tx", settleTx ? ui.c.accent(settleTx) : ui.c.muted("—")],
          [
            explorerName(network).toLowerCase(),
            settleTx ? ui.c.muted(explorerTx(network, settleTx)) : ui.c.muted("—"),
          ],
          ...(escrow
            ? ([
                [
                  "escrow",
                  escrow.releaseTx
                    ? `${ui.c.money("released")} ${ui.c.muted(explorerTx(network, escrow.releaseTx))}`
                    : ui.c.muted(`${escrow.state}${escrow.lastError ? ` — ${escrow.lastError}` : ""}`),
                ],
              ] as [string, string][])
            : []),
          ["result sha256", ui.c.muted((final.resultHash ?? "").slice(0, 32) + "…")],
          [
            "receipt",
            final.receiptTxHash
              ? ui.c.muted(explorerTx(network, final.receiptTxHash))
              : ui.c.muted("publishing…"),
          ],
        ]),
        { title: "receipt", color: ui.BRAND.azure },
      ),
    );
  } else {
    ui.bad(`job ${final?.status ?? "unknown"}: ${final?.error ?? "no result"}`);
    if (escrow?.refundTx) {
      ui.ok(`${ui.glyph.chain()} refunded from escrow — you paid nothing`);
      ui.muted(`  ${explorerTx(network, escrow.refundTx)}`);
    } else if (escrow) {
      ui.muted(`  your ${symbol} is in escrow; it is refundable by anyone after ${new Date(escrow.deadline * 1000).toLocaleTimeString()}`);
    }
  }
  ui.blank();
  await exitAfterFlush(final?.status === "completed" ? 0 : 1);
}

interface JobView {
  status: string;
  payment?: { scheme?: string; escrow?: EscrowRecord } | null;
  result?: string | null;
  error?: string | null;
  resultHash?: string | null;
  receiptTxHash?: string | null;
}

/** A job the broker has finished with, one way or the other. */
function isTerminal(job: JobView | null): boolean {
  return job?.status === "completed" || job?.status === "failed";
}

/**
 * Follow the job's server-sent event stream to completion.
 *
 * Parsed by hand rather than with EventSource, which Node still doesn't expose
 * on the global in every supported version — and a hand-rolled reader is a
 * dozen lines against a dependency and a polyfill.
 *
 * The stream is a convenience, not the source of truth. A connection can be cut
 * mid-job — a proxy or tunnel between here and the broker, a laptop lid — and
 * the job goes on without it. When the provider died mid-job, a buyer's
 * `xorv run --json` exited before the broker had even failed the job, and
 * printed nothing at all. So a stream that errors or ends without a verdict
 * falls back to polling the job until it has one.
 */
export async function watchJob(
  brokerUrl: string,
  jobId: string,
  quiet: boolean,
  pollMs = 2_000,
): Promise<JobView | null> {
  let last: JobView | null = null;

  try {
    const res = await fetch(`${brokerUrl}/api/jobs/${jobId}/stream`, {
      headers: { Accept: "text/event-stream" },
    });
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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
            if (name === "done" || isTerminal(last)) {
              reader.cancel().catch(() => {});
              return last;
            }
          }
        }
      }
    }
  } catch {
    // The connection was cut. The job is still the broker's to finish.
  }

  return pollJob(brokerUrl, jobId, last, pollMs);
}

/**
 * Poll a job until the broker gives it a verdict.
 *
 * Bounded above the broker's own ceiling — a job that outlives it is failed
 * there — so this cannot wait forever on a broker that has gone for good.
 */
async function pollJob(
  brokerUrl: string,
  jobId: string,
  last: JobView | null,
  pollMs: number,
  ceilingMs = 12 * 60_000,
): Promise<JobView | null> {
  const deadline = Date.now() + ceilingMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${brokerUrl}/api/jobs/${jobId}`, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        last = ((await res.json()) as { job: JobView }).job;
        if (isTerminal(last)) return last;
      }
    } catch {
      /* the broker is unreachable for now; keep asking until the deadline */
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
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
 * Pull the settled transaction hash off the response.
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
 * Wait for the broker's on-chain receipt to land.
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
  // Done when the receipt is out and any escrowed money has moved.
  const settled = (job: JobView | null) =>
    Boolean(job?.receiptTxHash) && (!job?.payment?.escrow || job.payment.escrow.state !== "funded");
  if (settled(current)) return current;
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
      if (settled(latest)) return latest;
    } catch {
      /* keep trying until the deadline */
    }
  }
  return latest;
}

/**
 * The network the broker settles on, from `/api/network`.
 *
 * Falls back to the local guess when the broker does not say — the quote
 * already succeeded, so a failure here is transient and the chain id in the
 * 402 is what the signature binds to anyway.
 */
async function brokerNetwork(brokerUrl: string, fallback: string): Promise<string> {
  try {
    const res = await fetch(`${brokerUrl}/api/network`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return fallback;
    const body = (await res.json()) as { network?: string; explorer?: string };
    // Links point where the broker's do, unless this machine chose otherwise.
    if (body.explorer && /^https?:\/\//.test(body.explorer) && !process.env.XORV_EXPLORER_URL) {
      process.env.XORV_EXPLORER_URL = body.explorer;
    }
    return body.network?.startsWith("eip155:") ? body.network : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The payer's balance in each offered stablecoin, keyed by lowercase address.
 *
 * Best-effort: a token whose balance can't be read is left out, which
 * `choosePaymentAsset` treats as "maybe payable" rather than ruling it out.
 */
async function payerBalances(
  network: string,
  payer: string,
  accepts: QuoteResponse["accepts"],
): Promise<Record<string, bigint>> {
  const client = readClient(network);
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
        /* unknown — leave it payable */
      }
    }),
  );
  return out;
}
