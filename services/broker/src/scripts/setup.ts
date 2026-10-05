/**
 * `pnpm setup` — get an Monad deployment from nothing to ready.
 *
 * Much less to do here than the Hedera version, and the difference is the
 * interesting part.
 *
 * On Hedera this script had to create three Consensus Service topics and two
 * funded accounts, and every generated account needed
 * `setMaxAutomaticTokenAssociations(-1)` or USDC could not land in it at all —
 * the single most common way a Hedera demo silently fails.
 *
 * On an EVM chain an account is a keypair. It exists because you generated
 * it; nothing is created on chain, nothing is opted into, and any address can
 * receive AUSD or USDC immediately. So this generates keys, reports what is
 * configured, and checks the things that can actually be wrong: whether each
 * stablecoin's EIP-712 domain matches its contract, whether the operator has
 * MON for gas, and whether the audit-log contract is really deployed where
 * config says it is.
 *
 *   pnpm setup              # check what's configured
 *   pnpm setup --accounts   # also generate a provider and buyer keypair
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  explorerAddress,
  explorerToken,
  fetchBalances,
  formatGas,
  formatUnits,
  logDeployed,
  networkInfo,
  readClient,
  stablecoins,
  verifyStablecoinDomains,
} from "@xorv/protocol";
import { loadConfig } from "../config.js";

const config = loadConfig();
const args = new Set(process.argv.slice(2));
const wantAccounts = args.has("--accounts");

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function reportBalance(label: string, address: string): Promise<void> {
  try {
    const b = await fetchBalances(config.network, address);
    const held = b.stablecoins.map((s) => `${formatUnits(s.units)} ${s.symbol}`).join("  ");
    line(label, `${address}  ${formatGas(b.gasWei)}${BigInt(b.gasWei) === 0n ? " ✖ needs MON for gas" : ""}  ${held}`);
  } catch (err) {
    line(label, `${address}  — could not read (${(err as Error).message})`);
  }
}

async function main(): Promise<void> {
  console.log("");
  console.log(`  ▁▂▃  XORV setup — ${networkInfo(config.network).name} (${config.network})`);
  console.log("");

  const client = readClient(config.network);
  const chainId = await client.getChainId().catch(() => null);
  line("rpc", chainId ? `reachable, chain ${chainId}` : "UNREACHABLE");

  // Recomputing each token's DOMAIN_SEPARATOR proves three things at once: the
  // RPC works, the token is really there, and the EIP-712 domain every 402
  // advertises is the one the contract verifies against. Without a matching
  // domain no payment in that token can ever settle.
  const checks = await verifyStablecoinDomains(config.network);
  stablecoins(config.network).forEach((token, i) => {
    const check = checks[i]!;
    line(
      token.symbol.toLowerCase(),
      `${token.address}  ${explorerToken(config.network, token.address)}${i === 0 ? "  (default)" : ""}`,
    );
    line(
      "  eip-712 domain",
      `name="${token.eip712.name}" version="${token.eip712.version}" ` +
        (check.ok ? "✔" : check.actual ? "✖ does not match DOMAIN_SEPARATOR" : "✖ could not check"),
    );
  });

  console.log("");
  await reportBalance("operator", config.operatorAddress);
  console.log("");

  if (config.logAddress) {
    const deployed = await logDeployed(config.network, config.logAddress);
    line(
      "audit log",
      deployed
        ? `${config.logAddress}  ${explorerAddress(config.network, config.logAddress)}`
        : `${config.logAddress}  ✖ NO CONTRACT AT THIS ADDRESS`,
    );
  } else {
    line("audit log", "not configured — run `pnpm dlx tsx scripts/deploy-log.mts`");
  }

  if (wantAccounts) {
    console.log("");
    console.log("  generating demo keypairs…");
    console.log("");
    const env: Record<string, string> = {};
    for (const [name, prefix] of [
      ["provider (receives)", "XORV_DEMO_PROVIDER"],
      ["buyer (spends)", "XORV_DEMO_PAYER"],
    ] as const) {
      const key = generatePrivateKey();
      const account = privateKeyToAccount(key);
      line(name, account.address);
      env[`${prefix}_ADDRESS`] = account.address;
      env[`${prefix}_KEY`] = key;
    }
    console.log("");
    console.log("  paste into .env:");
    console.log("");
    for (const [key, value] of Object.entries(env)) console.log(`${key}=${value}`);
    console.log("");
    console.log(
      `  Then fund the buyer with ${stablecoins(config.network).map((s) => s.symbol).join(" or ")} on ${networkInfo(config.network).name}.`,
    );
    console.log("  Neither needs MON: the provider only receives, the buyer only signs.");
  }

  console.log("");
}

main().catch((err) => {
  console.error("\n  setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
