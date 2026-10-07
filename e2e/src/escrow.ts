/**
 * `pnpm e2e:escrow`: escrowed payments, end to end, against real contract code.
 *
 * A local fork of Monad testnet (Hardhat 3 / EDR, as `pnpm e2e`), with Circle's real USDC and
 * Cleanverse's real A-Pass forked in. XorvLedger is deployed by its own script; XorvEscrow and
 * the CleanverseGate from contracts/ (Foundry's build output). Then the built broker with its
 * self-hosted facilitator as the escrow's attester, a real provider node (`xorv start`, echo
 * adapter), and real buyers (`xorv run`, and the protocol's x402 client). Every claim is read
 * back from the chain:
 *
 *  1. a paid job funds the escrow (buyer → XorvEscrow), the release pays the provider with the
 *     result's hash, and the XorvLedger receipt records the release as the job's payment;
 *  2. a buyer's cancel refunds the escrow in full (JobRefunded, provider not at fault);
 *  3. with the Cleanverse gate set on the escrow, a buyer without an A-Pass is refused before
 *     anything moves; once Cleanverse's own validator issues one (impersonated, on this fork
 *     only), the same buyer pays and the job is released.
 *
 * Needs `pnpm build` and `forge build` in contracts/. Writes e2e/last-run-escrow.md.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  MONAD_TESTNET,
  XORV_ESCROW_ABI,
  networkConfig,
  textHash,
  viemChain,
  type Capability,
  type PublicJob,
  type PublicProvider,
  type QuoteResponse,
} from "@xorv/protocol";
import { brokerApi, getJob, payQuote, waitForJob } from "./api.js";
import { deployLedger, fundUsdc, setMon, startFork, waitUntil, type Fork } from "./chain.js";
import { cleanEnv, sealedBrokerEnv } from "./env.js";
import { readLedgerEvents, usdcBalance } from "./onchain.js";
import { ProcessGroup, tail } from "./procs.js";
import { Report, bold, dim } from "./report.js";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const E2E_DIR = path.join(REPO, "e2e");
const CONTRACTS_DIR = path.join(REPO, "packages", "contracts");
const FOUNDRY_OUT = path.join(REPO, "contracts", "out");
const BROKER_ENTRY = path.join(REPO, "services", "broker", "dist", "index.js");
const CLI_ENTRY = path.join(REPO, "packages", "cli", "dist", "index.js");
const NETWORK = MONAD_TESTNET;
const NET = networkConfig(NETWORK);
const USDC = NET.usdc.address as Address;
/** Cleanverse on Monad testnet: the A-Pass credential, and the validator that holds its ISSUER_ROLE. */
const APASS = "0xbA82D189540CaC9DC6FF46B6837CaC1BFdEC58B9" as Address;
const CV_VALIDATOR = "0xaC7e5179C2C7f03f209136886c172eb34F161792" as Address;
const APASS_ISSUE = "0xb8dd3664";
const APASS_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const GATE_ABI = parseAbi(["function isVerified(address) view returns (bool)"]);
const BUYER_USDC = 5_000_000n;
const PRICE_UNITS = 1_000n; // the echo capability's $0.001
const CAPABILITIES: Capability[] = [
  { id: "echo", adapter: "echo", displayName: "Echo (test)", model: null, priceUsdMicros: 1_000, maxConcurrency: 4 },
];

const report = new Report();
const runDir = fs.mkdtempSync(path.join((fs.mkdirSync(path.join(E2E_DIR, ".runs"), { recursive: true }), path.join(E2E_DIR, ".runs")), "escrow-"));
const group = new ProcessGroup(path.join(runDir, "logs"));
let finishing: Promise<never> | null = null;

process.on("exit", () => group.killAllSync());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    report.error ??= `interrupted by ${signal}`;
    void finish(130);
  });
}

function finish(code: number): Promise<never> {
  finishing ??= (async (): Promise<never> => {
    await group.stopAll();
    const markdown = report.markdown({
      command: "pnpm e2e:escrow",
      environment: [
        ["node", process.version],
        ["platform", `${process.platform} ${os.release()}`],
        ["duration", `${((Date.now() - report.startedAt.getTime()) / 1000).toFixed(1)} s`],
      ],
    });
    fs.writeFileSync(path.join(E2E_DIR, "last-run-escrow.md"), markdown);
    process.stderr.write(`\n${bold(report.summaryLine())}\n${dim("report: e2e/last-run-escrow.md")}\n`);
    if (report.passed) fs.rmSync(runDir, { recursive: true, force: true });
    else {
      process.stderr.write(`${dim(`logs kept in ${path.join(runDir, "logs")}`)}\n`);
      for (const proc of group.list()) {
        if (proc.output.trim()) process.stderr.write(`\n--- ${proc.name} (last lines) ---\n${tail(proc.output, 25)}\n`);
      }
    }
    process.exit(report.passed ? 0 : code);
  })();
  return finishing;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const party = () => {
  const key = generatePrivateKey();
  return { key, address: privateKeyToAccount(key).address };
};

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const file = path.join(FOUNDRY_OUT, `${name}.sol`, `${name}.json`);
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

/** Issue an A-Pass as Cleanverse's validator does (it holds ISSUER_ROLE). Fork only. */
async function issueAPass(fork: Fork, holder: Address): Promise<Hex> {
  await fork.rpc("hardhat_impersonateAccount", [CV_VALIDATOR]);
  await setMon(fork, CV_VALIDATOR, 10n ** 18n);
  const block = await fork.client.getBlock();
  const args = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint8" },
      { type: "uint8" },
      { type: "bytes2" },
      { type: "bytes2" },
      { type: "uint64" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [holder, 2, 50, "0x0000", "0x4344", block.timestamp + 31_536_000n, BigInt(keccak256(toHex(`xorv-e2e-kyc-${holder}`))), 1n],
  );
  const hash = await fork.rpc<Hex>("eth_sendTransaction", [{ from: CV_VALIDATOR, to: APASS, data: `${APASS_ISSUE}${args.slice(2)}` }]);
  const receipt = await fork.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`A-Pass issue reverted: ${hash}`);
  return hash;
}

async function escrowEvents(fork: Fork, txHash: Hex) {
  const receipt = await fork.client.getTransactionReceipt({ hash: txHash });
  return parseEventLogs({ abi: XORV_ESCROW_ABI, logs: receipt.logs });
}

async function usdcTransfers(fork: Fork, txHash: Hex) {
  const receipt = await fork.client.getTransactionReceipt({ hash: txHash });
  return parseEventLogs({ abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]), logs: receipt.logs }).filter(
    (l) => l.address.toLowerCase() === USDC.toLowerCase(),
  );
}

async function main(): Promise<void> {
  const forkUrl = process.env.MONAD_FORK_URL?.trim() || NET.rpcUrl;

  await report.step("preflight", async (note) => {
    const missing = [BROKER_ENTRY, CLI_ENTRY, path.join(FOUNDRY_OUT, "XorvEscrow.sol", "XorvEscrow.json")].filter((f) => !fs.existsSync(f));
    if (missing.length) throw new Error(`missing ${missing.map((f) => path.relative(REPO, f)).join(", ")}: run \`pnpm build\` and \`forge build\` in contracts/`);
    note(`run directory ${runDir}`);
  });

  const parties = { operator: party(), facilitator: party(), provider: party(), buyer: party() };
  const buyer = privateKeyToAccount(parties.buyer.key);
  report.fact("operator (owns the escrow; ledger writes)", parties.operator.address, "parties");
  report.fact("facilitator (the escrow's attester: funds, releases, refunds)", parties.facilitator.address, "parties");
  report.fact("provider", parties.provider.address, "parties");
  report.fact("buyer (USDC only, no MON)", parties.buyer.address, "parties");

  const fork = await report.step("fork Monad testnet (Hardhat 3 / EDR, chain id 10143)", async (note) => {
    const f = await startFork({ group, contractsDir: CONTRACTS_DIR, port: await freePort(), forkUrl, forkBlock: process.env.MONAD_FORK_BLOCK?.trim() || null, env: cleanEnv() });
    note(`serving ${f.url}, forked at block ${f.forkBlock}`);
    return f;
  });

  await report.step("fund the parties", async () => {
    for (const p of [parties.operator, parties.facilitator, parties.provider]) await setMon(fork, p.address, 100n * 10n ** 18n);
    await fundUsdc(fork, USDC, parties.buyer.address, BUYER_USDC);
    report.equal("buyer USDC", await usdcBalance(fork.client, USDC, parties.buyer.address), BUYER_USDC);
    report.equal("buyer holds no MON", await fork.client.getBalance({ address: parties.buyer.address }), 0n);
  });

  const ledger = await report.step("deploy XorvLedger (packages/contracts' script)", async (note) => {
    const d = await deployLedger({ group, contractsDir: CONTRACTS_DIR, fork, broker: parties.operator.address, env: cleanEnv() });
    note(`XorvLedger at ${d.address}`);
    return d;
  });

  const operatorWallet = createWalletClient({
    chain: viemChain(NETWORK),
    transport: http(fork.url),
    account: privateKeyToAccount(parties.operator.key),
  });

  const escrow = await report.step("deploy XorvEscrow (contracts/, attester = the facilitator)", async (note) => {
    const { abi, bytecode } = artifact("XorvEscrow");
    const hash = await operatorWallet.deployContract({
      abi,
      bytecode,
      args: [parties.operator.address, parties.facilitator.address, "0x0000000000000000000000000000000000000000", [USDC]],
    });
    const receipt = await fork.client.waitForTransactionReceipt({ hash });
    const address = getAddress(receipt.contractAddress!);
    const attester = await fork.client.readContract({ address, abi: XORV_ESCROW_ABI, functionName: "attester" });
    report.equal("escrow attester is the facilitator", attester, parties.facilitator.address);
    report.equal("escrow accepts the forked USDC", await fork.client.readContract({ address, abi: XORV_ESCROW_ABI, functionName: "tokenAllowed", args: [USDC] }), true);
    note(`XorvEscrow at ${address} (tx ${hash})`);
    return address;
  });
  report.fact("XorvEscrow", escrow, "chain");

  const brokerPort = await freePort();
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;
  const api = brokerApi(brokerUrl);
  await report.step("start the broker with the escrow (self-hosted facilitator)", async (note) => {
    const env = sealedBrokerEnv(REPO, {
      XORV_NETWORK: NETWORK,
      XORV_RPC_URL: fork.url,
      XORV_OPERATOR_KEY: parties.operator.key,
      XORV_FACILITATOR_KEY: parties.facilitator.key,
      XORV_FACILITATOR: "self",
      XORV_ESCROW_ADDRESS: escrow,
      XORV_LEDGER_ADDRESS: ledger.address,
      XORV_LEDGER_FROM_BLOCK: ledger.fromBlock.toString(),
      XORV_RECEIPT_BATCH_MS: "500",
      XORV_BROKER_PORT: String(brokerPort),
      XORV_PUBLIC_URL: brokerUrl,
      XORV_BROKER_URL: brokerUrl,
      XORV_DB: path.join(runDir, "broker.db"),
      XORV_ROUTER: "off",
      XORV_SCREENER: "off",
      XORV_VERIFIER: "off",
    });
    const proc = group.start("broker", process.execPath, [BROKER_ENTRY], { cwd: runDir, env });
    await waitUntil("the broker to answer /health", 60_000, async () => {
      if (!proc.running) throw new Error(`the broker exited\n${tail(proc.output)}`);
      return (await api.raw("/health")).status === 200;
    });
    const info = await api.get<Record<string, any>>("/api/network");
    report.equal("broker reports the escrow", info.escrow?.address, escrow);
    report.equal("no identity gate yet", info.escrow?.identityGate ?? null, null);
    note(`listening on ${brokerUrl}`);
  });

  const providerHome = path.join(runDir, "provider");
  await report.step("provider: go live (xorv start, echo)", async (note) => {
    fs.mkdirSync(providerHome, { recursive: true });
    fs.writeFileSync(
      path.join(providerHome, "config.json"),
      JSON.stringify({
        nodeId: `e2e-escrow-${Math.random().toString(36).slice(2, 10)}`,
        label: "e2e-escrow-provider",
        network: NETWORK,
        brokerUrl,
        address: parties.provider.address,
        privateKey: parties.provider.key,
        agentId: null,
        capabilities: CAPABILITIES,
        region: null,
        tunnel: { enabled: false, hostname: null },
        sandboxDir: path.join(providerHome, "jobs"),
        providerId: null,
        token: null,
      }),
    );
    const env = { ...cleanEnv(), XORV_HOME: providerHome, XORV_NETWORK: NETWORK, XORV_RPC_URL: fork.url, XORV_BROKER_URL: brokerUrl };
    const proc = group.start("provider", process.execPath, [CLI_ENTRY, "start"], { cwd: providerHome, env });
    const live = await waitUntil("the provider to be online", 60_000, async () => {
      if (!proc.running) throw new Error(`xorv start exited\n${tail(proc.output)}`);
      const { providers } = await api.get<{ providers: PublicProvider[] }>("/api/providers");
      return providers.find((p) => p.address === parties.provider.address && p.connected);
    });
    note(`provider ${live.id} connected`);
  });

  // ---------------------------------------------------------------------------------------
  const buyerHome = path.join(runDir, "buyer");
  fs.mkdirSync(buyerHome, { recursive: true });
  const buyerEnv = { ...cleanEnv(), XORV_HOME: buyerHome, XORV_PAYER_KEY: parties.buyer.key, XORV_NETWORK: NETWORK, XORV_RPC_URL: fork.url, XORV_BROKER_URL: brokerUrl };

  const released = await report.step("buyer: xorv run pays into the escrow; the release pays the provider", async (note) => {
    const before = { buyer: await usdcBalance(fork.client, USDC, parties.buyer.address), provider: await usdcBalance(fork.client, USDC, parties.provider.address) };
    const result = await group.run("xorv-run", process.execPath, [CLI_ENTRY, "run", "Say hello to Monad", "--json", "--yes", "--max", "0.01"], {
      cwd: buyerHome,
      env: buyerEnv,
      timeoutMs: 180_000,
    });
    const out = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as { jobId: string; status: string; result: string | null; resultHash: string | null; quote: QuoteResponse };
    if (result.code !== 0) throw new Error(`xorv run exited ${result.code}: ${JSON.stringify(out).slice(0, 400)}`);
    report.equal("the quote named the escrow", out.quote.escrow?.address, escrow);
    report.equal("the 402 offered escrow first", out.quote.accepts[0]?.scheme, "escrow");
    report.equal("job completed", out.status, "completed");
    const job = await waitUntil("the escrow to be released", 60_000, async () => {
      const j = await getJob(api, out.jobId);
      return j.payment?.escrow?.state === "released" ? j : null;
    });
    const held = job.payment!.escrow!;
    report.equal("payment scheme", job.payment?.scheme, "escrow");
    report.equal("payTo is the provider the escrow released to", job.payment?.payTo, parties.provider.address);

    // Funding: the buyer's USDC went into the escrow, not to the provider.
    const funding = await usdcTransfers(fork, job.payment!.txHash as Hex);
    report.check(
      "funding moved exactly the price buyer → XorvEscrow",
      funding.length === 1 && funding[0]!.args.from === parties.buyer.address && funding[0]!.args.to === escrow && funding[0]!.args.value === PRICE_UNITS,
      JSON.stringify(funding.map((t) => ({ from: t.args.from, to: t.args.to, value: String(t.args.value) }))),
    );
    report.check("JobFunded in the funding tx", (await escrowEvents(fork, job.payment!.txHash as Hex)).some((e) => e.eventName === "JobFunded"));

    // Release: XorvEscrow → provider, with the result's hash on chain.
    const releaseEvents = await escrowEvents(fork, held.releaseTx as Hex);
    const releasedEvent = releaseEvents.find((e) => e.eventName === "JobReleased") as { args: { provider: string; resultHash: string } } | undefined;
    report.equal("JobReleased pays the provider", releasedEvent?.args.provider, parties.provider.address);
    report.equal("JobReleased carries the result's hash", releasedEvent?.args.resultHash, textHash(out.result ?? ""));
    const release = await usdcTransfers(fork, held.releaseTx as Hex);
    report.check("release moved the price XorvEscrow → provider", release.some((t) => t.args.from === escrow && t.args.to === parties.provider.address && t.args.value === PRICE_UNITS));

    report.equal("buyer paid exactly the price", before.buyer - (await usdcBalance(fork.client, USDC, parties.buyer.address)), PRICE_UNITS);
    report.equal("provider received exactly the price", (await usdcBalance(fork.client, USDC, parties.provider.address)) - before.provider, PRICE_UNITS);
    report.equal("escrow holds nothing for this job", await usdcBalance(fork.client, USDC, escrow), 0n);
    report.equal("buyer still holds no MON", await fork.client.getBalance({ address: parties.buyer.address }), 0n);
    note(`fund ${job.payment!.txHash}, release ${held.releaseTx}`);
    return job;
  });

  await report.step("XorvLedger receipt records the release as the job's payment", async () => {
    const withReceipt = await waitUntil("the receipt", 60_000, async () => {
      const j = await getJob(api, released.id);
      return j.receiptTxHash ? j : null;
    });
    const events = await readLedgerEvents(fork.client, ledger.address, ledger.fromBlock);
    const recorded = events.recorded.find((e) => e.transactionHash === withReceipt.receiptTxHash);
    report.equal("JobRecorded.paymentTx is the release", recorded?.args.paymentTx, released.payment!.escrow!.releaseTx);
    report.equal("JobRecorded.payTo is the provider", recorded?.args.payTo, parties.provider.address);
  });

  // ---------------------------------------------------------------------------------------
  await report.step("buyer cancels a running job: the escrow refunds in full, no fault", async (note) => {
    const before = await usdcBalance(fork.client, USDC, parties.buyer.address);
    const quote = await api.post<QuoteResponse>("/api/quotes", { prompt: "slow: please take your time", maxPriceUsdMicros: 10_000 });
    const paid = await payQuote({ quote, buyer, network: NETWORK });
    const res = await api.raw(`/api/jobs/${paid.jobId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${String(paid.body.cancelToken)}` },
      body: "{}",
    });
    const body = res.body as { refunded?: boolean; refundTx?: Hex; status?: string };
    if (body.status !== "failed") {
      // The echo job may finish before the cancel lands; then it was released, which is not this test.
      throw new Error(`the job finished before the cancel (${JSON.stringify(body)}); rerun`);
    }
    report.equal("cancel says refunded", body.refunded, true);
    const refund = (await escrowEvents(fork, body.refundTx!)).find((e) => e.eventName === "JobRefunded") as { args: { providerAtFault: boolean } } | undefined;
    report.equal("JobRefunded, provider not at fault", refund?.args.providerAtFault, false);
    report.equal("buyer made whole", await usdcBalance(fork.client, USDC, parties.buyer.address), before);
    note(`refund ${body.refundTx}`);
  });

  // ---------------------------------------------------------------------------------------
  const gate = await report.step("Cleanverse: deploy the gate over the real A-Pass and set it on the escrow", async (note) => {
    const { abi, bytecode } = artifact("CleanverseGate");
    const hash = await operatorWallet.deployContract({ abi, bytecode, args: [APASS, CV_VALIDATOR, "0x0000000000000000000000000000000000000000"] });
    const address = getAddress((await fork.client.waitForTransactionReceipt({ hash })).contractAddress!);
    const set = await operatorWallet.sendTransaction({
      to: escrow,
      data: encodeFunctionData({ abi: XORV_ESCROW_ABI, functionName: "setIdentityGate", args: [address] }),
    });
    await fork.client.waitForTransactionReceipt({ hash: set });
    await issueAPass(fork, parties.provider.address);
    report.equal("provider holds an A-Pass", await fork.client.readContract({ address: APASS, abi: APASS_ABI, functionName: "balanceOf", args: [parties.provider.address] }), 1n);
    report.equal("buyer holds none yet", await fork.client.readContract({ address: address, abi: GATE_ABI, functionName: "isVerified", args: [parties.buyer.address] }), false);
    await waitUntil("the broker to see the gate", 60_000, async () => {
      const info = await api.get<Record<string, any>>("/api/network");
      return info.escrow?.identityGate?.address === address ? true : null;
    });
    note(`CleanverseGate at ${address}`);
    return address;
  });
  report.fact("CleanverseGate", gate, "chain");

  await report.step("a buyer without an A-Pass is refused before anything moves", async () => {
    const before = await usdcBalance(fork.client, USDC, parties.buyer.address);
    const quote = await api.post<QuoteResponse>("/api/quotes", { prompt: "Say hello again", maxPriceUsdMicros: 10_000 });
    const refused = await payQuote({ quote, buyer, network: NETWORK }).then(
      () => null,
      (err: unknown) => err,
    );
    report.check("payment refused", refused !== null, String(refused).slice(0, 200));
    report.equal("buyer's USDC did not move", await usdcBalance(fork.client, USDC, parties.buyer.address), before);
  });

  await report.step("Cleanverse issues the buyer an A-Pass; the same buyer pays and is released", async () => {
    await issueAPass(fork, parties.buyer.address);
    report.equal("gate now verifies the buyer", await fork.client.readContract({ address: gate, abi: GATE_ABI, functionName: "isVerified", args: [parties.buyer.address] }), true);
    const quote = await api.post<QuoteResponse>("/api/quotes", { prompt: "Say hello, verified", maxPriceUsdMicros: 10_000 });
    const paid = await payQuote({ quote, buyer, network: NETWORK });
    await waitForJob(api, paid.jobId);
    const job = await waitUntil("the escrow release", 60_000, async () => {
      const j: PublicJob = await getJob(api, paid.jobId);
      return j.payment?.escrow?.state === "released" ? j : null;
    });
    report.check("released to the verified provider", Boolean(job.payment?.escrow?.releaseTx), job.payment?.escrow?.releaseTx ?? "none");
  });
}

main().then(
  () => finish(0),
  (err) => {
    report.error ??= err instanceof Error ? err.message : String(err);
    return finish(1);
  },
);
