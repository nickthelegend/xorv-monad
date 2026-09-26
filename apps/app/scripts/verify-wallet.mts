/**
 * Proves the wallet payment path end to end against the live facilitator.
 *
 * This runs the EXACT production code — buildTransferTransaction, the
 * ClientHederaSigner wrapper, ExactHederaScheme, wrapFetchWithPayment — and
 * swaps only the one thing a test runner cannot drive: instead of HashPack
 * producing the signature, a local key does. If the facilitator accepts this,
 * every step except the extension's own signing is verified.
 */
import { PrivateKey } from "@hashgraph/sdk";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createWalletHederaSigner, buildTransferTransaction } from "../lib/hedera-wallet.ts";

const BROKER = process.env.BROKER;
const ACCOUNT = process.env.XORV_DEMO_PAYER_ID;
const KEY = process.env.XORV_DEMO_PAYER_KEY;

function parseKey(raw) {
  const s = raw.trim();
  try { return PrivateKey.fromStringECDSA(s); } catch {}
  try { return PrivateKey.fromStringED25519(s); } catch {}
  return PrivateKey.fromStringDer(s);
}
const key = parseKey(KEY);

// Stands in for HashPack: same signature, same place in the flow.
const localWalletSign = async (tx) => tx.sign(key);

const signer = createWalletHederaSigner(ACCOUNT, localWalletSign);
console.log("signer.accountId :", signer.accountId);

// 1. quote
const quote = await (await fetch(`${BROKER}/api/quotes`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Reply with exactly: WALLET", adapter: "claude-code", maxPriceUsdMicros: 600000 }),
})).json();
console.log("quote            :", quote.quoteId, quote.priceLabel, "->", quote.provider.accountId);

// 2. pay through the real x402 client with our wallet-backed signer
const client = new x402Client().register("hedera:*", new ExactHederaScheme(signer));
const paidFetch = wrapFetchWithPayment(fetch, client);
const res = await paidFetch(`${BROKER}/api/jobs/${quote.quoteId}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
});
const body = await res.json();
console.log("http             :", res.status);
const hdr = res.headers.get("payment-required") || res.headers.get("Payment-Required");
if (hdr) {
  try {
    const decoded = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
    console.log("reject reason    :", JSON.stringify(decoded).slice(0, 500));
  } catch { console.log("payment-required :", hdr.slice(0, 300)); }
}
console.log("settled          :", JSON.stringify(body));
if (!res.ok || !body.jobId) { console.error("FAILED"); process.exit(1); }
console.log("\n*** the wallet path settled on Hedera ***");
console.log("job:", body.jobId);
