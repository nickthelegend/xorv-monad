/**
 * The browser-safe half of Xorv's x402 wiring: what a 402 offers, and what a
 * buyer is willing to sign.
 *
 * On Monad a payment is an EIP-3009 `transferWithAuthorization` over USDC: the
 * buyer signs an EIP-712 message offline, the facilitator submits it and pays
 * the MON gas, and the USDC moves buyer → provider in one transfer. The buyer
 * holds nothing but USDC, and the broker never touches the money.
 *
 * Everything here runs unchanged in a Privy embedded wallet in the browser, in
 * the CLI and in the MCP server — no node built-ins, no facilitator code (that
 * lives in `x402.ts`, which the web entry does not export).
 */

import { ESCROW_SCHEME, EscrowClientScheme, type EscrowClientSigner } from "./escrow.js";
import { x402Client, type PaymentPolicy } from "@x402/core/client";
import type { DynamicPayTo, HTTPRequestContext, PaymentOption } from "@x402/core/http";
import type { AssetAmount, Network, PaymentRequirements } from "@x402/core/types";
import type { ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { networkConfig, type NetworkConfig } from "./chains.js";
import { QUOTE_TTL_SECONDS, XORV_SCHEME } from "./constants.js";
import { isEvmAddress, normalizeAddress, sameAddress } from "./evm.js";

/** An amount in USDC's smallest unit, as the integer string x402 carries. */
function unitsString(value: string | bigint | number, what: string): string {
  const text = typeof value === "string" ? value.trim() : String(value);
  if (!/^\d+$/.test(text)) throw new Error(`${what} must be a non-negative integer amount of smallest units, got "${String(value)}"`);
  return BigInt(text).toString();
}

/**
 * The network's stablecoin as an x402 `AssetAmount`, EIP-712 domain included.
 *
 * `extra: { name, version }` is not optional decoration. The x402 server does
 * not fill it in for an explicit asset, the buyer's client refuses to sign
 * without it, and a wrong value ("USD Coin" instead of Monad's "USDC") makes
 * every signature invalid — a bare 402 with no obvious cause.
 */
export function usdcAssetAmount(network: string, amount: string | bigint): AssetAmount {
  const { usdc } = networkConfig(network);
  return {
    asset: usdc.address,
    amount: unitsString(amount, "amount"),
    extra: { name: usdc.name, version: usdc.version },
  };
}

/**
 * The one `accepts` row a priced Xorv resource offers: pay exactly `amount`
 * USDC to `payTo`.
 *
 * `payTo` is the matched **provider** — Xorv never takes custody of a job's
 * money, it only introduces the two parties and witnesses the result. Both
 * `payTo` and `amount` may be resolvers over the request, which is how the
 * broker reads them off the frozen quote named in the URL; a resolved payTo is
 * checksummed on the way out.
 *
 * `maxTimeoutSeconds` defaults to the quote TTL, and becomes the EIP-3009
 * `validBefore` window the buyer signs.
 */
export function usdcPaymentOption(opts: {
  network: string;
  payTo: string | DynamicPayTo;
  amount: string | bigint | ((context: HTTPRequestContext) => string | Promise<string>);
  maxTimeoutSeconds?: number;
}): PaymentOption {
  const cfg = networkConfig(opts.network);
  const payTo: string | DynamicPayTo =
    typeof opts.payTo === "string"
      ? normalizeAddress(opts.payTo)
      : async (context) => {
          const resolved = await (opts.payTo as DynamicPayTo)(context);
          // An unresolvable quote yields "" — pass it through untouched so the
          // 402 still renders; only real addresses get checksummed.
          return isEvmAddress(resolved) ? normalizeAddress(resolved) : resolved;
        };
  const amount = opts.amount;
  const price =
    typeof amount === "function"
      ? async (context: HTTPRequestContext) => usdcAssetAmount(cfg.caip2, await amount(context))
      : usdcAssetAmount(cfg.caip2, amount);
  return {
    scheme: XORV_SCHEME,
    network: cfg.caip2 as Network,
    payTo,
    price,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? QUOTE_TTL_SECONDS,
  };
}

/** The escrow terms a quote froze: which job id and refund deadline the money is bound to, for whom. */
export interface EscrowTerms {
  jobId: string;
  /** Unix seconds; after this anyone may refund the buyer. */
  deadline: number;
  /** The provider the escrow will release to. */
  provider: string;
}

/**
 * The `escrow` row: the same USDC amount, paid into XorvEscrow rather than to
 * the provider, with the job id, refund deadline and provider in `extra`. The
 * buyer's ReceiveWithAuthorization nonce is derived from the job id and the
 * deadline, so the signature can only ever fund that one job.
 */
export function escrowPaymentOption(opts: {
  network: string;
  escrow: string;
  amount: (context: HTTPRequestContext) => string | Promise<string>;
  terms: (context: HTTPRequestContext) => EscrowTerms | null | Promise<EscrowTerms | null>;
  maxTimeoutSeconds?: number;
}): PaymentOption {
  const cfg = networkConfig(opts.network);
  const escrow = normalizeAddress(opts.escrow);
  return {
    scheme: ESCROW_SCHEME,
    network: cfg.caip2 as Network,
    payTo: escrow,
    price: async (context: HTTPRequestContext) => {
      const base = usdcAssetAmount(cfg.caip2, await opts.amount(context));
      const terms = await opts.terms(context);
      return {
        ...base,
        extra: {
          ...base.extra,
          escrow,
          // An unresolvable quote renders a 402 nobody can pay, like exact's "".
          jobId: terms?.jobId ?? "0x",
          deadline: terms?.deadline ?? 0,
          provider: terms ? normalizeAddress(terms.provider) : "",
        },
      };
    },
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? QUOTE_TTL_SECONDS,
  };
}

/** What a buyer expects a 402 to ask for: the frozen quote it was shown. */
export interface QuoteExpectation {
  payTo: string;
  /** USDC smallest units — the quote's `usdcAmount`. */
  amount: string | bigint;
  /** Defaults to the client's network. */
  network?: string;
  /** Defaults to the network's USDC. */
  asset?: string;
  /**
   * The XorvEscrow contract the quote named, when the broker escrows payments.
   * An `escrow` option is signed only if it pays exactly this contract and its
   * `extra.provider` is `payTo`; without it, escrow options are refused and the
   * client pays `exact` as before.
   */
  escrow?: string | null;
}

function describeRequirements(reqs: PaymentRequirements[]): string {
  return reqs
    .map((r) => `{scheme=${r.scheme} network=${r.network} asset=${r.asset} amount=${r.amount} payTo=${r.payTo}}`)
    .join(", ");
}

/**
 * Keep only `exact` USDC requirements on the client's network.
 *
 * Throws (rather than returning an empty list) so the error names what the
 * server offered — "filtered out by policies" is not something anyone can act on.
 */
export function usdcOnlyPolicy(network: string): PaymentPolicy {
  const cfg: NetworkConfig = networkConfig(network);
  return (_version, reqs) => {
    const kept = reqs.filter(
      (r) =>
        (r.scheme === XORV_SCHEME || r.scheme === ESCROW_SCHEME) &&
        r.network === cfg.caip2 &&
        sameAddress(r.asset, cfg.usdc.address),
    );
    if (kept.length === 0) {
      throw new Error(
        `the 402 offers no exact-USDC payment on ${cfg.caip2} (${cfg.usdc.address}); it offered ${describeRequirements(reqs)}`,
      );
    }
    return kept;
  };
}

/**
 * Keep only requirements that match the frozen quote exactly: same payee, same
 * amount, same network, same asset.
 *
 * This is the buyer's half of "a quote is a price commitment". Without it a
 * client pays whatever the 402 says, up to its spend cap — so a broker bug (or
 * a compromised one) that swaps the payee or bumps the price between quote and
 * payment would be signed without a second look. With it, a mismatch is an
 * error that says exactly what differed.
 */
export function quoteMatchPolicy(expect: QuoteExpectation, network: string): PaymentPolicy {
  const cfg = networkConfig(network);
  const wantNetwork = expect.network ?? cfg.caip2;
  const wantAsset = expect.asset ?? cfg.usdc.address;
  const wantAmount = unitsString(expect.amount, "expected amount");
  const wantPayTo = normalizeAddress(expect.payTo);
  const wantEscrow = expect.escrow ? normalizeAddress(expect.escrow) : null;
  // Exact pays the provider directly; escrow pays the quoted contract, naming
  // the provider it will release to. Anything else differs from the quote.
  const payeeMatches = (r: PaymentRequirements): boolean => {
    if (r.scheme !== ESCROW_SCHEME) return sameAddress(r.payTo, wantPayTo);
    const extra = (r.extra ?? {}) as { escrow?: unknown; provider?: unknown };
    return (
      wantEscrow !== null &&
      sameAddress(r.payTo, wantEscrow) &&
      typeof extra.escrow === "string" &&
      sameAddress(extra.escrow, wantEscrow) &&
      typeof extra.provider === "string" &&
      sameAddress(extra.provider, wantPayTo)
    );
  };
  return (_version, reqs) => {
    const kept = reqs.filter(
      (r) =>
        r.network === wantNetwork &&
        sameAddress(r.asset, wantAsset) &&
        payeeMatches(r) &&
        /^\d+$/.test(r.amount) &&
        BigInt(r.amount) === BigInt(wantAmount),
    );
    if (kept.length === 0) {
      throw new Error(
        `the 402 does not match the quote (expected payTo=${wantPayTo} amount=${wantAmount} ` +
          `asset=${wantAsset} network=${wantNetwork}); it offered ${describeRequirements(reqs)} — refusing to sign`,
      );
    }
    return kept;
  };
}

/**
 * An x402 client that will pay Xorv jobs, and nothing else.
 *
 *  - `ExactEvmScheme` registered for exactly one network — the client cannot be
 *    talked into signing for another chain.
 *  - Spend controls with an explicit per-payment cap in USDC units. They are
 *    also *required* on testnet: since x402 2.23 a client only pays assets it
 *    recognises by default, and Monad-testnet USDC is not in `@x402/evm`'s
 *    default table, so without an `allowedAssets` entry every payment fails
 *    with a spend-controls error. (On mainnet USDC *is* a default asset, where
 *    the per-asset cap here overrides the library's $1 default.)
 *  - A USDC-only policy, and — when `expect` is given — a policy that refuses
 *    anything but the frozen quote.
 *
 * `signer` is anything with `address` + `signTypedData`: a viem local account,
 * or `toClientEvmSigner(...)` over a Privy / MetaMask wallet client.
 */
export function buyerX402Client(opts: {
  signer: ClientEvmSigner;
  network: string;
  maxUsdcUnits: string | bigint | number;
  expect?: QuoteExpectation | null;
}): x402Client {
  const cfg = networkConfig(opts.network);
  const cap = unitsString(opts.maxUsdcUnits, "maxUsdcUnits");
  if (BigInt(cap) === 0n) throw new Error("maxUsdcUnits must be greater than zero");

  const client = new x402Client()
    .register(cfg.caip2 as Network, new ExactEvmScheme(opts.signer))
    // Escrow first when the broker offers it (it lists it first): the money
    // waits in XorvEscrow until the job delivers, refundable if it doesn't.
    .register(cfg.caip2 as Network, new EscrowClientScheme(opts.signer as EscrowClientSigner))
    .setSpendControls({
      allowedAssets: [{ network: cfg.caip2 as Network, asset: cfg.usdc.address, maxAmountPerPayment: cap }],
    })
    .registerPolicy(usdcOnlyPolicy(cfg.caip2));
  if (opts.expect) client.registerPolicy(quoteMatchPolicy(opts.expect, cfg.caip2));
  return client;
}
