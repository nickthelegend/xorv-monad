/**
 * The deployment's demo account — server-only.
 *
 * A visitor without Privy configured, or without a funded wallet, can still
 * watch a real job settle: the app holds one testnet key and pays (or rates)
 * from it on their behalf. The UI labels that path "Pay from demo account" so
 * nobody mistakes it for their own money, and it exists only on testnet — a
 * mainnet deployment refuses outright rather than spend real USDC for anyone
 * who can reach the route.
 *
 * The key is read per request and never leaves this module: the routes get a
 * viem account (address + signer), and error messages never echo the value.
 * Nothing here is imported by client code.
 */

import type { PrivateKeyAccount } from "viem";
import { DEFAULT_NETWORK, accountFromKey, isSupportedNetwork, networkConfig, type MonadNetwork } from "@xorv/protocol/web";
import { errorMessage } from "@/lib/errors";
import { demoReceiptSecret } from "@/lib/server/demo-guard";

/**
 * Default per-payment ceiling: $0.50 in USDC units — the composer's default
 * max price. The route is unauthenticated, so this cap (plus the broker's
 * quote rate limit) is what bounds how fast anyone can spend the demo float.
 */
const DEFAULT_MAX_USDC_UNITS = "500000";

export interface DemoPayer {
  account: PrivateKeyAccount;
  network: MonadNetwork;
  brokerUrl: string;
  maxUsdcUnits: string;
  /**
   * HMAC key for demo receipts (lib/server/demo-guard.ts): derived one-way
   * from the key unless `XORV_DEMO_RECEIPT_SECRET` is set, so the key itself
   * still never leaves this module.
   */
  receiptSecret: Buffer;
}

export type DemoPayerResult = { ok: true; payer: DemoPayer } | { ok: false; status: number; error: string };

/** The network the server acts on: `XORV_NETWORK`, else the one the browser was built for. */
function serverNetwork(): string {
  return process.env.XORV_NETWORK?.trim() || process.env.NEXT_PUBLIC_XORV_NETWORK?.trim() || DEFAULT_NETWORK;
}

export function loadDemoPayer(): DemoPayerResult {
  const network = serverNetwork();
  if (!isSupportedNetwork(network)) {
    return { ok: false, status: 500, error: `XORV_NETWORK="${network}" is not a Monad network (use eip155:10143).` };
  }
  if (networkConfig(network).label === "mainnet") {
    return {
      ok: false,
      status: 403,
      error: "The demo account is testnet-only. On mainnet, log in and pay from your own wallet.",
    };
  }

  const key = process.env.XORV_DEMO_PAYER_KEY?.trim();
  if (!key) {
    return {
      ok: false,
      status: 501,
      error: "No demo account configured. Set XORV_DEMO_PAYER_KEY (a funded Monad testnet key) in apps/app/.env.local.",
    };
  }

  let account: PrivateKeyAccount;
  try {
    account = accountFromKey(key);
  } catch (err) {
    return { ok: false, status: 500, error: `XORV_DEMO_PAYER_KEY is not usable: ${errorMessage(err)}` };
  }

  const cap = process.env.XORV_DEMO_MAX_USDC_UNITS?.trim() || DEFAULT_MAX_USDC_UNITS;
  if (!/^\d+$/.test(cap) || BigInt(cap) === 0n) {
    return { ok: false, status: 500, error: "XORV_DEMO_MAX_USDC_UNITS must be a positive integer of USDC units." };
  }

  // `||`, not `??`: an empty `XORV_BROKER_URL=` line in .env.local means "unset".
  const brokerUrl = (
    process.env.XORV_BROKER_URL?.trim() || process.env.NEXT_PUBLIC_XORV_BROKER_URL?.trim() || "http://localhost:8402"
  ).replace(/\/+$/, "");

  return {
    ok: true,
    payer: { account, network, brokerUrl, maxUsdcUnits: BigInt(cap).toString(), receiptSecret: demoReceiptSecret(key) },
  };
}
