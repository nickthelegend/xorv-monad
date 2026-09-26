/**
 * `pnpm usdc` — is the buyer funded, and can we switch to real USDC yet?
 *
 * Written because "I sent it" and "it arrived" are different facts, and the
 * only way to tell them apart is to ask the ledger. It reports where the
 * account actually stands, and when USDC is present it prints the one line
 * that switches the network over to it.
 *
 * Read-only. It never moves funds and never edits a file.
 */

import {
  HEDERA_TESTNET_USDC,
  hashscanAccount,
  hashscanToken,
  mirrorNodeUrl,
  networkLabel,
} from "@xorv/protocol";
import { loadConfig } from "../config.js";

interface MirrorAccount {
  account?: string;
  balance?: { balance: number; tokens?: Array<{ token_id: string; balance: number }> };
  max_automatic_token_associations?: number;
  evm_address?: string;
}

const config = loadConfig();
const network = config.network;
const USDC = network === "hedera:mainnet" ? "0.0.456858" : HEDERA_TESTNET_USDC;

/** Every account the demo cares about, and why. */
const ACCOUNTS: Array<{ id: string | undefined; label: string; needs: "usdc" | "hbar" | "none" }> = [
  { id: process.env.XORV_DEMO_PAYER_ID, label: "buyer (spends USDC)", needs: "usdc" },
  { id: process.env.XORV_DEMO_PROVIDER_ID, label: "provider (receives)", needs: "none" },
  { id: config.operatorId, label: "facilitator (pays gas)", needs: "hbar" },
];

async function inspect(accountId: string): Promise<MirrorAccount | null> {
  try {
    const res = await fetch(`${mirrorNodeUrl(network)}/api/v1/accounts/${accountId}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as MirrorAccount;
  } catch {
    return null;
  }
}

function tokenBalance(account: MirrorAccount, tokenId: string): number {
  const tokens = account.balance?.tokens ?? [];
  return tokens.find((t) => t.token_id === tokenId)?.balance ?? 0;
}

async function main(): Promise<void> {
  console.log("");
  console.log(`  ▁▂▃  USDC on ${networkLabel(network)}`);
  console.log("");
  console.log(`  token  ${USDC}  ${hashscanToken(network, USDC)}`);
  console.log("");

  let buyerUsdc = 0;
  let buyerId: string | null = null;

  for (const entry of ACCOUNTS) {
    if (!entry.id) {
      console.log(`  ${entry.label.padEnd(24)} not configured`);
      continue;
    }
    const account = await inspect(entry.id);
    if (!account) {
      console.log(`  ${entry.label.padEnd(24)} ${entry.id}  — could not read`);
      continue;
    }

    const hbar = (account.balance?.balance ?? 0) / 1e8;
    const usdc = tokenBalance(account, USDC) / 1e6;
    const auto = account.max_automatic_token_associations ?? 0;

    if (entry.needs === "usdc") {
      buyerUsdc = usdc;
      buyerId = entry.id;
    }

    console.log(`  ${entry.label.padEnd(24)} ${entry.id}`);
    console.log(`    ${usdc.toFixed(2).padStart(10)} USDC   ${hbar.toFixed(4).padStart(12)} ℏ`);
    if (entry.needs === "usdc") {
      // The thing people get wrong: an account that cannot receive the token
      // silently never gets it, and the faucet reports success either way.
      const canReceive = auto === -1 || auto > (account.balance?.tokens?.length ?? 0) || usdc > 0;
      console.log(
        `    ${canReceive ? "can receive USDC" : "CANNOT receive USDC — no association, no auto slots"}` +
          ` (auto-association: ${auto === -1 ? "unlimited" : auto})`,
      );
      if (account.evm_address) console.log(`    evm: ${account.evm_address}`);
      console.log(`    ${hashscanAccount(network, entry.id)}`);
    }
    console.log("");
  }

  if (buyerUsdc > 0) {
    console.log(`  ✔ the buyer holds ${buyerUsdc} USDC — switch the network over with:`);
    console.log("");
    console.log(`      XORV_STABLECOIN=${USDC}`);
    console.log("");
    console.log("    then restart the broker. Nothing else changes.");
  } else {
    console.log("  ✖ no USDC yet.");
    console.log("");
    console.log(`    Send it to  ${buyerId ?? "the buyer account"}`);
    console.log("    at https://faucet.circle.com — pick Hedera Testnet.");
    console.log("");
    console.log("    If the faucet said it sent, the transfer went somewhere else:");
    console.log("    open the account link above on HashScan and check its token tab,");
    console.log("    then re-run this to confirm.");
  }
  console.log("");
}

main().catch((err) => {
  console.error("failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
