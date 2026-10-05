"use client";

/**
 * Paying a quote from the browser, with the user's own wallet.
 *
 * The x402 round trip happens *here*, in the tab: the broker answers 402 with
 * terms, the wallet signs an EIP-3009 authorization over them, and the signed
 * authorization goes back on the retry. The server never sees a key and never
 * signs anything.
 *
 * `/api/pay` still exists and still works — it is the fallback for a visitor
 * with no wallet, using a demo account the deployment holds. The two differ in
 * exactly one way that matters: with a wallet, the money is the user's and they
 * approved it; without one, it is the demo's.
 *
 * ## The user pays no gas, and that is not a figure of speech
 *
 * What the wallet signs is **typed data, not a transaction**. It is never
 * broadcast, it never enters a mempool, and the signer needs no balance beyond
 * the stablecoin being spent — no ETH at all. The facilitator takes that signature to
 * `transferWithAuthorization` and pays the fee itself. A visitor can arrive
 * holding nothing but a stablecoin and complete a purchase, which on most
 * chains is precisely where a normal person's crypto payment dies.
 *
 * Loaded lazily. `@x402/*` is a large graph and none of it belongs in the first
 * paint of a page whose job is a text box.
 */

import { createPublicClient, erc20Abi, getAddress, http } from "viem";
import type { WalletSession } from "@/lib/wallet";
import { XORV_CHAIN } from "@/lib/chains";

export interface WalletPaymentResult {
  jobId: string;
  /** Present when the facilitator reported one on the response header. */
  transaction: string | null;
  /** The stablecoin that was paid with, e.g. "USDG". */
  asset: string | null;
}

/** One option from the quote's `accepts`, in the broker's order (USDG first). */
export interface AcceptOption {
  asset: string;
  amount: string;
  symbol?: string;
}

/**
 * Pick the stablecoin to pay with: `preferred` if given and offered, otherwise
 * the first option the wallet holds enough of, otherwise the first option (so
 * the refusal names the real reason — insufficient funds).
 *
 * Mirrors `choosePaymentAsset` in `@xorv/protocol`, which the CLI and MCP use.
 */
export function chooseAccept<T extends AcceptOption>(
  accepts: readonly T[],
  balances: Record<string, bigint>,
  preferred?: string | null,
): T | null {
  if (accepts.length === 0) return null;
  const want = preferred?.trim().toLowerCase();
  if (want) {
    return accepts.find((a) => a.asset.toLowerCase() === want || a.symbol?.toLowerCase() === want) ?? null;
  }
  const affordable = accepts.find((a) => {
    const held = balances[a.asset.toLowerCase()];
    return held === undefined || held >= BigInt(a.amount);
  });
  return affordable ?? accepts[0]!;
}

/** The wallet's balance in each offered token, keyed by lowercase address. Best-effort. */
async function balancesFor(owner: string, accepts: readonly AcceptOption[]): Promise<Record<string, bigint>> {
  const client = createPublicClient({ chain: XORV_CHAIN, transport: http() });
  const out: Record<string, bigint> = {};
  await Promise.all(
    accepts.map(async (a) => {
      try {
        out[a.asset.toLowerCase()] = (await client.readContract({
          address: getAddress(a.asset),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [getAddress(owner)],
        })) as bigint;
      } catch {
        /* unknown — leave it payable */
      }
    }),
  );
  return out;
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
  opts: { accepts?: AcceptOption[]; token?: string | null } = {},
): Promise<WalletPaymentResult> {
  const [
    { x402Client, x402HTTPClient },
    { wrapFetchWithPayment },
    { registerExactEvmScheme },
    { EscrowClientScheme },
  ] = await Promise.all([
    import("@x402/core/client"),
    import("@x402/fetch"),
    import("@x402/evm/exact/client"),
    // The browser-safe subpath: the package root pulls in Node-only modules.
    import("@xorv/protocol/escrow"),
  ]);

  const client = new x402Client();
  registerExactEvmScheme(client, {
    // The wallet session satisfies `ClientEvmSigner` as it stands: an address
    // and `signTypedData`. No adapter, no second SDK, no protobuf — this is
    // the whole reason an ordinary EVM wallet can pay here and could not on
    // Hedera, where the scheme needed a signature over a native transaction.
    signer: { address: session.address, signTypedData: session.signTypedData },
    // The `eip155:*` wildcard, so the browser can pay whatever the broker
    // quotes rather than only a network baked in at build time. The EIP-712
    // domain binds each signature to one chain id, so widening this cannot let
    // an authorization be replayed elsewhere.
  });
  // The escrow scheme, which the broker offers first: the wallet signs a
  // ReceiveWithAuthorization to XorvEscrow, the money waits there until the
  // job delivers, and anyone can refund it after the deadline. The nonce is
  // derived here from the job id and deadline, never taken from the server.
  client.register(
    "eip155:*",
    new EscrowClientScheme({ address: session.address, signTypedData: session.signTypedData }),
  );

  // The 402 offers every stablecoin the broker accepts (USDG first). Pay in
  // the one this wallet can afford — or the one the user picked — rather than
  // blindly signing for the first. The policy narrows the list but never
  // empties it, which would fail a request the server was willing to serve.
  const accepts = opts.accepts ?? [];
  const balances = accepts.length ? await balancesFor(session.address, accepts) : {};
  const chosen = accepts.length ? chooseAccept(accepts, balances, opts.token) : null;
  if (accepts.length && !chosen) {
    throw new Error(`The broker does not accept ${opts.token}.`);
  }
  // Known short before anything is signed: say so, and don't ask the wallet to
  // sign an authorization the verifier will refuse (it answered with the bare
  // code "insufficient_funds" after the user had signed).
  if (chosen) {
    const held = balances[chosen.asset.toLowerCase()];
    if (held !== undefined && held < BigInt(chosen.amount)) {
      throw new Error(shortOfFunds(session.address, chosen, held));
    }
  }
  if (chosen) {
    const target = chosen.asset.toLowerCase();
    client.registerPolicy((_version, reqs) => {
      const narrowed = reqs.filter((r) => r.asset.toLowerCase() === target);
      return narrowed.length > 0 ? narrowed : reqs;
    });
  }

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

  return { jobId: body.jobId, transaction, asset: chosen?.symbol ?? null };
}

/** "This wallet holds 0 USDC — the job costs 0.2. Add USDC to 0x…, or …" */
function shortOfFunds(address: string, option: AcceptOption, held: bigint): string {
  const symbol = option.symbol ?? "stablecoin";
  const units = (v: bigint) => (Number(v) / 1_000_000).toString();
  return (
    `This wallet holds ${units(held)} ${symbol} on ${XORV_CHAIN.name} — the job costs ${units(BigInt(option.amount))}. ` +
    `Add ${symbol} to ${address}, or forget the wallet to let the demo account pay.`
  );
}

/** x402 refusal codes, in words a buyer can act on. Unknown codes pass through. */
const REFUSALS: Record<string, string> = {
  insufficient_funds: `This wallet doesn't hold enough of the stablecoin for this job on ${XORV_CHAIN.name}. Nothing was paid.`,
  invalid_exact_evm_payload_signature: "The wallet's signature didn't verify — it may have signed for another network. Nothing was paid.",
  invalid_signature: "The wallet's signature didn't verify — it may have signed for another network. Nothing was paid.",
  invalid_network: `The payment was for a different network than ${XORV_CHAIN.name}. Nothing was paid.`,
};

/** The refusal reason the resource server puts on the header, not the body. */
function decodeRefusal(res: Response): string | null {
  const header = res.headers.get("payment-required") ?? res.headers.get("Payment-Required");
  if (!header) return null;
  try {
    const decoded = JSON.parse(atob(header)) as { error?: string; errorReason?: string };
    const reason = decoded.error ?? decoded.errorReason ?? null;
    return reason ? (REFUSALS[reason] ?? reason) : null;
  } catch {
    return null;
  }
}
