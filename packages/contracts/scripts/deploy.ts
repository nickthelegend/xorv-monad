/**
 * Deploys XorvLedger and records where it went.
 *
 *   pnpm --filter @xorv/contracts deploy:testnet     # --network monadTestnet
 *   pnpm --filter @xorv/contracts deploy:mainnet     # --network monad
 *   pnpm --filter @xorv/contracts exec hardhat run scripts/deploy.ts   # dry run, in-process chain
 *
 * Constructor arguments are the network's canonical ERC-8004 Identity and Reputation registries
 * (scripts/lib/networks.ts), the broker (XORV_BROKER_ADDRESS, or the deployer when unset) and the
 * owner (XORV_LEDGER_OWNER, or the deployer when unset). The deployer key is XORV_DEPLOYER_KEY from
 * the env or the Hardhat keystore, or XORV_OPERATOR_KEY when it is in neither; it only pays.
 *
 * The owner can do two things: setBroker (rotate the broker key) and transferOwnership (single step).
 * That is the recovery plan for a leaked broker key, so on a real Monad network the script refuses an
 * owner that is the broker or the operator key (XORV_ALLOW_OWNER_IS_BROKER=1 overrides): whoever leaks
 * that key could transfer ownership to themselves first. Keep the owner key offline. To rotate:
 *   - broker key leaked or retired: from the owner, setBroker(<new broker address>); then give the
 *     broker the new key (XORV_OPERATOR_KEY) and restart it. Receipts the old key wrote stay valid.
 *   - owner key moving: from the owner, transferOwnership(<new owner>). There is no accept step and
 *     zero is refused, so check the address: a typo hands the ledger to nobody.
 * Both are plain calls from the owner's wallet: Monadscan's "Write Contract" tab once the source is
 * verified, or any client with the ABI (packages/contracts/abi/XorvLedger.json).
 *
 * Writes deployments/<network>.json and prints the env lines the broker and the Envio indexer need.
 * Refuses to replace an existing Monad deployment unless XORV_REDEPLOY=1: a new address orphans every
 * receipt and rating indexed under the old one.
 *
 * On an in-process or localhost chain there are no ERC-8004 registries, so the script deploys the
 * vendored reference registries first. That makes the dry run a real end-to-end check of this
 * script, without keys or MON.
 *
 * A local *fork* of Monad (`hardhat node --network monadFork`, reached from here as
 * `--network monadForkRpc`; see e2e/) is different: it reports Monad's chain id and the canonical
 * registries are right there, forked with the rest of the state. It is wired to those, with the same
 * on-chain checks as a real deployment, so the ledger the e2e harness tests is built exactly like the
 * one on testnet.
 */
import { access, mkdir, writeFile } from "node:fs/promises";

import { network } from "hardhat";
import { type Address, encodeDeployData, formatEther, getAddress, isAddress, parseAbi } from "viem";

import { deployErc8004 } from "./lib/erc8004-local.js";
import { chooseLedgerOwner, operatorAddress } from "./lib/owner.js";
import {
  type DeploymentRecord,
  type MonadDeployment,
  monadDeploymentFor,
  monadDeploymentForChainId,
  withGasMargin,
} from "./lib/networks.js";

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

const brokerEnv = process.env.XORV_BROKER_ADDRESS?.trim();
if (brokerEnv && !isAddress(brokerEnv, { strict: false })) {
  throw new Error(`XORV_BROKER_ADDRESS is not an address: ${brokerEnv}`);
}
const broker: Address = brokerEnv ? getAddress(brokerEnv) : deployerAddress;
// Settle the roles before estimating or sending anything: a hot owner on monadTestnet / monad stops here.
const { owner: ownerAddress, source: ownerSource, warning: ownerWarning } = chooseLedgerOwner({
  env: process.env,
  deployer: deployerAddress,
  broker,
  live: monad !== undefined,
});

const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();

// Not a Monad network by name, but a Monad chain by id with the canonical Identity Registry deployed:
// a fork. (A bare local chain that merely borrows the chain id has no code there and falls through
// to the vendored registries below.)
let forkOf: MonadDeployment | undefined;
if (monad === undefined) {
  const candidate = monadDeploymentForChainId(chainId);
  if (candidate !== undefined && (await publicClient.getCode({ address: candidate.identity })) !== undefined) {
    forkOf = candidate;
    console.log(`"${networkName}" is a fork of ${candidate.network}: using its canonical ERC-8004 registries.`);
  }
}
const canonical = monad ?? forkOf;

let identity: Address;
let reputation: Address;
if (canonical !== undefined) {
  if (chainId !== canonical.chainId) {
    throw new Error(`RPC for "${networkName}" reports chainId ${chainId}, expected ${canonical.chainId}.`);
  }
  identity = canonical.identity;
  reputation = canonical.reputation;

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

  // A fork is thrown away with its node, so there is nothing indexed under an old address to orphan.
  const outFile = new URL(`../deployments/${networkName}.json`, import.meta.url);
  const exists = await access(outFile).then(
    () => true,
    () => false,
  );
  if (monad !== undefined && exists && process.env.XORV_REDEPLOY !== "1") {
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

const args = [identity, reputation, broker, ownerAddress] as const;

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
console.log(`Owner      ${ownerAddress}${ownerSource === "deployer" ? "  (deployer; set XORV_LEDGER_OWNER to name another)" : ""}`);
if (deployerAddress === operatorAddress(process.env)) {
  console.log("           (deploying with XORV_OPERATOR_KEY: no XORV_DEPLOYER_KEY in the env or the keystore)");
}
console.log(`Gas        estimate ${estimate}, limit ${gas}, price ${formatEther(gasPrice, "gwei")} gwei, max ${formatEther(maxCost)} MON`);

if (ownerWarning !== undefined) console.warn(`! ${ownerWarning}`);
if (balance < maxCost) {
  throw new Error(`Deployer holds ${formatEther(balance)} MON but the deployment can cost ${formatEther(maxCost)} MON.`);
}
if (monad !== undefined && balance - maxCost < MONAD_RESERVE_WEI) {
  console.warn("! Deployer will be under Monad's 10 MON reserve balance after this; the tx may revert after inclusion.");
}

// Send through the wallet client and poll for the receipt, rather than hardhat-viem's
// sendDeploymentTransaction: that one calls eth_getTransactionByHash the instant the hash comes
// back, and Monad's public RPC is load-balanced, so the node it asks has often not seen the
// transaction yet. The first live testnet deploy died there with TransactionNotFoundError although
// the deployment had landed. waitForTransactionReceipt keeps polling through "not found yet".
const hash = await deployer.deployContract({
  abi: artifact.default.abi,
  bytecode: artifact.default.bytecode as `0x${string}`,
  args,
  gas,
});
console.log(`Sent       ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 1_000 });
if (receipt.status !== "success" || receipt.contractAddress == null) {
  throw new Error(`Deployment transaction ${receipt.transactionHash} failed (status ${receipt.status}).`);
}
const address = getAddress(receipt.contractAddress);
const ledger = await viem.getContractAt("XorvLedger", address);

const [owner, onchainBroker] = await Promise.all([ledger.read.owner(), ledger.read.broker()]);
if (getAddress(owner) !== ownerAddress || getAddress(onchainBroker) !== broker) {
  throw new Error(`Deployed ledger reports owner ${owner} and broker ${onchainBroker}, expected ${ownerAddress} and ${broker}.`);
}
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
} else if (forkOf !== undefined) {
  console.log(`\nFork of ${forkOf.network}: the chain is gone when its node stops, so nothing was written.`);
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
console.log(
  `Rotate     from the owner ${record.owner}: setBroker(<new broker>) if the broker key leaks, ` +
    "transferOwnership(<new owner>) to move the owner (single step, check the address).",
);

// Paste into the repo-root .env (broker) and the indexer's env. The from/start block is the deploy
// block: nothing can be emitted by the ledger before it, so scans and HyperSync start there.
console.log(`
XORV_LEDGER_ADDRESS=${address}
XORV_LEDGER_FROM_BLOCK=${record.blockNumber}
ENVIO_XORV_LEDGER_ADDRESS=${address}
ENVIO_XORV_LEDGER_START_BLOCK=${record.blockNumber}`);

await connection.close();
