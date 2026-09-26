/**
 * Broker entry point.
 */

import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { networkConfig } from "@xorv/protocol";
import { createApp } from "./app.js";
import { createAiHooks, describeAiRoles } from "./ai/index.js";
import { LedgerWriter } from "./chain.js";
import { loadConfig } from "./config.js";
import { Hub } from "./hub.js";
import { JobStore } from "./jobs.js";
import { Registry } from "./registry.js";
import { openPersistence } from "./store.js";
import { LayeredPersistence } from "./store-mongo.js";
import { VaultStore } from "./vaults.js";

const config = loadConfig();
const net = networkConfig(config.network);
const chain = new LedgerWriter({
  network: config.network,
  ledgerAddress: config.ledgerAddress,
  account: config.operator,
  batchMs: config.receiptBatchMs,
  batchMax: config.receiptBatchMax,
  log: (line) => console.error(`[broker] ${line}`),
});

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

// The sponsor-model roles: Hunyuan screens, Qwen routes, Kimi verifies. Each
// is on when its key is set (or explicitly asked for), off otherwise.
const ai = createAiHooks({
  ai: config.ai,
  network: config.network,
  verifierAccount: config.verifierAccount ?? null,
});
const registry = new Registry(persistence);
const jobs = new JobStore(persistence);
const vaults = new VaultStore(persistence);

let hub: Hub | null = null;
const { app, hubHandlers, sweep, settlement, trust } = createApp({
  config,
  chain,
  registry,
  jobs,
  vaults,
  getHub: () => hub,
  ai,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  const line = (label: string, value: string) => console.log(`  ${label.padEnd(14)} ${value}`);
  const ledgerMode = chain.mode();
  console.log("");
  console.log("  ▁▂▃  X O R V   B R O K E R");
  console.log("");
  line("listening", `http://localhost:${info.port}`);
  line("public url", config.publicUrl);
  line("network", `${config.network} (${net.name})`);
  line("rpc", net.rpcUrl);
  line("usdc", `${net.usdc.address} (EIP-712 "${net.usdc.name}" v${net.usdc.version})`);
  line("operator", config.operator ? config.operator.address : "none — read-only (set XORV_OPERATOR_KEY)");
  line(
    "facilitator",
    settlement.facilitator
      ? settlement.mode === "self"
        ? `self-hosted — ${settlement.address} pays settlement gas`
        : settlement.description
      : `UNAVAILABLE — ${settlement.unavailableReason}`,
  );
  line(
    "ledger",
    ledgerMode === "off"
      ? "not configured (set XORV_LEDGER_ADDRESS) — no on-chain receipts"
      : `${config.ledgerAddress} (${ledgerMode === "write" ? `writing, receipts batched every ${config.receiptBatchMs}ms` : "read-only"})`,
  );
  line("indexer", config.indexerUrl ?? "not configured — feeds read from RPC");
  line("fee", config.feeBps === 0 ? "0% — providers keep everything" : `${config.feeBps / 100}%`);
  line(
    "storage",
    local.kind === "sqlite"
      ? `${local.location} (${jobs.restoredCount} jobs, ${registry.restoredStatsCount} providers restored)`
      : local.location,
  );
  line("mongodb", mongoStatus);
  describeAiRoles(ai).forEach((role, i) => line(i === 0 ? "ai roles" : "", role));
  const nansen = trust.status();
  line(
    "nansen",
    nansen.mode === "off"
      ? "off (XORV_NANSEN_MODE=fixture|live for provider trust + the wash-rating guard)"
      : nansen.mode === "fixture"
        ? "fixture data — deterministic, no network, no payments"
        : nansen.auth === "api-key"
          ? "live, NANSEN_API_KEY"
          : `live, x402 on Monad mainnet from ${nansen.payer?.address} (≤ $${nansen.perCallCapUsdc}/call, $${nansen.budgetUsdc}/day)`,
  );
  console.log("");
});

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

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[broker] ${signal} — shutting down`);
  clearInterval(sweeper);
  if (mongoRetry) clearInterval(mongoRetry);
  hub?.close();
  // Queued receipts get one bounded chance to go out before the process ends.
  void chain.close().finally(() => {
    persistence.close();
    server.close(() => process.exit(0));
  });
  // Don't let a stuck socket or RPC hold the process open forever.
  setTimeout(() => process.exit(0), 8_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("unhandledRejection", (err) => {
  console.error("[broker] unhandled rejection:", err);
});
