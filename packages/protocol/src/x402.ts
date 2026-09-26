/**
 * Xorv's x402 wiring.
 *
 * Two things live here that the broker and the CLI both need:
 *
 *  1. `buildFacilitator` — Xorv can run its **own** facilitator in-process
 *     instead of calling out to a hosted one. That matters beyond independence:
 *     on Hedera the facilitator is the fee payer, so running it ourselves is
 *     what lets a job poster hold nothing but USDC and still transact. They
 *     sign a transfer; Xorv adds the second signature and pays the HBAR.
 *
 *  2. `paymentOptionsFor` — the `accepts` array a 402 offers, which is where
 *     "pay in USDC or pay in HBAR, your choice" comes from.
 */

import type { Client, PrivateKey } from "@hiero-ledger/sdk";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentOption } from "@x402/core/http";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme as ExactHederaFacilitator } from "@x402/hedera/exact/facilitator";
import {
  createHederaPreflightTransfer,
  createHederaSignAndSubmitTransaction,
  createHederaVerifyPayerSignature,
  toFacilitatorHederaSigner,
} from "@x402/hedera";
import { HBAR_ASSET_ID, QUOTE_TTL_SECONDS, XORV_SCHEME, usdcTokenId } from "./constants.js";
import { hederaClient } from "./hedera.js";
import { type HbarRate, usdMicrosToTinybars, usdMicrosToUsdcUnits } from "./money.js";

/**
 * The public x402 facilitator, which supports Hedera testnet with no signup.
 * Kept as a named fallback so `XORV_FACILITATOR=hosted` is a one-word change.
 */
export const PUBLIC_FACILITATOR_URL = "https://x402.org/facilitator";

/**
 * An in-process facilitator backed by our own Hedera account.
 *
 * `x402Facilitator` implements the same `FacilitatorClient` surface the HTTP
 * client does, so the resource server cannot tell the difference — which is the
 * point: self-hosted and hosted are a config flag, not two code paths.
 */
export function buildLocalFacilitator(opts: {
  network: string;
  client: Client;
  feePayerId: string;
  feePayerKey: PrivateKey;
}): FacilitatorClient {
  const signer = toFacilitatorHederaSigner({
    getAddresses: () => [opts.feePayerId],

    /**
     * One fresh SDK client per settlement, closed when it's done.
     *
     * A single long-lived client cannot be reused here. The payload is a
     * transaction frozen by *someone else's* client — the payer's — carrying
     * their node account ids and transaction id. Submitting one of those
     * mutates the submitting client's internal request state, and the next
     * settlement on the same client dies inside the SDK with "Cannot read
     * properties of undefined (reading 'length')". The symptom is brutal to
     * diagnose from outside: the first payment of a process succeeds, every
     * one after it comes back as a bare 402.
     *
     * The `buildClient` factory is called per settlement precisely so this can
     * be done. Constructing a client is cheap next to a consensus round-trip,
     * and closing it in `finally` keeps the gRPC pools from accumulating.
     */
    signAndSubmitTransaction: async (transactionBase64, feePayer, network) => {
      const client = hederaClient(network, opts.feePayerId, opts.feePayerKey);
      try {
        const submit = createHederaSignAndSubmitTransaction(() => client, opts.feePayerKey);
        return await submit(transactionBase64, feePayer, network);
      } finally {
        client.close();
      }
    },

    verifyPayerSignature: createHederaVerifyPayerSignature(),
    preflightTransfer: createHederaPreflightTransfer(),
  });

  const facilitator = new x402Facilitator().register(
    opts.network as Network,
    new ExactHederaFacilitator(signer),
  );

  // Adapt x402Facilitator to the FacilitatorClient shape the resource server
  // expects. Everything is local, so there is no network hop and no retry.
  return {
    async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) {
      const result = await facilitator.verify(paymentPayload, paymentRequirements);
      // A rejected payment is the hardest failure in this system to diagnose
      // from the outside — the caller sees a bare 402 and the reason lives only
      // here. Log it once, at the point of decision.
      if (!result.isValid) {
        console.error(
          `[x402] payment rejected: ${result.invalidReason ?? "unknown"}` +
            `${result.invalidMessage ? ` — ${result.invalidMessage}` : ""}` +
            ` (payer=${result.payer ?? "?"}, asset=${paymentRequirements.asset},` +
            ` amount=${paymentRequirements.amount}, payTo=${paymentRequirements.payTo})`,
        );
      }
      return result;
    },
    async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) {
      const result = await facilitator.settle(paymentPayload, paymentRequirements);
      if (!result.success) {
        console.error(
          `[x402] settlement failed: ${result.errorReason ?? "unknown"}` +
            `${result.errorMessage ? ` — ${result.errorMessage}` : ""}`,
        );
      }
      return result;
    },
    async getSupported() {
      return facilitator.getSupported();
    },
  } as unknown as FacilitatorClient;
}

/** A facilitator that talks HTTP to a hosted one. */
export function buildHostedFacilitator(url: string): FacilitatorClient {
  return new HTTPFacilitatorClient({ url });
}

/**
 * Pick a facilitator from config.
 *
 * `self` (the default) runs one in-process; anything else is treated as the URL
 * of a hosted facilitator, with the public x402.org one as the shorthand
 * `hosted`.
 */
export function buildFacilitator(opts: {
  mode: string;
  network: string;
  client: Client;
  feePayerId: string;
  feePayerKey: PrivateKey;
}): { facilitator: FacilitatorClient; description: string; feePayer: string } {
  const mode = (opts.mode || "self").trim();
  if (mode === "self") {
    return {
      facilitator: buildLocalFacilitator(opts),
      description: "self-hosted (in-process)",
      feePayer: opts.feePayerId,
    };
  }
  const url = mode === "hosted" ? PUBLIC_FACILITATOR_URL : mode;
  return {
    facilitator: buildHostedFacilitator(url),
    description: `hosted (${url})`,
    feePayer: "facilitator-managed",
  };
}

/**
 * The `accepts` array for a priced resource: the same job, offered in USDC and
 * in HBAR, with the caller free to pick either.
 *
 * `payTo` is a resolver rather than a fixed string because Xorv pays the
 * matched **provider** directly — the broker never takes custody of a job's
 * money, it only introduces the two parties and witnesses the result.
 */
export function paymentOptionsFor(opts: {
  network: string;
  priceUsdMicros: number;
  payTo: PaymentOption["payTo"];
  hbarRate?: HbarRate | null;
  maxTimeoutSeconds?: number;
}): PaymentOption[] {
  const network = opts.network as Network;
  const maxTimeoutSeconds = opts.maxTimeoutSeconds ?? QUOTE_TTL_SECONDS;

  const options: PaymentOption[] = [
    {
      scheme: XORV_SCHEME,
      network,
      payTo: opts.payTo,
      price: {
        asset: usdcTokenId(opts.network),
        amount: usdMicrosToUsdcUnits(opts.priceUsdMicros),
      },
      maxTimeoutSeconds,
    },
  ];

  // HBAR is only offered when we have a live rate. Quoting it from a stale or
  // missing rate would misprice the job in the provider's disfavour, and a
  // missing option is easier to explain than a wrong price.
  if (opts.hbarRate) {
    options.push({
      scheme: XORV_SCHEME,
      network,
      payTo: opts.payTo,
      price: {
        asset: HBAR_ASSET_ID,
        amount: usdMicrosToTinybars(opts.priceUsdMicros, opts.hbarRate),
      },
      maxTimeoutSeconds,
    });
  }

  return options;
}

/** Which asset a settled payment used, for display and receipts. */
export function assetKind(assetId: string): "usdc" | "hbar" {
  return assetId === HBAR_ASSET_ID ? "hbar" : "usdc";
}
