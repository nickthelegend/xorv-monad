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
 * decoding, a real EIP-3009 transfer settled on Monad. Two extra guards,
 * because this route is unauthenticated: it is testnet-only, and it will not
 * pay more than `XORV_DEMO_MAX_USDC_UNITS` for any one job.
 *
 * `GET` reports whether the demo account exists (and its address), so the
 * composer only offers the button when pressing it can work.
 */

import { NextResponse } from "next/server";
import { loadDemoPayer } from "@/lib/server/demo-payer";
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

export async function POST(request: Request): Promise<NextResponse> {
  const loaded = loadDemoPayer();
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const { account, network, brokerUrl, maxUsdcUnits } = loaded.payer;

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

  try {
    const result = await payQuote({
      quote: { quoteId, usdcAmount, payTo, network: typeof body.network === "string" ? body.network : null },
      signer: account,
      network,
      brokerUrl,
      maxUsdcUnits,
    });
    return NextResponse.json({ ...result, demo: true });
  } catch (err) {
    const failure = err instanceof PaymentError ? err : classifyPaymentError(err);
    // "Your wallet has no USDC" is the wrong advice here — the visitor can't
    // top up the deployment's account — so say whose balance ran out.
    const message =
      failure.kind === "insufficient_funds"
        ? `The demo account (${account.address}) is out of test USDC. Log in and pay from your own wallet, or top it up at the Circle faucet.`
        : failure.message || errorMessage(err);
    return NextResponse.json({ error: message, kind: failure.kind, reason: failure.reason }, { status: statusFor(failure) });
  }
}
