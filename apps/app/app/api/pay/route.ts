/**
 * The one route that spends money.
 *
 * This is the **fallback** path, for a visitor with no wallet. When a wallet is
 * connected the x402 round trip happens in the browser and the user signs their
 * own authorization (see `lib/pay-with-wallet.ts`); this route pays from a
 * single configured demo account instead, and the UI says so plainly.
 *
 * The key stays on the server because a key shipped to a browser tab is a key
 * in someone's extensions, devtools and clipboard history.
 *
 * Everything else about the flow is the genuine article: the same `@x402/*`
 * client any third party would use, against the broker's public HTTP surface,
 * settling a real stablecoin transfer on Arbitrum.
 *
 * The usual deployment sets no key here at all: the request is forwarded to
 * the broker's `/api/demo/pay`, which holds the demo account on its own
 * machine and picks the stablecoin that account can afford.
 */

import { NextResponse } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, erc20Abi, getAddress, http } from "viem";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { EscrowClientScheme } from "@xorv/protocol/escrow";
import { XORV_CHAIN } from "@/lib/chains";

export const runtime = "nodejs";
/** Never prerender or cache: this route moves funds. */
export const dynamic = "force-dynamic";
/** A settlement on Arbitrum plus the broker round trip; well under this, but never cut off mid-payment. */
export const maxDuration = 60;

const BROKER_URL = (process.env.XORV_BROKER_URL ?? "http://localhost:8402").replace(/\/+$/, "");

/**
 * Parse an EVM private key.
 *
 * Duplicated from @xorv/protocol rather than imported: this module is bundled
 * for a Next.js route, and pulling the whole protocol package in drags the
 * broker's dependency graph along with it for the sake of six lines.
 *
 * The Hedera version of this helper was four times the size and had to guess
 * between three key encodings, because the ED25519 and ECDSA parsers throw on
 * each other's input and a wrong guess surfaced as an unverifiable signature
 * much later. An EVM key has one format.
 */
function parseKey(raw: string): `0x${string}` {
  const key = raw.trim();
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("XORV_DEMO_PAYER_KEY is not a 32-byte hex private key");
  }
  return `0x${hex}`;
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
  const payerKey = process.env.XORV_DEMO_PAYER_KEY?.trim();

  // Only a key is needed. The address is derived from it, so there is no second
  // value to configure and no way for the two to disagree.
  if (!payerKey) {
    // The usual case: no key in this deployment. The broker holds the demo
    // account's key on its own machine and pays through its own x402 route, so
    // the secret never has to be copied into a hosting provider's environment.
    // Its answer — including "no demo payer configured" — is relayed as is.
    let forward: unknown;
    try {
      forward = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
    try {
      const res = await fetch(`${BROKER_URL}/api/demo/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(forward),
        signal: AbortSignal.timeout(55_000),
      });
      const payload = (await res.json().catch(() => ({ error: `broker returned ${res.status}` }))) as Record<string, unknown>;
      return NextResponse.json(payload, { status: res.status });
    } catch (err) {
      return NextResponse.json(
        { error: `Can't reach the broker to pay: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 },
      );
    }
  }

  let body: { quoteId?: string; token?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const quoteId = body.quoteId?.trim();
  if (!quoteId) {
    return NextResponse.json({ error: "quoteId is required" }, { status: 400 });
  }

  try {
    const payer = privateKeyToAccount(parseKey(payerKey));
    const publicClient = createPublicClient({ chain: XORV_CHAIN, transport: http() });

    // Which offered tokens the demo account can cover, read before paying.
    const affordable = await affordableTokens(publicClient, payer.address, quoteId);

    const client = new x402Client();
    const signer = toClientEvmSigner(payer, publicClient);
    registerExactEvmScheme(client, {
      signer,
      // Wildcard `eip155:*` — pay whatever the broker quotes. See
      // lib/pay-with-wallet.ts for why this is safe.
    });
    // Escrow first when the broker offers it; see lib/pay-with-wallet.ts.
    client.register("eip155:*", new EscrowClientScheme(signer));

    // The 402 offers every stablecoin the broker accepts (USDG first). Pay in
    // the one asked for, else the first the demo account can afford — never
    // emptying the list, which would fail a request the broker would serve.
    const preferred = body.token?.trim().toLowerCase() || null;
    client.registerPolicy((_version, reqs) => {
      const narrowed = preferred
        ? reqs.filter((r) => r.asset.toLowerCase() === preferred)
        : reqs.filter((r) => affordable.has(r.asset.toLowerCase()));
      return narrowed.length > 0 ? narrowed : reqs;
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
      // The broker's own refusals (402, 404 expired, 409 already paid / in
      // progress) are the buyer's answer and pass through with their status
      // and job id; only a broker failure (5xx) becomes a 502. Everything was
      // a 502 before, so "already paid" looked like an outage.
      return NextResponse.json(
        {
          error: reason ?? payload.error ?? `broker returned ${res.status}`,
          status: res.status,
          ...(payload.jobId ? { jobId: payload.jobId } : {}),
        },
        { status: res.status >= 400 && res.status < 500 ? res.status : 502 },
      );
    }

    const settlement = httpClient.getPaymentSettleResponse((name) => res.headers.get(name));

    return NextResponse.json({
      jobId: payload.jobId,
      payer: payer.address,
      transaction: settlement?.transaction ?? null,
      success: settlement?.success ?? true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Surfaced verbatim: the useful failure here ("payer holds no USDG") is
    // exactly the one worth reading.
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Lowercase addresses of the quote's offered stablecoins that `owner` holds
 * enough of. Reads the quote's `accepts` from the 402 itself, so there is no
 * second token table to keep in sync. Best-effort: on any failure it returns
 * an empty set, and the stock choice (the first option) applies.
 */
async function affordableTokens(
  client: { readContract: (args: never) => Promise<unknown> },
  owner: string,
  quoteId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const res = await fetch(`${BROKER_URL}/api/jobs/${quoteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    const header = res.headers.get("payment-required");
    if (res.status !== 402 || !header) return out;
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      accepts?: Array<{ asset: string; amount: string }>;
    };
    await Promise.all(
      (decoded.accepts ?? []).map(async (a) => {
        try {
          const held = (await client.readContract({
            address: getAddress(a.asset),
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [getAddress(owner)],
          } as never)) as bigint;
          if (held >= BigInt(a.amount)) out.add(a.asset.toLowerCase());
        } catch {
          /* unknown */
        }
      }),
    );
  } catch {
    /* fall back to the stock choice */
  }
  return out;
}
