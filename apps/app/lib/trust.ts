/**
 * Nansen trust, as the app reads and says it.
 *
 * The broker looks up every provider's payout wallet on Nansen — paying per
 * call in USDC over x402 on Monad mainnet — and publishes a public view on
 * `/api/providers`, `/api/providers/:id` and the leaderboard: a 0–100 score,
 * the wallet's age and first funder, risk flags, and the payments that
 * bought the data. It also checks, before relaying a rating, that buyer and
 * provider are not the same party. These readers accept that JSON
 * defensively (an older broker sends none of it) and turn it into the words
 * the UI shows. Smart-money data never reaches the app: the broker keeps it
 * internal, as Nansen's terms require.
 */

import { shortHex } from "@xorv/protocol/web";

export const NANSEN_ATTRIBUTION = "Powered by Nansen";
export const NANSEN_URL = "https://nansen.ai";

export type TrustBand = "high" | "medium" | "low" | "unknown";

export interface TrustPaidTx {
  txHash: string;
  url: string;
  endpoint: string;
  amountUsdc: string;
  at: number;
}

export interface TrustSignal {
  address: string;
  score: number;
  band: TrustBand;
  firstSeen: string | null;
  walletAgeDays: number | null;
  txCount: number;
  txCountCapped: boolean;
  firstFunder: { address: string; label: string | null; chain: string | null; url: string | null } | null;
  relatedWalletCount: number;
  labels: string[];
  riskFlags: string[];
  paidTx: TrustPaidTx[];
  paidUsdc: string;
  mode: "off" | "fixture" | "live";
  degraded: boolean;
  fetchedAt: string | null;
  attribution: string;
  attributionUrl: string;
}

export interface RelationReason {
  kind: string;
  message: string;
}

export interface TrustCheck {
  checkedAt: number;
  related: boolean;
  reasons: RelationReason[];
  mode: string;
  degraded: boolean;
}

export interface NansenStatus {
  mode: "off" | "fixture" | "live";
  auth: "x402" | "api-key" | "fixture" | "none";
  network: string;
  payer: { address: string; url: string } | null;
  callsToday: number;
  paidCallsToday: number;
  spentTodayUsdc: string;
  budgetUsdc: string;
  perCallCapUsdc: string;
  lastPaidTx: TrustPaidTx | null;
  recentPaidTx: TrustPaidTx[];
  lastError: string | null;
  walletsScored: number;
  ratingGuard: boolean;
  ratingChecks: number;
  ratingsRefused: number;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;
const isObject = (v: unknown): v is Loose => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const USDC = /^\d+(\.\d+)?$/;
const usdc = (v: unknown): string => (typeof v === "string" && USDC.test(v) ? v : "0.00");
/** Only an https link is ever rendered as a link. */
const httpsUrl = (v: unknown): string | null => {
  const url = str(v);
  return url && /^https:\/\//.test(url) ? url : null;
};
const MODES = new Set(["off", "fixture", "live"]);
const BANDS = new Set(["high", "medium", "low", "unknown"]);

function paidTx(v: unknown): TrustPaidTx[] {
  if (!Array.isArray(v)) return [];
  const out: TrustPaidTx[] = [];
  for (const raw of v) {
    if (!isObject(raw)) continue;
    const txHash = str(raw.txHash);
    const url = httpsUrl(raw.url);
    if (!txHash || !url) continue;
    out.push({ txHash, url, endpoint: str(raw.endpoint) ?? "", amountUsdc: usdc(raw.amountUsdc), at: num(raw.at) ?? 0 });
  }
  return out;
}

/** The `trust` object on a provider (or leaderboard row), or null when absent or malformed. */
export function readTrust(raw: unknown): TrustSignal | null {
  if (!isObject(raw)) return null;
  const score = num(raw.score);
  const address = str(raw.address);
  if (score === null || !address) return null;
  const funder = isObject(raw.firstFunder) ? raw.firstFunder : null;
  const funderAddress = funder ? str(funder.address) : null;
  const mode = str(raw.mode);
  const band = str(raw.band);
  return {
    address,
    score: Math.max(0, Math.min(100, Math.round(score))),
    band: band && BANDS.has(band) ? (band as TrustBand) : bandFor(score),
    firstSeen: str(raw.firstSeen),
    walletAgeDays: num(raw.walletAgeDays),
    txCount: num(raw.txCount) ?? 0,
    txCountCapped: raw.txCountCapped === true,
    firstFunder:
      funder && funderAddress
        ? { address: funderAddress, label: str(funder.label), chain: str(funder.chain), url: httpsUrl(funder.url) }
        : null,
    relatedWalletCount: num(raw.relatedWalletCount) ?? 0,
    labels: strings(raw.labels),
    riskFlags: strings(raw.riskFlags),
    paidTx: paidTx(raw.paidTx),
    paidUsdc: usdc(raw.paidUsdc),
    mode: mode && MODES.has(mode) ? (mode as TrustSignal["mode"]) : "live",
    degraded: raw.degraded === true,
    fetchedAt: str(raw.fetchedAt),
    attribution: str(raw.attribution) ?? NANSEN_ATTRIBUTION,
    attributionUrl: str(raw.attributionUrl) ?? NANSEN_URL,
  };
}

/** A job's related-wallet check, when one ran. */
export function readTrustCheck(raw: unknown): TrustCheck | null {
  if (!isObject(raw) || typeof raw.related !== "boolean") return null;
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.filter(isObject).map((r) => ({ kind: str(r.kind) ?? "related", message: str(r.message) ?? "" }))
    : [];
  return {
    checkedAt: num(raw.checkedAt) ?? 0,
    related: raw.related,
    reasons,
    mode: str(raw.mode) ?? "live",
    degraded: raw.degraded === true,
  };
}

/** `nansen` from `GET /api/network`, or null on a broker without it. */
export function readNansenStatus(info: unknown): NansenStatus | null {
  const raw = isObject(info) && isObject(info.nansen) ? info.nansen : null;
  if (!raw) return null;
  const mode = str(raw.mode);
  const auth = str(raw.auth);
  const payerAddress = isObject(raw.payer) ? str(raw.payer.address) : null;
  const payerUrl = isObject(raw.payer) ? httpsUrl(raw.payer.url) : null;
  const payer = payerAddress && payerUrl ? { address: payerAddress, url: payerUrl } : null;
  const last = paidTx(raw.lastPaidTx ? [raw.lastPaidTx] : [])[0] ?? null;
  return {
    mode: mode && MODES.has(mode) ? (mode as NansenStatus["mode"]) : "off",
    auth: auth === "x402" || auth === "api-key" || auth === "fixture" ? auth : "none",
    network: str(raw.network) ?? "eip155:143",
    payer,
    callsToday: num(raw.callsToday) ?? 0,
    paidCallsToday: num(raw.paidCallsToday) ?? 0,
    spentTodayUsdc: usdc(raw.spentTodayUsdc),
    budgetUsdc: usdc(raw.budgetUsdc),
    perCallCapUsdc: usdc(raw.perCallCapUsdc),
    lastPaidTx: last,
    recentPaidTx: paidTx(raw.recentPaidTx),
    lastError: str(raw.lastError),
    walletsScored: num(raw.walletsScored) ?? 0,
    ratingGuard: raw.ratingGuard === true,
    ratingChecks: num(raw.ratingChecks) ?? 0,
    ratingsRefused: num(raw.ratingsRefused) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export function bandFor(score: number): TrustBand {
  return score >= 70 ? "high" : score >= 45 ? "medium" : "low";
}

/** "Trust 78" — or "No history" when there is nothing to score. */
export function trustLabel(signal: TrustSignal): string {
  return signal.band === "unknown" ? "No wallet history" : `Trust ${signal.score}`;
}

/** Days → "2.3 years", "4 months", "12 days", "today". */
export function walletAge(days: number | null): string | null {
  if (days === null || days < 0) return null;
  if (days < 1) return "today";
  if (days < 60) return `${days} day${days === 1 ? "" : "s"}`;
  if (days < 365) return `${Math.floor(days / 30)} months`;
  const years = days / 365;
  return `${years < 10 ? years.toFixed(1) : Math.round(years)} years`;
}

/** "Binance 14 · 0x28c6…1d60", or the short address alone when unlabelled. */
export function funderText(signal: TrustSignal): string | null {
  const funder = signal.firstFunder;
  if (!funder) return null;
  return funder.label ? `${funder.label} · ${shortHex(funder.address)}` : shortHex(funder.address);
}

const FLAG_TEXT: Record<string, string> = {
  "no-first-funder-on-record": "no funding record (exchange- or bridge-credited, or new)",
};

/** A risk flag in words. Unknown flags pass through, prefixes tidied. */
export function riskFlagText(flag: string): string {
  return FLAG_TEXT[flag] ?? flag.replace(/^counterparty: /, "interacted with ").replace(/^funder: /, "funded by ");
}

/** Flags that should be read as a warning (the funding-record note is not one). */
export function warningFlags(signal: TrustSignal): string[] {
  return signal.riskFlags.filter((f) => !FLAG_TEXT[f]);
}

/**
 * "Xorv paid Nansen $0.03 over x402 on Monad" — only when a payment really
 * settled (never for fixture data or API-key credits).
 */
export function paidLine(signal: Pick<TrustSignal, "paidTx" | "paidUsdc">): string | null {
  if (signal.paidTx.length === 0) return null;
  return `Xorv paid Nansen $${signal.paidUsdc} over x402 on Monad`;
}

/** Where the data came from, in a few words. */
export function sourceNote(signal: Pick<TrustSignal, "mode" | "degraded">): string | null {
  if (signal.mode === "fixture") return "fixture data";
  if (signal.degraded) return "partial — some lookups failed";
  return null;
}

/** An endpoint path → the short name a person recognises. */
export function endpointName(endpoint: string): string {
  return endpoint.replace(/^\/api\/v1\//, "").replace(/^profiler\/address\//, "").replace(/^smart-money\//, "smart money ");
}

/** The headline for a rating the broker refused as a wash rating. */
export function refusalHeadline(check: Pick<TrustCheck, "reasons">): string {
  const kinds = new Set(check.reasons.map((r) => r.kind));
  if (kinds.has("same-wallet")) return "You can't rate your own provider wallet.";
  if (kinds.has("funded-by")) return "Refused: one of these wallets funded the other.";
  if (kinds.has("shared-funder")) return "Refused: both wallets were funded by the same wallet.";
  return "Refused: Nansen links these wallets.";
}
