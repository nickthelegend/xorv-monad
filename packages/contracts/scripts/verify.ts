/**
 * Verifies the recorded XorvLedger deployment on the Monad explorers.
 *
 *   pnpm --filter @xorv/contracts verify:testnet     # --network monadTestnet
 *   pnpm --filter @xorv/contracts verify:mainnet     # --network monad
 *
 * Reads deployments/<network>.json (written by scripts/deploy.ts) for the address, constructor
 * arguments and creation tx, then submits to:
 *   - Sourcify at sourcify-api-monad.blockvision.org, which backs MonadVision. No key needed.
 *   - Monadscan via Etherscan V2 (chainid 10143 / 143), when MONADSCAN_API_KEY or ETHERSCAN_API_KEY
 *     is set.
 * Both compile from the same build profile settings as the deployment, so the bytecode matches.
 *
 * The Monad docs warn that Hardhat's verify can print an error even when verification succeeded, so
 * each provider's outcome is reported separately with the explorer link to confirm by eye.
 */
import { readFile } from "node:fs/promises";

import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import hre from "hardhat";

import { type DeploymentRecord, monadDeploymentFor } from "./lib/networks.js";

const networkName = hre.globalOptions.network;
const monad = monadDeploymentFor(networkName);
if (monad === undefined) {
  throw new Error(`Pass --network monadTestnet or --network monad (got "${networkName}").`);
}

const file = new URL(`../deployments/${networkName}.json`, import.meta.url);
const record = JSON.parse(await readFile(file, "utf8").catch(() => {
  throw new Error(`deployments/${networkName}.json not found: deploy first (scripts/deploy.ts).`);
})) as DeploymentRecord;
if (record.chainId !== monad.chainId) {
  throw new Error(`deployments/${networkName}.json is for chainId ${record.chainId}, expected ${monad.chainId}.`);
}

const common = {
  address: record.address,
  constructorArgs: [record.identity, record.reputation, record.broker, record.owner],
  contract: "contracts/XorvLedger.sol:XorvLedger",
};

const providers: Array<"sourcify" | "etherscan"> = ["sourcify"];
if (hre.config.verify.etherscan.enabled) providers.push("etherscan");
else console.log("Monadscan skipped: set MONADSCAN_API_KEY or ETHERSCAN_API_KEY to verify there too.");

const results: Record<string, string> = {};
for (const provider of providers) {
  try {
    const ok = await verifyContract(
      provider === "sourcify" ? { ...common, provider, creationTxHash: record.txHash } : { ...common, provider },
      hre,
    );
    results[provider] = ok ? "verified" : "not verified";
  } catch (error) {
    // "Already verified" also lands here on some explorers; the link below is the source of truth.
    results[provider] = `error: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
}

console.log(`\nXorvLedger ${record.address} on ${networkName}`);
for (const [provider, outcome] of Object.entries(results)) console.log(`  ${provider.padEnd(10)} ${outcome}`);
const vision = networkName === "monad" ? "https://monadvision.com" : "https://testnet.monadvision.com";
console.log(`  Monadscan  ${monad.explorerUrl}/address/${record.address}#code`);
console.log(`  MonadVision ${vision}/address/${record.address}`);

if (!Object.values(results).some((outcome) => outcome === "verified")) process.exitCode = 1;
