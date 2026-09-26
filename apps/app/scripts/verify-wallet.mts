/**
 * Manual end-to-end check of the browser payment path against a live broker.
 *
 * Runs the same pieces the app's wallet path uses — protocol's
 * `buyerX402Client` pinned to the frozen quote, `@x402/fetch`'s
 * `wrapFetchWithPayment`, the EIP-3009 `exact` scheme — and swaps only the one
 * thing a script cannot drive: instead of a Privy embedded wallet producing
 * the EIP-712 signature, a local key does. If the broker's facilitator settles
 * this, every step except the wallet's own signing prompt is verified.
 *
 * Network-bound and spends real (testnet) USDC, so it is not part of the test
 * suite. Usage, from apps/app:
 *
 *   BROKER=http://localhost:8402 XORV_DEMO_PAYER_KEY=0x… node scripts/verify-wallet.mts
 *
 * Optional: XORV_NETWORK (default eip155:10143), ADAPTER (default "echo").
 */
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { accountFromKey, buyerX402Client, explorerTx } from "@xorv/protocol/web";

const BROKER = (process.env.BROKER ?? "http://localhost:8402").replace(/\/+$/, "");
const NETWORK = process.env.XORV_NETWORK ?? "eip155:10143";
const KEY = process.env.XORV_DEMO_PAYER_KEY;
if (!KEY) {
  console.error("set XORV_DEMO_PAYER_KEY to a funded Monad testnet key");
  process.exit(2);
}

// Stands in for the Privy account: same { address, signTypedData } shape.
const account = accountFromKey(KEY);
console.log("payer            :", account.address);

// 1. quote
const quoteRes = await fetch(`${BROKER}/api/quotes`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Reply with exactly: WALLET", adapter: process.env.ADAPTER ?? "echo", maxPriceUsdMicros: 600000 }),
});
const quote = await quoteRes.json();
if (!quoteRes.ok) {
  console.error("quote failed     :", quote);
  process.exit(1);
}
console.log("quote            :", quote.quoteId, quote.priceLabel, "->", quote.provider.address);

// 2. pay through the real x402 client, refusing anything but the frozen quote
const client = buyerX402Client({
  signer: account,
  network: NETWORK,
  maxUsdcUnits: quote.usdcAmount,
  expect: { payTo: quote.provider.address, amount: quote.usdcAmount },
});
const paidFetch = wrapFetchWithPayment(fetch, client);
const res = await paidFetch(`${BROKER}/api/jobs/${quote.quoteId}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
const body = await res.json();
console.log("http             :", res.status);
const refusal = res.headers.get("PAYMENT-REQUIRED");
if (refusal) console.log("payment-required :", Buffer.from(refusal, "base64").toString("utf8").slice(0, 500));
if (!res.ok || !body.jobId) {
  console.error("FAILED           :", JSON.stringify(body));
  process.exit(1);
}
try {
  const settled = new x402HTTPClient(client).getPaymentSettleResponse((name) => res.headers.get(name));
  console.log("settlement       :", explorerTx(NETWORK, settled.transaction));
} catch {
  console.log("settlement       : (no PAYMENT-RESPONSE header)");
}
console.log("\n*** the wallet path settled on Monad ***");
console.log("job:", `${BROKER}/api/jobs/${body.jobId}`);
