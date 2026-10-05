/**
 * `pnpm balances` — is everyone funded, and does every stablecoin's domain check out?
 *
 * Written because "I sent it" and "it arrived" are different facts, and the
 * only way to tell them apart is to ask the chain. Read-only: it never moves
 * funds and never edits a file.
 *
 * Two things are checked:
 *
 *  - **Each configured stablecoin's EIP-712 domain**, by recomputing its
 *    `DOMAIN_SEPARATOR` from the configured name/version and comparing it with
 *    the contract's. AUSD's domain name is not its `name()`, so this is the only way
 *    to know a buyer's signature will verify before a buyer finds out.
 *  - **Who holds what.** The buyer needs a stablecoin and **no MON** — it signs
 *    an authorization and never broadcasts. The provider needs nothing; it only
 *    receives. Only the operator needs MON, because only its facilitator (and
 *    the audit log) send transactions.
 */

import {
  explorerAddress,
  explorerToken,
  fetchBalances,
  formatGas,
  formatUnits,
  networkInfo,
  stablecoins,
  verifyStablecoinDomains,
} from "@xorv/protocol";
import { loadConfig } from "../config.js";

const config = loadConfig();
const network = config.network;
const info = networkInfo(network);

/** Every account the demo cares about, and what it actually needs. */
const ACCOUNTS: Array<{ address: string | undefined; label: string; needs: string }> = [
  {
    address: process.env.XORV_DEMO_PAYER_ADDRESS,
    label: "buyer",
    needs: "a stablecoin to spend — no MON, it never broadcasts",
  },
  {
    address: process.env.XORV_DEMO_PROVIDER_ADDRESS,
    label: "provider",
    needs: "nothing — it only receives",
  },
  {
    address: config.operatorAddress,
    label: "operator",
    needs: "MON for gas — its facilitator relays every payment",
  },
];

async function main(): Promise<void> {
  console.log("");
  console.log(`  ▁▂▃  stablecoins on ${info.name} (${network})`);
  console.log("");

  const checks = await verifyStablecoinDomains(network);
  stablecoins(network).forEach((token, i) => {
    const check = checks[i]!;
    console.log(
      `  ${token.symbol.padEnd(6)} ${token.address}${i === 0 ? "  (default)" : ""}`,
    );
    console.log(`         ${explorerToken(network, token.address)}`);
    console.log(
      `         name="${token.eip712.name}" version="${token.eip712.version}" ` +
        (check.ok
          ? "✔ matches DOMAIN_SEPARATOR"
          : check.actual
            ? "✖ DOES NOT MATCH DOMAIN_SEPARATOR — payments in this token will be rejected"
            : `✖ could not check (${check.error ?? "no DOMAIN_SEPARATOR()"})`),
    );
  });
  console.log("");

  let buyerFunded = false;
  let buyerAddress: string | null = null;

  for (const entry of ACCOUNTS) {
    if (!entry.address) {
      console.log(`  ${entry.label.padEnd(12)} not configured`);
      console.log("");
      continue;
    }

    console.log(`  ${entry.label.padEnd(12)} ${entry.address}`);
    try {
      const b = await fetchBalances(network, entry.address);
      if (entry.label === "buyer") {
        buyerAddress = entry.address;
        buyerFunded = b.stablecoins.some((s) => BigInt(s.units) > 0n);
      }
      const held = b.stablecoins
        .map((s) => (s.error ? `? ${s.symbol} (unreadable)` : `${formatUnits(s.units)} ${s.symbol}`))
        .join("   ");
      console.log(`    ${held}   ${formatGas(b.gasWei)}`);
      if (entry.label === "operator" && BigInt(b.gasWei) === 0n) {
        console.log("    ✖ no MON — the facilitator cannot relay a single payment");
      }
      console.log(`    needs: ${entry.needs}`);
      console.log(`    ${explorerAddress(network, entry.address)}`);
    } catch (err) {
      console.log(`    — could not read (${(err as Error).message})`);
    }
    console.log("");
  }

  if (buyerFunded) {
    console.log("  ✔ the buyer holds a stablecoin — ready to pay.");
  } else {
    console.log("  ✖ the buyer holds no stablecoin yet.");
    console.log("");
    console.log(`    Fund ${buyerAddress ?? "the buyer address"} with ${stablecoins(network).map((s) => s.symbol).join(" or ")} on ${info.name}.`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
