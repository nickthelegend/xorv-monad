/**
 * The broker as a paying customer of Nansen: one agent buying wallet
 * intelligence from another, per call, in USDC over x402 on Monad.
 *
 * Nansen's API answers an unauthenticated POST with an x402 v2 `402`. Its
 * `accepts` list has eight rows (Base, X Layer, four BNB stablecoins, Solana
 * and Monad); the Monad row is `exact` USDC on **mainnet** (`eip155:143`),
 * $0.01 for a basic profiler call and $0.05 for smart-money data. There is no
 * Monad testnet row, so this client pays on mainnet whatever network the rest
 * of the broker runs on. That is also why nothing here comes from
 * `networkConfig()`: `XORV_STABLECOIN` overrides the asset for both networks,
 * and a testnet test-token override must never reach a real payment.
 *
 * What stands between a 402 and a signature, in order:
 *
 *  1. The request is validated locally. Nansen returns its 402 *before* it
 *     validates the body (a bad chain and an empty `{}` both get one), so a
 *     malformed request would be paid for and then refused.
 *  2. Only `exact` on `eip155:143` is registered, so the other seven rows are
 *     never selectable, and a policy keeps only Circle USDC (and, when
 *     pinned, only Nansen's observed `payTo`).
 *  3. Spend controls cap every payment at the per-call cap.
 *  4. `onBeforePaymentCreation` checks the price against a per-endpoint
 *     table and reserves it against the daily budget. A price rise aborts.
 *  5. A reservation is released when signing fails, when the facilitator
 *     refuses the payment or when settlement fails. A paid call that fails
 *     some other way keeps its reservation: whether Nansen charges for it is
 *     not documented, so the budget assumes it did.
 *
 * Around that: a TTL cache (Nansen data is slow-moving, and its terms ask for
 * short retention), request de-duplication so concurrent callers never pay
 * twice, a concurrency limit of two (a 402 plus its paid retry is two
 * requests against a 5/s, 60/min per-wallet limit), and a cool-down after a
 * 429. An `apikey` takes precedence when configured: Nansen then bills
 * credits and no payment happens.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { Network, PaymentRequired } from "@x402/core/types";
import type { ClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";

// ---------------------------------------------------------------------------
// Facts (captured from unpaid 402s on 2026-09-26)
// ---------------------------------------------------------------------------

export const NANSEN_BASE_URL = "https://api.nansen.ai";
/** Nansen settles on Monad mainnet only. Deliberately not `XORV_NETWORK`. */
export const NANSEN_PAY_NETWORK = "eip155:143" as const;
/** Circle USDC on Monad mainnet, hard-coded so no stablecoin override can leak in. */
export const MONAD_MAINNET_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
/** The Monad `payTo` every probed endpoint named. Opt-in pin: refuse a swapped payee. */
export const NANSEN_OBSERVED_PAY_TO = "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f";
/** Paid-call links go to the mainnet explorer, not the one the broker is configured with. */
export const MONAD_MAINNET_EXPLORER = "https://monadvision.com";
export const NANSEN_ATTRIBUTION = "Powered by Nansen";
export const NANSEN_ATTRIBUTION_URL = "https://nansen.ai";

export const NANSEN_PATHS = {
  firstFunder: "/api/v1/profiler/address/first-funder",
  relatedWallets: "/api/v1/profiler/address/related-wallets",
  transactions: "/api/v1/profiler/address/transactions",
  smartMoney: "/api/v1/smart-money/pnl-leaderboard",
} as const;

export type NansenPath = (typeof NANSEN_PATHS)[keyof typeof NANSEN_PATHS];

/**
 * The most each endpoint may cost, in USDC units (6 dp), from each operation's
 * `x-payment-info` in Nansen's OpenAPI. A 402 above this is refused, and a
 * 402 for a path not listed here is refused outright.
 */
export const NANSEN_PRICE_UNITS: Record<NansenPath, bigint> = {
  [NANSEN_PATHS.firstFunder]: 10_000n,
  [NANSEN_PATHS.relatedWallets]: 10_000n,
  [NANSEN_PATHS.transactions]: 10_000n,
  [NANSEN_PATHS.smartMoney]: 50_000n,
};

/**
 * How long an answer is reused. A first funder is a historical fact; related
 * wallets move slowly; activity is kept for an hour. Short on purpose: the
 * API terms forbid keeping copies longer than the documentation allows.
 */
export const NANSEN_TTL_MS: Record<NansenPath, number> = {
  [NANSEN_PATHS.firstFunder]: 7 * 86_400_000,
  [NANSEN_PATHS.relatedWallets]: 86_400_000,
  [NANSEN_PATHS.transactions]: 3_600_000,
  [NANSEN_PATHS.smartMoney]: 86_400_000,
};

export const DEFAULT_PER_CALL_CAP_UNITS = 50_000n;
export const DEFAULT_DAILY_CAP_UNITS = 1_000_000n;
/** Transactions window. Nansen allows at most a year per request. */
export const DEFAULT_LOOKBACK_DAYS = 90;
/** One page of activity is enough for a signal; the endpoint caps pages at 100. */
export const TRANSACTIONS_PAGE = 100;
export const RELATED_WALLETS_PAGE = 100;
export const SMART_MONEY_PAGE = 1_000;

/** EVM chains a profiler request may name (the subset of Nansen's enum we would ever ask for). */
const PROFILER_CHAINS = new Set(["monad", "ethereum", "base", "arbitrum", "optimism", "polygon", "bnb", "avalanche", "linea"]);
const SM_TIMEFRAMES = new Set([1, 7, 30, 90, 180]);

// ---------------------------------------------------------------------------
// Response shapes (openapi.json, trimmed to the fields we read)
// ---------------------------------------------------------------------------

export interface NansenPagination {
  page?: number;
  per_page?: number;
  is_last_page?: boolean;
}

export interface FirstFunderRow {
  wallet_address: string;
  first_funder_address: string;
  first_funder_name?: string | null;
  transaction_hash: string;
  block_timestamp: string;
  chain: string;
}

export interface RelatedWalletRow {
  address: string;
  address_label?: string | null;
  relation: string;
  transaction_hash: string;
  block_timestamp: string;
  order: number;
  chain: string;
}

export interface TokenLeg {
  token_symbol?: string;
  token_amount?: number;
  token_address?: string;
  value_usd?: number | null;
  chain?: string;
  from_address: string;
  to_address: string;
  from_address_label?: string | null;
  to_address_label?: string | null;
}

export interface TransactionRow {
  chain: string;
  method: string;
  block_timestamp: string;
  transaction_hash: string;
  source_type: string;
  volume_usd?: number | null;
  tokens_sent?: TokenLeg[] | null;
  tokens_received?: TokenLeg[] | null;
}

export interface SmartMoneyRow {
  address: string;
  address_label?: string | null;
  total_pnl_usd?: number;
}

export interface NansenPage<T> {
  pagination: NansenPagination;
  data: T[];
}

export type FirstFunderResponse = NansenPage<FirstFunderRow>;
export type RelatedWalletsResponse = NansenPage<RelatedWalletRow>;
export type TransactionsResponse = NansenPage<TransactionRow>;
export type SmartMoneyResponse = NansenPage<SmartMoneyRow>;

// ---------------------------------------------------------------------------
// Client types
// ---------------------------------------------------------------------------

export type NansenMode = "off" | "fixture" | "live";

/** One call Xorv paid Nansen for, as settled on Monad mainnet. */
export interface PaidCall {
  txHash: string;
  url: string;
  endpoint: NansenPath;
  amountUnits: string;
  network: string;
  at: number;
}

export type CallResult<T> =
  | { ok: true; data: T; paid: PaidCall | null; cached: boolean }
  | { ok: false; error: string };

/** Deterministic stand-in for Nansen in `fixture` mode (see fixtures.ts). */
export type NansenFixtureSource = (path: NansenPath, body: Record<string, unknown>) => unknown | null;

export interface NansenClientOptions {
  mode: NansenMode;
  /** Sent as `apikey`; Nansen then bills credits and x402 never triggers. */
  apiKey?: string | null;
  /** Signs the EIP-3009 authorizations. A viem local account holding MAINNET USDC. */
  signer?: ClientEvmSigner | null;
  perCallCapUnits?: bigint;
  dailyCapUnits?: bigint;
  /** Refuse any payee but this one (e.g. NANSEN_OBSERVED_PAY_TO). */
  pinPayTo?: string | null;
  fixtures?: NansenFixtureSource | null;
  fetch?: typeof fetch;
  /** Per request (the 402 and the paid retry each get their own). */
  timeoutMs?: number;
  lookbackDays?: number;
  /** At most 2: the per-wallet limit counts the 402 and the paid retry. */
  maxConcurrency?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface NansenUsage {
  day: string;
  /** Answers Nansen (or a fixture) served today, cache hits excluded. */
  calls: number;
  paidCalls: number;
  /** Reserved or settled today, USDC units. */
  spentUnits: bigint;
  failures: number;
  lastError: string | null;
  recentPaid: PaidCall[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const lc = (value: string) => value.toLowerCase();
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** USDC units → "0.03" (at least two decimals, no trailing noise). */
export function usdcString(units: bigint | string | number): string {
  const value = BigInt(units);
  const whole = value / 1_000_000n;
  const frac = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

export function mainnetTxUrl(txHash: string): string {
  return `${MONAD_MAINNET_EXPLORER}/tx/${txHash}`;
}

export function mainnetAddressUrl(address: string): string {
  return `${MONAD_MAINNET_EXPLORER}/address/${address}`;
}

function pagination(value: unknown, maxPerPage: number): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return "pagination must be an object";
  const page = value.page ?? 1;
  const perPage = value.per_page ?? 10;
  if (!Number.isInteger(page) || (page as number) < 1) return "pagination.page must be a positive integer";
  if (!Number.isInteger(perPage) || (perPage as number) < 1 || (perPage as number) > maxPerPage) {
    return `pagination.per_page must be 1..${maxPerPage}`;
  }
  return null;
}

/**
 * Check a request body before it can cost anything.
 *
 * Nansen's 402 comes back before its own validation runs, so every rule the
 * API would enforce afterwards is enforced here first: address shape, the
 * chain enum, page sizes, the one-year date window, the timeframe enum.
 * Returns the first problem, or null.
 */
export function validateNansenRequest(path: string, body: unknown): string | null {
  if (!isRecord(body)) return "body must be a JSON object";
  switch (path) {
    case NANSEN_PATHS.firstFunder: {
      if (typeof body.address !== "string" || !EVM_ADDRESS.test(body.address)) return "address must be an EVM address";
      if (body.chain !== "all") return 'first-funder only accepts chain "all"';
      return null;
    }
    case NANSEN_PATHS.relatedWallets: {
      if (typeof body.wallet_address !== "string" || !EVM_ADDRESS.test(body.wallet_address)) {
        return "wallet_address must be an EVM address";
      }
      if (typeof body.chain !== "string" || !PROFILER_CHAINS.has(body.chain)) return `unsupported chain ${String(body.chain)}`;
      return pagination(body.pagination, 1_000);
    }
    case NANSEN_PATHS.transactions: {
      if (typeof body.address !== "string" || !EVM_ADDRESS.test(body.address)) return "address must be an EVM address";
      if (typeof body.chain !== "string" || !PROFILER_CHAINS.has(body.chain)) return `unsupported chain ${String(body.chain)}`;
      const date = body.date;
      if (!isRecord(date) || typeof date.from !== "string" || typeof date.to !== "string") {
        return "date {from, to} is required";
      }
      if (!ISO_DAY.test(date.from) || !ISO_DAY.test(date.to)) return "date.from and date.to must be YYYY-MM-DD";
      const from = Date.parse(`${date.from}T00:00:00Z`);
      const to = Date.parse(`${date.to}T00:00:00Z`);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return "date is not a real calendar day";
      if (from > to) return "date.from is after date.to";
      if (to - from > 366 * 86_400_000) return "date range must be at most one year";
      if (body.hide_spam_token !== undefined && typeof body.hide_spam_token !== "boolean") {
        return "hide_spam_token must be a boolean";
      }
      if (body.order_by !== undefined) {
        if (!Array.isArray(body.order_by)) return "order_by must be an array";
        for (const o of body.order_by) {
          if (!isRecord(o) || o.field !== "block_timestamp" || (o.direction !== "ASC" && o.direction !== "DESC")) {
            return "order_by only supports block_timestamp ASC|DESC";
          }
        }
      }
      return pagination(body.pagination, TRANSACTIONS_PAGE);
    }
    case NANSEN_PATHS.smartMoney: {
      if (!Array.isArray(body.chains) || body.chains.length === 0 || body.chains.some((c) => c !== "monad")) {
        return 'chains must be ["monad"]';
      }
      if (body.timeframe !== undefined && !SM_TIMEFRAMES.has(body.timeframe as number)) {
        return "timeframe must be 1, 7, 30, 90 or 180";
      }
      return pagination(body.pagination, SMART_MONEY_PAGE);
    }
    default:
      return `unknown Nansen endpoint ${path}`;
  }
}

/**
 * Today's spend, with reservations.
 *
 * A reservation is taken before signing and counts until it is released, so
 * two concurrent payments can never both fit under the last cent of budget.
 * The day is UTC; the counter resets at midnight. In memory: a restart
 * forgets today's spend, which the per-call cap and the payer's small balance
 * bound.
 */
/**
 * What a paid Nansen call is for. Provider signals are bought on a trigger
 * anyone can pull (a node connecting with a fresh payout address), so they
 * may not spend the slice of the daily budget kept for the rating guard:
 * otherwise draining the budget with throwaway registrations switched the
 * wash-rating guard off for the rest of the day.
 */
export type SpendPurpose = "signal" | "guard";

/** The share of the daily cap, in basis points, only the rating guard may spend. */
export const GUARD_RESERVE_BPS = 3_000n;

export class SpendBudget {
  private day = "";
  private committed = 0n;
  /** Units only a `guard` reservation may take. */
  readonly guardReserveUnits: bigint;

  constructor(
    readonly dailyCapUnits: bigint,
    private readonly now: () => number = Date.now,
  ) {
    this.guardReserveUnits = (dailyCapUnits * GUARD_RESERVE_BPS) / 10_000n;
  }

  private roll(): void {
    const today = utcDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.committed = 0n;
    }
  }

  /** Reserve `units`; a `signal` reservation stops short of the guard's slice. */
  tryReserve(units: bigint, purpose: SpendPurpose = "guard"): boolean {
    this.roll();
    if (units <= 0n) return true;
    const ceiling = purpose === "guard" ? this.dailyCapUnits : this.dailyCapUnits - this.guardReserveUnits;
    if (this.committed + units > ceiling) return false;
    this.committed += units;
    return true;
  }

  release(units: bigint): void {
    this.roll();
    this.committed = this.committed > units ? this.committed - units : 0n;
  }

  spentToday(): bigint {
    this.roll();
    return this.committed;
  }
}

/** A counting semaphore — calls beyond the limit queue in order. */
class Slots {
  private free: number;
  private readonly waiting: Array<() => void> = [];
  constructor(size: number) {
    this.free = size;
  }
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free += 1;
  }
}

interface CacheEntry {
  at: number;
  value: unknown;
  paid: PaidCall | null;
}

const MAX_CACHE_ENTRIES = 5_000;

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class NansenClient {
  readonly mode: NansenMode;
  readonly budget: SpendBudget;
  readonly perCallCapUnits: bigint;
  readonly payerAddress: string | null;
  readonly auth: "x402" | "api-key" | "fixture" | "none";

  private readonly apiKey: string | null;
  private readonly fixtures: NansenFixtureSource | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly lookbackDays: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly pinPayTo: string | null;
  private readonly x402: { client: x402Client; http: x402HTTPClient } | null;
  private readonly slots: Slots;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<CallResult<unknown>>>();
  /** The purpose of the calls running in this async context (see `forPurpose`). */
  private readonly purpose = new AsyncLocalStorage<SpendPurpose>();
  private cooldownUntil = 0;
  private usage: NansenUsage;

  constructor(opts: NansenClientOptions) {
    this.mode = opts.mode;
    this.now = opts.now ?? Date.now;
    this.perCallCapUnits = opts.perCallCapUnits ?? DEFAULT_PER_CALL_CAP_UNITS;
    this.budget = new SpendBudget(opts.dailyCapUnits ?? DEFAULT_DAILY_CAP_UNITS, this.now);
    this.apiKey = opts.apiKey?.trim() || null;
    this.fixtures = opts.fixtures ?? null;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.lookbackDays = Math.min(365, Math.max(1, opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS));
    this.log = opts.log ?? (() => {});
    this.pinPayTo = opts.pinPayTo?.trim() || null;
    this.slots = new Slots(Math.min(2, Math.max(1, opts.maxConcurrency ?? 2)));
    this.usage = this.freshUsage();

    const payWithX402 = opts.mode === "live" && !this.apiKey && Boolean(opts.signer);
    this.payerAddress = payWithX402 && opts.signer ? opts.signer.address : null;
    this.auth =
      opts.mode === "fixture" ? "fixture" : opts.mode !== "live" ? "none" : this.apiKey ? "api-key" : payWithX402 ? "x402" : "none";
    this.x402 = payWithX402 && opts.signer ? this.buildX402(opts.signer) : null;
  }

  private freshUsage(): NansenUsage {
    return { day: utcDay(this.now()), calls: 0, paidCalls: 0, spentUnits: 0n, failures: 0, lastError: null, recentPaid: [] };
  }

  private today(): NansenUsage {
    const day = utcDay(this.now());
    if (this.usage.day !== day) {
      const recentPaid = this.usage.recentPaid;
      this.usage = { ...this.freshUsage(), recentPaid };
    }
    return this.usage;
  }

  /**
   * Run `fn` with every paid call inside it drawing on `purpose`'s share of
   * the daily budget. Calls made outside any purpose count as `signal`.
   */
  forPurpose<T>(purpose: SpendPurpose, fn: () => Promise<T>): Promise<T> {
    return this.purpose.run(purpose, fn);
  }

  /** Today's counters, with spend read from the budget (reservations included). */
  usageToday(): NansenUsage {
    const usage = this.today();
    return { ...usage, spentUnits: this.budget.spentToday(), recentPaid: [...usage.recentPaid] };
  }

  /** How many answers are cached right now. */
  cacheSize(): number {
    return this.cache.size;
  }

  private buildX402(signer: ClientEvmSigner): { client: x402Client; http: x402HTTPClient } {
    const cap = this.perCallCapUnits;
    const client = new x402Client()
      // Only Monad mainnet is registered, so the other seven rows in Nansen's
      // `accepts` can never be selected.
      .register(NANSEN_PAY_NETWORK as Network, new ExactEvmScheme(signer))
      // USDC on 143 is an @x402/evm default asset: its $1 default cap is
      // replaced by ours, in dollars and in atomic units.
      .setSpendControls({
        maxAmountPerPayment: `$${usdcString(cap)}`,
        allowedAssets: [{ network: NANSEN_PAY_NETWORK as Network, asset: MONAD_MAINNET_USDC, maxAmountPerPayment: cap.toString() }],
      })
      .registerPolicy((_version, requirements) =>
        requirements.filter(
          (r) =>
            r.scheme === "exact" &&
            r.network === NANSEN_PAY_NETWORK &&
            lc(r.asset) === lc(MONAD_MAINNET_USDC) &&
            (!this.pinPayTo || lc(r.payTo) === lc(this.pinPayTo)),
        ),
      )
      // The price check and the budget, before anything is signed.
      .onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
        const path = resourcePath(paymentRequired);
        const ceiling = path ? NANSEN_PRICE_UNITS[path as NansenPath] : undefined;
        const amount = BigInt(selectedRequirements.amount);
        if (ceiling === undefined) return { abort: true, reason: `no price on record for ${path ?? "an unknown resource"}` };
        if (amount > ceiling) return { abort: true, reason: `${path} now costs ${amount} units, above the ${ceiling} on record` };
        if (amount > cap) return { abort: true, reason: `${amount} units is above the per-call cap of ${cap}` };
        const purpose = this.purpose.getStore() ?? "signal";
        if (!this.budget.tryReserve(amount, purpose)) {
          return {
            abort: true,
            reason:
              purpose === "guard"
                ? `the daily Nansen budget (${usdcString(this.budget.dailyCapUnits)} USDC) is spent`
                : `the daily Nansen budget for provider signals is spent ` +
                  `(${usdcString(this.budget.guardReserveUnits)} of ${usdcString(this.budget.dailyCapUnits)} USDC is kept for the rating guard)`,
          };
        }
        this.log(`nansen: reserved ${usdcString(amount)} USDC for ${path} → ${selectedRequirements.payTo}`);
        return;
      })
      // Signing failed after the reservation: give it back.
      .onPaymentCreationFailure(async ({ selectedRequirements, error }) => {
        this.budget.release(BigInt(selectedRequirements.amount));
        this.log(`nansen: released ${selectedRequirements.amount} units (signing failed: ${error.message})`);
        return;
      })
      // Refused at verify (a fresh 402) or failed at settle: give it back.
      .onPaymentResponse(async ({ requirements, settleResponse, paymentRequired }) => {
        if (settleResponse?.success) return;
        if (paymentRequired || settleResponse?.success === false) {
          this.budget.release(BigInt(requirements.amount));
          this.log(`nansen: released ${requirements.amount} units (${settleResponse?.errorReason ?? "payment refused"})`);
        }
        return;
      });
    return { client, http: new x402HTTPClient(client) };
  }

  /**
   * One POST, validated, cached and de-duplicated.
   *
   * `cacheKey` identifies the answer (usually the address, plus the date for
   * activity). Concurrent calls for the same key share one request, so a
   * burst of registrations for one wallet pays once.
   */
  async call<T>(path: NansenPath, body: Record<string, unknown>, cacheKey: string): Promise<CallResult<T>> {
    const problem = validateNansenRequest(path, body);
    if (problem) return { ok: false, error: `invalid request, not sent: ${problem}` };

    const key = `${path}|${cacheKey}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < NANSEN_TTL_MS[path]) {
      return { ok: true, data: hit.value as T, paid: hit.paid, cached: true };
    }

    if (this.mode === "off") return { ok: false, error: "Nansen is off (XORV_NANSEN_MODE=off)" };

    if (this.mode === "fixture") {
      const data = this.fixtures?.(path, body) ?? null;
      if (data === null) return this.fail(`no fixture for ${path}`);
      this.remember(key, data, null);
      this.today().calls += 1;
      return { ok: true, data: data as T, paid: null, cached: false };
    }

    if (this.auth === "none") {
      return this.fail("live mode needs XORV_NANSEN_PAYER_KEY (Monad mainnet USDC) or NANSEN_API_KEY");
    }
    if (this.now() < this.cooldownUntil) {
      return this.fail(`rate limited by Nansen, cooling down for ${Math.ceil((this.cooldownUntil - this.now()) / 1000)}s`);
    }

    const running = this.inflight.get(key);
    if (running) return running as Promise<CallResult<T>>;
    const pending = this.request<T>(path, body, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending as Promise<CallResult<unknown>>);
    return pending;
  }

  private fail<T>(error: string): CallResult<T> {
    const usage = this.today();
    usage.failures += 1;
    usage.lastError = error;
    return { ok: false, error };
  }

  private remember(key: string, value: unknown, paid: PaidCall | null): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: this.now(), value, paid });
  }

  private async request<T>(path: NansenPath, body: Record<string, unknown>, key: string): Promise<CallResult<T>> {
    const url = `${NANSEN_BASE_URL}${path}`;
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (this.apiKey) headers.apikey = this.apiKey;
    // Lets Nansen quote promotional pricing for this payer when one runs.
    else if (this.payerAddress) headers["x-payer-address"] = this.payerAddress;
    const post = (extra: Record<string, string> = {}) =>
      this.fetchImpl(url, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: payload,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

    await this.slots.acquire();
    try {
      let res = await post();
      let paid: PaidCall | null = null;

      if (res.status === 402 && this.x402) {
        const { client, http } = this.x402;
        const text = await res.text();
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        const first = res;
        let required: PaymentRequired;
        try {
          required = http.getPaymentRequiredResponse((name) => first.headers.get(name), json);
        } catch (err) {
          return this.fail(`unreadable 402 from ${path}: ${message(err)}`);
        }
        // Defence in depth: the 402 must be for the resource we asked for, on Nansen.
        const origin = resourceOrigin(required);
        if (origin !== NANSEN_BASE_URL || resourcePath(required) !== path) {
          return this.fail(`402 names ${required.resource?.url ?? "no resource"}, not ${url} — refusing to pay`);
        }
        let signed;
        try {
          signed = await client.createPaymentPayload(required);
        } catch (err) {
          return this.fail(`payment refused: ${message(err).replace(/^Payment creation aborted: /, "")}`);
        }
        res = await post(http.encodePaymentSignatureHeader(signed));
        const paidRes = res;
        const result = await http.processPaymentResult(signed, (name) => paidRes.headers.get(name), paidRes.status);
        const settled = result.settleResponse;
        if (settled?.success && settled.transaction) {
          paid = {
            txHash: settled.transaction,
            url: mainnetTxUrl(settled.transaction),
            endpoint: path,
            amountUnits: signed.accepted.amount,
            network: settled.network ?? NANSEN_PAY_NETWORK,
            at: this.now(),
          };
          const usage = this.today();
          usage.paidCalls += 1;
          usage.recentPaid = [paid, ...usage.recentPaid].slice(0, 10);
          this.log(`nansen: paid ${usdcString(paid.amountUnits)} USDC for ${path} — ${paid.url}`);
        }
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "10");
        this.cooldownUntil = this.now() + (Number.isFinite(retryAfter) ? Math.max(1, retryAfter) : 10) * 1_000;
        return this.fail(`429 from Nansen (${res.headers.get("x-nansen-ratelimit-scope") ?? "rate limit"})`);
      }
      if (res.status === 402) return this.fail(`402 from ${path}: payment not accepted`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return this.fail(`${res.status} from ${path}${text ? `: ${text.slice(0, 160)}` : ""}`);
      }
      const data = (await res.json()) as T;
      if (!isRecord(data) || !Array.isArray((data as Record<string, unknown>).data)) {
        return this.fail(`unexpected response shape from ${path}`);
      }
      this.remember(key, data, paid);
      this.today().calls += 1;
      return { ok: true, data, paid, cached: false };
    } catch (err) {
      return this.fail(`${path}: ${message(err)}`);
    } finally {
      this.slots.release();
    }
  }

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  /** Who first sent this wallet gas, on any EVM chain ("all") — the one cross-chain answer. */
  firstFunder(address: string): Promise<CallResult<FirstFunderResponse>> {
    return this.call(NANSEN_PATHS.firstFunder, { address, chain: "all" }, lc(address));
  }

  /** Structural relations on Monad: first funder, signers, deployers. */
  relatedWallets(address: string): Promise<CallResult<RelatedWalletsResponse>> {
    return this.call(
      NANSEN_PATHS.relatedWallets,
      { wallet_address: address, chain: "monad", pagination: { page: 1, per_page: RELATED_WALLETS_PAGE } },
      lc(address),
    );
  }

  /** The last `lookbackDays` of Monad mainnet activity, one page, newest first. */
  transactions(address: string): Promise<CallResult<TransactionsResponse>> {
    const to = new Date(this.now());
    const from = new Date(to.getTime() - this.lookbackDays * 86_400_000);
    return this.call(
      NANSEN_PATHS.transactions,
      {
        address,
        chain: "monad",
        date: { from: utcDay(from.getTime()), to: utcDay(to.getTime()) },
        hide_spam_token: true,
        pagination: { page: 1, per_page: TRANSACTIONS_PAGE },
        order_by: [{ field: "block_timestamp", direction: "DESC" }],
      },
      `${lc(address)}|${utcDay(to.getTime())}`,
    );
  }

  /** Today's Monad smart-money leaderboard ($0.05). INTERNAL use only — never redistributed. */
  smartMoney(): Promise<CallResult<SmartMoneyResponse>> {
    return this.call(
      NANSEN_PATHS.smartMoney,
      { chains: ["monad"], timeframe: 30, pagination: { page: 1, per_page: SMART_MONEY_PAGE } },
      utcDay(this.now()),
    );
  }
}

function resourcePath(required: PaymentRequired): string | null {
  try {
    return new URL(required.resource?.url ?? "").pathname;
  } catch {
    return null;
  }
}

function resourceOrigin(required: PaymentRequired): string | null {
  try {
    return new URL(required.resource?.url ?? "").origin;
  } catch {
    return null;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
