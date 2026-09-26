/**
 * Deploys XorvLedger and records where it went.
 *
 *   pnpm --filter @xorv/contracts deploy:testnet     # --network monadTestnet
 *   pnpm --filter @xorv/contracts deploy:mainnet     # --network monad
 *   pnpm --filter @xorv/contracts exec hardhat run scripts/deploy.ts   # dry run, in-process chain
 *
 * Constructor arguments are the network's canonical ERC-8004 Identity and Reputation registries
 * (scripts/lib/networks.ts) and the broker: XORV_BROKER_ADDRESS, or the deployer when unset. The
 * deployer key comes from XORV_DEPLOYER_KEY (falling back to XORV_OPERATOR_KEY), via the env or the
 * Hardhat keystore. The deployer becomes the ledger's owner.
 *
 * Writes deployments/<network>.json and prints the env lines the broker and the Envio indexer need.
 * Refuses to replace an existing Monad deployment unless XORV_REDEPLOY=1: a new address orphans every
 * receipt and rating indexed under the old one.
 *
 * On an in-process or localhost chain there are no ERC-8004 registries, so the script deploys the
 * vendored reference registries first. That makes the dry run a real end-to-end check of this
 * script, without keys or MON.
 */
import { access, mkdir, writeFile } from "node:fs/promises";

import { network } from "hardhat";
import { type Address, encodeDeployData, formatEther, getAddress, isAddress, parseAbi } from "viem";

import { deployErc8004 } from "./lib/erc8004-local.js";
import { type DeploymentRecord, monadDeploymentFor, withGasMargin } from "./lib/networks.js";

const REGISTRY_ABI = parseAbi([
  "function getVersion() view returns (string)",
  "function getIdentityRegistry() view returns (address)",
]);

// Monad keeps ~10 MON per EOA as a reserve for in-flight gas; a deployer below it may see the
// transaction included and then reverted. Warn rather than refuse: the rule has exceptions.
const MONAD_RESERVE_WEI = 10n * 10n ** 18n;

const connection = await network.create();
const { viem, networkName } = connection;
const monad = monadDeploymentFor(networkName);

// Resolve the key before touching the RPC, so a missing key fails fast and offline.
const [deployer] = await viem.getWalletClients();
if (deployer === undefined) {
  throw new Error(
    `No deployer account on "${networkName}". Set XORV_DEPLOYER_KEY (or XORV_OPERATOR_KEY) in the environment, ` +
      "the repo-root .env, or the Hardhat keystore (pnpm hardhat keystore set XORV_DEPLOYER_KEY).",
  );
}
const deployerAddress = getAddress(deployer.account.address);
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();

const brokerEnv = process.env.XORV_BROKER_ADDRESS?.trim();
if (brokerEnv && !isAddress(brokerEnv, { strict: false })) {
  throw new Error(`XORV_BROKER_ADDRESS is not an address: ${brokerEnv}`);
}
const broker: Address = brokerEnv ? getAddress(brokerEnv) : deployerAddress;

let identity: Address;
let reputation: Address;
if (monad !== undefined) {
  if (chainId !== monad.chainId) {
    throw new Error(`RPC for "${networkName}" reports chainId ${chainId}, expected ${monad.chainId}.`);
  }
  identity = monad.identity;
  reputation = monad.reputation;

  // The registries are immutable constructor arguments: check they are what we think before paying.
  const [identityVersion, reputationVersion, wiredIdentity] = await Promise.all([
    publicClient.readContract({ address: identity, abi: REGISTRY_ABI, functionName: "getVersion" }),
    publicClient.readContract({ address: reputation, abi: REGISTRY_ABI, functionName: "getVersion" }),
    publicClient.readContract({ address: reputation, abi: REGISTRY_ABI, functionName: "getIdentityRegistry" }),
  ]);
  if (getAddress(wiredIdentity) !== getAddress(identity)) {
    throw new Error(`Reputation registry ${reputation} points at identity ${wiredIdentity}, not ${identity}.`);
  }
  if (identityVersion !== "2.0.0" || reputationVersion !== "2.0.0") {
    console.warn(`! ERC-8004 registries report versions ${identityVersion}/${reputationVersion}, not 2.0.0.`);
  }

  const outFile = new URL(`../deployments/${networkName}.json`, import.meta.url);
  const exists = await access(outFile).then(
    () => true,
    () => false,
  );
  if (exists && process.env.XORV_REDEPLOY !== "1") {
    throw new Error(
      `deployments/${networkName}.json already exists. Redeploying moves the ledger to a new address and ` +
        "orphans everything indexed under the old one. Set XORV_REDEPLOY=1 if that is really intended.",
    );
  }
} else {
  console.log(`"${networkName}" is not a Monad network: deploying the vendored ERC-8004 registries first.`);
  const local = await deployErc8004(viem);
  identity = getAddress(local.identity.address);
  reputation = getAddress(local.reputation.address);
}

const args = [identity, reputation, broker] as const;

// Monad bills the gas limit, so size it from an estimate of this exact deployment plus a margin.
const artifact = await import("../artifacts/contracts/XorvLedger.sol/XorvLedger.json", { with: { type: "json" } });
const estimate = await publicClient.estimateGas({
  account: deployerAddress,
  data: encodeDeployData({ abi: artifact.default.abi, bytecode: artifact.default.bytecode as `0x${string}`, args }),
});
const gas = withGasMargin(estimate);
const gasPrice = await publicClient.getGasPrice();
const balance = await publicClient.getBalance({ address: deployerAddress });
const maxCost = gas * gasPrice;

console.log(`Network    ${networkName} (chainId ${chainId})`);
console.log(`Deployer   ${deployerAddress}  balance ${formatEther(balance)} MON`);
console.log(`Identity   ${identity}`);
console.log(`Reputation ${reputation}`);
console.log(`Broker     ${broker}${brokerEnv ? "" : "  (deployer; set XORV_BROKER_ADDRESS to use another EOA)"}`);
console.log(`Gas        estimate ${estimate}, limit ${gas}, price ${formatEther(gasPrice, "gwei")} gwei, max ${formatEther(maxCost)} MON`);

if (balance < maxCost) {
  throw new Error(`Deployer holds ${formatEther(balance)} MON but the deployment can cost ${formatEther(maxCost)} MON.`);
}
if (monad !== undefined && balance - maxCost < MONAD_RESERVE_WEI) {
  console.warn("! Deployer will be under Monad's 10 MON reserve balance after this; the tx may revert after inclusion.");
}

const { contract: ledger, deploymentTransaction } = await viem.sendDeploymentTransaction("XorvLedger", [...args], { gas });
console.log(`Sent       ${deploymentTransaction.hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
if (receipt.status !== "success" || receipt.contractAddress == null) {
  throw new Error(`Deployment transaction ${receipt.transactionHash} failed (status ${receipt.status}).`);
}
const address = getAddress(receipt.contractAddress);
if (address !== getAddress(ledger.address)) {
  throw new Error(`Receipt address ${address} differs from the expected ${ledger.address}.`);
}

const [owner, onchainBroker] = await Promise.all([ledger.read.owner(), ledger.read.broker()]);
const record: DeploymentRecord = {
  contract: "XorvLedger",
  network: networkName,
  chainId,
  address,
  txHash: receipt.transactionHash,
  blockNumber: Number(receipt.blockNumber),
  identity,
  reputation,
  broker: getAddress(onchainBroker),
  owner: getAddress(owner),
  deployedAt: new Date().toISOString(),
};

console.log(`Deployed   ${address} in block ${record.blockNumber} (gas used ${receipt.gasUsed} of ${gas})`);

if (networkName === "default") {
  console.log("\nIn-process dry run: the chain is gone when this script exits, so nothing was written.");
} else {
  const outDir = new URL("../deployments/", import.meta.url);
  await mkdir(outDir, { recursive: true });
  await writeFile(new URL(`${networkName}.json`, outDir), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Wrote      deployments/${networkName}.json`);
}

if (monad !== undefined) {
  console.log(`Explorer   ${monad.explorerUrl}/address/${address}`);
  console.log(`Verify     pnpm --filter @xorv/contracts verify:${networkName === "monad" ? "mainnet" : "testnet"}`);
}

// Paste into the repo-root .env (broker) and the indexer's env. The from/start block is the deploy
// block: nothing can be emitted by the ledger before it, so scans and HyperSync start there.
console.log(`
XORV_LEDGER_ADDRESS=${address}
XORV_LEDGER_FROM_BLOCK=${record.blockNumber}
ENVIO_XORV_LEDGER_ADDRESS=${address}
ENVIO_XORV_LEDGER_START_BLOCK=${record.blockNumber}`);

await connection.close();
