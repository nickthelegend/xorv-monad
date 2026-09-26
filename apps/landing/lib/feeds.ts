/**
 * Reading the broker's public feeds.
 *
 * The ledger section shows three payloads — `/api/network`, `/api/receipts`
 * and `/api/leaderboard` — from a server this page does not control and may be
 * a version ahead of or behind it. So every field is read defensively here,
 * once, into the small shapes the section renders: a missing or mistyped field
 * becomes `null` (and the row says "—"), never a crash that takes the whole
 * section down with it.
 *
 * Two rules that matter more than the parsing:
 *
 *  - **Links come from the payload, and only if they are http(s).** The broker
 *    builds explorer URLs from its own network config, which is the one that
 *    actually settled the payment — so the landing does not rebuild them from a
 *    constant that could name the wrong chain. A value that isn't an http(s) URL
 *    is dropped rather than put in an `href`.
 *  - **Nothing is invented.** No placeholder rows, no sample hashes: an empty
 *    feed parses to an empty list, and the section says so.
 */

/** What the section needs from `GET /api/network`. */
export interface NetworkSnapshot {
  network: string | null;
  chainId: number | null;
  explorerUrl: string | null;
  ledger: { address: string; url: string | null } | null;
  usdc: { address: string; url: string | null } | null;
  erc8004: { identity: string | null; reputation: string | null };
  /** True when the broker reads its feeds from an Envio indexer. */
  indexer: boolean;
  /** Which sponsor model holds each AI role on this broker, when enabled. */
  ai: { router: string | null; screener: string | null; verifier: string | null };
  stats: { providersLive: number; jobsCompleted: number; paidUsdMicros: number } | null;
}

/** One `JobRecorded` receipt, flattened. */
export interface ReceiptRow {
  /** `<blockNumber>:<logIndex>` — unique per chain, so it keys the list. */
  id: string;
  /** The broker's own job id when it knows it, else the on-chain bytes32. */
  jobId: string | null;
  buyer: string | null;
  payTo: string | null;
  /** USDC smallest units (6 decimals), as an integer string. */
  amountUnits: string | null;
  ok: boolean | null;
  durationMs: number | null;
  /** Block time, epoch ms. */
  at: number | null;
  /** The receipt transaction on the explorer. */
  explorerUrl: string | null;
  /** The x402 settlement transaction on the explorer; null for a job recorded unpaid. */
  paymentUrl: string | null;
}

export interface ReceiptsFeed {
  /** False when the broker has no ledger and no indexer to read from. */
  configured: boolean;
  source: string | null;
  receipts: ReceiptRow[];
}

export interface LeaderRow {
  rank: number;
  label: string;
  address: string | null;
  addressUrl: string | null;
  agentId: string | null;
  agentUrl: string | null;
  live: boolean;
  jobsOk: number;
  jobsTotal: number;
  successRate: number | null;
  earnedUsdMicros: number;
  avgRating: number | null;
  ratingsCount: number;
}

export interface LeaderboardFeed {
  /** `indexer` (Envio) or `memory` (this broker's own counters). */
  source: string | null;
  providers: LeaderRow[];
}

// ---------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** An integer amount as a decimal string — the broker sends bigints as strings. */
function units(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/** Only an http(s) URL is allowed into an `href`; anything else is dropped. */
export function safeUrl(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  try {
    const url = new URL(s);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A zero bytes32 (or a zero-length hash) is how an unpaid receipt says "no payment". */
function isZeroHash(value: string | null): boolean {
  return value === null || /^0x0*$/i.test(value);
}

function role(value: unknown): string | null {
  const r = obj(value);
  if (!r) return null;
  return str(r.model) ?? str(r.by);
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export function parseNetwork(body: unknown): NetworkSnapshot | null {
  const b = obj(body);
  if (!b) return null;
  const ledger = obj(b.ledger);
  const usdc = obj(b.usdc);
  const erc8004 = obj(b.erc8004);
  const ai = obj(b.ai);
  const stats = obj(b.stats);
  const ledgerAddress = str(ledger?.address);
  const usdcAddress = str(usdc?.address);
  return {
    network: str(b.network),
    chainId: num(b.chainId),
    explorerUrl: safeUrl(b.explorerUrl),
    ledger: ledgerAddress ? { address: ledgerAddress, url: safeUrl(ledger?.url) } : null,
    usdc: usdcAddress ? { address: usdcAddress, url: safeUrl(usdc?.url) } : null,
    erc8004: { identity: str(erc8004?.identity), reputation: str(erc8004?.reputation) },
    indexer: obj(b.indexer) !== null,
    ai: { router: role(ai?.router), screener: role(ai?.screener), verifier: role(ai?.verifier) },
    stats: stats
      ? {
          providersLive: num(stats.providersLive) ?? 0,
          jobsCompleted: num(stats.jobsCompleted) ?? 0,
          paidUsdMicros: num(stats.paidUsdMicros) ?? 0,
        }
      : null,
  };
}

/**
 * `/api/receipts` rows.
 *
 * The broker serves each receipt with both the Monad names (`buyer`, `payTo`,
 * `paymentTx`, `explorerUrl`, `paymentUrl`) and the keys the feed carried
 * before the port (`payer`, `providerAccountId`, `transactionId`). The new
 * names win; the old ones are a fallback so a broker mid-upgrade still renders.
 */
export function parseReceipts(body: unknown, limit = 6): ReceiptsFeed {
  const b = obj(body);
  if (!b || !Array.isArray(b.receipts)) return { configured: false, source: null, receipts: [] };
  const source = str(b.source);
  // `source: "none"` is the broker saying it has neither a ledger contract nor
  // an indexer — a different sentence from "the ledger has no receipts yet".
  const configured = source !== "none" && (obj(b.ledger) !== null || source !== null);

  const rows: ReceiptRow[] = [];
  for (const [index, raw] of b.receipts.entries()) {
    const r = obj(raw);
    if (!r) continue;
    const payload = obj(r.payload);
    const d = obj(payload?.data) ?? {};
    const paymentTx = str(d.paymentTx) ?? str(d.transactionId);
    rows.push({
      id: str(r.id) ?? (typeof r.sequence === "number" || typeof r.sequence === "string" ? String(r.sequence) : `row-${index}`),
      jobId: str(r.brokerJobId) ?? str(d.brokerJobId) ?? str(d.jobId),
      buyer: str(d.buyer) ?? str(d.payer),
      payTo: str(d.payTo) ?? str(d.providerAddress) ?? str(d.providerAccountId),
      amountUnits: units(d.amount),
      ok: bool(d.ok),
      durationMs: num(d.durationMs),
      at: num(r.at) ?? num(payload?.at),
      explorerUrl: safeUrl(r.explorerUrl),
      paymentUrl: isZeroHash(paymentTx) ? null : safeUrl(d.paymentUrl),
    });
    if (rows.length >= limit) break;
  }
  return { configured, source, receipts: rows };
}

export function parseLeaderboard(body: unknown, limit = 5): LeaderboardFeed {
  const b = obj(body);
  if (!b || !Array.isArray(b.providers)) return { source: null, providers: [] };
  const providers: LeaderRow[] = [];
  for (const raw of b.providers) {
    const p = obj(raw);
    if (!p) continue;
    const address = str(p.address);
    providers.push({
      rank: num(p.rank) ?? providers.length + 1,
      label: str(p.label) ?? (address ? address : "unnamed provider"),
      address,
      addressUrl: safeUrl(p.addressUrl),
      agentId: str(p.agentId) ?? (num(p.agentId) !== null ? String(num(p.agentId)) : null),
      agentUrl: safeUrl(p.agentUrl),
      live: p.live === true,
      jobsOk: num(p.jobsOk) ?? 0,
      jobsTotal: num(p.jobsTotal) ?? 0,
      successRate: num(p.successRate),
      earnedUsdMicros: num(p.earnedUsdMicros) ?? 0,
      avgRating: num(p.avgRating),
      ratingsCount: num(p.ratingsCount) ?? 0,
    });
    if (providers.length >= limit) break;
  }
  return { source: str(b.source), providers };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * USDC smallest units as a dollar string: `250000` → `0.25`, `2500` → `0.0025`.
 *
 * Exact (bigint) rather than float, and trimmed to the precision the amount
 * actually has — a sub-cent job priced at $0.0025 must not read as $0.00, and
 * a quarter should not read as 0.250000.
 */
export function formatUsdcUnits(amount: string | number | bigint): string {
  let value: bigint;
  try {
    value = BigInt(amount);
  } catch {
    return "—";
  }
  const negative = value < BigInt(0);
  if (negative) value = -value;
  const scale = BigInt(1_000_000);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

/** Micro-USD (the broker's price unit) formats the same way: both are 10⁻⁶ dollars. */
export function formatUsdMicros(micros: number): string {
  return formatUsdcUnits(Number.isSafeInteger(micros) ? micros : Math.round(micros));
}
