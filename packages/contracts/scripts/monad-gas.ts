/**
 * Measures XorvLedger's gas on the live Monad chain, without deploying anything or holding any MON.
 *
 *   pnpm --filter @xorv/contracts gas:monad                 # Monad testnet
 *   pnpm --filter @xorv/contracts exec hardhat run scripts/monad-gas.ts --network monad
 *
 * Hardhat's simulated chain prices gas like Ethereum. Monad doesn't: cold accounts cost 10,100, storage
 * is warmed per 128-slot page (8,100 cold), and a fresh slot costs 27,900. And since Monad bills the
 * gas LIMIT, these are the numbers the broker's MON budget actually depends on.
 *
 * How: every figure is an eth_estimateGas against the public RPC with state overrides. The ledger's
 * runtime code (obtained by eth_call-ing its creation code, so the immutables are real) is placed at
 * the address a fresh deployer would get, with the broker slot and job slots written directly. Calls
 * go into the REAL ERC-8004 registries on that chain, including a real agent's verified wallet. The
 * throwaway keys below only ever sign EIP-712 data locally. Nothing is broadcast.
 */
import hre from "hardhat";
import {
  type Address,
  type Hex,
  type StateOverride,
  BaseError,
  createPublicClient,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  formatGwei,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { NO_AGENT, makeRating, makeReceipt, ratingTypedData, textHash } from "../test/helpers.js";
import { monadDeploymentFor, rpcUrlFor, withGasMargin } from "./lib/networks.js";

const net = monadDeploymentFor(hre.globalOptions.network);
if (net === undefined) {
  throw new Error(`Pass --network monadTestnet or --network monad (got "${hre.globalOptions.network}").`);
}
const client = createPublicClient({ transport: http(rpcUrlFor(net)) });
const chainId = await client.getChainId();
if (chainId !== net.chainId) throw new Error(`RPC reports chainId ${chainId}, expected ${net.chainId}.`);

const ledgerArtifact = await hre.artifacts.readArtifact("XorvLedger");
const walletArtifact = await hre.artifacts.readArtifact("ERC1271WalletMock");
const abi = ledgerArtifact.abi;

// XorvLedger storage: EIP712's two fallback strings take slots 0-1, then owner, broker, jobs.
// Checked below by reading broker() and jobs() back through the override.
const SLOT_BROKER = 3n;
const SLOT_JOBS = 4n;
// ReputationRegistryUpgradeable's ERC-7201 namespace ("erc8004.reputation.registry.2") and the
// positions of _lastIndex and _clientExists in its storage struct.
const REPUTATION_NS = 0xa03d7693f2b3746b2d03f163c788147b71aa82854399a21fdf4de143ba778300n;
const REP_LAST_INDEX = REPUTATION_NS + 1n;
const REP_CLIENT_EXISTS = REPUTATION_NS + 6n;

const IDENTITY_ABI = parseAbi(["function getAgentWallet(uint256) view returns (address)"]);
const REPUTATION_ABI = parseAbi(["function getLastIndex(uint256, address) view returns (uint64)"]);

const word = (value: bigint): Hex => pad(numberToHex(value), { size: 32 });
const mappingSlot = (key: Hex, keyType: "bytes32" | "uint256" | "address", slot: bigint | Hex): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: keyType }, { type: "uint256" }],
      [keyType === "uint256" ? BigInt(key) : key, typeof slot === "bigint" ? slot : BigInt(slot)] as never,
    ),
  );

// A fresh deployer: the ledger lands at its nonce-0 CREATE address, and eth_call of the creation code
// from it returns runtime code with exactly that address baked into EIP712's cached domain.
const deployer = privateKeyToAccount(generatePrivateKey()).address;
const broker = deployer;
const ledger = getContractAddress({ from: deployer, nonce: 0n });
const deployData = encodeDeployData({
  abi,
  bytecode: ledgerArtifact.bytecode as Hex,
  args: [net.identity, net.reputation, broker],
});
const deployGas = await client.estimateGas({ account: deployer, data: deployData });
const ledgerRuntime = (await client.request({ method: "eth_call", params: [{ from: deployer, data: deployData }, "latest"] })) as Hex;

// A real, currently-verified agent on this chain: the first low agentId whose wallet is set.
let agentId = -1n;
let payTo: Address = zeroAddress;
for (let id = 0n; id < 50n && agentId < 0n; id++) {
  const wallet = await client.readContract({ address: net.identity, abi: IDENTITY_ABI, functionName: "getAgentWallet", args: [id] });
  if (wallet !== zeroAddress) {
    agentId = id;
    payTo = getAddress(wallet);
  }
}
if (agentId < 0n) throw new Error("No agent with a verified wallet among agentIds 0-49.");

const buyer = privateKeyToAccount(generatePrivateKey());
const walletOwner = privateKeyToAccount(generatePrivateKey());
const smartWallet = getContractAddress({ from: deployer, nonce: 1n });
const walletRuntime = (await client.request({
  method: "eth_call",
  params: [
    {
      from: deployer,
      data: encodeDeployData({ abi: walletArtifact.abi, bytecode: walletArtifact.bytecode as Hex, args: [walletOwner.address] }),
    },
    "latest",
  ],
})) as Hex;

const rateJobs = {
  direct: makeReceipt("monad-direct", { agentId, buyer: buyer.address, payTo }),
  relayed: makeReceipt("monad-relayed", { agentId, buyer: buyer.address, payTo }),
  erc1271: makeReceipt("monad-1271", { agentId, buyer: smartWallet, payTo }),
};
const packedJob = (jobBuyer: Address) => word(BigInt(jobBuyer) | (agentId << 160n)); // rated = false

/** The ledger as if deployed and holding the three recorded jobs; optionally not its first rating. */
function overrides(opts: { laterRating?: boolean } = {}): StateOverride {
  const ledgerState = [
    { slot: word(SLOT_BROKER), value: word(BigInt(broker)) },
    ...Object.values(rateJobs).map((r) => ({ slot: mappingSlot(r.jobId, "bytes32", SLOT_JOBS), value: packedJob(r.buyer) })),
  ];
  const state: StateOverride = [
    { address: ledger, code: ledgerRuntime, stateDiff: ledgerState },
    { address: smartWallet, code: walletRuntime },
  ];
  if (opts.laterRating) {
    // The registry already lists the ledger as a client of this agent with one earlier feedback,
    // which is the steady state: only the very first rating of each agent pays for the client list.
    const perAgent = (base: bigint) => mappingSlot(numberToHex(agentId), "uint256", base);
    state.push({
      address: net!.reputation,
      stateDiff: [
        { slot: mappingSlot(ledger, "address", perAgent(REP_CLIENT_EXISTS)), value: word(1n) },
        { slot: mappingSlot(ledger, "address", perAgent(REP_LAST_INDEX)), value: word(1n) },
      ],
    });
  }
  return state;
}

// Sanity-check the override layout before trusting any number.
const readThrough = async (data: Hex, stateOverride: StateOverride) =>
  (await client.call({ to: ledger, data, stateOverride })).data ?? "0x";
if (BigInt(await readThrough(encodeFunctionData({ abi, functionName: "broker" }), overrides())) !== BigInt(broker)) {
  throw new Error("broker() didn't read back through the override: XorvLedger's storage layout changed.");
}
const jobWord = await readThrough(encodeFunctionData({ abi, functionName: "jobs", args: [rateJobs.direct.jobId] }), overrides());
if (BigInt(`0x${jobWord.slice(2, 66)}`) !== BigInt(buyer.address)) {
  throw new Error("jobs() didn't read back through the override: XorvLedger's storage layout changed.");
}
const lastIndex = await client.readContract({
  address: net.reputation,
  abi: REPUTATION_ABI,
  functionName: "getLastIndex",
  args: [agentId, ledger],
  stateOverride: overrides({ laterRating: true }),
});
if (lastIndex !== 1n) throw new Error("ReputationRegistry storage override missed: its layout changed.");

interface Row {
  call: string;
  gas: bigint;
  jobs?: number;
}
const rows: Row[] = [{ call: "deploy XorvLedger", gas: deployGas }];
const estimate = (account: Address, data: Hex, stateOverride = overrides()) =>
  client.estimateGas({ account, to: ledger, data, stateOverride });

rows.push({
  call: "registerProvider (with agent)",
  gas: await estimate(
    broker,
    encodeFunctionData({
      abi,
      functionName: "registerProvider",
      args: [textHash("node-7f3a"), payTo, agentId, "node-7f3a (Claude Code)", "claude-code:10000,qwen:5000"],
    }),
  ),
});
rows.push({
  call: "heartbeat",
  gas: await estimate(broker, encodeFunctionData({ abi, functionName: "heartbeat", args: [textHash("node-7f3a"), 2, 4, 86_400] })),
});
for (const n of [1, 5, 20]) {
  const batch = Array.from({ length: n }, (_, i) => makeReceipt(`monad-${n}-${i}`, { agentId, buyer: buyer.address, payTo }));
  rows.push({ call: `recordJobs(${n}), one agent`, gas: await estimate(broker, encodeFunctionData({ abi, functionName: "recordJobs", args: [batch] })), jobs: n });
}
{
  const batch = Array.from({ length: 20 }, (_, i) => makeReceipt(`monad-na-${i}`, { agentId: NO_AGENT, buyer: buyer.address, payTo }));
  rows.push({ call: "recordJobs(20), NO_AGENT", gas: await estimate(broker, encodeFunctionData({ abi, functionName: "recordJobs", args: [batch] })), jobs: 20 });
}

const rating = (jobId: Hex) => makeRating(jobId);
const sign = (signer: typeof buyer, jobId: Hex) => signer.signTypedData(ratingTypedData(chainId, ledger, rating(jobId)));
const rateData = (jobId: Hex, signature: Hex) => encodeFunctionData({ abi, functionName: "rateJob", args: [rating(jobId), signature] });

for (const later of [false, true]) {
  const suffix = later ? "later rating" : "1st rating of agent";
  const state = overrides({ laterRating: later });
  rows.push({ call: `rateJob direct (${suffix})`, gas: await estimate(buyer.address, rateData(rateJobs.direct.jobId, "0x"), state) });
  rows.push({
    call: `rateJob relayed EOA sig (${suffix})`,
    gas: await estimate(broker, rateData(rateJobs.relayed.jobId, await sign(buyer, rateJobs.relayed.jobId)), state),
  });
  rows.push({
    call: `rateJob relayed ERC-1271 (${suffix})`,
    gas: await estimate(broker, rateData(rateJobs.erc1271.jobId, await sign(walletOwner, rateJobs.erc1271.jobId)), state),
  });
}

// The same wiring must reject what the tests say it rejects, against the live registries.
async function revertSelector(account: Address, data: Hex): Promise<string> {
  try {
    await client.call({ account, to: ledger, data, stateOverride: overrides() });
    return "no revert";
  } catch (error) {
    // The revert payload sits on whichever error in viem's cause chain carries `data`.
    const hexData = (e: unknown): string | undefined => {
      const data = (e as { data?: unknown }).data;
      if (typeof data === "string" && data.startsWith("0x")) return data;
      const nested = (data as { data?: unknown } | undefined)?.data;
      return typeof nested === "string" && nested.startsWith("0x") ? nested : undefined;
    };
    const carrier = error instanceof BaseError ? error.walk((e) => hexData(e) !== undefined) : error;
    const hex = hexData(carrier);
    return hex ? hex.slice(0, 10) : "reverted without data";
  }
}
const intruder = privateKeyToAccount(generatePrivateKey());
const badSig = await revertSelector(broker, rateData(rateJobs.relayed.jobId, await sign(intruder, rateJobs.relayed.jobId)));
const badPayTo = await revertSelector(
  broker,
  encodeFunctionData({ abi, functionName: "recordJobs", args: [[makeReceipt("monad-bad", { agentId, buyer: buyer.address, payTo: buyer.address })]] }),
);

const gasPrice = await client.getGasPrice();
const block = await client.getBlock();
console.log(`\nXorvLedger on ${net.network} (chainId ${chainId}), block ${block.number}, gas price ${formatGwei(gasPrice)} gwei`);
console.log(`Real ERC-8004 agent #${agentId} (wallet ${payTo}); ledger simulated at ${ledger}\n`);
console.log(`  ${"call".padEnd(48)}${"estimate".padStart(11)}${"limit x1.15".padStart(13)}${"MON".padStart(10)}${"per job".padStart(10)}`);
for (const r of rows) {
  const limit = withGasMargin(r.gas);
  const mon = Number(formatEther(limit * gasPrice)).toFixed(4);
  const perJob = r.jobs ? (r.gas / BigInt(r.jobs)).toLocaleString("en-US") : "";
  console.log(
    `  ${r.call.padEnd(48)}${r.gas.toLocaleString("en-US").padStart(11)}${limit.toLocaleString("en-US").padStart(13)}${mon.padStart(10)}${perJob.padStart(10)}`,
  );
}
const expectRevert = (label: string, got: string, errorSignature: string) => {
  const want = toFunctionSelector(errorSignature);
  const verdict = got === want ? "ok" : `UNEXPECTED, wanted ${want}`;
  console.log(`  ${label.padEnd(16)} -> ${got} ${verdict} (${errorSignature.split("(")[0]})`);
  if (got !== want) process.exitCode = 1;
};
console.log();
expectRevert("wrong signer", badSig, "BadSignature()");
expectRevert("payTo mismatch", badPayTo, "PayToNotAgentWallet(uint256,address,address)");
console.log();
