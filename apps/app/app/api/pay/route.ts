/**
 * The one route that spends money.
 *
 * Signing an x402 payment needs a Hedera private key. A key shipped to a
 * browser tab is a key in someone's extensions, devtools and clipboard history,
 * so the signing stays on the server and the browser only ever asks for it to
 * happen. In production this is where a real wallet connection (HashPack,
 * WalletConnect) or a per-user custodial key would go; for the demo it is a
 * single configured testnet payer, and the UI says so plainly.
 *
 * Everything else about the flow is the genuine article: the same `@x402/*`
 * client any third party would use, against the broker's public HTTP surface,
 * settling a real transfer on Hedera.
 */

import { NextResponse } from "next/server";
import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

export const runtime = "nodejs";
/** Never prerender or cache: this route moves funds. */
export const dynamic = "force-dynamic";

const BROKER_URL = (process.env.XORV_BROKER_URL ?? "http://localhost:8402").replace(/\/+$/, "");
const NETWORK = process.env.XORV_NETWORK ?? "hedera:testnet";
const HBAR_ASSET_ID = "0.0.0";

/**
 * Parse a Hedera key without knowing its curve.
 *
 * Duplicated from @xorv/protocol rather than imported: this module is bundled
 * for a Next.js route, and pulling the whole protocol package in drags the
 * broker's dependency graph along with it for the sake of twelve lines.
 */
function parseKey(raw: string): PrivateKey {
  const key = raw.trim();
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    try {
      return PrivateKey.fromStringECDSA(key);
    } catch {
      return PrivateKey.fromStringED25519(key);
    }
  }
  return PrivateKey.fromStringDer(key);
}

/** Pull the resource server's failure reason out of the `payment-required` header. */
function decodePaymentRequiredError(res: Response): string | null {
  const header = res.headers.get("payment-required") ?? res.headers.get("Payment-Required");
  if (!header) return null;
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      error?: string;
    };
    return decoded.error && decoded.error !== "Payment required" ? decoded.error : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const payerId = process.env.XORV_DEMO_PAYER_ID?.trim();
  const payerKey = process.env.XORV_DEMO_PAYER_KEY?.trim();

  if (!payerId || !payerKey) {
    return NextResponse.json(
      {
        error:
          "No demo payer configured. Set XORV_DEMO_PAYER_ID and XORV_DEMO_PAYER_KEY in .env.local — see .env.example.",
      },
      { status: 501 },
    );
  }

  let body: { quoteId?: string; asset?: "usdc" | "hbar" };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const quoteId = body.quoteId?.trim();
  if (!quoteId) {
    return NextResponse.json({ error: "quoteId is required" }, { status: 400 });
  }
  const wantHbar = body.asset === "hbar";

  try {
    const signer = createClientHederaSigner(payerId, parseKey(payerKey), { network: NETWORK });
    const client = new x402Client().register("hedera:*", new ExactHederaScheme(signer));

    // Narrow the server's `accepts` to the requested asset, never to nothing:
    // an empty list would fail a request the broker was willing to serve.
    client.registerPolicy((_version, requirements) => {
      const preferred = wantHbar
        ? requirements.filter((r) => r.asset === HBAR_ASSET_ID)
        : requirements.filter((r) => r.asset !== HBAR_ASSET_ID);
      return preferred.length > 0 ? preferred : requirements;
    });

    const paidFetch = wrapFetchWithPayment(fetch, client);
    const httpClient = new x402HTTPClient(client);

    const res = await paidFetch(`${BROKER_URL}/api/jobs/${quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const payload = (await res.json()) as { jobId?: string; error?: string };
    if (!res.ok || !payload.jobId) {
      // On a rejected payment the useful detail is in the `payment-required`
      // header, not the body — the resource server puts its `error` there, and
      // the broker replaces the body with its own hint. Decode it so the caller
      // sees "insufficient funds" rather than a bare 402.
      const reason = decodePaymentRequiredError(res);
      return NextResponse.json(
        {
          error: reason ?? payload.error ?? `broker returned ${res.status}`,
          status: res.status,
        },
        { status: res.status === 402 ? 402 : 502 },
      );
    }

    const settlement = httpClient.getPaymentSettleResponse((name) => res.headers.get(name));

    return NextResponse.json({
      jobId: payload.jobId,
      payer: payerId,
      transaction: settlement?.transaction ?? null,
      success: settlement?.success ?? true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Surfaced verbatim: the useful failures here ("payer holds no USDC",
    // "token not associated") are exactly the ones worth reading.
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
