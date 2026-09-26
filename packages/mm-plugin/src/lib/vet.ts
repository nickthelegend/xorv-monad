/**
 * Everything that must be true of a quote before the wallet is asked to sign.
 *
 * On EVM a signed EIP-3009 authorization is directly spendable by whoever
 * holds it, so the checks happen here, in the buyer's process, rather than
 * being trusted to the broker:
 *
 *  - the quote is on a chain the plugin targets (and the one `--chain-id` pins);
 *  - the price is at or under the buyer's `--max`;
 *  - the frozen USDC amount is exactly the quoted price, and the advertised
 *    `accepts` row asks for exactly that, to exactly the quoted provider;
 *  - the provider is not the buyer (a self-payment would mint a "paid job"
 *    receipt, and reputation, for the price of the facilitator's gas).
 *
 * The 402 itself is then held to the same terms by `quoteMatchPolicy`
 * (`@xorv/protocol`), so a broker cannot swap the payee between quote and
 * payment either. Pure, so every refusal is unit-tested.
 */

import {
  XORV_SCHEME,
  formatUsd,
  isEvmAddress,
  networkConfig,
  sameAddress,
  usdMicrosToUsdcUnits,
  type NetworkConfig,
  type QuoteResponse,
} from "@xorv/protocol";
import { TARGET_CHAIN_IDS, networkName, targetChainIdOf } from "./config.js";
import { XorvPluginError } from "./errors.js";

export interface VettedQuote {
  quote: QuoteResponse;
  network: string;
  chainId: number;
  config: NetworkConfig;
}

export function vetQuote(
  quote: QuoteResponse,
  opts: { maxPriceUsdMicros: number; chainId?: number | null; payer?: string | null; now?: number },
): VettedQuote {
  const chainId = targetChainIdOf(quote.network);
  if (chainId === null) {
    throw new XorvPluginError(
      "XORV_UNSUPPORTED_NETWORK",
      `the broker quotes on ${quote.network || "an unnamed network"}, which this plugin does not sign for`,
      `mm xorv only pays on Monad (chain ${TARGET_CHAIN_IDS.join(" or ")}); point --broker at a Monad broker.`,
    );
  }
  if (opts.chainId && opts.chainId !== chainId) {
    throw new XorvPluginError(
      "XORV_UNSUPPORTED_NETWORK",
      `the broker quotes on ${networkName(quote.network)} (chain ${chainId}) but --chain-id is ${opts.chainId}`,
      "Drop --chain-id, or point --broker at a broker on the chain you meant.",
    );
  }
  const config = networkConfig(quote.network);

  if (!Number.isFinite(quote.priceUsdMicros) || quote.priceUsdMicros <= 0) {
    throw refusal(`the quote carries no usable price (${String(quote.priceUsdMicros)})`);
  }
  if (quote.priceUsdMicros > opts.maxPriceUsdMicros) {
    // The broker was asked for quotes under the ceiling; enforcing it here too
    // means a broker that ignores the request still cannot overcharge.
    throw new XorvPluginError(
      "XORV_QUOTE_REFUSED",
      `quoted ${formatUsd(quote.priceUsdMicros)}, above your --max of ${formatUsd(opts.maxPriceUsdMicros)}`,
      "Raise --max if that price is acceptable.",
    );
  }
  if (!/^\d+$/.test(quote.usdcAmount ?? "")) {
    throw refusal("the quote carries no USDC amount — refusing to sign an open-ended payment");
  }
  const expected = usdMicrosToUsdcUnits(quote.priceUsdMicros);
  if (BigInt(quote.usdcAmount) !== BigInt(expected)) {
    throw refusal(`the quote says ${quote.priceLabel} but freezes ${quote.usdcAmount} USDC units (expected ${expected})`);
  }
  const payTo = quote.provider?.address;
  if (!payTo || !isEvmAddress(payTo)) {
    throw refusal("the quote names no provider address to pay");
  }
  if (Array.isArray(quote.accepts) && quote.accepts.length > 0) {
    const matching = quote.accepts.some(
      (row) =>
        row.scheme === XORV_SCHEME &&
        row.network === config.caip2 &&
        sameAddress(row.asset, config.usdc.address) &&
        sameAddress(row.payTo, payTo) &&
        /^\d+$/.test(row.amount) &&
        BigInt(row.amount) === BigInt(quote.usdcAmount),
    );
    if (!matching) {
      throw refusal(
        `the quote's payment terms do not match its own provider and price (expected ${quote.usdcAmount} ` +
          `${config.usdc.symbol} units to ${payTo} on ${config.caip2})`,
      );
    }
  }
  if (opts.payer && sameAddress(opts.payer, payTo)) {
    throw new XorvPluginError(
      "XORV_QUOTE_REFUSED",
      `the quoted provider is your own address (${payTo}) — you cannot pay yourself`,
      "Buy from a different wallet than the one your provider node is paid at.",
    );
  }
  const now = opts.now ?? Date.now();
  if (Number.isFinite(quote.expiresAt) && quote.expiresAt <= now) {
    throw new XorvPluginError("XORV_QUOTE_REFUSED", "the quote has already expired", "Request a new quote.");
  }
  return { quote, network: config.caip2, chainId, config };
}

function refusal(message: string): XorvPluginError {
  return new XorvPluginError(
    "XORV_QUOTE_REFUSED",
    `${message} — refusing to sign`,
    "This is a broker fault; nothing was signed or paid. Try again or use a different broker.",
  );
}
