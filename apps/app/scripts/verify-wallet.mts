/**
 * Proves the browser payment path end to end against the live facilitator.
 *
 * A browser extension cannot be driven from a script, so the wallet click is
 * the one link that can only be verified by hand. This runs **everything
 * else** — the real `@x402/*` client, the real EVM exact scheme, the real
 * broker, the real facilitator, a real settlement on Arbitrum — and swaps in a local
 * key for the one function the extension provides.
 *
 * That substitution is exact rather than approximate, and it is worth being
 * precise about why. `WalletSession` is two members: an address, and
 * `signTypedData`. MetaMask implements the second with
 * `eth_signTypedData_v4`; `privateKeyToAccount().signTypedData` implements it
 * with the same EIP-712 hashing over the same struct. The bytes that reach the
 * facilitator are indistinguishable. If this passes, the only thing left
 * untested is whether the extension signs correctly, which is its job.
 *
 * Contrast with the Hedera version of this script, where the substitution was
 * *not* exact: a local key signs every candidate node's transaction body, while
 * HashPack signs only the first and the library merged that one signature into
 * all of them. That gap is precisely where the bug lived which this script
 * could not catch.
 *
 *   BROKER=https://…  pnpm dlx tsx apps/app/scripts/verify-wallet.mts
 */

import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { payQuoteWithWallet } from "../lib/pay-with-wallet.ts";
import type { WalletSession } from "../lib/wallet.ts";
import { XORV_CHAIN, explorerTx } from "../lib/chains.ts";

const env = Object.fromEntries(
  readFileSync(new URL("../../../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
) as Record<string, string>;

const BROKER = (process.env.BROKER ?? "http://localhost:8402").replace(/\/+$/, "");
const KEY = (process.env.XORV_DEMO_PAYER_KEY ?? env.XORV_DEMO_PAYER_KEY) as `0x${string}`;
if (!KEY) {
  console.error("Set XORV_DEMO_PAYER_KEY (or put it in .env).");
  process.exit(1);
}

const account = privateKeyToAccount(KEY);

/**
 * A `WalletSession` backed by a local key.
 *
 * Structurally identical to what `connectWallet()` returns — which is the whole
 * point: `payQuoteWithWallet` cannot tell the difference, so what runs below is
 * the production browser path with no test-only branch anywhere in it.
 */
const session: WalletSession = {
  address: account.address,
  chainId: XORV_CHAIN.id,
  signTypedData: (message) => account.signTypedData(message as never),
};

console.log(`\n  broker   ${BROKER}`);
console.log(`  payer    ${session.address}  (stands in for the wallet)\n`);

// 1. quote — the same public endpoint the composer calls
const quoteRes = await fetch(`${BROKER}/api/quotes`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    prompt: "Reply with exactly: WALLET",
    maxPriceUsdMicros: 600_000,
  }),
});
const quote = (await quoteRes.json()) as {
  quoteId?: string;
  priceLabel?: string;
  provider?: { address?: string };
  accepts?: Array<{ asset: string; amount: string; symbol?: string }>;
  error?: string;
};
if (!quoteRes.ok || !quote.quoteId) {
  console.error(`  ✖ no quote: ${quote.error ?? quoteRes.status}\n`);
  process.exit(1);
}
console.log(`  quote    ${quote.quoteId}  ${quote.priceLabel}  →  ${quote.provider?.address}`);

// 2. pay — production code, unmodified
try {
  const { jobId, transaction, asset } = await payQuoteWithWallet(session, BROKER, quote.quoteId, {
    accepts: quote.accepts,
    token: process.env.TOKEN ?? null,
  });
  console.log(`  paid     job ${jobId}${asset ? ` in ${asset}` : ""}`);
  if (transaction) {
    console.log(`  tx       ${explorerTx(transaction)}`);
  }
  console.log(`\n  ✔ the wallet path settled on ${XORV_CHAIN.name}\n`);
} catch (err) {
  console.error(`\n  ✖ payment failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
