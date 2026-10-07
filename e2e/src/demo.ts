/**
 * `pnpm demo`: the whole product on your machine, with no keys and no testnet funds.
 *
 * One command brings up a local fork of Monad testnet (anvil) with Circle's real USDC and the
 * canonical ERC-8004 registries forked in, deploys XorvLedger (its own script) and XorvEscrow
 * (contracts/), starts the built broker with its self-hosted facilitator as the escrow's attester,
 * two provider nodes (each registered in the canonical ERC-8004 Identity Registry with
 * `xorv identity register`, then `xorv start` with the echo adapter at two prices), seeds a few real paid jobs
 * (escrowed, released, one cancelled and refunded), and starts the web app with a funded demo
 * account. Every transaction is a real signed transaction on the fork; nothing is mocked.
 *
 * The keys it generates exist only on this fork. Ctrl-C stops everything it started.
 *
 *   pnpm build && (cd contracts && forge build) && pnpm demo
 *
 * Env: XORV_DEMO_APP=0 skips the app (run it yourself with the printed env); XORV_DEMO_SEED=0
 * skips the seeded jobs; MONAD_FORK_URL picks the RPC to fork; XORV_DEMO_PORT_BASE (default 8650)
 * picks the ports (chain +0, broker +1, app +2).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, getAddress, http, type Abi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  MONAD_TESTNET,
  networkConfig,
  viemChain,
  type Capability,
  type PublicJob,
  type PublicProvider,
  type QuoteResponse,
  ratingTypedData,
} from "@xorv/protocol";
import { brokerApi, getJob, payQuote, waitForJob } from "./api.js";
import { deployLedger, fundUsdc, setMon, waitUntil, type Fork } from "./chain.js";
import { cleanEnv, sealedBrokerEnv } from "./env.js";
import { ProcessGroup, tail } from "./procs.js";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RUN_DIR = path.join(REPO, "e2e", ".runs", "demo");
const CONTRACTS_DIR = path.join(REPO, "packages", "contracts");
const FOUNDRY_OUT = path.join(REPO, "contracts", "out");
const BROKER_ENTRY = path.join(REPO, "services", "broker", "dist", "index.js");
const CLI_ENTRY = path.join(REPO, "packages", "cli", "dist", "index.js");
const APP_DIR = path.join(REPO, "apps", "app");
const NETWORK = MONAD_TESTNET;
const NET = networkConfig(NETWORK);
const USDC = NET.usdc.address as Address;
const BASE = Number(process.env.XORV_DEMO_PORT_BASE ?? 8650);
const PORTS = { chain: BASE, broker: BASE + 1, app: BASE + 2 };
const WITH_APP = process.env.XORV_DEMO_APP !== "0";
const SEED = process.env.XORV_DEMO_SEED !== "0";

const PROVIDERS: { label: string; capabilities: Capability[] }[] = [
  {
    label: "atlas",
    capabilities: [{ id: "echo", adapter: "echo", displayName: "Echo (test)", model: null, priceUsdMicros: 1_000, maxConcurrency: 4 }],
  },
  {
    label: "borealis",
    capabilities: [{ id: "echo", adapter: "echo", displayName: "Echo (test)", model: null, priceUsdMicros: 2_000, maxConcurrency: 4 }],
  },
];

const SEED_PROMPTS = [
  "Summarise what an x402 payment is in two sentences.",
  "List three things a provider should check before accepting a job.",
  "Explain ERC-8004 reputation to a new user.",
  "Write a haiku about 400 ms blocks.",
];

const group = new ProcessGroup(path.join(RUN_DIR, "logs"));
const log = (line: string) => process.stderr.write(`${line}\n`);
let stopping = false;

process.on("exit", () => group.killAllSync());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => void stop(0));
}

async function stop(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    log("\nstopping the demo stack…");
    await group.stopAll();
  }
  process.exit(code);
}

const party = () => {
  const key = generatePrivateKey();
  return { key, address: privateKeyToAccount(key).address };
};

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(fs.readFileSync(path.join(FOUNDRY_OUT, `${name}.sol`, `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

/** anvil, forking Monad testnet: Monad's 400 ms block interval, bounded state history. */
async function startChain(forkUrl: string): Promise<Fork> {
  const url = `http://127.0.0.1:${PORTS.chain}`;
  const proc = group.start(
    "chain",
    "anvil",
    ["--fork-url", forkUrl, "--port", String(PORTS.chain), "--block-time", "0.4", "--prune-history", "300", "--silent", "--retries", "8", "--fork-retry-backoff", "500", "--timeout", "30000"],
    { cwd: RUN_DIR, env: cleanEnv() },
  );
  const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  };
  await waitUntil("anvil to answer", 120_000, async () => {
    if (!proc.running) throw new Error(`anvil exited\n${tail(proc.output)}`);
    return Number(await rpc<string>("eth_chainId")) === NET.chainId;
  });
  const client = createPublicClient({ chain: viemChain(NETWORK), transport: http(url, { timeout: 120_000 }), pollingInterval: 200 });
  return { url, chainId: NET.chainId, forkBlock: await client.getBlockNumber(), forkedFrom: forkUrl, process: proc, client, rpc };
}

async function main(): Promise<void> {
  const missing = [BROKER_ENTRY, CLI_ENTRY, path.join(FOUNDRY_OUT, "XorvEscrow.sol", "XorvEscrow.json")].filter((f) => !fs.existsSync(f));
  if (missing.length) throw new Error(`missing ${missing.map((f) => path.relative(REPO, f)).join(", ")}: run \`pnpm build\` and \`forge build\` in contracts/`);
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN_DIR, "logs"), { recursive: true });

  const forkUrl = process.env.MONAD_FORK_URL?.trim() || NET.rpcUrl;
  log(`▸ forking Monad testnet from ${forkUrl}`);
  const fork = await startChain(forkUrl);
  log(`  chain ${fork.url} (chain id ${fork.chainId}, from block ${fork.forkBlock})`);

  const parties = { operator: party(), facilitator: party(), buyer: party(), demo: party(), providers: PROVIDERS.map(party) };
  for (const p of [parties.operator, parties.facilitator, ...parties.providers]) await setMon(fork, p.address, 100n * 10n ** 18n);
  await fundUsdc(fork, USDC, parties.buyer.address, 20_000_000n);
  await fundUsdc(fork, USDC, parties.demo.address, 20_000_000n);
  log("▸ funded: operator, facilitator and providers with MON; buyer and demo account with USDC only");

  const ledger = await deployLedger({ group, contractsDir: CONTRACTS_DIR, fork, broker: parties.operator.address, env: cleanEnv() });
  log(`▸ XorvLedger ${ledger.address}`);

  const wallet = createWalletClient({ chain: viemChain(NETWORK), transport: http(fork.url), account: privateKeyToAccount(parties.operator.key) });
  const { abi, bytecode } = artifact("XorvEscrow");
  const deployTx = await wallet.deployContract({ abi, bytecode, args: [parties.operator.address, parties.facilitator.address, "0x0000000000000000000000000000000000000000", [USDC]] });
  const escrow = getAddress((await fork.client.waitForTransactionReceipt({ hash: deployTx })).contractAddress!);
  log(`▸ XorvEscrow ${escrow} (attester = the facilitator)`);

  const brokerUrl = `http://127.0.0.1:${PORTS.broker}`;
  const api = brokerApi(brokerUrl);
  const broker = group.start("broker", process.execPath, [BROKER_ENTRY], {
    cwd: RUN_DIR,
    env: sealedBrokerEnv(REPO, {
      XORV_NETWORK: NETWORK,
      XORV_RPC_URL: fork.url,
      XORV_OPERATOR_KEY: parties.operator.key,
      XORV_FACILITATOR_KEY: parties.facilitator.key,
      XORV_FACILITATOR: "self",
      XORV_ESCROW_ADDRESS: escrow,
      XORV_LEDGER_ADDRESS: ledger.address,
      XORV_LEDGER_FROM_BLOCK: ledger.fromBlock.toString(),
      XORV_RECEIPT_BATCH_MS: "1000",
      XORV_BROKER_PORT: String(PORTS.broker),
      XORV_PUBLIC_URL: brokerUrl,
      XORV_BROKER_URL: brokerUrl,
      XORV_DB: path.join(RUN_DIR, "broker.db"),
      XORV_CORS_ORIGINS: `http://localhost:${PORTS.app},http://127.0.0.1:${PORTS.app}`,
    }),
  });
  await waitUntil("the broker to answer /health", 180_000, async () => {
    if (!broker.running) throw new Error(`the broker exited\n${tail(broker.output)}`);
    return (await api.raw("/health")).status === 200;
  });
  log(`▸ broker ${brokerUrl}`);

  for (const [i, spec] of PROVIDERS.entries()) {
    const who = parties.providers[i]!;
    const home = path.join(RUN_DIR, `provider-${spec.label}`);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        nodeId: `demo-${spec.label}-${Math.random().toString(36).slice(2, 8)}`,
        label: spec.label,
        network: NETWORK,
        brokerUrl,
        address: who.address,
        privateKey: who.key,
        agentId: null,
        capabilities: spec.capabilities,
        region: null,
        tunnel: { enabled: false, hostname: null },
        sandboxDir: path.join(home, "jobs"),
        providerId: null,
        token: null,
      }),
    );
    const providerEnv = { ...cleanEnv(), XORV_HOME: home, XORV_NETWORK: NETWORK, XORV_RPC_URL: fork.url, XORV_BROKER_URL: brokerUrl };
    // A real ERC-8004 identity in the canonical registry, so buyers can rate the provider's jobs.
    const registered = await group.run(`identity-${spec.label}`, process.execPath, [CLI_ENTRY, "identity", "register", "--yes"], {
      cwd: home,
      env: providerEnv,
      timeoutMs: 120_000,
    });
    const agentId = (JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) as { agentId: string | null }).agentId;
    if (registered.code !== 0 || !agentId) throw new Error(`xorv identity register failed for ${spec.label}\n${tail(`${registered.stdout}\n${registered.stderr}`)}`);
    const proc = group.start(`provider-${spec.label}`, process.execPath, [CLI_ENTRY, "start"], { cwd: home, env: providerEnv });
    await waitUntil(`provider ${spec.label} to connect`, 180_000, async () => {
      if (!proc.running) throw new Error(`xorv start exited\n${tail(proc.output)}`);
      const { providers } = await api.get<{ providers: PublicProvider[] }>("/api/providers");
      return providers.some((p) => p.address === who.address && p.connected);
    });
    log(`▸ provider ${spec.label} ${who.address} online, ERC-8004 agent #${agentId}`);
  }

  if (SEED) {
    const buyer = privateKeyToAccount(parties.buyer.key);
    const released: string[] = [];
    for (const prompt of SEED_PROMPTS) {
      const quote = await api.post<QuoteResponse>("/api/quotes", { prompt, maxPriceUsdMicros: 10_000 });
      const paid = await payQuote({ quote, buyer, network: NETWORK });
      await waitForJob(api, paid.jobId);
      const job = await waitUntil("the escrow release", 60_000, async () => {
        const j: PublicJob = await getJob(api, paid.jobId);
        return j.payment?.escrow?.state === "released" ? j : null;
      });
      released.push(job.id);
      log(`  seeded ${job.id}: paid into the escrow, released ${job.payment?.escrow?.releaseTx?.slice(0, 12)}…`);
    }
    // The buyer rates two of them: one gasless EIP-712 signature each, relayed through
    // XorvLedger.rateJob into the ERC-8004 Reputation Registry.
    for (const [jobId, value] of [[released[0]!, 92], [released[1]!, 78]] as const) {
      await waitUntil(`the receipt for ${jobId}`, 60_000, async () => Boolean((await getJob(api, jobId)).receiptTxHash));
      const offer = await api.get<{ deadline: number; typedData: { domain: { verifyingContract: Address }; message: Record<string, unknown> } }>(
        `/api/jobs/${jobId}/rating?value=${value}`,
      );
      const typedData = ratingTypedData({ network: NETWORK, ledger: offer.typedData.domain.verifyingContract, rating: offer.typedData.message as never });
      const rated = await api.post<{ txHash: string }>(`/api/jobs/${jobId}/rate`, { value, deadline: offer.deadline, signature: await buyer.signTypedData(typedData) });
      log(`  rated ${jobId} ${value}/100: ERC-8004 feedback in ${rated.txHash.slice(0, 12)}…`);
    }
    // One cancelled job: the escrow refunds the buyer in full.
    const quote = await api.post<QuoteResponse>("/api/quotes", { prompt: "slow: a long research task the buyer cancels", maxPriceUsdMicros: 10_000 });
    const paid = await payQuote({ quote, buyer, network: NETWORK });
    const res = await api.raw(`/api/jobs/${paid.jobId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${String(paid.body.cancelToken)}` },
      body: "{}",
    });
    log(`  seeded ${paid.jobId}: cancelled, ${(res.body as { refunded?: boolean }).refunded ? "refunded by the escrow" : "finished before the cancel"}`);
  }

  const appEnv: Record<string, string> = {
    NEXT_PUBLIC_XORV_BROKER_URL: brokerUrl,
    NEXT_PUBLIC_XORV_NETWORK: NETWORK,
    NEXT_PUBLIC_XORV_RPC_URL: fork.url,
    XORV_BROKER_URL: brokerUrl,
    XORV_NETWORK: NETWORK,
    XORV_DEMO_PAYER_KEY: parties.demo.key,
  };
  fs.writeFileSync(
    path.join(RUN_DIR, "app.env"),
    `# Generated by pnpm demo; these keys exist only on the local fork.\n${Object.entries(appEnv).map(([k, v]) => `${k}=${v}`).join("\n")}\n`,
  );

  const appUrl = `http://localhost:${PORTS.app}`;
  if (WITH_APP) {
    const nextBin = path.join(APP_DIR, "node_modules", ".bin", "next");
    const app = group.start("app", nextBin, ["dev", "-p", String(PORTS.app)], { cwd: APP_DIR, env: { ...cleanEnv(), ...appEnv, NO_COLOR: "1" } });
    await app.waitFor(/Ready in|ready started|Local:/i, 240_000);
    log(`▸ app ${appUrl}`);
  }

  log("");
  log(`Xorv is running on a local fork of Monad testnet (chain ${NET.chainId}).`);
  log(`  app      ${WITH_APP ? appUrl : `not started (env in ${path.relative(REPO, path.join(RUN_DIR, "app.env"))})`}`);
  log(`  broker   ${brokerUrl}`);
  log(`  chain    ${fork.url}`);
  log(`  ledger   ${ledger.address}`);
  log(`  escrow   ${escrow}`);
  log(`  logs     ${path.relative(REPO, path.join(RUN_DIR, "logs"))}`);
  log("Ctrl-C stops everything.");
  fs.writeFileSync(path.join(RUN_DIR, "ready"), JSON.stringify({ appUrl, brokerUrl, chain: fork.url, ledger: ledger.address, escrow, pid: process.pid }, null, 2));
  await new Promise(() => {});
}

main().catch((err) => {
  log(`\ndemo failed: ${err instanceof Error ? err.message : String(err)}`);
  for (const proc of group.list()) if (proc.output.trim()) log(`\n--- ${proc.name} (last lines) ---\n${tail(proc.output, 20)}`);
  void stop(1);
});
