/**
 * `pnpm setup:monad` — what this broker needs on Monad, and what it has.
 *
 * Read-only and idempotent: it never sends a transaction or edits a file. It
 * reports the operator and facilitator EOAs and their MON/USDC balances, says
 * where to get more, checks the XorvLedger deployment (or prints the exact
 * command that makes one), and ends with the env lines to paste into `.env`.
 *
 *   pnpm setup:monad              the report
 *   pnpm setup:monad --new-keys   also print freshly generated keys to use
 *
 * Deploying the ledger is deliberately a separate, explicit step
 * (`pnpm --filter @xorv/contracts deploy:testnet`): a redeploy moves the
 * ledger to a new address and orphans everything indexed under the old one,
 * which is not something a setup script should do on a whim.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  XORV_LEDGER_ABI,
  explorerAddress,
  fetchBalances,
  formatMon,
  formatUsdc,
  networkConfig,
  publicClientFor,
  sameAddress,
} from "@xorv/protocol";
import { loadConfig } from "../config.js";

/** Monad holds back ~10 MON per EOA as a reserve for in-flight gas. */
const MON_RESERVE_WEI = 10n * 10n ** 18n;

const here = path.dirname(fileURLToPath(import.meta.url));

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function balanceLine(network: string, address: string, needs: "mon" | "usdc"): Promise<void> {
  try {
    const { monWei, usdcUnits } = await fetchBalances(network, address);
    const low = needs === "mon" ? BigInt(monWei) < MON_RESERVE_WEI : BigInt(usdcUnits) === 0n;
    line("", `${formatMon(monWei)} · ${formatUsdc(usdcUnits)} USDC${low ? "   ← needs funding" : ""}`);
  } catch (err) {
    line("", `balance unavailable (${err instanceof Error ? err.message : String(err)})`);
  }
}

interface DeploymentRecord {
  address?: string;
  blockNumber?: number;
  broker?: string;
}

function readDeployment(network: string): DeploymentRecord | null {
  const name = network === "eip155:143" ? "monad" : "monadTestnet";
  const file = path.resolve(here, "../../../../packages/contracts/deployments", `${name}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as DeploymentRecord;
  } catch {
    return null;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfig();
  const cfg = networkConfig(config.network);
  const env: Record<string, string> = {};

  console.log("");
  console.log(`  ▁▂▃  XORV setup — ${cfg.name} (${config.network})`);
  console.log("");
  line("rpc", cfg.rpcUrl);
  line("explorer", cfg.explorerUrl);
  line("usdc", `${cfg.usdc.address}  (EIP-712 "${cfg.usdc.name}" v${cfg.usdc.version})`);
  line("erc-8004 identity", cfg.erc8004.identity);
  line("erc-8004 reputation", cfg.erc8004.reputation);
  console.log("");

  if (argv.includes("--new-keys")) {
    console.log("  fresh keys (keep them secret; fund the addresses before use):");
    for (const name of ["XORV_OPERATOR_KEY", "XORV_FACILITATOR_KEY"]) {
      const key = generatePrivateKey();
      line(name, `${privateKeyToAccount(key).address}`);
      env[name] = key;
    }
    console.log("");
  }

  // -- operator: ledger writes, rating relays --------------------------------
  if (config.operator) {
    line("operator", `${config.operator.address}   ${explorerAddress(config.network, config.operator.address)}`);
    await balanceLine(config.network, config.operator.address, "mon");
  } else {
    line("operator", "not set — the broker runs read-only (no ledger writes, no rating relays)");
  }

  // -- facilitator: settles buyers' EIP-3009 authorizations ------------------
  if (config.facilitatorAccount) {
    const shared = config.operator && sameAddress(config.operator.address, config.facilitatorAccount.address);
    line(
      "facilitator",
      `${config.facilitatorAccount.address}${shared ? "   (same as operator — a separate XORV_FACILITATOR_KEY is recommended)" : ""}`,
    );
    if (!shared) await balanceLine(config.network, config.facilitatorAccount.address, "mon");
  } else {
    line(
      "facilitator",
      config.facilitatorMode === "self"
        ? "XORV_FACILITATOR=self but no key — payments are disabled"
        : `no key — payments settle through the hosted facilitator (${cfg.facilitatorUrl})`,
    );
  }
  console.log("");
  if (cfg.faucets.mon || cfg.faucets.usdc) {
    console.log("  faucets:");
    if (cfg.faucets.mon) line("MON (gas)", cfg.faucets.mon);
    if (cfg.faucets.usdc) line("USDC (buyers)", `${cfg.faucets.usdc}  — pick "Monad Testnet"`);
    console.log("    Keep each broker EOA above ~10 MON: Monad reserves that much per account for in-flight gas.");
    console.log("    Buyers need USDC only; the facilitator pays their gas.");
    console.log("");
  }

  // -- the ledger -----------------------------------------------------------
  const deployment = readDeployment(config.network);
  const ledger = config.ledgerAddress ?? deployment?.address ?? null;
  if (ledger) {
    line("xorv ledger", `${ledger}   ${explorerAddress(config.network, ledger)}`);
    try {
      const client = publicClientFor(config.network);
      const code = await client.getCode({ address: ledger as `0x${string}` });
      if (!code || code === "0x") {
        line("", "no contract code at this address on this network — wrong network, or not deployed yet");
      } else {
        const broker = await client.readContract({
          address: ledger as `0x${string}`,
          abi: XORV_LEDGER_ABI,
          functionName: "broker",
        });
        const ok = config.operator && sameAddress(broker, config.operator.address);
        line(
          "",
          ok
            ? `broker = ${broker} ✔ (the operator can write)`
            : `broker = ${broker} — XORV_OPERATOR_KEY must be this address's key, or the owner must call setBroker`,
        );
      }
    } catch (err) {
      line("", `could not read the ledger (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!config.ledgerAddress) env.XORV_LEDGER_ADDRESS = ledger;
    if (!config.ledgerFromBlock && deployment?.blockNumber !== undefined) {
      env.XORV_LEDGER_FROM_BLOCK = String(deployment.blockNumber);
    }
  } else {
    const task = config.network === "eip155:143" ? "deploy:mainnet" : "deploy:testnet";
    line("xorv ledger", "not deployed / not configured");
    console.log("");
    console.log("  deploy it (the operator becomes the ledger's broker; needs MON for gas):");
    console.log("");
    console.log(
      `      XORV_BROKER_ADDRESS=${config.operator?.address ?? "<operator address>"} pnpm --filter @xorv/contracts ${task}`,
    );
    console.log("");
    console.log("  it prints XORV_LEDGER_ADDRESS and XORV_LEDGER_FROM_BLOCK — paste both into .env.");
  }
  console.log("");

  if (!process.env.XORV_PUBLIC_URL?.trim()) {
    console.log("  note: XORV_PUBLIC_URL is unset. It is baked into agent and feedback URIs on-chain, so set it");
    console.log("        to the broker's public https URL before providers register agents or buyers rate jobs.");
    console.log("");
  }

  if (Object.keys(env).length > 0) {
    console.log("  paste into .env:");
    console.log("");
    for (const [key, value] of Object.entries(env)) console.log(`${key}=${value}`);
    console.log("");
  }
}

// Only when run directly — importing this file (a test, a REPL) must not
// start making RPC calls.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error("\n  setup failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
