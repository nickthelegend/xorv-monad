/**
 * `xorv run "<prompt>"` — the buyer side.
 *
 * Posts a job, pays for it with a real USDC transfer over x402 on Monad,
 * watches it execute on a stranger's machine, and prints the answer plus the
 * explorer link that proves the payment. The whole protocol, end to end, in
 * one command and a few seconds.
 *
 * This is also the honest test of the network: it uses the same public HTTP
 * surface and the same `@x402/*` client any third party would, with no
 * privileged access to the broker.
 *
 * Paying is an EIP-3009 `transferWithAuthorization`: the buyer signs an
 * EIP-712 message offline, the facilitator submits it and pays the MON gas,
 * and USDC moves buyer → provider in one transfer. So a buyer needs USDC and
 * nothing else — no MON, no approval transaction.
 *
 * Three checks stand between the quote and the signature, because on EVM a
 * signed authorization is directly spendable:
 *
 *  1. **The ceiling.** `--max` caps the quote here, not only on the broker,
 *     and the same figure is the x402 client's per-payment spend cap.
 *  2. **The frozen quote.** The 402 must ask for exactly what the quote showed
 *     — same provider address, same USDC amount, same network and token — or
 *     the client refuses to sign (`buyerX402Client`'s `expect`). A broker bug,
 *     or a compromised one, cannot swap the payee between quote and payment.
 *  3. **No self-pay.** Paying your own provider address is refused outright.
 *     It is a valid transfer on-chain (from == to), which is exactly the
 *     problem: it would mint a "paid job" receipt, and the reputation that
 *     rides on it, for the price of the facilitator's gas.
 */

import { x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import {
  DEFAULT_NETWORK,
  accountFromKey,
  buyerX402Client,
  explorerAddress,
  explorerAgent,
  explorerTx,
  formatDuration,
  formatUsd,
  formatUsdc,
  networkConfig,
  networkLabel,
  parseUsd,
  sameAddress,
  shortHex,
  usdMicrosToUsdcUnits,
  type AdapterKind,
  type PublicJob,
  type QuoteResponse,
} from "@xorv/protocol";
import type { PrivateKeyAccount } from "viem";
import { LegacyConfigError, loadConfig, type NodeConfig } from "../config.js";
import * as ui from "../ui.js";

interface RunOptions {
  broker?: string;
  max?: string;
  adapter?: string;
  yes?: boolean;
  json?: boolean;
}

/** A failure the buyer can act on, with the hints to show alongside it. */
export class RunRefusal extends Error {
  readonly stage: "setup" | "quote" | "payment";
  readonly hints: string[];
  constructor(stage: RunRefusal["stage"], message: string, hints: string[] = []) {
    super(message);
    this.name = "RunRefusal";
    this.stage = stage;
    this.hints = hints;
  }
}

/**
 * Which network this buyer pays on: `XORV_NETWORK`, then the node config, then
 * Monad testnet. Validated here — a leftover `hedera:testnet` fails with the
 * fix named, not later as an unverifiable signature.
 */
export function buyerNetwork(config: Pick<NodeConfig, "network"> | null, env = process.env): string {
  const network = env.XORV_NETWORK?.trim() || config?.network || DEFAULT_NETWORK;
  return networkConfig(network).caip2;
}

/**
 * The buyer's key: `XORV_PAYER_KEY` (a dedicated buyer key, the recommended
 * setup on a machine that also runs a node), then `XORV_PRIVATE_KEY`, then
 * the key in the node config. Deliberately not a command-line flag — argv is
 * visible to every user on the machine through `ps`.
 */
export function resolveBuyerAccount(
  config: Pick<NodeConfig, "privateKey"> | null,
  env = process.env,
): PrivateKeyAccount {
  const hints = [
    "set XORV_PAYER_KEY to a Monad key (0x + 64 hex) holding USDC — no MON needed",
    "test USDC: https://faucet.circle.com (pick Monad Testnet)",
  ];
  const candidates: Array<[string, string | undefined]> = [
    ["XORV_PAYER_KEY", env.XORV_PAYER_KEY?.trim()],
    ["XORV_PRIVATE_KEY", env.XORV_PRIVATE_KEY?.trim()],
    ["the node config", config?.privateKey?.trim()],
  ];
  const found = candidates.find(([, value]) => Boolean(value));
  if (!found) {
    throw new RunRefusal(
      "setup",
      config
        ? "no buyer key: this node keeps no private key (it was set up address-only, which is all a provider needs)"
        : "no buyer key configured",
      hints,
    );
  }
  const [source, raw] = found;
  try {
    return accountFromKey(raw!);
  } catch (err) {
    throw new RunRefusal("setup", `the key in ${source} is unusable: ${err instanceof Error ? err.message : String(err)}`, hints);
  }
}

/**
 * Everything that must be true of a quote before anything is signed.
 *
 * Pure, so every refusal is unit-tested rather than discovered with real money.
 */
export function vetQuote(
  quote: QuoteResponse,
  ctx: { network: string; maxPriceUsdMicros: number; payer: string },
): void {
  if (quote.network && quote.network !== ctx.network) {
    throw new RunRefusal(
      "quote",
      `the broker quotes on ${quote.network} but this buyer pays on ${ctx.network} — the signature could never verify`,
      [`set XORV_NETWORK=${quote.network}, or point --broker at a ${networkLabel(ctx.network)} broker`],
    );
  }
  if (!Number.isFinite(quote.priceUsdMicros) || quote.priceUsdMicros > ctx.maxPriceUsdMicros) {
    // The broker is asked for quotes under the ceiling; enforcing it here too
    // means a broker that ignores the request still cannot overcharge.
    throw new RunRefusal(
      "quote",
      `quoted ${formatUsd(quote.priceUsdMicros)}, above your --max of ${formatUsd(ctx.maxPriceUsdMicros)}`,
      ["raise --max if that price is acceptable"],
    );
  }
  if (!/^\d+$/.test(quote.usdcAmount ?? "")) {
    throw new RunRefusal("quote", "the quote carries no USDC amount to pay — refusing to sign an open-ended payment");
  }
  const expected = usdMicrosToUsdcUnits(quote.priceUsdMicros);
  if (BigInt(quote.usdcAmount) !== BigInt(expected)) {
    throw new RunRefusal(
      "quote",
      `the quote says ${quote.priceLabel} but freezes ${quote.usdcAmount} USDC units (expected ${expected}) — refusing to sign`,
    );
  }
  if (!quote.provider?.address) {
    throw new RunRefusal("quote", "the quote names no provider address to pay");
  }
  if (sameAddress(ctx.payer, quote.provider.address)) {
    throw new RunRefusal(
      "payment",
      `payer and provider are the same address (${quote.provider.address}) — you cannot pay yourself`,
      [
        "this machine's node key is also its payout address; buy with a separate key:",
        "  export XORV_PAYER_KEY=0x…   (a Monad key holding test USDC)",
      ],
    );
  }
}

/**
 * A fetch that pays the 402 for exactly this quote and nothing else, plus the
 * x402 HTTP client used to read the settlement back off the response.
 */
export function payingFetch(opts: {
  account: PrivateKeyAccount;
  network: string;
  maxPriceUsdMicros: number;
  quote: QuoteResponse;
  fetch?: typeof globalThis.fetch;
}): { fetch: ReturnType<typeof wrapFetchWithPayment>; httpClient: x402HTTPClient } {
  const client = buyerX402Client({
    signer: opts.account,
    network: opts.network,
    maxUsdcUnits: usdMicrosToUsdcUnits(opts.maxPriceUsdMicros),
    expect: {
      payTo: opts.quote.provider.address,
      amount: opts.quote.usdcAmount,
      network: opts.network,
      asset: networkConfig(opts.network).usdc.address,
      // The broker's escrow, when the quote named one: pay into it, nowhere else.
      escrow: opts.quote.escrow?.address ?? null,
    },
  });
  return {
    fetch: wrapFetchWithPayment(opts.fetch ?? globalThis.fetch, client),
    httpClient: new x402HTTPClient(client),
  };
}

/** The `--json` success shape. The /xorv skill parses this; keep SKILL.md in sync. */
export interface RunJsonResult {
  jobId: string;
  network: string;
  payer: string;
  quote: QuoteResponse;
  settlementTransaction: string | null;
  /** Explorer link for the settlement — the receipt a user can check. */
  explorer: string | null;
  /** The XorvLedger receipt transaction, once the broker has recorded it. */
  receiptTransaction: string | null;
  receiptExplorer: string | null;
  /** The provider's ERC-8004 identity page, when it has one. */
  agentExplorer: string | null;
  status: string | null;
  result: string | null;
  error: string | null;
  resultHash: string | null;
  durationMs: number;
}

export function runJsonResult(input: {
  jobId: string;
  network: string;
  payer: string;
  quote: QuoteResponse;
  settleTx: string | null;
  job: JobView | null;
  durationMs: number;
}): RunJsonResult {
  const settle = input.settleTx ?? input.job?.payment?.txHash ?? null;
  const receipt = input.job?.receiptTxHash ?? null;
  const agentId = input.quote.provider.agentId;
  return {
    jobId: input.jobId,
    network: input.network,
    payer: input.payer,
    quote: input.quote,
    settlementTransaction: settle,
    explorer: settle ? explorerTx(input.network, settle) : null,
    receiptTransaction: receipt,
    receiptExplorer: receipt ? explorerTx(input.network, receipt) : null,
    agentExplorer: agentId ? explorerAgent(input.network, agentId) : null,
    status: input.job?.status ?? null,
    result: input.job?.result ?? null,
    error: input.job?.error ?? null,
    resultHash: input.job?.resultHash ?? null,
    durationMs: input.durationMs,
  };
}

/**
 * Leave the process, having flushed stdout.
 *
 * Once the answer is printed and the payment settled there is nothing left to
 * do, and exiting deliberately guarantees the exit code a script (or the
 * /xorv skill) keys off — a lingering keep-alive socket must not turn a
 * finished run into a hung one.
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
  // -- 0. who pays, on which chain -----------------------------------------

  let config: NodeConfig | null = null;
  let network = DEFAULT_NETWORK as string;
  let account: PrivateKeyAccount;
  try {
    // Buying needs no node config. A Hedera-era one is only in the way when
    // it was also going to be the source of the key, so it is surfaced then
    // and not otherwise.
    let legacy: LegacyConfigError | null = null;
    try {
      config = loadConfig();
    } catch (err) {
      if (!(err instanceof LegacyConfigError)) throw err;
      legacy = err;
    }
    network = buyerNetwork(config);
    try {
      account = resolveBuyerAccount(config);
    } catch (err) {
      throw legacy ?? err;
    }
  } catch (err) {
    if (!opts.json) ui.bad(err instanceof Error ? err.message : String(err));
    await failOut(opts.json, "setup", err, err instanceof RunRefusal ? err.hints : []);
    return;
  }
  const payer = account.address;

  const brokerUrl = (
    opts.broker ??
    process.env.XORV_BROKER_URL ??
    config?.brokerUrl ??
    "http://localhost:8402"
  ).replace(/\/+$/, "");

  if (!opts.json) console.log(ui.banner("post a job"));

  // -- 1. quote -------------------------------------------------------------

  let maxPrice: number;
  try {
    maxPrice = parseUsd(opts.max ?? "0.05");
    if (maxPrice <= 0) throw new Error("--max must be greater than zero");
  } catch (err) {
    await failOut(opts.json, "setup", err);
    return;
  }
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

  try {
    vetQuote(quote, { network, maxPriceUsdMicros: maxPrice, payer });
  } catch (err) {
    const refusal = err instanceof RunRefusal ? err : new RunRefusal("quote", String(err));
    if (!opts.json) quoteSpin?.fail(refusal.message);
    await failOut(opts.json, refusal.stage, refusal, refusal.hints);
    return;
  }
  quoteSpin?.succeed(`matched ${ui.c.bold(quote.provider.label)}`);

  if (!opts.json) {
    ui.blank();
    const rows: Array<[string, string]> = [
      ["provider", `${ui.c.bold(quote.provider.label)} ${ui.c.muted(`· ${quote.provider.stats.jobsCompleted} jobs done`)}`],
      ["running", `${quote.provider.capability}${quote.provider.model ? ui.c.muted(` · ${quote.provider.model}`) : ""}`],
      ["price", `${ui.c.money(ui.c.bold(quote.priceLabel))} ${ui.c.muted(`(${quote.usdcAmount} USDC units)`)}`],
      ["goes to", `${quote.provider.address} ${ui.c.muted("— straight to the provider, not the broker")}`],
    ];
    if (quote.provider.agentId) {
      rows.push(["identity", `ERC-8004 agent #${quote.provider.agentId} ${ui.c.muted(explorerAgent(network, quote.provider.agentId))}`]);
    }
    if (quote.routing) rows.push(["routed by", `${quote.routing.model} ${ui.c.muted(`— ${quote.routing.reason}`)}`]);
    rows.push(["from", `${payer} ${ui.c.muted(`(${networkLabel(network)})`)}`]);
    console.log(ui.box(ui.kv(rows), { title: "quote" }));
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

  const { fetch: paidFetch, httpClient } = payingFetch({ account, network, maxPriceUsdMicros: maxPrice, quote });
  const paySpin = opts.json ? null : ui.spinner(`signing the USDC authorization and settling on Monad ${networkLabel(network)}…`);

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
    const body = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
    if (!res.ok || !body.jobId) {
      throw new Error(body.error ?? `broker returned ${res.status}`);
    }
    jobId = body.jobId;
    settleTx = readSettlementTx(httpClient, res);
  } catch (err) {
    if (!opts.json) paySpin?.fail(`payment failed: ${err instanceof Error ? err.message : String(err)}`);
    await failOut(opts.json, "payment", err, [
      `common causes: ${shortHex(payer)} holds less than ${formatUsdc(quote.usdcAmount)} USDC on ${networkLabel(network)},`,
      "the quote expired (they last five minutes), or the provider went offline",
      "check with: xorv wallet",
    ]);
  }

  paySpin?.succeed(`paid ${ui.c.money(quote.priceLabel)} — job ${ui.c.bold(jobId)}`);
  if (settleTx && !opts.json) {
    ui.ok(`${ui.glyph.chain()} settled on Monad ${networkLabel(network)}`);
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
    const spin = opts.json ? null : ui.spinner("waiting for the XorvLedger receipt…");
    final = await awaitReceipt(brokerUrl, jobId, final);
    if (final?.receiptTxHash) spin?.succeed("receipt recorded on XorvLedger");
    else spin?.stop();
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        runJsonResult({ jobId, network, payer, quote, settleTx, job: final, durationMs: Date.now() - started }),
        null,
        2,
      ),
    );
    await exitAfterFlush(final?.status === "completed" ? 0 : 1);
  }

  ui.blank();
  const settle = settleTx ?? final?.payment?.txHash ?? null;
  if (final?.status === "completed") {
    console.log(
      ui.box([final.result ?? ""], {
        title: `result · ${formatDuration(Date.now() - started)}`,
        color: ui.BRAND.mint,
      }),
    );
    ui.blank();
    const rows: Array<[string, string]> = [
      ["paid", ui.c.money(quote.priceLabel)],
      ["to", `${quote.provider.label} ${ui.c.muted(explorerAddress(network, quote.provider.address))}`],
      ["tx", settle ? ui.c.accent(settle) : ui.c.muted("—")],
      ["explorer", settle ? ui.c.muted(explorerTx(network, settle)) : ui.c.muted("—")],
      ["result keccak", ui.c.muted(final.resultHash ? shortHex(final.resultHash, 18, 8) : "—")],
      [
        "ledger receipt",
        final.receiptTxHash ? ui.c.muted(explorerTx(network, final.receiptTxHash)) : ui.c.muted("recording…"),
      ],
    ];
    if (quote.provider.agentId) {
      rows.push(["agent", ui.c.muted(explorerAgent(network, quote.provider.agentId))]);
    }
    if (final.verification) {
      rows.push([
        "verified",
        `${final.verification.pass ? ui.c.ok("pass") : ui.c.warn("flagged")} ${final.verification.score}/100 ${ui.c.muted(`by ${final.verification.model}`)}`,
      ]);
    }
    console.log(ui.box(ui.kv(rows), { title: "receipt", color: ui.BRAND.azure }));
  } else {
    ui.bad(`job ${final?.status ?? "unknown"}: ${final?.error ?? "no result"}`);
  }
  ui.blank();
  await exitAfterFlush(final?.status === "completed" ? 0 : 1);
}

/** The slice of the broker's `PublicJob` this command reads. */
export type JobView = Pick<PublicJob, "status"> &
  Partial<Pick<PublicJob, "result" | "error" | "resultHash" | "receiptTxHash" | "payment" | "verification">>;

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
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

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
 * Pull the settlement transaction hash off the response.
 *
 * Goes through the protocol client's own reader rather than base64-decoding the
 * header by hand: the header's name and encoding are x402's to change, and a
 * hand-rolled parser that silently returns null on a format change would show
 * "—" where the on-chain proof should be.
 */
function readSettlementTx(httpClient: x402HTTPClient, res: Response): string | null {
  try {
    const settlement = httpClient.getPaymentSettleResponse((name) => res.headers.get(name));
    return settlement?.transaction || null;
  } catch {
    return null;
  }
}

/**
 * Wait for the broker's XorvLedger receipt.
 *
 * The receipt is written only once the job is terminal *and* its payment is
 * recorded, and the broker batches receipts into one `recordJobs` call every
 * few seconds, so a fast job outruns it. Polling briefly here means the final
 * output carries the audit link instead of "recording…", and giving up quietly
 * after the window keeps a slow or unconfigured ledger from holding the
 * terminal.
 */
async function awaitReceipt(
  brokerUrl: string,
  jobId: string,
  current: JobView | null,
  timeoutMs = 20_000,
): Promise<JobView | null> {
  if (current?.receiptTxHash) return current;
  const deadline = Date.now() + timeoutMs;
  let latest = current;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    try {
      const res = await fetch(`${brokerUrl}/api/jobs/${jobId}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { job: JobView };
      latest = body.job;
      if (latest.receiptTxHash) return latest;
    } catch {
      /* keep trying until the deadline */
    }
  }
  return latest;
}
