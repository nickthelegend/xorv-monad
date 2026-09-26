"use client";

/**
 * Paying a quote from the browser, with the user's own wallet.
 *
 * This is the whole point of replacing Privy. The x402 round trip happens
 * *here*, in the tab: the broker answers 402 with terms, this builds the
 * transfer, HashPack signs it, and the signed transaction goes back on the
 * retry. The server never sees a key and never signs anything.
 *
 * `/api/pay` still exists and still works — it is the fallback for a visitor
 * with no wallet connected, using a demo account the deployment holds. The two
 * differ in exactly one way that matters: with a wallet, the money is the
 * user's and they approved it; without one, it is the demo's.
 *
 * Loaded lazily. `@x402/*` plus the Hedera SDK is a large graph with `window`
 * assumptions, and none of it should be in the first paint of a page whose job
 * is a text box.
 */

import type { WalletSession } from "@/lib/hashpack";
import { createWalletHederaSigner } from "@/lib/hedera-wallet";

export interface WalletPaymentResult {
  jobId: string;
  /** Present when the facilitator reported one on the response header. */
  transaction: string | null;
}

/**
 * Run the paid request for `quoteId`, signing with the connected wallet.
 *
 * @throws with the facilitator's own reason when the payment is refused — the
 * useful text lives in the `payment-required` header rather than the body, so
 * a bare "402" is never what the caller sees.
 */
export async function payQuoteWithWallet(
  session: WalletSession,
  brokerUrl: string,
  quoteId: string,
  asset: "usdc" | "hbar",
): Promise<WalletPaymentResult> {
  const [{ x402Client, x402HTTPClient }, { wrapFetchWithPayment }, { ExactHederaScheme }] =
    await Promise.all([
      import("@x402/core/client"),
      import("@x402/fetch"),
      import("@x402/hedera/exact/client"),
    ]);

  const signer = createWalletHederaSigner(session.accountId, session.signTransaction);
  const client = new x402Client().register(
    "hedera:*",
    // Structurally the ClientHederaSigner the scheme wants; the cast is only
    // because our signer is built on @hashgraph/sdk types rather than the
    // @hiero-ledger ones the package declares. Base64 is the real contract.
    new ExactHederaScheme(signer as never),
  );

  // Narrow to the requested asset, but never to nothing — an empty list would
  // refuse a payment the broker was willing to accept.
  client.registerPolicy((_version, requirements) => {
    const wantHbar = asset === "hbar";
    const preferred = wantHbar
      ? requirements.filter((r) => r.asset === "0.0.0")
      : requirements.filter((r) => r.asset !== "0.0.0");
    return preferred.length > 0 ? preferred : requirements;
  });

  const paidFetch = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);

  const res = await paidFetch(`${brokerUrl}/api/jobs/${quoteId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  const body = (await res.json()) as { jobId?: string; error?: string };
  if (!res.ok || !body.jobId) {
    throw new Error(decodeRefusal(res) ?? body.error ?? `Payment failed (${res.status}).`);
  }

  let transaction: string | null = null;
  try {
    const settled = httpClient.getPaymentSettleResponse((name) => res.headers.get(name));
    transaction = settled?.transaction ?? null;
  } catch {
    /* the receipt is a nicety; a settled job without it is still settled */
  }

  return { jobId: body.jobId, transaction };
}

/** The refusal reason the resource server puts on the header, not the body. */
function decodeRefusal(res: Response): string | null {
  const header = res.headers.get("payment-required") ?? res.headers.get("Payment-Required");
  if (!header) return null;
  try {
    const decoded = JSON.parse(atob(header)) as { error?: string; errorReason?: string };
    return decoded.error ?? decoded.errorReason ?? null;
  } catch {
    return null;
  }
}
