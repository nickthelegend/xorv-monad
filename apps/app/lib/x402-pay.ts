/**
 * Paying a quote over x402 — the same code for every payer.
 *
 * On Monad the whole payment is one EIP-712 signature: the broker answers
 * `402` with an `exact` USDC requirement, the buyer signs an EIP-3009
 * `TransferWithAuthorization` for exactly that amount to exactly that
 * provider, and the facilitator submits it and pays the MON gas. The buyer
 * needs USDC and nothing else, and the broker never holds the money.
 *
 * That makes this helper payer-agnostic: a Privy embedded wallet (via
 * `toViemAccount`), an injected wallet (via a viem wallet client), and the
 * server's demo account (a local viem account) are all just a
 * `{ address, signTypedData }`, and all go through the one client below. The
 * wallet only ever signs — it never sees or holds anything else.
 *
 * Privy ships its own `useX402Fetch`, but it speaks x402 v1 over the legacy
 * `x402` package, which has no Monad network and no Monad USDC; it cannot pay
 * here. `@x402/fetch` v2 with protocol's `buyerX402Client` can.
 *
 * Kept free of React and of `window`, so tests drive it with a mocked fetch
 * and a local key standing in for the wallet.
 */

import { x402HTTPClient } from "@x402/core/client";
import type { ClientEvmSigner } from "@x402/evm";
import { wrapFetchWithPayment } from "@x402/fetch";
import { buyerX402Client, explorerTx, sameAddress, type QuoteResponse } from "@xorv/protocol/web";
import { errorMessage, isUserRejection } from "@/lib/errors";

/** Anything that can sign an x402 payment: a viem account, a Privy account, a wallet-client adapter. */
export type PaymentSigner = ClientEvmSigner;

/** The slice of a quote a payment needs — what the buyer was shown and agreed to. */
export interface PayableQuote {
  quoteId: string;
  /** CAIP-2 network the quote was priced on; checked against the app's. */
  network?: string | null;
  /** USDC smallest units, frozen at quote time. */
  usdcAmount: string;
  /** The provider's address — x402 `payTo` for exact, the payee the escrow releases to. */
  payTo: string;
  /** XorvEscrow, when the broker escrows payments: the only contract the client will pay into. */
  escrow?: string | null;
}

export type PaymentFailureKind =
  | "rejected"
  | "insufficient_funds"
  | "quote_mismatch"
  | "quote_expired"
  | "already_paid"
  | "provider_offline"
  | "wrong_network"
  | "signature"
  | "authorization_expired"
  | "settlement_failed"
  | "unknown";

/** A payment that did not happen, with a reason the UI can act on. */
export class PaymentError extends Error {
  readonly kind: PaymentFailureKind;
  /** The facilitator's own code (e.g. `invalid_exact_evm_insufficient_balance`), when there was one. */
  readonly reason: string | null;
  readonly status: number | null;

  constructor(kind: PaymentFailureKind, message: string, opts: { reason?: string | null; status?: number | null } = {}) {
    super(message);
    this.name = "PaymentError";
    this.kind = kind;
    this.reason = opts.reason ?? null;
    this.status = opts.status ?? null;
  }
}

export interface PaymentResult {
  jobId: string;
  /** The settlement (`transferWithAuthorization`) tx, when the broker returned the settle header. */
  txHash: string | null;
  payer: string;
  explorerUrl: string | null;
}

/**
 * The frozen terms of a broker quote, checked for internal consistency.
 *
 * The quote names the provider twice — once for display, once in `accepts` —
 * and the buyer is shown the first. If they differ, something between the
 * matcher and the response is wrong, and the time to find out is before a
 * signature exists.
 */
export function payableQuote(
  quote: Pick<QuoteResponse, "quoteId" | "network" | "usdcAmount" | "provider" | "accepts" | "escrow">,
): PayableQuote {
  const inconsistent = (payTo: string, amount: string) =>
    new PaymentError(
      "quote_mismatch",
      `The quote is inconsistent: it shows ${quote.provider.address} for ${quote.usdcAmount} units but asks for ` +
        `${payTo} / ${amount}. Nothing was signed — request a new quote.`,
    );
  for (const accept of quote.accepts ?? []) {
    if (accept.amount !== quote.usdcAmount) throw inconsistent(accept.payTo, accept.amount);
    if (accept.scheme === "escrow") {
      // Into the escrow the quote named, releasing to the quoted provider — nothing else.
      const ok =
        Boolean(quote.escrow) &&
        sameAddress(accept.payTo, quote.escrow!.address) &&
        sameAddress(accept.extra.provider ?? "", quote.provider.address);
      if (!ok) throw inconsistent(accept.payTo, accept.amount);
    } else if (!sameAddress(accept.payTo, quote.provider.address)) {
      throw inconsistent(accept.payTo, accept.amount);
    }
  }
  return {
    quoteId: quote.quoteId,
    network: quote.network,
    usdcAmount: quote.usdcAmount,
    payTo: quote.provider.address,
    escrow: quote.escrow?.address ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reading refusals
// ---------------------------------------------------------------------------

function base64ToUtf8(value: string): string {
  // x402 uses standard base64; accept the URL-safe alphabet too, and missing padding.
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Decode a base64-JSON x402 header (`PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`); null for anything else. */
export function decodeX402Header(header: string | null | undefined): Record<string, unknown> | null {
  if (!header?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(base64ToUtf8(header.trim()));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const GENERIC_REASON = /^payment required\.?$/i;

function reasonText(value: unknown): string | null {
  return typeof value === "string" && value.trim() && !GENERIC_REASON.test(value.trim()) ? value.trim() : null;
}

/**
 * Why a paid request was refused, read from the headers rather than the body.
 *
 * The x402 server puts its reason on the retried 402's `PAYMENT-REQUIRED`
 * (`error`), or on a failed settle's `PAYMENT-RESPONSE` (`errorReason`), while
 * the body carries the broker's generic hint. Server and browser both use this
 * one reader, so the demo route and the wallet path can never disagree about
 * what a refusal said. The generic "Payment required" — what every *first*
 * 402 says — is not a reason and is dropped.
 */
export function refusalReason(headers: { get(name: string): string | null }): string | null {
  const required = decodeX402Header(headers.get("PAYMENT-REQUIRED"));
  const settled = decodeX402Header(headers.get("PAYMENT-RESPONSE") ?? headers.get("X-PAYMENT-RESPONSE"));
  const settleFailed = settled && settled.success === false ? settled : null;
  const code =
    reasonText(required?.error) ??
    reasonText(required?.errorReason) ??
    reasonText(required?.invalidReason) ??
    reasonText(settleFailed?.errorReason) ??
    reasonText(settleFailed?.error);
  if (!code) return null;
  const detail = reasonText(required?.invalidMessage) ?? reasonText(settleFailed?.errorMessage);
  return detail && detail !== code ? `${code}: ${detail}` : code;
}

/** Turn a facilitator reason code into something a buyer can act on. */
export function describeRefusal(reason: string, status: number | null = 402): PaymentError {
  const code = reason.split(":")[0]!.trim();
  const say = (kind: PaymentFailureKind, text: string) =>
    new PaymentError(kind, `${text} (${code})`, { reason, status });

  if (/insufficient_balance|insufficient_funds|insufficient funds/i.test(code)) {
    return say("insufficient_funds", "This wallet doesn't hold enough USDC for the job. Nothing was paid.");
  }
  if (/valid_before|valid_after|expired/i.test(code)) {
    return say("authorization_expired", "The payment authorization expired before it could settle. Request a new quote.");
  }
  if (/recipient_mismatch|value_mismatch|authorization_value/i.test(code)) {
    return say("quote_mismatch", "The signed payment didn't match what the broker asked for. Nothing was paid.");
  }
  if (/network_mismatch/i.test(code)) {
    return say("wrong_network", "The payment was signed for a different network.");
  }
  if (/signature|token_name|token_version|eip712_domain|undeployed_smart_wallet/i.test(code)) {
    return say("signature", "The facilitator couldn't verify the payment signature. Nothing was paid.");
  }
  if (/nonce_already_used/i.test(code)) {
    return say("signature", "That payment authorization was already used. Request a new quote.");
  }
  if (/transaction_failed|simulation_failed|transfer_event|settle/i.test(code)) {
    return say("settlement_failed", "The settlement transaction failed on Monad. Nothing was charged.");
  }
  return new PaymentError("unknown", `The payment was refused: ${reason}`, { reason, status });
}

/** A non-2xx broker answer after the x402 round trip, as a PaymentError. */
export function failureFromResponse(status: number, body: { error?: string } | null, reason: string | null): PaymentError {
  if (reason) return describeRefusal(reason, status);
  const said = body?.error?.trim();
  if (status === 402) {
    return new PaymentError("unknown", said ? `The broker refused the payment: ${said}` : "The broker refused the payment (402).", { status });
  }
  if (status === 404) {
    return new PaymentError("quote_expired", "This quote expired before it was paid. Request a new one — nothing was charged.", { status });
  }
  if (status === 409) {
    if (said && /already been paid/i.test(said)) return new PaymentError("already_paid", said, { status });
    if (said && /offline/i.test(said)) {
      return new PaymentError("provider_offline", "The quoted provider went offline. Request a new quote — nothing was charged.", { status });
    }
  }
  return new PaymentError("unknown", said ?? `The broker returned ${status}.`, { status });
}

/**
 * Classify anything thrown while paying.
 *
 * The x402 fetch wrapper rethrows signer and policy errors as
 * `Failed to create payment payload: …`, so the useful distinctions — the user
 * declined, the 402 didn't match the quote — have to be recovered from it.
 */
export function classifyPaymentError(err: unknown): PaymentError {
  if (err instanceof PaymentError) return err;
  if (isUserRejection(err)) {
    return new PaymentError("rejected", "You declined the signature — nothing was paid.");
  }
  const message = errorMessage(err).replace(/^Failed to create payment payload:\s*/i, "");
  if (/does not match the quote|refusing to sign/i.test(message)) {
    return new PaymentError("quote_mismatch", `The broker's 402 didn't match the quote you accepted, so nothing was signed. ${message}`);
  }
  if (/spendControls|spend control|maxAmountPerPayment/i.test(message)) {
    return new PaymentError("quote_mismatch", "The 402 asked for more than this payer is allowed to spend, so nothing was signed.");
  }
  if (/no exact-USDC payment/i.test(message)) {
    return new PaymentError("wrong_network", message);
  }
  if (/Failed to fetch|NetworkError|Load failed|ECONNREFUSED/i.test(message)) {
    return new PaymentError("unknown", "Couldn't reach the broker. Nothing was paid.");
  }
  return new PaymentError("unknown", message);
}

// ---------------------------------------------------------------------------
// Paying
// ---------------------------------------------------------------------------

export interface PayQuoteOptions {
  quote: PayableQuote;
  signer: PaymentSigner;
  /** The app's CAIP-2 network; the signer is registered for this one only. */
  network: string;
  brokerUrl: string;
  /**
   * Per-payment cap in USDC units. Defaults to the quote's own amount — the
   * tightest cap there is, since the quote-match policy already refuses any
   * other amount. The demo route passes its server-side ceiling here.
   */
  maxUsdcUnits?: string | bigint;
  fetch?: typeof fetch;
}

/**
 * Buy the job behind `quote`: POST the pay URL, answer the 402 with a signed
 * EIP-3009 authorization, and return the job id and settlement tx.
 *
 * The client refuses to sign anything but the frozen quote — same payee, same
 * amount, same asset, same network — so a broker that swapped the provider or
 * bumped the price between quote and payment gets an error, not a signature.
 *
 * @throws {PaymentError} for every failure, classified.
 */
export async function payQuote(opts: PayQuoteOptions): Promise<PaymentResult> {
  const { quote, signer, network } = opts;
  if (quote.network && quote.network !== network) {
    throw new PaymentError("wrong_network", `This quote is priced on ${quote.network}, but the app is on ${network}. Nothing was signed.`);
  }

  let client: ReturnType<typeof buyerX402Client>;
  try {
    client = buyerX402Client({
      signer,
      network,
      maxUsdcUnits: opts.maxUsdcUnits ?? quote.usdcAmount,
      expect: { payTo: quote.payTo, amount: quote.usdcAmount, escrow: quote.escrow ?? null },
    });
  } catch (err) {
    throw new PaymentError("quote_mismatch", `The quote can't be paid as shown: ${errorMessage(err)}`);
  }

  const baseFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const paidFetch = wrapFetchWithPayment(baseFetch, client);
  const url = `${opts.brokerUrl.replace(/\/+$/, "")}/api/jobs/${encodeURIComponent(quote.quoteId)}`;

  let res: Response;
  try {
    res = await paidFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch (err) {
    throw classifyPaymentError(err);
  }

  const body = (await res.json().catch(() => null)) as { jobId?: string; error?: string } | null;
  if (!res.ok || !body?.jobId) {
    throw failureFromResponse(res.status, body, refusalReason(res.headers));
  }

  let txHash: string | null = null;
  let payer: string = signer.address;
  try {
    const settled = new x402HTTPClient(client).getPaymentSettleResponse((name) => res.headers.get(name));
    txHash = settled.transaction || null;
    payer = settled.payer || payer;
  } catch {
    /* the settle header is a nicety; a job the broker accepted is paid either way */
  }

  return { jobId: body.jobId, txHash, payer, explorerUrl: txHash ? explorerTx(network, txHash) : null };
}
