/**
 * Broker entry point.
 */

import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import {
  GAS_TOKEN_SYMBOL,
  formatGas,
  formatUsd,
  logFromBlock,
  networkInfo,
  readClient,
  checkContractWiring,
  stablecoins,
  verifyStablecoinDomains,
} from "@xorv/protocol";
import { createApp } from "./app.js";
import { Chain } from "./chain.js";
import { loadConfig } from "./config.js";
import { Hub } from "./hub.js";
import { JobStore } from "./jobs.js";
import { Registry } from "./registry.js";
import { openPersistence } from "./store.js";
import { LayeredPersistence } from "./store-mongo.js";
import { LogIndex } from "./log-index.js";

const config = loadConfig();
const chain = new Chain(config);

// SQLite is always present — it is the write that cannot fail. Mongo layers on
// top as the restore source, so the broker's history survives losing the box.
const local = openPersistence(config.dbFile);
const layered = config.mongoUri
  ? new LayeredPersistence({
      local,
      uri: config.mongoUri,
      dbName: config.mongoDb,
      onStatus: (message) => console.warn(`[broker] ${message}`),
    })
  : null;

let mongoStatus = "not configured";
if (layered) {
  const result = await layered.connect();
  mongoStatus = result.ok
    ? `connected (${result.jobs} jobs, ${result.providers} providers restored)`
    : `unreachable — running on local disk (${result.error})`;
  if (!result.ok) {
    console.warn(`[broker] mongodb ${mongoStatus}`);
  }
}

const persistence = layered ?? local;
const registry = new Registry(persistence);
const jobs = new JobStore(persistence);

// The audit trail, indexed forward into SQLite so pages never scan the chain.
const logInfo = chain.describeLog();
const logIndex = logInfo
  ? new LogIndex({
      network: config.network,
      address: logInfo.address,
      fromBlock: logFromBlock(),
      store: persistence,
      // Receipts this broker published: readable at once, however old.
      knownTransactions: () =>
        jobs
          .list({ limit: 500 })
          .map((job) => job.receiptTxHash ?? "")
          .filter(Boolean),
      // Settlements and audit writes first; the backfill waits its turn.
      yieldTo: () => chain.writing?.() ?? false,
      onEvent: (message) => console.log(`[broker] log index: ${message}`),
    })
  : null;

let hub: Hub | null = null;
const { app, hubHandlers, sweep } = createApp({
  config,
  chain,
  registry,
  jobs,
  getHub: () => hub,
  logIndex: logIndex ?? undefined,
});

logIndex?.start();

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  const log = chain.describeLog();
  const line = (label: string, value: string) => console.log(`  ${label.padEnd(14)} ${value}`);
  console.log("");
  console.log("  ▁▂▃  X O R V   B R O K E R");
  console.log("");
  line("listening", `http://localhost:${info.port}`);
  line("network", `${networkInfo(config.network).name} (${config.network})`);
  line("operator", config.operatorAddress);
  line("signer", chain.signerDescription);
  line(
    "facilitator",
    config.facilitatorMode !== "self"
      ? config.facilitatorMode
      : config.signer?.privy?.sponsor
        ? "self-hosted — Privy sponsors the gas"
        : `self-hosted — the operator pays the gas in ${GAS_TOKEN_SYMBOL}`,
  );
  line(
    "stablecoins",
    stablecoins(config.network)
      .map((t, i) => `${t.symbol} ${t.address}${i === 0 ? " (default)" : ""}`)
      .join("\n" + " ".repeat(17)),
  );
  line("fee", config.feeBps === 0 ? "0% — providers keep everything" : `${config.feeBps / 100}%`);
  line(
    "storage",
    local.kind === "sqlite"
      ? `${local.location} (${jobs.restoredCount} jobs, ${registry.restoredStatsCount} providers restored)`
      : local.location,
  );
  line("mongodb", mongoStatus);
  line("audit log", log ? log.address : "not configured");
  line(
    "escrow",
    config.escrowAddress
      ? `${config.escrowAddress} — jobs are paid into escrow, refundable after ${config.escrowDeadlineSeconds / 60} min`
      : "off — providers are paid directly (set XORV_ESCROW_ADDRESS)",
  );
  line("reputation", config.registryAddress ? `${config.registryAddress} ` : "off (set XORV_REGISTRY_ADDRESS)");
  if (process.env.XORV_CLEANVERSE_MOCK?.trim() === "1") {
    line("identity", "CLEANVERSE MOCK — the escrow's A-Pass is a local stand-in, not Cleanverse's");
  }
  console.log("");
  void bootChecks();
});

/**
 * Off the boot path, but loud: the two things that make every payment fail
 * with an opaque 402 — a stablecoin whose configured EIP-712 domain does not
 * match the contract, and an operator with no MON to relay settlements.
 */
async function bootChecks(): Promise<void> {
  try {
    for (const check of await verifyStablecoinDomains(config.network)) {
      if (check.ok) continue;
      console.warn(
        `[broker] ⚠ ${check.symbol} ${check.address}: configured EIP-712 domain ` +
          `"${check.eip712.name}"/"${check.eip712.version}" ` +
          (check.actual
            ? `does not match the contract's DOMAIN_SEPARATOR — payments in ${check.symbol} will be rejected`
            : `could not be checked (${check.error ?? "no DOMAIN_SEPARATOR()"})`),
      );
    }
  } catch (err) {
    console.warn(`[broker] stablecoin domain check skipped: ${err instanceof Error ? err.message : err}`);
  }
  if (config.escrowAddress || config.registryAddress) {
    try {
      const problems = await checkContractWiring({
        client: readClient(config.network),
        operator: config.operatorAddress,
        escrow: config.escrowAddress,
        registry: config.registryAddress,
        tokens: stablecoins(config.network).map((t) => t.address),
      });
      for (const p of problems) console.warn(`[broker] ⚠ ${p}`);
      if (problems.length === 0) console.log("[broker] escrow and registry wiring verified on chain");
    } catch (err) {
      console.warn(`[broker] contract wiring check skipped: ${err instanceof Error ? err.message : err}`);
    }
  }
  // A Privy-sponsored operator needs no MON; its balance is beside the point.
  if (config.facilitatorMode !== "self" || config.signer?.privy?.sponsor) return;
  try {
    const wei = await readClient(config.network).getBalance({
      address: config.operatorAddress as `0x${string}`,
    });
    if (wei === 0n) {
      console.warn(
        `[broker] ⚠ operator ${config.operatorAddress} holds no ${GAS_TOKEN_SYMBOL} — ` +
          `the facilitator cannot relay payments until it is funded`,
      );
    } else {
      console.log(`[broker] operator gas balance: ${formatGas(wei)}`);
    }
  } catch {
    /* the RPC is briefly unreachable; the first payment will say so */
  }
}

// The hub needs the raw http server to handle upgrades, which only exists once
// `serve` has returned.
hub = new Hub(server as unknown as HttpServer, registry, hubHandlers);

const sweeper = setInterval(sweep, 15_000);

// Drain anything Mongo missed while it was unreachable. Cheap when the queue is
// empty, which is the normal case.
const mongoRetry = layered
  ? setInterval(() => {
      void layered.retryPending();
    }, 30_000)
  : null;
mongoRetry?.unref?.();

function shutdown(signal: string): void {
  console.log(`\n[broker] ${signal} — shutting down`);
  clearInterval(sweeper);
  if (mongoRetry) clearInterval(mongoRetry);
  logIndex?.stop();
  hub?.close();
  chain.close();
  persistence.close();
  server.close(() => process.exit(0));
  // Don't let a stuck socket hold the process open forever.
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (err) => {
  console.error("[broker] unhandled rejection:", err);
});

export { formatUsd };
