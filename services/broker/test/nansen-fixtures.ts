/**
 * Tests only. Nansen-shaped answers with no network and no
 * money, for development, the test suite and a demo without mainnet funds.
 *
 * Every answer has the shape of the real response (see openapi.json and the
 * captured 402s' `bazaar` output schemas) and is a pure function of the
 * address and the clock, so the same wallet always gets the same profile.
 * Wallets fall into a few personas by the first byte of sha256(address):
 * a seasoned exchange-funded wallet, an ordinary one, a fresh one, and one
 * with no history on record. Nothing here is a real observation, and
 * nothing claims a payment: fixture signals carry `mode: "fixture"` and no
 * paid transactions.
 *
 * `cluster` makes a sybil ring on purpose: every address in it is given the
 * same unlabelled first funder, which is how a demo shows the broker
 * refusing a wash rating (`XORV_NANSEN_FIXTURE_CLUSTER=0xBuyer,0xProvider`).
 */

import { createHash } from "node:crypto";
import {
  NANSEN_PATHS,
  utcDay,
  type FirstFunderResponse,
  type NansenFixtureSource,
  type NansenPath,
  type RelatedWalletsResponse,
  type SmartMoneyResponse,
  type TransactionRow,
  type TransactionsResponse,
} from "../src/trust/nansen.js";

/** The exchange hot wallet Nansen's own documentation uses as its example address. */
const EXCHANGE_FUNDER = { address: "0x28C6c06298d514Db089934071355E5743bf21d60", name: "Binance 14" };
const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const DAY = 86_400_000;

export interface FixtureOptions {
  now?: () => number;
  /** Addresses that share one (unlabelled) first funder — a deliberate sybil ring. */
  cluster?: string[];
}

function digest(...parts: string[]): Buffer {
  return createHash("sha256").update(parts.join("|"), "utf8").digest();
}

function derivedAddress(...parts: string[]): string {
  return `0x${digest("addr", ...parts).subarray(0, 20).toString("hex")}`;
}

function derivedHash(...parts: string[]): string {
  return `0x${digest("tx", ...parts).toString("hex")}`;
}

type Persona = "seasoned" | "regular" | "fresh" | "blank";

interface Profile {
  persona: Persona;
  ageDays: number;
  funder: { address: string; name: string | null } | null;
  funderChain: string;
  txCount: number;
  related: number;
}

function profileFor(address: string, cluster: Set<string>, clusterFunder: string): Profile {
  const h = digest("profile", address.toLowerCase());
  const b0 = h[0]!;
  const b1 = h[1]!;
  const b2 = h[2]!;
  const persona: Persona = b0 < 64 ? "seasoned" : b0 < 160 ? "regular" : b0 < 224 ? "fresh" : "blank";
  const profile: Profile =
    persona === "seasoned"
      ? { persona, ageDays: 400 + ((b1 << 2) | (b2 & 3)), funder: EXCHANGE_FUNDER, funderChain: "ethereum", txCount: 40 + (b2 % 61), related: 1 + (b1 % 3) }
      : persona === "regular"
        ? {
            persona,
            ageDays: 45 + (b1 % 320),
            funder: b2 % 2 === 0 ? EXCHANGE_FUNDER : { address: derivedAddress("funder", address.toLowerCase()), name: null },
            funderChain: b2 % 3 === 0 ? "base" : "ethereum",
            txCount: 8 + (b2 % 40),
            related: b1 % 3,
          }
        : persona === "fresh"
          ? {
              persona,
              ageDays: 1 + (b1 % 12),
              funder: { address: derivedAddress("funder", address.toLowerCase()), name: null },
              funderChain: "monad",
              txCount: b2 % 5,
              related: 1,
            }
          : { persona, ageDays: 0, funder: null, funderChain: "monad", txCount: 0, related: 0 };
  if (cluster.has(address.toLowerCase())) {
    profile.funder = { address: clusterFunder, name: null };
    profile.funderChain = "monad";
    profile.related = Math.max(1, profile.related);
    if (profile.ageDays === 0) profile.ageDays = 3;
  }
  return profile;
}

/** Build the fixture source. */
export function createNansenFixtures(opts: FixtureOptions = {}): NansenFixtureSource {
  const now = opts.now ?? Date.now;
  const members = (opts.cluster ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean);
  const cluster = new Set(members);
  const clusterFunder = derivedAddress("cluster", ...[...cluster].sort());

  const firstFunder = (address: string): FirstFunderResponse => {
    const p = profileFor(address, cluster, clusterFunder);
    if (!p.funder) return { pagination: { page: 1, per_page: 10, is_last_page: true }, data: [] };
    return {
      pagination: { page: 1, per_page: 10, is_last_page: true },
      data: [
        {
          wallet_address: address.toLowerCase(),
          first_funder_address: p.funder.address.toLowerCase(),
          first_funder_name: p.funder.name,
          transaction_hash: derivedHash("funding", address.toLowerCase()),
          block_timestamp: new Date(now() - p.ageDays * DAY).toISOString().replace(/\.\d{3}Z$/, ""),
          chain: p.funderChain,
        },
      ],
    };
  };

  const relatedWallets = (address: string): RelatedWalletsResponse => {
    const p = profileFor(address, cluster, clusterFunder);
    const data: RelatedWalletsResponse["data"] = [];
    if (p.funder && p.related > 0) {
      data.push({
        address: p.funder.address.toLowerCase(),
        address_label: p.funder.name,
        relation: "First Funder",
        transaction_hash: derivedHash("funding", address.toLowerCase()),
        block_timestamp: new Date(now() - p.ageDays * DAY).toISOString().replace(/\.\d{3}Z$/, ""),
        order: 1,
        chain: "monad",
      });
    }
    for (let i = data.length; i < p.related; i++) {
      data.push({
        address: derivedAddress("related", address.toLowerCase(), String(i)),
        address_label: null,
        relation: i % 2 ? "Signer" : "Deployed Contract",
        transaction_hash: derivedHash("related", address.toLowerCase(), String(i)),
        block_timestamp: new Date(now() - Math.max(1, p.ageDays - 10 * i) * DAY).toISOString().replace(/\.\d{3}Z$/, ""),
        order: i + 1,
        chain: "monad",
      });
    }
    return { pagination: { page: 1, per_page: 100, is_last_page: true }, data };
  };

  const transactions = (address: string, lookbackDays: number): TransactionsResponse => {
    const p = profileFor(address, cluster, clusterFunder);
    const me = address.toLowerCase();
    const span = Math.max(1, Math.min(lookbackDays, p.ageDays || 1));
    const data: TransactionRow[] = [];
    for (let i = 0; i < Math.min(100, p.txCount); i++) {
      const h = digest("row", me, String(i));
      const counterparty = derivedAddress("cp", me, String(h[0]! % 12));
      const outgoing = h[1]! % 2 === 0;
      const value = Number((((h[2]! << 8) | h[3]!) / 100).toFixed(2));
      const leg = {
        token_symbol: "USDC",
        token_amount: value,
        token_address: MONAD_USDC,
        price_usd: 1,
        value_usd: value,
        chain: "monad",
        from_address: outgoing ? me : counterparty,
        to_address: outgoing ? counterparty : me,
        from_address_label: null,
        to_address_label: null,
      };
      data.push({
        chain: "monad",
        method: outgoing ? "transfer" : "receive",
        block_timestamp: new Date(now() - ((i * span * DAY) / Math.max(1, p.txCount) + (h[4]! * 60_000)))
          .toISOString()
          .replace(/\.\d{3}Z$/, ""),
        transaction_hash: derivedHash("row", me, String(i)),
        source_type: "Onchain",
        volume_usd: value,
        tokens_sent: outgoing ? [leg] : [],
        tokens_received: outgoing ? [] : [leg],
      });
    }
    return { pagination: { page: 1, per_page: 100, is_last_page: p.txCount < 100 }, data };
  };

  const smartMoney = (): SmartMoneyResponse => ({
    pagination: { page: 1, per_page: 1000, is_last_page: true },
    data: Array.from({ length: 25 }, (_, i) => ({
      address: derivedAddress("smart-money", utcDay(now()), String(i)),
      address_label: null,
      total_pnl_usd: 250_000 - i * 7_500,
    })),
  });

  return (path: NansenPath, body: Record<string, unknown>) => {
    switch (path) {
      case NANSEN_PATHS.firstFunder:
        return firstFunder(String(body.address));
      case NANSEN_PATHS.relatedWallets:
        return relatedWallets(String(body.wallet_address));
      case NANSEN_PATHS.transactions: {
        const date = body.date as { from: string; to: string };
        const days = Math.round((Date.parse(date.to) - Date.parse(date.from)) / DAY);
        return transactions(String(body.address), days);
      }
      case NANSEN_PATHS.smartMoney:
        return smartMoney();
      default:
        return null;
    }
  };
}
