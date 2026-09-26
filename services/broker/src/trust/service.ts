/**
 * NansenTrust — where the broker's decisions meet Nansen's data.
 *
 * Three places lean on it:
 *
 *  1. **Provider trust.** When a node registers (and every few hours while it
 *     stays), the broker looks up its payout wallet and keeps a signal. The
 *     public view rides on `/api/providers`, `/api/providers/:id` and the
 *     leaderboard. The lookup never blocks registration: it runs in the
 *     background and the provider simply has no signal until it lands.
 *  2. **Wash-rating guard.** Before relaying a buyer's rating into ERC-8004,
 *     the broker asks whether buyer and provider are the same party — one
 *     funded the other, they share a (non-exchange) first funder, or Nansen
 *     lists them as related wallets. If so the rating is refused. Reputation
 *     that a provider can buy from its own second wallet is worth nothing;
 *     this is what keeps Xorv's worth something.
 *  3. **Matching.** The score breaks ties between equally priced providers
 *     (see `Registry.candidates`), with a small internal nudge for Nansen
 *     smart-money wallets that is never shown.
 *
 * Every path degrades to "no opinion": a failed or slow lookup never blocks,
 * never refuses a rating and never lowers a provider's rank.
 */

import { normalizeAddress } from "@xorv/protocol";
import {
  NANSEN_ATTRIBUTION,
  NANSEN_ATTRIBUTION_URL,
  NANSEN_PAY_NETWORK,
  mainnetAddressUrl,
  usdcString,
  type NansenClient,
  type NansenMode,
  type PaidCall,
} from "./nansen.js";
import {
  buildTrustSignal,
  matchScore,
  neutralSignal,
  publicTrustView,
  relatedParties,
  type PublicTrustSignal,
  type RelationReason,
  type TrustSignal,
  type WalletLinks,
} from "./signal.js";

export interface NansenTrustOptions {
  client: NansenClient;
  /** Fetch today's Monad smart-money list ($0.05/day) for the internal matching nudge. */
  smartMoney?: boolean;
  /** Refuse ratings between related wallets. */
  ratingGuard?: boolean;
  /** Rebuild a provider's signal after this long. */
  refreshMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** The outcome of one wash-rating check, as stored on the job. */
export interface RelatedCheck {
  checkedAt: number;
  related: boolean;
  reasons: RelationReason[];
  buyer: string;
  provider: string;
  mode: NansenMode;
  /** Some lookups failed or timed out; an unproven link is never a refusal. */
  degraded: boolean;
  /** INTERNAL. */
  errors: string[];
}

export interface PublicRelatedCheck {
  checkedAt: number;
  related: boolean;
  reasons: RelationReason[];
  mode: NansenMode;
  degraded: boolean;
  attribution: typeof NANSEN_ATTRIBUTION;
  attributionUrl: typeof NANSEN_ATTRIBUTION_URL;
}

export interface NansenStatus {
  mode: NansenMode;
  /** How calls are paid for: x402 on Monad mainnet, an API key, fixtures, or not at all. */
  auth: "x402" | "api-key" | "fixture" | "none";
  network: typeof NANSEN_PAY_NETWORK;
  payer: { address: string; url: string } | null;
  callsToday: number;
  paidCallsToday: number;
  spentTodayUnits: string;
  spentTodayUsdc: string;
  budgetUnits: string;
  budgetUsdc: string;
  perCallCapUsdc: string;
  lastPaidTx: { txHash: string; url: string; endpoint: string; amountUsdc: string; at: number } | null;
  recentPaidTx: Array<{ txHash: string; url: string; endpoint: string; amountUsdc: string; at: number }>;
  lastError: string | null;
  walletsScored: number;
  cacheEntries: number;
  ratingGuard: boolean;
  ratingChecks: number;
  ratingsRefused: number;
  attribution: typeof NANSEN_ATTRIBUTION;
  attributionUrl: typeof NANSEN_ATTRIBUTION_URL;
}

const DEFAULT_REFRESH_MS = 6 * 3_600_000;
/** A signal some of whose calls failed is retried sooner — only the failed calls cost anything (the rest are cached). */
const DEGRADED_RETRY_MS = 10 * 60_000;
const MAX_SIGNALS = 2_000;

function paidView(p: PaidCall) {
  return { txHash: p.txHash, url: p.url, endpoint: p.endpoint, amountUsdc: usdcString(p.amountUnits), at: p.at };
}

export function publicRelatedCheck(check: RelatedCheck): PublicRelatedCheck {
  return {
    checkedAt: check.checkedAt,
    related: check.related,
    reasons: check.reasons,
    mode: check.mode,
    degraded: check.degraded,
    attribution: NANSEN_ATTRIBUTION,
    attributionUrl: NANSEN_ATTRIBUTION_URL,
  };
}

/** The refusal a buyer reads when the guard says no. */
export function refusalMessage(check: RelatedCheck): string {
  const why = check.reasons.map((r) => r.message).join("; ");
  return (
    `Rating refused: the buyer and provider wallets are related (Nansen) — ${why}. ` +
    "Ratings between wallets controlled by the same party would let a provider buy its own reputation, " +
    "so Xorv only relays ratings from independent buyers."
  );
}

export class NansenTrust {
  readonly client: NansenClient;
  readonly mode: NansenMode;
  readonly ratingGuard: boolean;
  private readonly smartMoneyOn: boolean;
  private readonly refreshMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly signals = new Map<string, TrustSignal>();
  private readonly building = new Map<string, Promise<TrustSignal>>();
  private smartMoneySet: { day: number; set: Set<string> } | null = null;
  private ratingChecks = 0;
  private ratingsRefused = 0;

  constructor(opts: NansenTrustOptions) {
    this.client = opts.client;
    this.mode = opts.client.mode;
    this.ratingGuard = (opts.ratingGuard ?? true) && this.mode !== "off";
    this.smartMoneyOn = opts.smartMoney ?? true;
    this.refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  get enabled(): boolean {
    return this.mode !== "off";
  }

  /** The signal last built for this wallet, if any. Never fetches. */
  peek(address: string): TrustSignal | null {
    return this.signals.get(address.toLowerCase()) ?? null;
  }

  publicSignal(address: string): PublicTrustSignal | null {
    const signal = this.peek(address);
    return signal ? publicTrustView(signal) : null;
  }

  /** The internal score the matcher uses, or null for "no opinion". */
  matchScore(address: string): number | null {
    return matchScore(this.peek(address));
  }

  /**
   * Make sure a signal exists and is fresh, in the background. Safe to call
   * on every registration and every sweep: an up-to-date signal costs nothing,
   * and concurrent calls for one wallet share one build.
   */
  watch(address: string): void {
    if (!this.enabled) return;
    const existing = this.peek(address);
    const freshFor = existing?.degraded ? Math.min(this.refreshMs, DEGRADED_RETRY_MS) : this.refreshMs;
    if (existing && this.now() - Date.parse(existing.fetchedAt) < freshFor) return;
    void this.signal(address).catch((err) => this.log(`nansen: signal for ${address} failed: ${String(err)}`));
  }

  /** Re-watch every wallet whose signal is missing or older than the refresh interval. */
  refreshStale(addresses: Iterable<string>): void {
    for (const address of addresses) this.watch(address);
  }

  /** Build (or rebuild) a wallet's full signal. Resolves even when every call fails. */
  async signal(address: string): Promise<TrustSignal> {
    const key = address.toLowerCase();
    const running = this.building.get(key);
    if (running) return running;
    const pending = this.build(address).finally(() => this.building.delete(key));
    this.building.set(key, pending);
    return pending;
  }

  private async build(raw: string): Promise<TrustSignal> {
    let address: string;
    try {
      address = normalizeAddress(raw);
    } catch {
      // Validated locally: never spend a cent asking about something that is not an address.
      return neutralSignal(raw, this.mode, this.now(), ["not an EVM address"]);
    }
    const [firstFunder, relatedWallets, transactions, smartMoney] = await Promise.all([
      this.client.firstFunder(address),
      this.client.relatedWallets(address),
      this.client.transactions(address),
      this.smartMoneyOn ? this.smartMoney() : Promise.resolve(null),
    ]);
    const signal = buildTrustSignal({
      address,
      mode: this.mode,
      now: this.now(),
      firstFunder,
      relatedWallets,
      transactions,
      smartMoney,
    });
    this.store(signal);
    if (signal.degraded) this.log(`nansen: ${address} scored ${signal.score} (degraded: ${signal.errors.join("; ")})`);
    return signal;
  }

  private store(signal: TrustSignal): void {
    const key = signal.address.toLowerCase();
    this.signals.delete(key);
    if (this.signals.size >= MAX_SIGNALS) {
      const oldest = this.signals.keys().next().value;
      if (oldest !== undefined) this.signals.delete(oldest);
    }
    this.signals.set(key, signal);
  }

  /** Today's Monad smart-money addresses. INTERNAL: used for matching only. */
  private async smartMoney(): Promise<Set<string> | null> {
    const day = Math.floor(this.now() / 86_400_000);
    if (this.smartMoneySet?.day === day) return this.smartMoneySet.set;
    const result = await this.client.smartMoney();
    if (!result.ok) return this.smartMoneySet?.set ?? null;
    const set = new Set(result.data.data.map((row) => row.address.toLowerCase()));
    this.smartMoneySet = { day, set };
    return set;
  }

  /**
   * First funder and related wallets for one wallet — what the related-party
   * check needs. Reuses a full signal when there is one (a provider's), and
   * otherwise asks only the two calls it needs (a buyer costs $0.02, not $0.03).
   */
  async links(raw: string): Promise<WalletLinks & { errors: string[] }> {
    const existing = this.peek(raw);
    if (existing && existing.errors.length === 0) {
      return { address: existing.address, firstFunder: existing.firstFunder, relatedWallets: existing.relatedWallets, errors: [] };
    }
    const address = normalizeAddress(raw);
    const [ff, rw] = await Promise.all([this.client.firstFunder(address), this.client.relatedWallets(address)]);
    const partial = buildTrustSignal({
      address,
      mode: this.mode,
      now: this.now(),
      firstFunder: ff,
      relatedWallets: rw,
      transactions: { ok: false, error: "not needed for a link check" },
    });
    return {
      address,
      firstFunder: partial.firstFunder,
      relatedWallets: partial.relatedWallets,
      errors: partial.errors.filter((e) => !e.startsWith("transactions:")),
    };
  }

  /**
   * Are this buyer and this provider the same party? Bounded by `timeoutMs`:
   * a check that runs out of time is recorded as degraded and does not block
   * the rating. The lookups keep running and warm the cache for next time.
   */
  async checkRelated(buyer: string, provider: string, opts: { timeoutMs?: number } = {}): Promise<RelatedCheck> {
    this.ratingChecks += 1;
    const base = { checkedAt: this.now(), buyer, provider, mode: this.mode };
    // The same wallet on both sides needs no lookup at all.
    const self = relatedParties(
      { address: buyer, firstFunder: null, relatedWallets: [] },
      { address: provider, firstFunder: null, relatedWallets: [] },
    );
    if (self.related) {
      this.ratingsRefused += 1;
      return { ...base, related: true, reasons: self.reasons, degraded: false, errors: [] };
    }

    const lookups = Promise.all([this.links(buyer), this.links(provider)]).then(
      ([a, b]) => ({ a, b }),
      (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ error: string }>((resolve) => {
      timer = setTimeout(() => resolve({ error: "Nansen lookup timed out" }), opts.timeoutMs ?? 12_000);
    });
    const outcome = await Promise.race([lookups, timeout]).finally(() => clearTimeout(timer));
    if ("error" in outcome) {
      return { ...base, related: false, reasons: [], degraded: true, errors: [outcome.error] };
    }
    const verdict = relatedParties(outcome.a, outcome.b);
    const errors = [...outcome.a.errors.map((e) => `buyer ${e}`), ...outcome.b.errors.map((e) => `provider ${e}`)];
    if (verdict.related) this.ratingsRefused += 1;
    return { ...base, related: verdict.related, reasons: verdict.reasons, degraded: errors.length > 0, errors };
  }

  status(): NansenStatus {
    const usage = this.client.usageToday();
    const last = usage.recentPaid[0] ?? null;
    return {
      mode: this.mode,
      auth: this.client.auth,
      network: NANSEN_PAY_NETWORK,
      payer: this.client.payerAddress
        ? { address: this.client.payerAddress, url: mainnetAddressUrl(this.client.payerAddress) }
        : null,
      callsToday: usage.calls,
      paidCallsToday: usage.paidCalls,
      spentTodayUnits: usage.spentUnits.toString(),
      spentTodayUsdc: usdcString(usage.spentUnits),
      budgetUnits: this.client.budget.dailyCapUnits.toString(),
      budgetUsdc: usdcString(this.client.budget.dailyCapUnits),
      perCallCapUsdc: usdcString(this.client.perCallCapUnits),
      lastPaidTx: last ? paidView(last) : null,
      recentPaidTx: usage.recentPaid.slice(0, 5).map(paidView),
      lastError: usage.lastError,
      walletsScored: this.signals.size,
      cacheEntries: this.client.cacheSize(),
      ratingGuard: this.ratingGuard,
      ratingChecks: this.ratingChecks,
      ratingsRefused: this.ratingsRefused,
      attribution: NANSEN_ATTRIBUTION,
      attributionUrl: NANSEN_ATTRIBUTION_URL,
    };
  }
}
