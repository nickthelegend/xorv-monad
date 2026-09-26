/**
 * Broker configuration, resolved once at boot.
 *
 * Everything that can be wrong about a deployment — missing key, unfunded
 * operator, topics that don't exist — should be discoverable here or in
 * `describeConfig`, not three seconds into someone's first paid job.
 */

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HEDERA_TESTNET_CAIP2, isAccountId, parsePrivateKey } from "@xorv/protocol";
import type { PrivateKey } from "@hiero-ledger/sdk";

// The repo keeps one .env at the root; the broker is two directories down.
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, "../../../.env"), quiet: true });
loadDotenv({ quiet: true });

export interface BrokerConfig {
  network: string;
  operatorId: string;
  operatorKey: PrivateKey;
  topics: { registry: string | null; heartbeat: string | null; receipts: string | null };
  port: number;
  publicUrl: string;
  corsOrigins: string[];
  feeBps: number;
  /** "self" runs the facilitator in-process; "hosted" or a URL calls one out. */
  facilitatorMode: string;
  /** SQLite file for durable jobs and earnings; "off" disables persistence. */
  dbFile: string | null;
  /** MongoDB URI. When set, it becomes the restore source; SQLite stays the write guarantee. */
  mongoUri: string | null;
  mongoDb: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in — a funded testnet account takes ~60s at https://portal.hedera.com`,
    );
  }
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function loadConfig(): BrokerConfig {
  const operatorId = required("HEDERA_OPERATOR_ID");
  if (!isAccountId(operatorId)) {
    throw new Error(`HEDERA_OPERATOR_ID must look like 0.0.12345, got "${operatorId}"`);
  }

  return {
    network: process.env.XORV_NETWORK?.trim() || HEDERA_TESTNET_CAIP2,
    operatorId,
    operatorKey: parsePrivateKey(required("HEDERA_OPERATOR_KEY")),
    topics: {
      registry: optional("XORV_TOPIC_REGISTRY"),
      heartbeat: optional("XORV_TOPIC_HEARTBEAT"),
      receipts: optional("XORV_TOPIC_RECEIPTS"),
    },
    port: Number(process.env.XORV_BROKER_PORT ?? 8402),
    publicUrl: process.env.XORV_BROKER_URL?.trim() || `http://localhost:${process.env.XORV_BROKER_PORT ?? 8402}`,
    corsOrigins: (process.env.XORV_CORS_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    feeBps: Number(process.env.XORV_FEE_BPS ?? 0),
    facilitatorMode: process.env.XORV_FACILITATOR?.trim() || "self",
    dbFile: process.env.XORV_DB?.trim() || path.resolve(here, "../../../data/xorv.db"),
    mongoUri: process.env.XORV_MONGO_URI?.trim() || null,
    mongoDb: process.env.XORV_MONGO_DB?.trim() || "xorv",
  };
}
