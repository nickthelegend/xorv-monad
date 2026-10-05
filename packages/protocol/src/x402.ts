/**
 * Xorv's x402 wiring.
 *
 * Two things live here that the broker and the CLI both need:
 *
 *  1. `buildFacilitator` — Xorv runs its **own** facilitator in-process instead
 *     of calling out to a hosted one. That matters beyond independence: the
 *     facilitator is the party that broadcasts, so running it ourselves is what
 *     lets a job poster hold nothing but a stablecoin and still transact. They
 *     sign an authorization; Xorv submits it and pays the MON gas.
 *
 *  2. `paymentOptionsFor` — the `accepts` array a 402 offers, one option per
 *     configured stablecoin — and, for buyers, `choosePaymentAsset` /
 *     `onlyAssetPolicy` to pick which of them to pay with.
 *
 * ## What changed from the Hedera version, and what didn't
 *
 * The mechanism is completely different and the guarantee is identical.
 *
 * On Hedera the buyer built a native protobuf `TransferTransaction`, signed it,
 * and handed over a *partially signed transaction* for the facilitator to
 * counter-sign as fee payer. On Monad the buyer signs an **EIP-3009
 * authorization** — an EIP-712 typed-data message, not a transaction — and the
 * facilitator calls `transferWithAuthorization` on the AUSD (or USDC) contract.
 * The buyer's bytes are never a transaction and never touch the mempool.
 *
 * Both end in the same place: the buyer needs no gas token, and the money moves
 * buyer → provider directly with no escrow in between.
 *
 * The consequence for this file is that there is **no Xorv-specific scheme
 * code**. Hedera needed a bespoke signer that built a fresh SDK client per
 * settlement, because submitting a transaction frozen by someone else's client
 * corrupted the submitting client's internal state and every payment after the
 * first came back as a bare 402. An EVM chain needs `registerExactEvmScheme`
 * and a viem client. The stock scheme settles as-is.
 */

import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentOption } from "@x402/core/http";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { getAddress, type PublicClient, type WalletClient } from "viem";
import type { x402Client } from "@x402/core/client";
import { registerExactEvmScheme as registerExactClientScheme } from "@x402/evm/exact/client";
import type { ClientEvmSigner } from "@x402/evm";
import { EscrowClientScheme, EscrowFacilitatorScheme, ESCROW_SCHEME } from "./escrow.js";
import {
  QUOTE_TTL_SECONDS,
  XORV_SCHEME,
  stablecoinByAddress,
  stablecoins,
  type StablecoinInfo,
} from "./constants.js";
import { readClient, writeClient } from "./chain.js";
import { usdMicrosToUnits } from "./money.js";

/**
 * A hosted x402 facilitator, kept as a named fallback so switching is a
 * one-word config change. The public facilitator does not know AUSD, which is
 * part of why Xorv runs its own.
 */
export const PUBLIC_FACILITATOR_URL = "https://x402.org/facilitator";

/**
 * Compose the signer the EVM scheme wants.
 *
 * Built by hand rather than spread from the viem clients because the surface
 * spans both of them — reads and a typed-data check come from the public
 * client, writes from the wallet — and `writeContract`/`sendTransaction` must
 * stay bound to the client that actually holds the account. Spreading two viem
 * clients into one object happens to work today and breaks silently the moment
 * either changes how its actions are attached.
 */
export function facilitatorSigner(opts: {
  address: string;
  wallet: WalletClient;
  public: PublicClient;
}) {
  return toFacilitatorEvmSigner({
    address: getAddress(opts.address),
    readContract: (args) => opts.public.readContract(args as never) as Promise<unknown>,
    verifyTypedData: (args) => opts.public.verifyTypedData(args as never),
    getCode: (args) => opts.public.getCode(args as never),
    waitForTransactionReceipt: (args) =>
      opts.public.waitForTransactionReceipt(args as never) as never,
    writeContract: (args) => opts.wallet.writeContract(args as never),
    sendTransaction: (args) => opts.wallet.sendTransaction(args as never),
  });
}

/**
 * An in-process facilitator backed by the operator's own account (which holds the MON for gas).
 *
 * `x402Facilitator` implements the same `FacilitatorClient` surface the HTTP
 * client does, so the resource server cannot tell the difference — which is the
 * point: self-hosted and hosted are a config flag, not two code paths.
 */
export function buildLocalFacilitator(opts: {
  network: string;
  feePayerAddress: string;
  feePayerKey: string;
  /** XorvEscrow address. When set, the `escrow` scheme is served too; the key must be its attester. */
  escrow?: string | null;
  /** Called around each escrow write, so background RPC readers can back off. */
  onWrite?: (phase: "start" | "end") => void;
}): FacilitatorClient {
  const publicClient = readClient(opts.network);
  const wallet = writeClient(opts.network, opts.feePayerKey);

  const facilitator = new x402Facilitator();
  registerExactEvmScheme(facilitator, {
    signer: facilitatorSigner({
      address: opts.feePayerAddress,
      wallet,
      public: publicClient,
    }),
    // Not optional, and it fails confusingly when omitted: scheme routing is
    // derived from this set, and the `eip155:*` wildcard is only synthesised
    // when two or more networks share a namespace. With it missing, verify()
    // throws from inside a regex helper rather than saying what is unconfigured.
    networks: [opts.network as Network],
  });
  if (opts.escrow) {
    facilitator.register(
      [opts.network as Network],
      new EscrowFacilitatorScheme(
        { public: publicClient, wallet },
        { escrow: getAddress(opts.escrow), onWrite: opts.onWrite },
      ),
    );
  }

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
 * of a hosted facilitator, with `hosted` as shorthand for the public one.
 */
export function buildFacilitator(opts: {
  mode: string;
  network: string;
  feePayerAddress: string;
  feePayerKey: string;
  escrow?: string | null;
  onWrite?: (phase: "start" | "end") => void;
}): { facilitator: FacilitatorClient; description: string; feePayer: string } {
  const mode = (opts.mode || "self").trim();
  if (mode === "self") {
    return {
      facilitator: buildLocalFacilitator(opts),
      description: "self-hosted (in-process)",
      feePayer: opts.feePayerAddress,
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
 * The `accepts` array for a priced resource: one option per stablecoin.
 *
 * Every option carries the same amount — all of them are 6-decimal dollar
 * stablecoins — and they are ordered as configured, AUSD first. A stock x402
 * client pays the first option it supports, so AUSD is the default and USDC is
 * there for a buyer who holds only that.
 *
 * `payTo` is a resolver rather than a fixed string because Xorv pays the
 * matched **provider** directly — the broker never takes custody of a job's
 * money, it only introduces the two parties and witnesses the result.
 *
 * `extra` carries each token's EIP-712 domain from the network table. It is
 * not optional and it is not guessable: an EIP-3009 signature is made over
 * `(name, version, chainId, verifyingContract)`, x402 fills these in only for
 * tokens in its own registry, and a wrong `version` yields a signature that
 * verifies against nothing, reported as an opaque failure.
 */
export function paymentOptionsFor(opts: {
  network: string;
  priceUsdMicros: number;
  payTo: PaymentOption["payTo"];
  /** Defaults to the network's configured stablecoins. */
  tokens?: StablecoinInfo[];
  maxTimeoutSeconds?: number;
}): PaymentOption[] {
  const tokens = opts.tokens ?? stablecoins(opts.network);
  return tokens.map(
    (token) =>
      ({
        scheme: XORV_SCHEME,
        network: opts.network as Network,
        payTo: opts.payTo,
        price: {
          asset: token.address,
          amount: usdMicrosToUnits(opts.priceUsdMicros),
          extra: { name: token.eip712.name, version: token.eip712.version },
        },
        maxTimeoutSeconds: opts.maxTimeoutSeconds ?? QUOTE_TTL_SECONDS,
      }) as PaymentOption,
  );
}

/**
 * The symbol of the asset a settled payment used, for display and receipts.
 *
 * "AUSD" or "USDC" for a configured token; a token the table doesn't know
 * reads as "stablecoin" rather than being mislabelled as either.
 */
export function assetSymbol(network: string, assetId: string): string {
  return stablecoinByAddress(network, assetId)?.symbol ?? "stablecoin";
}

/** One payable option, as a buyer sees it after the quote. */
export interface AssetOption {
  asset: string;
  amount: string;
  symbol?: string;
}

/**
 * Which of the offered stablecoins a buyer should pay with.
 *
 * - `preferred` (a symbol or an address, e.g. from `--token USDC`) wins if it
 *   is offered at all — the buyer asked for it; an unfunded choice fails at
 *   verification with a clear reason rather than being silently swapped.
 * - Otherwise the first offered option the buyer can afford, in the broker's
 *   order (AUSD first).
 * - Otherwise the first option, so the payment fails with the facilitator's
 *   "insufficient funds" rather than this function inventing an error.
 *
 * `balances` maps a lowercase token address to its balance in smallest units;
 * a token missing from it is treated as unknown and therefore payable.
 *
 * Returns null only when `preferred` names a token the broker does not offer.
 */
export function choosePaymentAsset<T extends AssetOption>(
  accepts: readonly T[],
  opts: { balances?: Record<string, string | bigint>; preferred?: string | null } = {},
): T | null {
  if (accepts.length === 0) return null;
  const preferred = opts.preferred?.trim().toLowerCase();
  if (preferred) {
    return (
      accepts.find(
        (a) => a.asset.toLowerCase() === preferred || a.symbol?.toLowerCase() === preferred,
      ) ?? null
    );
  }
  const balances = opts.balances ?? {};
  const affordable = accepts.find((a) => {
    const held = balances[a.asset.toLowerCase()];
    return held === undefined || BigInt(held) >= BigInt(a.amount);
  });
  return affordable ?? accepts[0]!;
}

/**
 * An x402 client policy that narrows a 402's `accepts` to one asset.
 *
 * Registered with `client.registerPolicy(onlyAssetPolicy(chosen.asset))` after
 * `choosePaymentAsset`, so the stock client signs for the stablecoin the buyer
 * picked instead of blindly taking the first option. If the asset is somehow
 * absent from a later 402 the list is left untouched rather than emptied,
 * which would fail a request the server was willing to serve.
 */
export function onlyAssetPolicy(asset: string) {
  const target = asset.toLowerCase();
  return <R extends { asset: string }>(_version: number, requirements: R[]): R[] => {
    const narrowed = requirements.filter((r) => r.asset.toLowerCase() === target);
    return narrowed.length > 0 ? narrowed : requirements;
  };
}

/**
 * Register every payment scheme a Xorv buyer speaks on an x402 client: the
 * `escrow` scheme (money waits in XorvEscrow until the job is delivered) and
 * the stock `exact` scheme (money goes straight to the provider).
 *
 * The broker lists escrow options first, and the client pays the first option
 * it supports, so a Xorv buyer is protected by escrow whenever the broker
 * offers it and still able to pay one that doesn't.
 */
export function registerXorvPaymentSchemes(client: x402Client, signer: ClientEvmSigner): x402Client {
  registerExactClientScheme(client, { signer });
  client.register("eip155:*" as Network, new EscrowClientScheme(signer as never));
  return client;
}

/** True when a settled payment went into escrow rather than straight to the provider. */
export function isEscrowPayment(requirements: { scheme: string }): boolean {
  return requirements.scheme === ESCROW_SCHEME;
}

