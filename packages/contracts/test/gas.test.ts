import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { type Hash, encodeDeployData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { NO_AGENT, deployErc8004, makeRating, makeReceipt, registerAgent, signRating, textHash } from "./helpers.js";

// Gas report for the calls the broker pays for. Printed, and loosely bounded so a regression that
// doubles a cost fails CI instead of silently doubling the broker's MON bill.
//
// These figures come from Hardhat's simulated chain, which uses Ethereum's gas schedule. Monad reprices
// cold state (10,100 per cold account, 8,100 per cold 128-slot storage page, 27,900 for a fresh slot on
// a new page), so the numbers on Monad differ; `pnpm gas:monad` measures the same calls against the live
// Monad RPC with eth_estimateGas and state overrides (read-only: nothing is deployed or signed).

interface Row {
  call: string;
  gasUsed: bigint;
  estimate: bigint;
  perJob?: bigint;
}

describe("gas report (Hardhat simulated chain, Ethereum gas schedule)", async function () {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const [, broker, provider, buyer] = await viem.getWalletClients();
  if (!broker || !provider || !buyer) throw new Error("need 4 accounts");

  it("measures deploy, registerProvider, heartbeat, recordJobs(1/5/20) and rateJob", async function () {
    const rows: Row[] = [];
    const gasOf = async (hash: Hash) => (await publicClient.waitForTransactionReceipt({ hash })).gasUsed;

    const { identity, reputation } = await deployErc8004(viem);
    const agentId = await registerAgent(viem, identity, provider, "https://broker.xorv.xyz/agents/node-7f3a.json");

    const artifact = await import("../artifacts/contracts/XorvLedger.sol/XorvLedger.json", { with: { type: "json" } });
    const deployData = encodeDeployData({
      abi: artifact.default.abi,
      bytecode: artifact.default.bytecode as `0x${string}`,
      args: [identity.address, reputation.address, broker.account.address],
    });
    const deployEstimate = await publicClient.estimateGas({ account: broker.account.address, data: deployData });
    const { contract: ledger, deploymentTransaction } = await viem.sendDeploymentTransaction("XorvLedger", [
      identity.address,
      reputation.address,
      broker.account.address,
    ]);
    rows.push({ call: "deploy XorvLedger", gasUsed: await gasOf(deploymentTransaction.hash), estimate: deployEstimate });

    const asBroker = await viem.getContractAt("XorvLedger", ledger.address, { client: { wallet: broker } });
    const brokerAccount = broker.account.address;

    const register = [textHash("node-7f3a"), provider.account.address, agentId, "node-7f3a (Claude Code)", "claude-code:10000,qwen:5000"] as const;
    rows.push({
      call: "registerProvider (with agent)",
      estimate: await asBroker.estimateGas.registerProvider([...register], { account: brokerAccount }),
      gasUsed: await gasOf(await asBroker.write.registerProvider([...register])),
    });
    rows.push({
      call: "heartbeat",
      estimate: await asBroker.estimateGas.heartbeat([textHash("node-7f3a"), 2, 4, 86_400], { account: brokerAccount }),
      gasUsed: await gasOf(await asBroker.write.heartbeat([textHash("node-7f3a"), 2, 4, 86_400])),
    });

    const perJob: Record<number, bigint> = {};
    for (const n of [1, 5, 20]) {
      const batch = Array.from({ length: n }, (_, i) =>
        makeReceipt(`batch${n}-${i}`, { agentId, buyer: buyer.account.address, payTo: provider.account.address }),
      );
      const estimate = await asBroker.estimateGas.recordJobs([batch], { account: brokerAccount });
      const gasUsed = await gasOf(await asBroker.write.recordJobs([batch]));
      perJob[n] = gasUsed / BigInt(n);
      rows.push({ call: `recordJobs(${n}), one agent`, gasUsed, estimate, perJob: perJob[n] });
    }
    {
      const batch = Array.from({ length: 20 }, (_, i) =>
        makeReceipt(`noagent-${i}`, { agentId: NO_AGENT, buyer: buyer.account.address, payTo: provider.account.address }),
      );
      const estimate = await asBroker.estimateGas.recordJobs([batch], { account: brokerAccount });
      const gasUsed = await gasOf(await asBroker.write.recordJobs([batch]));
      rows.push({ call: "recordJobs(20), NO_AGENT", gasUsed, estimate, perJob: gasUsed / 20n });
    }

    // Ratings: record the jobs first, then rate each one a different way.
    const viemBuyer = privateKeyToAccount(generatePrivateKey());
    const walletOwner = privateKeyToAccount(generatePrivateKey());
    const smartWallet = await viem.deployContract("ERC1271WalletMock", [walletOwner.address]);
    const jobs = {
      first: makeReceipt("rate-first", { agentId, buyer: buyer.account.address, payTo: provider.account.address }),
      second: makeReceipt("rate-second", { agentId, buyer: buyer.account.address, payTo: provider.account.address }),
      relayed: makeReceipt("rate-relayed", { agentId, buyer: viemBuyer.address, payTo: provider.account.address }),
      erc1271: makeReceipt("rate-1271", { agentId, buyer: smartWallet.address, payTo: provider.account.address }),
    };
    await asBroker.write.recordJobs([Object.values(jobs)]);

    const asBuyer = await viem.getContractAt("XorvLedger", ledger.address, { client: { wallet: buyer } });
    const direct = async (label: string, jobId: `0x${string}`) => {
      const rating = makeRating(jobId);
      rows.push({
        call: label,
        estimate: await asBuyer.estimateGas.rateJob([rating, "0x"], { account: buyer.account.address }),
        gasUsed: await gasOf(await asBuyer.write.rateJob([rating, "0x"])),
      });
    };
    const relayed = async (label: string, jobId: `0x${string}`, signer: typeof viemBuyer) => {
      const rating = makeRating(jobId);
      const signature = await signRating(signer, chainId, ledger.address, rating);
      rows.push({
        call: label,
        estimate: await asBroker.estimateGas.rateJob([rating, signature], { account: brokerAccount }),
        gasUsed: await gasOf(await asBroker.write.rateJob([rating, signature])),
      });
    };
    // The ledger's first rating of an agent also appends it to the registry's client list.
    await direct("rateJob direct (ledger's 1st rating of agent)", jobs.first.jobId);
    await direct("rateJob direct (later rating)", jobs.second.jobId);
    await relayed("rateJob relayed, EOA EIP-712 sig", jobs.relayed.jobId, viemBuyer);
    await relayed("rateJob relayed, ERC-1271 wallet", jobs.erc1271.jobId, walletOwner);

    const pad = (s: string, n: number) => s.padEnd(n);
    const num = (v: bigint | undefined, n: number) => (v === undefined ? "" : v.toLocaleString("en-US")).padStart(n);
    console.log("\n  XorvLedger gas (Hardhat EDR, Ethereum schedule; Monad figures: pnpm gas:monad)");
    console.log(`  ${pad("call", 46)}${"gasUsed".padStart(12)}${"estimate".padStart(12)}${"per job".padStart(10)}`);
    for (const r of rows) console.log(`  ${pad(r.call, 46)}${num(r.gasUsed, 12)}${num(r.estimate, 12)}${num(r.perJob, 10)}`);
    console.log();

    // Batching must pay off: the per-job cost of a 20-receipt batch is well under a single receipt's.
    assert.ok(perJob[20]! * 2n < perJob[1]!, `batching stopped amortising: ${perJob[20]} vs ${perJob[1]}`);
    // Loose ceilings (roughly 1.5x today's figures) to catch accidental extra storage writes.
    assert.ok(perJob[20]! < 45_000n, `recordJobs(20) per job ${perJob[20]}`);
    assert.ok(perJob[1]! < 110_000n, `recordJobs(1) ${perJob[1]}`);
    for (const r of rows.filter((row) => row.call.startsWith("rateJob"))) {
      assert.ok(r.gasUsed < 450_000n, `${r.call} ${r.gasUsed}`);
    }
  });
});
