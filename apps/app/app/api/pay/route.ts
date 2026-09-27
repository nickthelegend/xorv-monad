/**
 * Pay a quote from the deployment's demo account.
 *
 * The primary way to pay is the buyer's own wallet, in the browser: a Privy
 * embedded wallet (or an injected one) signs the x402 authorization and the
 * server never sees a key. This route is the fallback for a visitor who has
 * neither — the app pays from one configured testnet account, and the button
 * that calls it says "Pay from demo account", because it is not their money.
 *
 * The flow is the same code the wallet path runs (`payQuote`), with a local
 * viem account as the signer: the same frozen-quote policy, the same refusal
 * decoding, a real EIP-3009 transfer settled on Monad. Because this route is
 * unauthenticated it is testnet-only, will not pay more than
 * `XORV_DEMO_MAX_USDC_UNITS` for any one job, and is bounded by
 * lib/server/demo-guard.ts: per-IP and deployment-wide rate limits, a rolling
 * 24 h spend cap (`XORV_DEMO_DAILY_USDC_UNITS`), and one attempt per quote.
 *
 * A successful payment sets an HttpOnly demo receipt for the job (scoped to
 * `/api/rate`), so only this browser can then rate it as the demo account.
 *
 * `GET` reports whether the demo account exists (and its address), so the
 * composer only offers the button when pressing it can work.
 */

import { NextResponse } from "next/server";
import { loadDemoPayer } from "@/lib/server/demo-payer";
import {
  DEMO_RATING_WINDOW_MS,
  clientIp,
  dailyCapUnits,
  demoGuards,
  demoReceiptCookie,
  isCookieSafeJobId,
  mintDemoReceipt,
} from "@/lib/server/demo-guard";
import { PaymentError, classifyPaymentError, payQuote } from "@/lib/x402-pay";
import { errorMessage } from "@/lib/errors";

export const runtime = "nodejs";
/** Never prerender or cache: this route moves funds. */
export const dynamic = "force-dynamic";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function GET(): Promise<NextResponse> {
  const loaded = loadDemoPayer();
  if (!loaded.ok) {
    return NextResponse.json({ configured: false, address: null, reason: loaded.error });
  }
  const { account, network, maxUsdcUnits } = loaded.payer;
  return NextResponse.json({ configured: true, address: account.address, network, maxUsdcUnits });
}

/** What the payment's failure kind means as an HTTP status for the browser. */
function statusFor(err: PaymentError): number {
  switch (err.kind) {
    case "quote_expired":
      return 404;
    case "already_paid":
    case "provider_offline":
      return 409;
    case "quote_mismatch":
    case "wrong_network":
      return 400;
    default:
      return 402;
  }
}

function tooMany(retryAfterMs: number, message: string): NextResponse {
  return NextResponse.json(
    { error: message, kind: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const loaded = loadDemoPayer();
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const { account, network, brokerUrl, maxUsdcUnits } = loaded.payer;
  const cap = dailyCapUnits();
  if (cap === null) {
    return NextResponse.json({ error: "XORV_DEMO_DAILY_USDC_UNITS must be a positive integer of USDC units." }, { status: 500 });
  }
  const guards = demoGuards(cap);

  // Rate limits first: they cost nothing and don't depend on the body.
  const perIp = guards.payPerIp.take(clientIp(request));
  if (!perIp.ok) return tooMany(perIp.retryAfterMs, "Too many demo payments from this address — wait a few minutes, or log in and pay from your own wallet.");
  const global = guards.payGlobal.take("*");
  if (!global.ok) return tooMany(global.retryAfterMs, "The demo account is busy — try again in a few minutes, or log in and pay from your own wallet.");

  let body: { quoteId?: unknown; payTo?: unknown; usdcAmount?: unknown; network?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // The browser sends the terms it showed the visitor; the payment policy then
  // refuses any 402 that asks for something else.
  const quoteId = typeof body.quoteId === "string" ? body.quoteId.trim() : "";
  const payTo = typeof body.payTo === "string" ? body.payTo.trim() : "";
  const usdcAmount = typeof body.usdcAmount === "string" ? body.usdcAmount.trim() : "";
  if (!quoteId || !ADDRESS.test(payTo) || !/^\d+$/.test(usdcAmount)) {
    return NextResponse.json({ error: "quoteId, payTo (0x address) and usdcAmount (integer units) are required" }, { status: 400 });
  }
  if (BigInt(usdcAmount) > BigInt(maxUsdcUnits)) {
    return NextResponse.json(
      {
        error: `This job costs more than the demo account will pay (cap ${maxUsdcUnits} USDC units). Log in and pay from your own wallet.`,
        kind: "over_cap",
      },
      { status: 402 },
    );
  }

  // One attempt per quote: a replay (or a burst of parallel requests) for the
  // same quote never reaches the signer twice.
  if (!guards.quotes.claim(quoteId)) {
    return NextResponse.json(
      { error: "The demo account has already tried to pay this quote. Request a new quote.", kind: "already_paid" },
      { status: 409 },
    );
  }
  const reserved = guards.spend.reserve(BigInt(usdcAmount));
  if (!reserved.ok) {
    return NextResponse.json(
      {
        error: "The demo account has reached its spending limit for today. Log in and pay from your own wallet.",
        kind: "daily_cap",
      },
      { status: 429 },
    );
  }

  try {
    const result = await payQuote({
      quote: { quoteId, usdcAmount, payTo, network: typeof body.network === "string" ? body.network : null },
      signer: account,
      network,
      brokerUrl,
      maxUsdcUnits,
    });
    const response = NextResponse.json({ ...result, demo: true });
    // The demo receipt: proof, for /api/rate only, that this browser is the one
    // the demo account just paid for. HttpOnly, so page scripts can't lift it.
    if (isCookieSafeJobId(result.jobId)) {
      response.cookies.set(demoReceiptCookie(result.jobId), mintDemoReceipt(loaded.payer.receiptSecret, result.jobId, Date.now()), {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        path: "/api/rate",
        maxAge: Math.floor(DEMO_RATING_WINDOW_MS / 1000),
      });
    }
    return response;
  } catch (err) {
    const failure = err instanceof PaymentError ? err : classifyPaymentError(err);
    // A classified refusal moved no money, so it doesn't count against the
    // day's cap. "unknown" might have settled — keep it counted.
    if (failure.kind !== "unknown") reserved.release();
    // "Your wallet has no USDC" is the wrong advice here — the visitor can't
    // top up the deployment's account — so say whose balance ran out.
    const message =
      failure.kind === "insufficient_funds"
        ? `The demo account (${account.address}) is out of test USDC. Log in and pay from your own wallet, or top it up at the Circle faucet.`
        : failure.message || errorMessage(err);
    return NextResponse.json({ error: message, kind: failure.kind, reason: failure.reason }, { status: statusFor(failure) });
  }
}
