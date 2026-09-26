/**
 * From Nansen's answers to one number a buyer can use, and one verdict the
 * broker acts on.
 *
 * A **trust signal** folds three profiler calls about a wallet into a score:
 * how old it is and who funded it (first funder, cross-chain), how active it
 * is on Monad mainnet (transactions), and what it is structurally tied to
 * (related wallets). The rules are small and written down below, because a
 * score nobody can explain is a score nobody should trust.
 *
 * The one rule that matters most: **missing data never costs a provider
 * anything.** Xorv runs on Monad testnet, most provider wallets have no Monad
 * mainnet history at all, and a wallet funded straight from an exchange has
 * no first funder on record. An unanswered call leaves the score where it
 * was; when nothing could be learned the score is exactly 50, neutral, and
 * the signal says it is degraded.
 *
 * What may leave the broker is decided by `publicTrustView`. Smart-money
 * membership is Nansen data that may not be redistributed, so it only ever
 * nudges matching (see `matchScore`) and never appears in a response; related
 * wallet addresses are used for the sybil check and not published.
 */

import {
  NANSEN_ATTRIBUTION,
  NANSEN_ATTRIBUTION_URL,
  mainnetAddressUrl,
  usdcString,
  type CallResult,
  type FirstFunderResponse,
  type NansenMode,
  type PaidCall,
  type RelatedWalletsResponse,
  type TransactionsResponse,
} from "./nansen.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FirstFunder {
  address: string;
  /** Nansen's name for the funder, e.g. "Binance 14" — null when unlabelled. */
  label: string | null;
  chain: string | null;
  txHash: string | null;
  at: string | null;
}

export interface RelatedWallet {
  address: string;
  relation: string;
  label: string | null;
}

export interface TrustSignal {
  /** The wallet, as asked about. */
  address: string;
  /** 0–100; 50 is "nothing known". Built without smart-money data, so it is safe to show. */
  score: number;
  /** When the wallet was first funded (any EVM chain), else its oldest Monad tx in the window. */
  firstSeen: string | null;
  walletAgeDays: number | null;
  /** Monad mainnet transactions in the lookback window (one page, so at most 100). */
  txCount: number;
  txCountCapped: boolean;
  firstFunder: FirstFunder | null;
  /** INTERNAL — addresses for the sybil check, never published. */
  relatedWallets: RelatedWallet[];
  /** Display-safe labels (smart-money wording removed). */
  labels: string[];
  riskFlags: string[];
  /** INTERNAL ONLY — Nansen smart-money data may not be redistributed. */
  smartMoney: boolean | null;
  /** The x402 payments that bought the data behind this signal (empty in fixture/api-key mode). */
  paidTx: PaidCall[];
  source: "nansen";
  mode: NansenMode;
  /** True when at least one call failed; the score then only reflects what was answered. */
  degraded: boolean;
  /** INTERNAL — why calls failed. */
  errors: string[];
  fetchedAt: string;
}

/** What `/api/providers`, the leaderboard and the app see. */
export interface PublicTrustSignal {
  address: string;
  score: number;
  band: "high" | "medium" | "low" | "unknown";
  firstSeen: string | null;
  walletAgeDays: number | null;
  txCount: number;
  txCountCapped: boolean;
  firstFunder: (FirstFunder & { url: string }) | null;
  relatedWalletCount: number;
  labels: string[];
  riskFlags: string[];
  paidTx: Array<{ txHash: string; url: string; endpoint: string; amountUsdc: string; at: number }>;
  /** What Xorv paid Nansen, in USDC, for the data behind this signal. */
  paidUsdc: string;
  source: "nansen";
  mode: NansenMode;
  degraded: boolean;
  fetchedAt: string;
  attribution: typeof NANSEN_ATTRIBUTION;
  attributionUrl: typeof NANSEN_ATTRIBUTION_URL;
}

/** The inputs for `relatedParties`: what links one wallet to others. */
export interface WalletLinks {
  address: string;
  firstFunder: FirstFunder | null;
  relatedWallets: RelatedWallet[];
}

export type RelationKind = "same-wallet" | "funded-by" | "shared-funder" | "related-wallets";

export interface RelationReason {
  kind: RelationKind;
  message: string;
}

// ---------------------------------------------------------------------------
// Label rules
// ---------------------------------------------------------------------------

/** Smart-money wording is proprietary; it never reaches a label we display. */
const SMART_MONEY_LABEL = /smart\s*(money|trader|lp|hl)|\bfund\b|🤓|\b(30|90|180)D\b/i;
const RISK_LABEL = /tornado|mixer|exploit|hack(er)?\b|drainer|phish|scam|sanction|ofac|rug\s?pull|launder/i;
const EXCHANGE_LABEL =
  /binance|coinbase|kraken|okx|bybit|bitget|kucoin|gate\.io|htx|huobi|upbit|crypto\.com|mexc|bitfinex|gemini|exchange|\bcex\b/i;
/**
 * A funder that funds strangers by the thousand — an exchange hot wallet, a
 * bridge relayer, a faucet. Two wallets sharing one of these are not related.
 */
const SERVICE_LABEL = new RegExp(
  `${EXCHANGE_LABEL.source}|bridge|relayer|faucet|layerzero|stargate|across|wormhole|orbiter|hop protocol|synapse|deposit|hot wallet|router|disperse|multisender`,
  "i",
);

export function isServiceLabel(label: string | null | undefined): boolean {
  return Boolean(label && SERVICE_LABEL.test(label));
}

export function isDisplaySafeLabel(label: string | null | undefined): label is string {
  return Boolean(label && label.trim() && !SMART_MONEY_LABEL.test(label));
}

const lc = (value: string) => value.toLowerCase();

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * The score, as rules:
 *
 *  - start at 50;
 *  - wallet age from its first funding: > 1 year +20, > 90 days +10,
 *    > 30 days +5, under 7 days −10 (a wallet made this week for this job);
 *  - funded by a labelled exchange: +5 (someone passed an on-ramp);
 *  - Monad mainnet activity: ≥ 50 txs +10, ≥ 10 txs +5 — and no penalty for
 *    none, because testnet-only wallets have none;
 *  - each risky label on the funder, a related wallet or a counterparty
 *    (mixer, exploit, drainer, sanctioned…): −20, at most −40;
 *  - clamped to 0–100; exactly 50 when every call failed.
 */
export const TRUST_RULES = {
  base: 50,
  age: { year: 20, quarter: 10, month: 5, week: -10 },
  exchangeFunded: 5,
  activity: { busy: 10, active: 5 },
  riskEach: -20,
  riskMax: -40,
} as const;

export interface SignalInputs {
  address: string;
  mode: NansenMode;
  now: number;
  firstFunder: CallResult<FirstFunderResponse>;
  relatedWallets: CallResult<RelatedWalletsResponse>;
  transactions: CallResult<TransactionsResponse>;
  /** Today's smart-money set, when fetched. INTERNAL. */
  smartMoney?: Set<string> | null;
}

export function neutralSignal(address: string, mode: NansenMode, now: number, errors: string[]): TrustSignal {
  return {
    address,
    score: TRUST_RULES.base,
    firstSeen: null,
    walletAgeDays: null,
    txCount: 0,
    txCountCapped: false,
    firstFunder: null,
    relatedWallets: [],
    labels: [],
    riskFlags: [],
    smartMoney: null,
    paidTx: [],
    source: "nansen",
    mode,
    degraded: errors.length > 0,
    errors,
    fetchedAt: new Date(now).toISOString(),
  };
}

export function buildTrustSignal(input: SignalInputs): TrustSignal {
  const { address, now } = input;
  const me = lc(address);
  const signal = neutralSignal(address, input.mode, now, []);
  const labels = new Set<string>();
  const risks = new Set<string>();
  let score: number = TRUST_RULES.base;
  let answered = 0;

  const note = (result: CallResult<unknown>, name: string): boolean => {
    if (!result.ok) {
      signal.errors.push(`${name}: ${result.error}`);
      return false;
    }
    answered += 1;
    if (result.paid) signal.paidTx.push(result.paid);
    return true;
  };
  const risky = (label: string | null | undefined, flag: string) => {
    if (label && RISK_LABEL.test(label)) risks.add(`${flag}: ${label}`);
  };

  // 1. Funding origin and age — cross-chain, so a testnet-era key still has history.
  if (note(input.firstFunder, "first-funder") && input.firstFunder.ok) {
    const row = input.firstFunder.data.data.find((r) => lc(r.wallet_address) === me) ?? input.firstFunder.data.data[0];
    if (row) {
      const label = row.first_funder_name?.trim() || null;
      signal.firstFunder = {
        address: row.first_funder_address,
        label: isDisplaySafeLabel(label) ? label : null,
        chain: row.chain ?? null,
        txHash: row.transaction_hash ?? null,
        at: row.block_timestamp ?? null,
      };
      const at = Date.parse(row.block_timestamp);
      if (Number.isFinite(at)) {
        signal.firstSeen = new Date(at).toISOString();
        const days = Math.max(0, Math.floor((now - at) / 86_400_000));
        signal.walletAgeDays = days;
        score +=
          days > 365
            ? TRUST_RULES.age.year
            : days > 90
              ? TRUST_RULES.age.quarter
              : days > 30
                ? TRUST_RULES.age.month
                : days < 7
                  ? TRUST_RULES.age.week
                  : 0;
      }
      if (label && EXCHANGE_LABEL.test(label)) score += TRUST_RULES.exchangeFunded;
      if (isDisplaySafeLabel(label)) labels.add(`funded by ${label}`);
      risky(label, "funder");
    } else {
      // Exchange- or bridge-credited, or brand new. Informational only.
      signal.riskFlags.push("no-first-funder-on-record");
    }
  }

  // 2. Structural ties on Monad (first funder, signer, deployer…).
  if (note(input.relatedWallets, "related-wallets") && input.relatedWallets.ok) {
    const seen = new Set<string>();
    for (const row of input.relatedWallets.data.data) {
      const key = lc(row.address);
      if (key === me || seen.has(key)) continue;
      seen.add(key);
      signal.relatedWallets.push({ address: row.address, relation: row.relation, label: row.address_label ?? null });
      risky(row.address_label, `related (${row.relation})`);
    }
  }

  // 3. Activity on Monad mainnet, and the wallet's own label where Nansen stamps it.
  if (note(input.transactions, "transactions") && input.transactions.ok) {
    const rows = input.transactions.data.data;
    signal.txCount = rows.length;
    signal.txCountCapped = rows.length >= 100 && input.transactions.data.pagination?.is_last_page === false;
    score += rows.length >= 50 ? TRUST_RULES.activity.busy : rows.length >= 10 ? TRUST_RULES.activity.active : 0;
    for (const row of rows) {
      for (const leg of [...(row.tokens_sent ?? []), ...(row.tokens_received ?? [])]) {
        const fromMe = lc(leg.from_address) === me;
        const toMe = lc(leg.to_address) === me;
        if (fromMe && isDisplaySafeLabel(leg.from_address_label) && !RISK_LABEL.test(leg.from_address_label)) {
          labels.add(leg.from_address_label);
        }
        if (toMe && isDisplaySafeLabel(leg.to_address_label) && !RISK_LABEL.test(leg.to_address_label)) {
          labels.add(leg.to_address_label);
        }
        risky(fromMe ? leg.to_address_label : leg.from_address_label, "counterparty");
      }
    }
    if (!signal.firstSeen && rows.length) {
      const oldest = rows.map((r) => Date.parse(r.block_timestamp)).filter(Number.isFinite).sort((a, b) => a - b)[0];
      if (oldest !== undefined) signal.firstSeen = new Date(oldest).toISOString();
    }
  }

  if (input.smartMoney) signal.smartMoney = input.smartMoney.has(me);

  signal.riskFlags.push(...risks);
  score += Math.max(TRUST_RULES.riskMax, risks.size * TRUST_RULES.riskEach);
  signal.labels = [...labels].slice(0, 6);
  signal.degraded = signal.errors.length > 0;
  signal.score = answered === 0 ? TRUST_RULES.base : Math.max(0, Math.min(100, Math.round(score)));
  return signal;
}

/**
 * The score matching uses: the public score plus a small, internal nudge for
 * a wallet on Nansen's Monad smart-money list. Null when nothing was learned,
 * so an unknown provider ranks as neutral rather than as a 50.
 */
export function matchScore(signal: TrustSignal | null | undefined): number | null {
  // All three calls failed: nothing was learned, so no opinion either way.
  if (!signal || signal.errors.length >= 3) return null;
  return Math.min(100, signal.score + (signal.smartMoney ? 5 : 0));
}

/**
 * A coarse reading for the badge. "unknown" when there is no history to go
 * on (every call failed, or no funder and no Monad activity on record) —
 * which is not the same thing as a bad wallet, and is not shown as one.
 */
export function trustBand(
  signal: Pick<TrustSignal, "score" | "errors" | "firstFunder" | "txCount" | "riskFlags">,
): PublicTrustSignal["band"] {
  const risky = signal.riskFlags.some((f) => f !== "no-first-funder-on-record");
  if (signal.errors.length >= 3 || (!signal.firstFunder && signal.txCount === 0 && !risky)) return "unknown";
  if (signal.score >= 70) return "high";
  if (signal.score >= 45) return "medium";
  return "low";
}

/** Strip what may not leave the broker and attach Nansen's attribution. */
export function publicTrustView(signal: TrustSignal): PublicTrustSignal {
  const paidUnits = signal.paidTx.reduce((sum, p) => sum + BigInt(p.amountUnits), 0n);
  return {
    address: signal.address,
    score: signal.score,
    band: trustBand(signal),
    firstSeen: signal.firstSeen,
    walletAgeDays: signal.walletAgeDays,
    txCount: signal.txCount,
    txCountCapped: signal.txCountCapped,
    firstFunder: signal.firstFunder ? { ...signal.firstFunder, url: mainnetAddressUrl(signal.firstFunder.address) } : null,
    relatedWalletCount: signal.relatedWallets.length,
    labels: [...signal.labels],
    riskFlags: [...signal.riskFlags],
    paidTx: signal.paidTx.map((p) => ({
      txHash: p.txHash,
      url: p.url,
      endpoint: p.endpoint,
      amountUsdc: usdcString(p.amountUnits),
      at: p.at,
    })),
    paidUsdc: usdcString(paidUnits),
    source: "nansen",
    mode: signal.mode,
    degraded: signal.degraded,
    fetchedAt: signal.fetchedAt,
    attribution: NANSEN_ATTRIBUTION,
    attributionUrl: NANSEN_ATTRIBUTION_URL,
  };
}

// ---------------------------------------------------------------------------
// Related parties — the wash-rating check
// ---------------------------------------------------------------------------

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Are these two wallets the same party?
 *
 * Related when any of these hold:
 *  - they are the same address (rating yourself);
 *  - one first funded the other;
 *  - they share a first funder that is not a service (an exchange hot
 *    wallet, a bridge relayer or a faucet funds thousands of strangers, so
 *    sharing one proves nothing);
 *  - Nansen lists either as a related wallet of the other, or both list the
 *    same non-service wallet as their first funder on Monad.
 */
export function relatedParties(a: WalletLinks, b: WalletLinks): { related: boolean; reasons: RelationReason[] } {
  const reasons: RelationReason[] = [];
  const A = lc(a.address);
  const B = lc(b.address);
  if (A === B) {
    reasons.push({ kind: "same-wallet", message: "the buyer and the provider are the same wallet" });
    return { related: true, reasons };
  }

  const aFunder = a.firstFunder ? lc(a.firstFunder.address) : null;
  const bFunder = b.firstFunder ? lc(b.firstFunder.address) : null;
  if (aFunder === B) {
    reasons.push({ kind: "funded-by", message: `${short(b.address)} first funded ${short(a.address)}` });
  }
  if (bFunder === A) {
    reasons.push({ kind: "funded-by", message: `${short(a.address)} first funded ${short(b.address)}` });
  }
  if (
    aFunder &&
    aFunder === bFunder &&
    !isServiceLabel(a.firstFunder?.label) &&
    !isServiceLabel(b.firstFunder?.label)
  ) {
    reasons.push({ kind: "shared-funder", message: `both wallets were first funded by ${short(a.firstFunder!.address)}` });
  }

  const aRelated = new Map(a.relatedWallets.map((r) => [lc(r.address), r]));
  const bRelated = new Map(b.relatedWallets.map((r) => [lc(r.address), r]));
  const aLists = aRelated.get(B);
  const bLists = bRelated.get(A);
  if (aLists || bLists) {
    const relation = (aLists ?? bLists)!.relation;
    reasons.push({ kind: "related-wallets", message: `Nansen lists them as related wallets (${relation})` });
  }
  if (!reasons.some((r) => r.kind === "shared-funder")) {
    for (const [address, row] of aRelated) {
      const other = bRelated.get(address);
      if (!other) continue;
      const funderLink = /first funder/i.test(row.relation) && /first funder/i.test(other.relation);
      if (funderLink && !isServiceLabel(row.label) && !isServiceLabel(other.label)) {
        reasons.push({ kind: "shared-funder", message: `both wallets were first funded on Monad by ${short(row.address)}` });
        break;
      }
    }
  }
  return { related: reasons.length > 0, reasons };
}
