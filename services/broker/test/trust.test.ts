/**
 * The Nansen integration, with no network and no money.
 *
 * The payment tests replay the 402s Nansen actually served on 2026-09-26
 * (test/fixtures/nansen/, byte-for-byte the `payment-required` payloads, all
 * eight `accepts` rows) through a mock `fetch`, and sign with a throwaway
 * key: the x402 client, its spend controls, policy and hooks are the real
 * ones, so what is asserted is exactly what would be sent to Nansen.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PaymentRequired } from "@x402/core/types";
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { RegisterRequest } from "@xorv/protocol";
import {
  MONAD_MAINNET_USDC,
  NANSEN_OBSERVED_PAY_TO,
  NANSEN_OFF,
  NANSEN_PATHS,
  NansenClient,
  NansenTrust,
  SpendBudget,
  TRUST_RULES,
  buildTrustSignal,
  createNansenFixtures,
  createNansenTrust,
  matchScore,
  publicTrustView,
  relatedParties,
  usdcString,
  validateNansenRequest,
  type CallResult,
  type FirstFunderResponse,
  type NansenPath,
  type RelatedWalletsResponse,
  type TransactionsResponse,
  type WalletLinks,
} from "../src/trust/index.js";
import { Registry } from "../src/registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-09-26T12:00:00Z");
const DAY = 86_400_000;
const WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const OTHER = "0x1111111111111111111111111111111111111111";

function captured(name: string): PaymentRequired {
  return JSON.parse(readFileSync(path.join(here, "fixtures", "nansen", `402-${name}.json`), "utf8")) as PaymentRequired;
}

const CAPTURED: Record<NansenPath, PaymentRequired> = {
  [NANSEN_PATHS.firstFunder]: captured("first-funder"),
  [NANSEN_PATHS.relatedWallets]: captured("related-wallets"),
  [NANSEN_PATHS.transactions]: captured("transactions"),
  [NANSEN_PATHS.smartMoney]: captured("sm-pnl-leaderboard"),
};

interface SeenCall {
  path: string;
  body: Record<string, unknown>;
  headers: Headers;
  payment: ReturnType<typeof decodePaymentSignatureHeader> | null;
}

/**
 * Nansen, as far as the client can tell: 402 with the captured requirements
 * for an unpaid POST, the data plus a settlement header for a paid one.
 */
function mockNansen(
  opts: {
    tamper?: (required: PaymentRequired, path: string) => PaymentRequired;
    settle?: "ok" | "fail" | "none";
    status?: number;
    apiKey?: boolean;
  } = {},
) {
  const calls: SeenCall[] = [];
  const data = createNansenFixtures({ now: () => NOW });
  let tx = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const signature = headers.get("payment-signature");
    calls.push({ path: url.pathname, body, headers, payment: signature ? decodePaymentSignatureHeader(signature) : null });
    const required = CAPTURED[url.pathname as NansenPath];
    if (!required) return new Response("not found", { status: 404 });
    if (opts.apiKey && headers.get("apikey")) {
      return Response.json(data(url.pathname as NansenPath, body));
    }
    if (!signature) {
      const offered = opts.tamper ? opts.tamper(structuredClone(required), url.pathname) : required;
      return new Response(JSON.stringify(offered), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "payment-required": Buffer.from(JSON.stringify(offered)).toString("base64"),
        },
      });
    }
    const out = new Headers({ "content-type": "application/json" });
    if (opts.settle !== "none") {
      tx += 1;
      out.set(
        "payment-response",
        encodePaymentResponseHeader({
          success: opts.settle !== "fail",
          transaction: opts.settle === "fail" ? "" : `0x${tx.toString(16).padStart(64, "a")}`,
          network: "eip155:143",
          payer: headers.get("x-payer-address") ?? undefined,
          ...(opts.settle === "fail" ? { errorReason: "invalid_exact_evm_insufficient_balance" } : {}),
        } as Parameters<typeof encodePaymentResponseHeader>[0]),
      );
    }
    const status = opts.status ?? 200;
    return new Response(status === 200 ? JSON.stringify(data(url.pathname as NansenPath, body)) : "upstream error", {
      status,
      headers: out,
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const refusingSigner = {
  address: "0x000000000000000000000000000000000000dEaD" as const,
  signTypedData: async () => {
    throw new Error("the stub signer refuses to sign");
  },
};

function monadRow(required: PaymentRequired) {
  return required.accepts.find((r) => r.network === "eip155:143")!;
}

// ---------------------------------------------------------------------------
// Payment gating
// ---------------------------------------------------------------------------

describe("paying Nansen over x402", () => {
  it("offers eight rows and pays only the Monad mainnet USDC one, at the captured price, to the captured payee", async () => {
    expect(CAPTURED[NANSEN_PATHS.firstFunder].accepts).toHaveLength(8);
    const signer = privateKeyToAccount(generatePrivateKey());
    const nansen = mockNansen();
    const client = new NansenClient({ mode: "live", signer, fetch: nansen.fetch, now: () => NOW });

    const result = await client.firstFunder(WALLET);
    expect(result.ok).toBe(true);
    expect(nansen.calls).toHaveLength(2);
    const [unpaid, paid] = nansen.calls;
    expect(unpaid!.payment).toBeNull();
    expect(unpaid!.headers.get("x-payer-address")).toBe(signer.address);
    expect(unpaid!.body).toEqual({ address: WALLET, chain: "all" });
    // The retry carries the same body and an EIP-3009 authorization for chain 143.
    expect(paid!.body).toEqual(unpaid!.body);
    const payment = paid!.payment!;
    expect(payment.x402Version).toBe(2);
    expect(payment.accepted).toMatchObject({
      scheme: "exact",
      network: "eip155:143",
      asset: MONAD_MAINNET_USDC,
      amount: "10000",
      payTo: NANSEN_OBSERVED_PAY_TO,
    });
    const auth = (payment.payload as { authorization: { from: string; to: string; value: string } }).authorization;
    expect(auth.from).toBe(signer.address);
    expect(auth.to).toBe(NANSEN_OBSERVED_PAY_TO);
    expect(auth.value).toBe("10000");

    // The settlement is captured as a Monad mainnet explorer link.
    if (!result.ok) throw new Error("unreachable");
    expect(result.paid).toMatchObject({ endpoint: NANSEN_PATHS.firstFunder, amountUnits: "10000", network: "eip155:143" });
    expect(result.paid!.url).toBe(`https://monadscan.com/tx/${result.paid!.txHash}`);
    expect(client.budget.spentToday()).toBe(10_000n);
    expect(client.usageToday()).toMatchObject({ calls: 1, paidCalls: 1 });
  });

  it("will not pay when the Monad row is missing — no other network is registered", async () => {
    const nansen = mockNansen({
      tamper: (r) => ({ ...r, accepts: r.accepts.filter((row) => row.network !== "eip155:143") }),
    });
    const client = new NansenClient({ mode: "live", signer: refusingSigner, fetch: nansen.fetch, now: () => NOW });
    const result = await client.relatedWallets(WALLET);
    expect(result.ok).toBe(false);
    expect(nansen.calls).toHaveLength(1);
    expect(client.budget.spentToday()).toBe(0n);
  });

  it("will not pay a different token on Monad", async () => {
    const nansen = mockNansen({
      tamper: (r) => {
        monadRow(r).asset = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
        return r;
      },
    });
    const client = new NansenClient({ mode: "live", signer: refusingSigner, fetch: nansen.fetch, now: () => NOW });
    expect((await client.relatedWallets(WALLET)).ok).toBe(false);
    expect(nansen.calls).toHaveLength(1);
  });

  it("aborts before signing when an endpoint's price rises above the table", async () => {
    const nansen = mockNansen({
      tamper: (r) => {
        monadRow(r).amount = "20000";
        return r;
      },
    });
    const client = new NansenClient({ mode: "live", signer: refusingSigner, fetch: nansen.fetch, now: () => NOW });
    const result = await client.firstFunder(WALLET);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(/costs 20000 units, above the 10000 on record/);
    expect(nansen.calls).toHaveLength(1);
    expect(client.budget.spentToday()).toBe(0n);
  });

  it("pays the $0.05 smart-money list only while the per-call cap allows it", async () => {
    const nansen = mockNansen();
    const signer = privateKeyToAccount(generatePrivateKey());
    const ok = new NansenClient({ mode: "live", signer, fetch: nansen.fetch, now: () => NOW });
    expect((await ok.smartMoney()).ok).toBe(true);
    expect(ok.budget.spentToday()).toBe(50_000n);

    const capped = new NansenClient({ mode: "live", signer, fetch: nansen.fetch, now: () => NOW, perCallCapUnits: 10_000n });
    const refused = await capped.smartMoney();
    expect(refused.ok).toBe(false);
    expect(capped.budget.spentToday()).toBe(0n);
  });

  it("refuses a swapped payee when payTo is pinned", async () => {
    const nansen = mockNansen({
      tamper: (r) => {
        monadRow(r).payTo = OTHER;
        return r;
      },
    });
    const pinned = new NansenClient({
      mode: "live",
      signer: refusingSigner,
      fetch: nansen.fetch,
      now: () => NOW,
      pinPayTo: NANSEN_OBSERVED_PAY_TO,
    });
    expect((await pinned.firstFunder(WALLET)).ok).toBe(false);
    expect(nansen.calls).toHaveLength(1);
  });

  it("refuses a 402 that names a different resource than the one requested", async () => {
    const nansen = mockNansen({
      tamper: (r) => ({ ...r, resource: { ...r.resource, url: "https://api.nansen.ai/api/v1/profiler/address/labels" } }),
    });
    const client = new NansenClient({ mode: "live", signer: refusingSigner, fetch: nansen.fetch, now: () => NOW });
    const result = await client.firstFunder(WALLET);
    expect(!result.ok && result.error).toMatch(/refusing to pay/);
  });

  it("reserves against the daily budget and stops when it is spent", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const nansen = mockNansen();
    const client = new NansenClient({ mode: "live", signer, fetch: nansen.fetch, now: () => NOW, dailyCapUnits: 15_000n });
    expect((await client.firstFunder(WALLET)).ok).toBe(true);
    const second = await client.firstFunder(OTHER);
    expect(!second.ok && second.error).toMatch(/daily Nansen budget/);
    expect(client.budget.spentToday()).toBe(10_000n);
    expect(nansen.calls.filter((c) => c.payment)).toHaveLength(1);
  });

  it("releases the reservation when signing fails", async () => {
    const nansen = mockNansen();
    const client = new NansenClient({ mode: "live", signer: refusingSigner, fetch: nansen.fetch, now: () => NOW });
    const result = await client.firstFunder(WALLET);
    expect(result.ok).toBe(false);
    expect(client.budget.spentToday()).toBe(0n);
  });

  it("releases the reservation when settlement fails, and keeps it when the outcome is unknown", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const failed = new NansenClient({ mode: "live", signer, fetch: mockNansen({ settle: "fail", status: 402 }).fetch, now: () => NOW });
    expect((await failed.firstFunder(WALLET)).ok).toBe(false);
    expect(failed.budget.spentToday()).toBe(0n);

    // A paid call that errors with no settlement header may still have been
    // charged — the budget assumes it was.
    const unknown = new NansenClient({ mode: "live", signer, fetch: mockNansen({ settle: "none", status: 500 }).fetch, now: () => NOW });
    expect((await unknown.firstFunder(WALLET)).ok).toBe(false);
    expect(unknown.budget.spentToday()).toBe(10_000n);
  });

  it("uses the API key instead of paying when one is configured", async () => {
    const nansen = mockNansen({ apiKey: true });
    const client = new NansenClient({
      mode: "live",
      apiKey: "test-key",
      signer: refusingSigner,
      fetch: nansen.fetch,
      now: () => NOW,
    });
    expect(client.auth).toBe("api-key");
    const result = await client.firstFunder(WALLET);
    expect(result.ok).toBe(true);
    expect(nansen.calls).toHaveLength(1);
    expect(nansen.calls[0]!.headers.get("apikey")).toBe("test-key");
    expect(nansen.calls[0]!.headers.get("x-payer-address")).toBeNull();
    expect(client.budget.spentToday()).toBe(0n);
  });
});

describe("SpendBudget", () => {
  it("reserves, releases and resets at UTC midnight", () => {
    let now = NOW;
    const budget = new SpendBudget(30_000n, () => now);
    expect(budget.tryReserve(10_000n)).toBe(true);
    expect(budget.tryReserve(20_000n)).toBe(true);
    expect(budget.tryReserve(1n)).toBe(false);
    budget.release(20_000n);
    expect(budget.spentToday()).toBe(10_000n);
    budget.release(99_999n);
    expect(budget.spentToday()).toBe(0n);
    expect(budget.tryReserve(30_000n)).toBe(true);
    now += DAY;
    expect(budget.spentToday()).toBe(0n);
    expect(budget.tryReserve(30_000n)).toBe(true);
  });

  it("formats USDC units", () => {
    expect(usdcString(30_000n)).toBe("0.03");
    expect(usdcString(15_000n)).toBe("0.015");
    expect(usdcString(1_000_000n)).toBe("1.00");
    expect(usdcString(0n)).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// Local validation, cache, de-duplication, concurrency
// ---------------------------------------------------------------------------

describe("request validation (Nansen charges before it validates)", () => {
  it("accepts the bodies the client sends and rejects what Nansen would refuse after payment", () => {
    expect(validateNansenRequest(NANSEN_PATHS.firstFunder, { address: WALLET, chain: "all" })).toBeNull();
    expect(validateNansenRequest(NANSEN_PATHS.firstFunder, { address: WALLET, chain: "monad" })).toMatch(/"all"/);
    expect(validateNansenRequest(NANSEN_PATHS.firstFunder, {})).toMatch(/EVM address/);
    expect(validateNansenRequest(NANSEN_PATHS.relatedWallets, { wallet_address: WALLET, chain: "monad-testnet" })).toMatch(
      /unsupported chain/,
    );
    expect(
      validateNansenRequest(NANSEN_PATHS.relatedWallets, { wallet_address: WALLET, chain: "monad", pagination: { per_page: 5000 } }),
    ).toMatch(/per_page/);
    const tx = { address: WALLET, chain: "monad", date: { from: "2026-06-28", to: "2026-09-26" } };
    expect(validateNansenRequest(NANSEN_PATHS.transactions, tx)).toBeNull();
    expect(validateNansenRequest(NANSEN_PATHS.transactions, { ...tx, date: { from: "2024-01-01", to: "2026-09-26" } })).toMatch(
      /one year/,
    );
    expect(validateNansenRequest(NANSEN_PATHS.transactions, { ...tx, date: { from: "2026-09-27", to: "2026-09-26" } })).toMatch(
      /after/,
    );
    expect(validateNansenRequest(NANSEN_PATHS.transactions, { ...tx, pagination: { per_page: 101 } })).toMatch(/per_page/);
    expect(validateNansenRequest(NANSEN_PATHS.smartMoney, { chains: ["monad"], timeframe: 30 })).toBeNull();
    expect(validateNansenRequest(NANSEN_PATHS.smartMoney, { chains: ["monad"], timeframe: 14 })).toMatch(/timeframe/);
    expect(validateNansenRequest("/api/v1/profiler/address/labels", { address: WALLET })).toMatch(/unknown/);
  });

  it("never sends (or pays for) an invalid request", async () => {
    const nansen = mockNansen();
    const client = new NansenClient({ mode: "live", signer: refusingSigner, fetch: nansen.fetch, now: () => NOW });
    const result = await client.firstFunder("0xnot-an-address");
    expect(!result.ok && result.error).toMatch(/invalid request, not sent/);
    expect(nansen.calls).toHaveLength(0);
  });
});

describe("cache and de-duplication", () => {
  it("shares one request between concurrent callers and reuses it until the TTL runs out", async () => {
    let now = NOW;
    const nansen = mockNansen({ apiKey: true });
    const client = new NansenClient({ mode: "live", apiKey: "k", fetch: nansen.fetch, now: () => now });
    const [a, b] = await Promise.all([client.firstFunder(WALLET), client.firstFunder(WALLET.toLowerCase())]);
    expect(a.ok && b.ok).toBe(true);
    expect(nansen.calls).toHaveLength(1);

    const cached = await client.firstFunder(WALLET);
    expect(cached.ok && cached.cached).toBe(true);
    expect(nansen.calls).toHaveLength(1);

    // Transactions expire after an hour, first funders after a week.
    await client.transactions(WALLET);
    now += 2 * 3_600_000;
    await client.transactions(WALLET);
    await client.firstFunder(WALLET);
    expect(nansen.calls.map((c) => c.path)).toEqual([
      NANSEN_PATHS.firstFunder,
      NANSEN_PATHS.transactions,
      NANSEN_PATHS.transactions,
    ]);
  });

  it("keeps the paid tx with the cached answer, so a cache hit still shows what bought it", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const nansen = mockNansen();
    const client = new NansenClient({ mode: "live", signer, fetch: nansen.fetch, now: () => NOW });
    const first = await client.firstFunder(WALLET);
    const again = await client.firstFunder(WALLET);
    expect(again.ok && again.cached).toBe(true);
    expect(again.ok && again.paid?.txHash).toBe(first.ok && first.paid?.txHash);
    expect(client.budget.spentToday()).toBe(10_000n);
  });

  it("runs at most two requests at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const data = createNansenFixtures({ now: () => NOW });
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      const url = new URL(String(input));
      return Response.json(data(url.pathname as NansenPath, JSON.parse(String(init?.body))));
    }) as typeof fetch;
    const client = new NansenClient({ mode: "live", apiKey: "k", fetch: slow, now: () => NOW });
    const addresses = Array.from({ length: 6 }, (_, i) => `0x${String(i + 1).repeat(40)}`);
    const results = await Promise.all(addresses.map((a) => client.firstFunder(a)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(2);
  });

  it("cools down after a 429 instead of hammering the per-wallet limit", async () => {
    let calls = 0;
    const limited = (async () => {
      calls += 1;
      return new Response("slow down", { status: 429, headers: { "retry-after": "5" } });
    }) as typeof fetch;
    let now = NOW;
    const client = new NansenClient({ mode: "live", apiKey: "k", fetch: limited, now: () => now });
    expect((await client.firstFunder(WALLET)).ok).toBe(false);
    const cooling = await client.firstFunder(OTHER);
    expect(!cooling.ok && cooling.error).toMatch(/cooling down/);
    expect(calls).toBe(1);
    now += 6_000;
    await client.firstFunder(OTHER);
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Scoring, degradation and the public view
// ---------------------------------------------------------------------------

function ok<T>(data: T, paid: Parameters<typeof okPaid>[1] = null): CallResult<T> {
  return okPaid(data, paid);
}
function okPaid<T>(data: T, paid: { txHash: string; amountUnits: string } | null): CallResult<T> {
  return {
    ok: true,
    data,
    cached: false,
    paid: paid
      ? {
          txHash: paid.txHash,
          url: `https://monadscan.com/tx/${paid.txHash}`,
          endpoint: NANSEN_PATHS.firstFunder,
          amountUnits: paid.amountUnits,
          network: "eip155:143",
          at: NOW,
        }
      : null,
  };
}
const failed = <T>(error = "boom"): CallResult<T> => ({ ok: false, error });

function funded(ageDays: number, funder = OTHER, name: string | null = null): FirstFunderResponse {
  return {
    pagination: { is_last_page: true },
    data: [
      {
        wallet_address: WALLET.toLowerCase(),
        first_funder_address: funder,
        first_funder_name: name,
        transaction_hash: `0x${"f".repeat(64)}`,
        block_timestamp: new Date(NOW - ageDays * DAY).toISOString(),
        chain: "ethereum",
      },
    ],
  };
}
function related(rows: Array<{ address: string; relation: string; label?: string | null }>): RelatedWalletsResponse {
  return {
    pagination: { is_last_page: true },
    data: rows.map((r, i) => ({
      address: r.address,
      address_label: r.label ?? null,
      relation: r.relation,
      transaction_hash: `0x${String(i).repeat(64)}`,
      block_timestamp: new Date(NOW - DAY).toISOString(),
      order: i + 1,
      chain: "monad",
    })),
  };
}
function activity(n: number, counterpartyLabel: string | null = null, ownLabel: string | null = null): TransactionsResponse {
  return {
    pagination: { is_last_page: true },
    data: Array.from({ length: n }, (_, i) => ({
      chain: "monad",
      method: "transfer",
      block_timestamp: new Date(NOW - i * DAY).toISOString(),
      transaction_hash: `0x${i.toString(16).padStart(64, "0")}`,
      source_type: "Onchain",
      tokens_sent: [
        {
          from_address: WALLET,
          to_address: OTHER,
          from_address_label: ownLabel,
          to_address_label: counterpartyLabel,
        },
      ],
      tokens_received: [],
    })),
  };
}
const empty = <T>(): T => ({ pagination: { is_last_page: true }, data: [] }) as unknown as T;

describe("the trust score", () => {
  it("rewards an old, exchange-funded, active wallet", () => {
    const signal = buildTrustSignal({
      address: WALLET,
      mode: "live",
      now: NOW,
      firstFunder: ok(funded(800, "0x28C6c06298d514Db089934071355E5743bf21d60", "Binance 14")),
      relatedWallets: ok(empty<RelatedWalletsResponse>()),
      transactions: ok(activity(60)),
    });
    expect(signal.score).toBe(
      TRUST_RULES.base + TRUST_RULES.age.year + TRUST_RULES.exchangeFunded + TRUST_RULES.activity.busy,
    );
    expect(signal.walletAgeDays).toBe(800);
    expect(signal.firstFunder).toMatchObject({ label: "Binance 14" });
    expect(signal.labels).toContain("funded by Binance 14");
    expect(signal.degraded).toBe(false);
  });

  it("marks a wallet created this week down, and a risky counterparty down further", () => {
    const fresh = buildTrustSignal({
      address: WALLET,
      mode: "live",
      now: NOW,
      firstFunder: ok(funded(2)),
      relatedWallets: ok(empty<RelatedWalletsResponse>()),
      transactions: ok(activity(3, "Tornado Cash: Router")),
    });
    expect(fresh.score).toBe(TRUST_RULES.base + TRUST_RULES.age.week + TRUST_RULES.riskEach);
    expect(fresh.riskFlags).toEqual(["counterparty: Tornado Cash: Router"]);
  });

  it("never penalises missing data: no history is a neutral 50", () => {
    const blank = buildTrustSignal({
      address: WALLET,
      mode: "live",
      now: NOW,
      firstFunder: ok(empty<FirstFunderResponse>()),
      relatedWallets: ok(empty<RelatedWalletsResponse>()),
      transactions: ok(empty<TransactionsResponse>()),
    });
    expect(blank.score).toBe(50);
    expect(blank.degraded).toBe(false);
    expect(publicTrustView(blank).band).toBe("unknown");
  });

  it("degrades to exactly 50 when every call fails, with no matching opinion", () => {
    const down = buildTrustSignal({
      address: WALLET,
      mode: "live",
      now: NOW,
      firstFunder: failed(),
      relatedWallets: failed(),
      transactions: failed(),
    });
    expect(down.score).toBe(50);
    expect(down.degraded).toBe(true);
    expect(matchScore(down)).toBeNull();
    expect(publicTrustView(down).band).toBe("unknown");
  });

  it("scores what it could learn when only some calls fail", () => {
    const partial = buildTrustSignal({
      address: WALLET,
      mode: "live",
      now: NOW,
      firstFunder: ok(funded(500)),
      relatedWallets: failed(),
      transactions: failed(),
    });
    expect(partial.score).toBe(TRUST_RULES.base + TRUST_RULES.age.year);
    expect(partial.degraded).toBe(true);
    expect(matchScore(partial)).toBe(partial.score);
  });

  it("keeps smart-money wording out of labels and uses membership only internally", () => {
    const signal = buildTrustSignal({
      address: WALLET,
      mode: "live",
      now: NOW,
      firstFunder: ok(funded(100)),
      relatedWallets: ok(empty<RelatedWalletsResponse>()),
      transactions: ok(activity(1, null, "Smart Trader")),
      smartMoney: new Set([WALLET.toLowerCase()]),
    });
    expect(signal.labels.some((l) => /smart/i.test(l))).toBe(false);
    expect(signal.smartMoney).toBe(true);
    expect(matchScore(signal)).toBe(signal.score + 5);
  });
});

describe("publicTrustView", () => {
  it("strips smart-money, related-wallet addresses and errors, and attributes Nansen", () => {
    const signal = buildTrustSignal({
      address: WALLET,
      mode: "live",
      now: NOW,
      firstFunder: ok(funded(400), { txHash: `0x${"1".repeat(64)}`, amountUnits: "10000" }),
      relatedWallets: okPaid(related([{ address: "0x0000000000000000000000000000000000c0ffee", relation: "Signer" }]), {
        txHash: `0x${"2".repeat(64)}`,
        amountUnits: "10000",
      }),
      transactions: okPaid(activity(12), { txHash: `0x${"3".repeat(64)}`, amountUnits: "10000" }),
      smartMoney: new Set([WALLET.toLowerCase()]),
    });
    const view = publicTrustView(signal);
    const wire = JSON.stringify(view);
    expect(wire).not.toContain("smartMoney");
    expect(wire).not.toContain("relatedWallets");
    expect(wire).not.toContain("0x0000000000000000000000000000000000c0ffee");
    expect(wire).not.toContain("errors");
    expect(view).toMatchObject({
      attribution: "Powered by Nansen",
      attributionUrl: "https://nansen.ai",
      relatedWalletCount: 1,
      paidUsdc: "0.03",
      source: "nansen",
    });
    expect(view.paidTx.map((p) => p.url)).toEqual([
      `https://monadscan.com/tx/0x${"1".repeat(64)}`,
      `https://monadscan.com/tx/0x${"2".repeat(64)}`,
      `https://monadscan.com/tx/0x${"3".repeat(64)}`,
    ]);
    expect(view.firstFunder?.url).toBe(`https://monadscan.com/address/${OTHER}`);
  });
});

// ---------------------------------------------------------------------------
// Related parties
// ---------------------------------------------------------------------------

describe("relatedParties", () => {
  const A = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
  const B = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
  const F = "0xf000000000000000000000000000000000000001";
  const EXCHANGE = "0x28C6c06298d514Db089934071355E5743bf21d60";
  const links = (address: string, funder: string | null = null, label: string | null = null, rel: WalletLinks["relatedWallets"] = []) =>
    ({
      address,
      firstFunder: funder ? { address: funder, label, chain: "ethereum", txHash: null, at: null } : null,
      relatedWallets: rel,
    }) satisfies WalletLinks;

  const cases: Array<[string, WalletLinks, WalletLinks, boolean, string | null]> = [
    ["the same wallet", links(A), links(A.toLowerCase()), true, "same-wallet"],
    ["B first funded A", links(A, B), links(B), true, "funded-by"],
    ["A first funded B", links(A), links(B, A.toLowerCase()), true, "funded-by"],
    ["a shared unlabelled first funder", links(A, F), links(B, F), true, "shared-funder"],
    ["a shared exchange hot wallet", links(A, EXCHANGE, "Binance 14"), links(B, EXCHANGE, "Binance 14"), false, null],
    ["a shared bridge relayer", links(A, F, "Across Protocol: Relayer"), links(B, F, "Across Protocol: Relayer"), false, null],
    ["A lists B as a related wallet", links(A, null, null, [{ address: B, relation: "Signer", label: null }]), links(B), true, "related-wallets"],
    ["B lists A as a related wallet", links(A), links(B, null, null, [{ address: A, relation: "Deployed via", label: null }]), true, "related-wallets"],
    [
      "the same Monad first funder in both related lists",
      links(A, null, null, [{ address: F, relation: "First Funder", label: null }]),
      links(B, null, null, [{ address: F, relation: "First Funder", label: null }]),
      true,
      "shared-funder",
    ],
    [
      "the same exchange as Monad first funder",
      links(A, null, null, [{ address: EXCHANGE, relation: "First Funder", label: "Binance 14" }]),
      links(B, null, null, [{ address: EXCHANGE, relation: "First Funder", label: "Binance 14" }]),
      false,
      null,
    ],
    ["unrelated wallets", links(A, F), links(B, OTHER), false, null],
    ["no data at all", links(A), links(B), false, null],
  ];

  it.each(cases)("%s", (_name, a, b, isRelated, kind) => {
    const verdict = relatedParties(a, b);
    expect(verdict.related).toBe(isRelated);
    if (kind) expect(verdict.reasons.map((r) => r.kind)).toContain(kind);
    else expect(verdict.reasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The service: fixture mode, degradation, the rating check
// ---------------------------------------------------------------------------

describe("NansenTrust", () => {
  const fixture = (cluster: string[] = []) =>
    createNansenTrust({ ...NANSEN_OFF, mode: "fixture", fixtureCluster: cluster }, { now: () => NOW });

  it("is deterministic in fixture mode, pays nothing and claims no payment", async () => {
    const a = await fixture().signal(WALLET);
    const b = await fixture().signal(WALLET);
    expect(a).toEqual(b);
    expect(a.mode).toBe("fixture");
    expect(a.paidTx).toEqual([]);
    expect(a.degraded).toBe(false);
    const sample = await Promise.all(
      Array.from({ length: 12 }, (_, i) => fixture().signal(`0x${(i + 10).toString(16).padStart(40, "0")}`)),
    );
    expect(new Set(sample.map((s) => `${s.score}:${s.firstSeen}`)).size).toBeGreaterThan(3);
    const trust = fixture();
    await trust.signal(WALLET);
    expect(trust.status()).toMatchObject({ mode: "fixture", auth: "fixture", spentTodayUsdc: "0.00", lastPaidTx: null });
    expect(trust.status().callsToday).toBeGreaterThanOrEqual(3);
  });

  it("returns no public signal and no opinion when off", async () => {
    const off = createNansenTrust();
    expect(off.enabled).toBe(false);
    expect(off.ratingGuard).toBe(false);
    off.watch(WALLET);
    expect(off.publicSignal(WALLET)).toBeNull();
    expect(off.matchScore(WALLET)).toBeNull();
    expect(off.status()).toMatchObject({ mode: "off", auth: "none", callsToday: 0 });
  });

  it("degrades to a neutral 50 when Nansen is unreachable", async () => {
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    const trust = createNansenTrust({ ...NANSEN_OFF, mode: "live", apiKey: "k" }, { fetch: down, now: () => NOW });
    const signal = await trust.signal(WALLET);
    expect(signal).toMatchObject({ score: 50, degraded: true });
    expect(trust.matchScore(WALLET)).toBeNull();
    expect(trust.publicSignal(WALLET)).toMatchObject({ score: 50, degraded: true, band: "unknown" });
    expect(trust.status().lastError).toMatch(/ECONNRESET/);
    const check = await trust.checkRelated(WALLET, OTHER);
    expect(check).toMatchObject({ related: false, degraded: true });
  });

  it("refuses the cluster and passes strangers in the rating check", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey()).address;
    const provider = privateKeyToAccount(generatePrivateKey()).address;
    const trust = fixture([buyer, provider]);
    const refused = await trust.checkRelated(buyer, provider);
    expect(refused.related).toBe(true);
    expect(refused.reasons.map((r) => r.kind)).toContain("shared-funder");

    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const passed = await trust.checkRelated(stranger, provider);
    expect(passed.related).toBe(false);
    expect(trust.status()).toMatchObject({ ratingChecks: 2, ratingsRefused: 1 });

    expect((await trust.checkRelated(provider, provider)).reasons[0]!.kind).toBe("same-wallet");
  });

  it("bounds the rating check by a timeout and does not refuse on it", async () => {
    const hang = (() => new Promise<Response>(() => {})) as typeof fetch;
    const trust = createNansenTrust({ ...NANSEN_OFF, mode: "live", apiKey: "k" }, { fetch: hang, now: () => NOW });
    const check = await trust.checkRelated(WALLET, OTHER, { timeoutMs: 30 });
    expect(check).toMatchObject({ related: false, degraded: true, errors: ["Nansen lookup timed out"] });
  });

  it("builds one signal per wallet however many times it is watched", async () => {
    let calls = 0;
    const data = createNansenFixtures({ now: () => NOW });
    const counting = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      return Response.json(data(new URL(String(input)).pathname as NansenPath, JSON.parse(String(init?.body))));
    }) as typeof fetch;
    const trust = new NansenTrust({
      client: new NansenClient({ mode: "live", apiKey: "k", fetch: counting, now: () => NOW }),
      smartMoney: false,
      now: () => NOW,
    });
    trust.watch(WALLET);
    trust.watch(WALLET);
    await trust.signal(WALLET);
    trust.watch(WALLET);
    expect(calls).toBe(3);
    expect(trust.peek(WALLET)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

describe("trust as a matching tie-breaker", () => {
  const registration = (label: string, address: string, price: number): RegisterRequest & { agentId: null } => ({
    label,
    address,
    agentId: null,
    endpoint: "http://localhost:1",
    capabilities: [{ id: "echo", adapter: "echo", displayName: "Echo", model: null, priceUsdMicros: price, maxConcurrency: 1 }],
    version: "test",
    region: null,
    nodeId: `node-${label}`,
  }) as RegisterRequest & { agentId: null };

  it("orders equally priced, equally proven providers by wallet trust — and never over price", () => {
    const registry = new Registry();
    const low = registry.register(registration("low", "0x000000000000000000000000000000000000000A", 1_000));
    const high = registry.register(registration("high", "0x000000000000000000000000000000000000000B", 1_000));
    const cheap = registry.register(registration("cheap", "0x000000000000000000000000000000000000000C", 900));
    const scores: Record<string, number | null> = { [low.address]: 20, [high.address]: 90, [cheap.address]: 0 };
    registry.setTrustScorer((a) => scores[a] ?? null);
    expect(registry.candidates({ maxPriceUsdMicros: 5_000 }).map((m) => m.provider.label)).toEqual(["cheap", "high", "low"]);

    registry.setTrustScorer(null);
    // Without trust, the tie falls through to the existing order (activeJobs, then insertion).
    expect(registry.candidates({ maxPriceUsdMicros: 5_000 })[0]!.provider.label).toBe("cheap");
  });

  it("never lets trust outrank a real track record", () => {
    const registry = new Registry();
    const proven = registry.register(registration("proven", "0x000000000000000000000000000000000000000D", 1_000));
    const shiny = registry.register(registration("shiny", "0x000000000000000000000000000000000000000E", 1_000));
    registry.jobStarted(proven.id);
    registry.jobFinished(proven.id, { ok: true, durationMs: 10 });
    registry.setTrustScorer((a) => (a === shiny.address ? 100 : 0));
    expect(registry.candidates({ maxPriceUsdMicros: 5_000 })[0]!.provider.label).toBe("proven");
  });

  it("treats an unknown wallet as neutral", () => {
    const registry = new Registry();
    const known = registry.register(registration("known", "0x000000000000000000000000000000000000000F", 1_000));
    registry.register(registration("unknown", "0x0000000000000000000000000000000000000010", 1_000));
    registry.setTrustScorer((a) => (a === known.address ? 40 : null));
    expect(registry.candidates({ maxPriceUsdMicros: 5_000 })[0]!.provider.label).toBe("unknown");
  });
});
