/**
 * Buying a job: quote, vet, pay over x402, wait for the answer.
 *
 * On Monad the payment is an EIP-3009 `transferWithAuthorization` over USDC:
 * the payer signs an EIP-712 message, the broker's facilitator submits it and
 * pays the MON gas, and the USDC moves payer → provider in one transfer. The
 * payer holds nothing but USDC, and the broker is never the payee.
 *
 * A signed authorization is directly spendable by whoever holds it, so
 * everything that can be checked is checked *before* signing:
 *
 *   - the quote is on this server's network, under every ceiling, pays a real
 *     provider address that is not our own, and freezes a USDC amount that is
 *     exactly its advertised price;
 *   - the 402 must then ask for exactly that frozen quote — same payee, same
 *     amount, same asset, same chain (`buyerX402Client`'s `expect`, i.e.
 *     protocol `quoteMatchPolicy`) — or the client refuses to sign. A broker
 *     bug, or a compromised broker, that swaps the payee or bumps the price
 *     between quote and payment gets an error, not a signature;
 *   - x402's per-payment spend control carries the per-job ceiling as a last
 *     line inside the library itself.
 */

import { x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import {
  buyerX402Client,
  formatUsd,
  networkConfig,
  networkLabel,
  parseUsd,
  sameAddress,
  usdMicrosToUsdcUnits,
  type AgentSessionTag,
  type PaymentRecord,
  type PublicJob,
  type QuoteResponse,
} from "@xorv/protocol";
import { BudgetExceededError, type SessionBudget } from "./budget.js";
import { brokerErrorText, type BrokerClient } from "./broker.js";
import type { PayerSigner, ResolvedPayer } from "./signer.js";

export type BuyStage = "setup" | "budget" | "quote" | "payment" | "job";

/**
 * How long the pay request (402, sign, paid retry with settlement) may take.
 * Monad settles in about a second; this is slack for a slow RPC behind the
 * facilitator, not an expected duration.
 */
export const PAYMENT_TIMEOUT_MS = 90_000;

/** A refusal or failure with the stage it happened at, so the tool can say what to do. */
export class BuyError extends Error {
  constructor(
    readonly stage: BuyStage,
    message: string,
  ) {
    super(message);
    this.name = "BuyError";
  }
}

/** The price ceiling for one call: the smallest of what was asked, the per-job cap and the budget left. */
export function effectiveCeiling(opts: {
  requestedUsd?: number | null;
  maxPriceUsdMicros: number;
  budgetRemainingUsdMicros: number;
}): number {
  const requested = opts.requestedUsd ? parseUsd(opts.requestedUsd) : opts.maxPriceUsdMicros;
  return Math.min(requested, opts.maxPriceUsdMicros, opts.budgetRemainingUsdMicros);
}

/**
 * Everything that must be true of a quote before anything is signed.
 *
 * Pure, so every refusal is unit-tested rather than discovered with money.
 */
export function vetQuote(
  quote: QuoteResponse,
  ctx: { network: string; ceilingUsdMicros: number; payer: string },
): void {
  if (quote.network && quote.network !== ctx.network) {
    throw new BuyError(
      "quote",
      `the broker quotes on ${quote.network} but this server pays on ${ctx.network} — the signature could never verify. ` +
        `Set XORV_NETWORK=${quote.network}, or point XORV_BROKER_URL at a ${networkLabel(ctx.network)} broker.`,
    );
  }
  if (!Number.isFinite(quote.priceUsdMicros) || quote.priceUsdMicros <= 0) {
    throw new BuyError("quote", "the quote carries no usable price — refusing to sign");
  }
  // The broker was asked for quotes under the ceiling; enforcing it here too
  // means a broker that ignores the request still cannot overcharge.
  if (quote.priceUsdMicros > ctx.ceilingUsdMicros) {
    throw new BuyError(
      "quote",
      `Refusing to pay ${quote.priceLabel ?? formatUsd(quote.priceUsdMicros)}, which is over the ${formatUsd(ctx.ceilingUsdMicros)} limit.`,
    );
  }
  if (!/^\d+$/.test(quote.usdcAmount ?? "")) {
    throw new BuyError("quote", "the quote carries no USDC amount to pay — refusing to sign an open-ended payment");
  }
  const expected = usdMicrosToUsdcUnits(quote.priceUsdMicros);
  if (BigInt(quote.usdcAmount) !== BigInt(expected)) {
    throw new BuyError(
      "quote",
      `the quote says ${quote.priceLabel} but freezes ${quote.usdcAmount} USDC units (expected ${expected}) — refusing to sign`,
    );
  }
  if (!quote.provider?.address) {
    throw new BuyError("quote", "the quote names no provider address to pay");
  }
  if (sameAddress(ctx.payer, quote.provider.address)) {
    throw new BuyError(
      "quote",
      `the quoted provider pays out to ${quote.provider.address}, which is this server's own payer address — ` +
        "buying from yourself only burns the broker's gas. Use a separate payer key or wallet.",
    );
  }
}

export interface BuyDeps {
  broker: BrokerClient;
  signer: PayerSigner;
  budget: SessionBudget;
  network: string;
  maxPriceUsdMicros: number;
  /** The fetch the x402 client wraps; tests point it at a local server. */
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  jobTimeoutMs?: number;
  /** How long to wait for the batched XorvLedger receipt after a job completes. */
  receiptWaitMs?: number;
  /** This agent session's tag, sent with the quote. */
  agent?: AgentSessionTag | null;
}

export interface BuyArgs {
  prompt: string;
  adapter?: string | null;
  maxUsd?: number | null;
}

export interface BuyResult {
  payer: ResolvedPayer;
  quote: QuoteResponse;
  jobId: string;
  /** Settlement transaction hash, from x402's own response header (or the broker's record). */
  settlementTx: string | null;
  payment: PaymentRecord | null;
  job: PublicJob;
}

/** Quote a job under a ceiling. Shared by `xorv_quote` and `xorv_run_job`. */
export async function requestQuote(
  broker: BrokerClient,
  args: { prompt: string; adapter?: string | null; ceilingUsdMicros: number; agent?: AgentSessionTag | null },
): Promise<QuoteResponse> {
  const reply = await broker.postJson<QuoteResponse & { error?: string }>("/api/quotes", {
    prompt: args.prompt,
    adapter: args.adapter ?? null,
    maxPriceUsdMicros: args.ceilingUsdMicros,
    ...(args.agent ? { agent: args.agent } : {}),
  });
  if (!reply.ok) {
    throw new BuyError("quote", brokerErrorText(reply.body) ?? `No quote: broker returned ${reply.status}`);
  }
  return reply.body;
}

/**
 * Buy one job end to end. Throws `BuyError` on every refusal or failure; the
 * message is written for the model (and person) reading the tool result.
 */
export async function buyJob(deps: BuyDeps, args: BuyArgs): Promise<BuyResult> {
  let payer: ResolvedPayer;
  try {
    payer = await deps.signer.resolve();
  } catch (err) {
    throw new BuyError("setup", err instanceof Error ? err.message : String(err));
  }

  const remaining = deps.budget.remainingUsdMicros();
  const ceiling = effectiveCeiling({
    requestedUsd: args.maxUsd,
    maxPriceUsdMicros: deps.maxPriceUsdMicros,
    budgetRemainingUsdMicros: remaining,
  });
  if (ceiling <= 0) {
    throw new BuyError("budget", `The session budget is used up: ${deps.budget.describe()}. Raise XORV_SESSION_BUDGET_USD and restart the MCP server if more spending is intended.`);
  }

  // 1. Quote — so the price is pinned and can be refused before paying.
  let quote: QuoteResponse;
  try {
    quote = await requestQuote(deps.broker, { prompt: args.prompt, adapter: args.adapter, ceilingUsdMicros: ceiling, agent: deps.agent });
  } catch (err) {
    if (err instanceof BuyError && remaining < deps.maxPriceUsdMicros) {
      throw new BuyError("quote", `${err.message} (only ${formatUsd(remaining)} of the session budget is left)`);
    }
    throw err;
  }
  vetQuote(quote, { network: deps.network, ceilingUsdMicros: ceiling, payer: payer.address });

  // 2. Hold the price against the session budget before anything is signed.
  let reservation;
  try {
    reservation = deps.budget.reserve(quote.priceUsdMicros);
  } catch (err) {
    if (err instanceof BudgetExceededError) throw new BuyError("budget", err.message);
    throw err;
  }

  // 3. Pay. The 402 dance happens inside the wrapped fetch; the client signs
  //    only the frozen quote, and `signed` records whether it got that far.
  const cfg = networkConfig(deps.network);
  const client = buyerX402Client({
    signer: payer.account,
    network: cfg.caip2,
    maxUsdcUnits: usdMicrosToUsdcUnits(ceiling),
    expect: {
      payTo: quote.provider.address,
      amount: quote.usdcAmount,
      network: cfg.caip2,
      asset: cfg.usdc.address,
      // The broker's escrow, when the quote named one: the money waits there until the job delivers.
      escrow: quote.escrow?.address ?? null,
    },
  });
  let signed = false;
  client.onAfterPaymentCreation(async () => {
    signed = true;
  });
  const httpClient = new x402HTTPClient(client);
  const paidFetch = wrapFetchWithPayment(deps.fetch ?? globalThis.fetch, client);

  // Pay at the broker this server is configured for, not the quote's
  // self-reported `payUrl`: the origin that answered the quote is the one to trust.
  let res: Response;
  try {
    res = await paidFetch(`${deps.broker.url}/api/jobs/${encodeURIComponent(quote.quoteId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      // Covers the 402 round-trip and the paid retry, which includes the
      // on-chain settlement (the broker settles before it answers).
      signal: AbortSignal.timeout(PAYMENT_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (signed) {
      // A signature left this process and no answer came back: it may have
      // settled. Count it — see budget.ts for why doubt resolves to "spent".
      reservation.commit();
      throw new BuyError(
        "payment",
        `The payment was signed but the broker's answer never arrived (${message}). It may have settled — check ${payer.address} on the explorer before retrying.`,
      );
    }
    reservation.release();
    throw new BuyError("payment", `Payment not made: ${message}`);
  }

  let settlement: { success?: boolean; transaction?: string } | null = null;
  try {
    settlement = httpClient.getPaymentSettleResponse((name) => res.headers.get(name));
  } catch {
    // No settlement header — the broker's own payment record may still carry the hash.
  }
  const paid = (await res.json().catch(() => ({}))) as {
    jobId?: string;
    error?: string;
    payment?: PaymentRecord | null;
  };

  if (!res.ok || !paid.jobId) {
    const knownUnpaid = !signed || (res.status === 402 && settlement?.success !== true);
    if (knownUnpaid) reservation.release();
    else reservation.commit();
    const reason =
      paid.error ??
      (res.status === 402
        ? `the payment was not accepted — ${payer.address} may hold too little USDC on ${cfg.name} (faucet: ${cfg.faucets.usdc ?? "none on mainnet"})`
        : `the broker returned ${res.status}`);
    throw new BuyError("payment", `Payment failed (${res.status}): ${reason}`);
  }
  reservation.commit();

  const settlementTx = settlement?.transaction || paid.payment?.txHash || null;

  // 4. Wait for the answer.
  const job = await pollUntilDone(deps.broker, paid.jobId, {
    timeoutMs: deps.jobTimeoutMs ?? 10 * 60_000,
    intervalMs: deps.pollIntervalMs ?? 2_000,
    receiptWaitMs: deps.receiptWaitMs ?? 8_000,
  });

  return {
    payer,
    quote,
    jobId: paid.jobId,
    settlementTx: settlementTx ?? job.payment?.txHash ?? null,
    payment: job.payment ?? paid.payment ?? null,
    job,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "expired";
}

/**
 * Poll a job to a terminal state.
 *
 * Polling rather than SSE: an MCP tool call is a request/response, nobody is
 * watching a stream, and a 2 s poll against a job that takes seconds to
 * minutes is not worth a streaming client's failure modes.
 *
 * Once the job completes, keep polling briefly for its XorvLedger receipt so
 * the proof link is in the answer. Receipts are batched (the broker flushes
 * every few seconds and only after the job is terminal *and* paid), so a
 * fast job always outruns its receipt; give up quietly after the window.
 */
export async function pollUntilDone(
  broker: BrokerClient,
  jobId: string,
  opts: { timeoutMs: number; intervalMs: number; receiptWaitMs: number },
): Promise<PublicJob> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: PublicJob | null = null;
  while (Date.now() < deadline) {
    try {
      const job = await broker.getJob(jobId);
      last = job;
      if (isTerminal(job.status)) {
        if (job.status !== "completed" || job.receiptTxHash || !job.payment) return job;
        const receiptDeadline = Date.now() + opts.receiptWaitMs;
        let latest = job;
        while (!latest.receiptTxHash && Date.now() < receiptDeadline) {
          await sleep(Math.min(opts.intervalMs, Math.max(0, receiptDeadline - Date.now())));
          latest = await broker.getJob(jobId).catch(() => latest);
        }
        return latest;
      }
    } catch {
      // A transient broker blip; keep polling until the deadline.
    }
    await sleep(opts.intervalMs);
  }
  if (last) return { ...last, error: last.error ?? "timed out waiting for the provider" };
  throw new BuyError("job", `Job ${jobId} was paid for, but the broker stopped answering; look it up later with xorv_get_job.`);
}
