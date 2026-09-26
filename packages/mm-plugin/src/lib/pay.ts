/**
 * Paying for a quote: 402 → MetaMask-signed EIP-3009 → retry.
 *
 *  1. `POST /api/jobs/:quoteId` with no payment answers 402, with the x402 v2
 *     `PAYMENT-REQUIRED` header: `exact` scheme, Monad USDC, amount, payTo =
 *     the provider, `extra: { name: "USDC", version: "2" }` (the token's
 *     EIP-712 domain — MetaMask's x402 support requires it, and so does ours).
 *  2. `buyerX402Client` (`@xorv/protocol`) decides whether to sign: only
 *     exact-USDC on the quote's network, at most `--max`, and only the frozen
 *     quote's payee and amount (`quoteMatchPolicy`).
 *  3. `@x402/evm` builds the `TransferWithAuthorization` and hands it to our
 *     `ClientEvmSigner`, whose `signTypedData` is `ctx.walletExecutor` — so the
 *     signature is made by MetaMask, under the user's wallet policy.
 *  4. `@x402/fetch` retries with the `PAYMENT-SIGNATURE` header. The broker's
 *     facilitator settles on-chain before dispatching (upfront settlement) and
 *     answers with the job id plus a `PAYMENT-RESPONSE` settlement receipt.
 *
 * The buyer needs USDC only: the facilitator submits the authorization and
 * pays the MON gas.
 */

import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import type { ClientEvmSigner } from "@x402/evm";
import {
  ERC20_ABI,
  buyerX402Client,
  explorerTx,
  networkConfig,
  usdMicrosToUsdcUnits,
  type PaymentRecord,
} from "@xorv/protocol";
import type { Address, PublicClient } from "viem";
import type { BrokerClient, PaidJobResponse } from "./broker.js";
import { XorvPluginError, errorMessage } from "./errors.js";
import { usdcLabel } from "./format.js";
import type { VettedQuote } from "./vet.js";

export interface Settlement {
  /** Settlement (`transferWithAuthorization`) transaction hash. */
  txHash: string | null;
  explorerUrl: string | null;
  payer: string | null;
  network: string;
}

export interface PaidJob {
  response: PaidJobResponse;
  settlement: Settlement;
}

/**
 * Pay one vetted quote and return the created job.
 *
 * Errors keep their meaning: a MetaMask refusal stays `XORV_SIGNATURE_*`, a
 * policy mismatch is `XORV_PAYMENT_REFUSED`, and a facilitator rejection
 * carries the x402 reason code (e.g. `invalid_exact_evm_insufficient_balance`).
 */
export async function payForQuote(opts: {
  broker: BrokerClient;
  vetted: VettedQuote;
  signer: ClientEvmSigner;
  maxPriceUsdMicros: number;
  /** The first error the signer raised, if any — `wrapFetchWithPayment` hides it behind its own message. */
  signerError: () => unknown;
}): Promise<PaidJob> {
  const { quote, network, config } = opts.vetted;
  const client = buyerX402Client({
    signer: opts.signer,
    network,
    maxUsdcUnits: usdMicrosToUsdcUnits(opts.maxPriceUsdMicros),
    expect: { payTo: quote.provider.address, amount: quote.usdcAmount, network, asset: config.usdc.address },
  });
  const httpClient = new x402HTTPClient(client);
  const paidFetch = wrapFetchWithPayment(opts.broker.fetch, client);

  let res: Response;
  try {
    res = await paidFetch(opts.broker.payUrl(quote.quoteId), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
    });
  } catch (err) {
    const original = opts.signerError();
    if (original instanceof XorvPluginError) throw original;
    const message = errorMessage(err);
    if (/does not match the quote|no exact-USDC payment|spend|policies|rejected/i.test(message)) {
      throw new XorvPluginError(
        "XORV_PAYMENT_REFUSED",
        message,
        "Nothing was signed or paid: the broker's 402 did not match the quote you accepted.",
      );
    }
    if (err instanceof TypeError || /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message)) {
      throw new XorvPluginError(
        "XORV_BROKER_UNREACHABLE",
        `lost the broker while paying: ${message}`,
        "If a signature was made it can only settle once; re-quote and retry.",
      );
    }
    throw new XorvPluginError("XORV_PAYMENT_REFUSED", message, "Nothing was paid. Re-quote and retry.");
  }

  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> | null = null;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }

  if (res.status === 402) {
    // The payment was attempted and refused: the reason is in PAYMENT-REQUIRED.
    let reason: string | undefined;
    try {
      reason = httpClient.getPaymentRequiredResponse((h) => res.headers.get(h), body ?? undefined).error;
    } catch {
      reason = undefined;
    }
    throw paymentRejected(reason, quote.usdcAmount, network);
  }
  if (!res.ok || !body || typeof body.jobId !== "string") {
    const message = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new XorvPluginError(
      "XORV_BROKER_ERROR",
      `the broker did not start the job: ${message}`,
      res.status === 404 || res.status === 409
        ? "The quote expired or was already used; request a new one."
        : "Check the job list on the broker before retrying, so you do not pay twice.",
    );
  }

  const response = body as unknown as PaidJobResponse;
  let txHash: string | null = null;
  let payer: string | null = null;
  try {
    const settle = httpClient.getPaymentSettleResponse((h) => res.headers.get(h));
    txHash = settle.transaction || null;
    payer = settle.payer ?? null;
  } catch {
    // No PAYMENT-RESPONSE header: fall back to the payment record in the body.
  }
  const record: PaymentRecord | null = response.payment ?? null;
  txHash = txHash ?? record?.txHash ?? null;
  payer = payer ?? record?.payer ?? null;
  return {
    response,
    settlement: { txHash, explorerUrl: txHash ? explorerTx(network, txHash) : null, payer, network },
  };
}

/** Map an x402 rejection reason to a message and a next step. */
export function paymentRejected(reason: string | undefined, amount: string, network: string): XorvPluginError {
  const cfg = networkConfig(network);
  if (reason && /insufficient_balance|insufficient_funds/i.test(reason)) {
    return new XorvPluginError(
      "XORV_INSUFFICIENT_USDC",
      `the wallet holds less than ${usdcLabel(amount)} on ${cfg.name} (${reason})`,
      cfg.faucets.usdc
        ? `Get test USDC at ${cfg.faucets.usdc} (pick ${cfg.name}); no MON is needed.`
        : `Fund the wallet with ${cfg.usdc.symbol} on ${cfg.name}; no MON is needed.`,
    );
  }
  return new XorvPluginError(
    "XORV_PAYMENT_REFUSED",
    `the broker's facilitator rejected the payment${reason ? ` (${reason})` : ""}`,
    "Nothing settled. Re-quote and retry; if it repeats, run mm doctor.",
  );
}

/**
 * Best-effort USDC balance check before asking MetaMask to sign, over the
 * host's authenticated RPC client (capability `wallet-read`).
 *
 * Saves the user a 2FA approval for a payment that cannot settle. If the read
 * itself fails, the payment goes ahead: the facilitator simulates the transfer
 * and would report the shortfall anyway.
 */
export async function checkUsdcBalance(opts: {
  client: Pick<PublicClient, "readContract"> | null;
  network: string;
  owner: Address;
  amount: string;
}): Promise<bigint | null> {
  if (!opts.client) return null;
  const cfg = networkConfig(opts.network);
  let balance: bigint;
  try {
    balance = (await opts.client.readContract({
      address: cfg.usdc.address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [opts.owner],
    })) as bigint;
  } catch {
    return null;
  }
  if (balance < BigInt(opts.amount)) {
    throw new XorvPluginError(
      "XORV_INSUFFICIENT_USDC",
      `${opts.owner} holds ${usdcLabel(balance)} on ${cfg.name}; this job costs ${usdcLabel(opts.amount)}`,
      cfg.faucets.usdc
        ? `Get test USDC at ${cfg.faucets.usdc} (pick ${cfg.name}); no MON is needed.`
        : `Fund the wallet with ${cfg.usdc.symbol} on ${cfg.name}; no MON is needed.`,
    );
  }
  return balance;
}
