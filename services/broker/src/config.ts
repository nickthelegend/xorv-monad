/**
 * Broker configuration, resolved once at boot.
 *
 * Everything that can be wrong about a deployment — missing key, unfunded
 * operator, a log contract that isn't there — should be discoverable here or in
 * `describeConfig`, not three seconds into someone's first paid job.
 */

import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DEFAULT_NETWORK,
  ESCROW_DEADLINE_SECONDS,
  NETWORKS,
  accountFor,
  escrowAddress as configuredEscrow,
  registryAddress as configuredRegistry,
  isAccountAddress,
  parsePrivateKey,
} from "@xorv/protocol";

// The repo keeps one .env at the root; the broker is two directories down.
const here = path.dirname(fileURLToPath(import.meta.url));
// XORV_ENV_FILE picks a different file — the local stack's, say — and then
// only that one is read, so a second deployment's values can't leak in.
const envFile = process.env.XORV_ENV_FILE?.trim();
if (envFile) {
  loadDotenv({ path: path.resolve(envFile), quiet: true });
} else {
  loadDotenv({ path: path.resolve(here, "../../../.env"), quiet: true });
  loadDotenv({ quiet: true });
}

export interface BrokerConfig {
  network: string;
  /** The operator's address, derived from the key rather than configured twice. */
  operatorAddress: string;
  operatorKey: string;
  /** Deployed XorvLog contract; null disables the audit trail rather than failing. */
  logAddress: string | null;
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
  /**
   * XorvEscrow address; null pays providers directly. The operator key must be
   * the escrow's attester, because only the attester may fund and settle.
   */
  escrowAddress: string | null;
  /** XorvRegistry address; null disables on-chain reputation. The operator must be its operator. */
  registryAddress: string | null;
  /** Seconds from quote to the point anyone may refund the buyer. */
  escrowDeadlineSeconds: number;
  /** How long a settlement waits for the payment to be recorded before giving up. */
  escrowFundingWaitMs: number;
  escrowRetries: number;
  escrowRetryDelayMs: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in — the operator ` +
        `needs Monad testnet MON for gas (https://faucet.monad.xyz)`,
    );
  }
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function loadConfig(): BrokerConfig {
  const operatorKey = parsePrivateKey(required("XORV_OPERATOR_KEY"));

  // Derived, not configured. The Hedera version required an account id
  // alongside the key and could not check that the two matched — a mismatched
  // pair produced INVALID_SIGNATURE on the first payment and nothing before it.
  // An EVM address is a pure function of its key, so the pair cannot disagree.
  const operatorAddress = accountFor(operatorKey).address;

  const declared = optional("XORV_OPERATOR_ADDRESS");
  if (declared && declared.toLowerCase() !== operatorAddress.toLowerCase()) {
    throw new Error(
      `XORV_OPERATOR_ADDRESS is ${declared} but XORV_OPERATOR_KEY controls ${operatorAddress}. ` +
        `Remove the address — it is derived from the key — or fix the key.`,
    );
  }

  const logAddress = optional("XORV_LOG_ADDRESS");
  if (logAddress && !isAccountAddress(logAddress)) {
    throw new Error(`XORV_LOG_ADDRESS must be an EVM address, got "${logAddress}"`);
  }

  const network = process.env.XORV_NETWORK?.trim() || DEFAULT_NETWORK;
  if (!NETWORKS[network]) {
    throw new Error(
      `XORV_NETWORK is "${network}", which Xorv has no stablecoin table for. ` +
        `Use one of: ${Object.keys(NETWORKS).join(", ")}`,
    );
  }

  const escrowAddress = configuredEscrow(network);
  const escrowDeadlineSeconds = Number(process.env.XORV_ESCROW_DEADLINE_S ?? ESCROW_DEADLINE_SECONDS);
  if (!Number.isFinite(escrowDeadlineSeconds) || escrowDeadlineSeconds < 120) {
    // The contract refuses deadlines under a minute; under two leaves no room for a job.
    throw new Error(`XORV_ESCROW_DEADLINE_S must be at least 120, got ${process.env.XORV_ESCROW_DEADLINE_S}`);
  }

  return {
    network,
    operatorAddress,
    operatorKey,
    logAddress,
    // Railway, Render and Fly inject `PORT` and route only to it. The explicit
    // variable still wins, so a local .env keeps working unchanged.
    port: Number(process.env.XORV_BROKER_PORT ?? process.env.PORT ?? 8402),
    publicUrl:
      process.env.XORV_BROKER_URL?.trim() ||
      `http://localhost:${process.env.XORV_BROKER_PORT ?? process.env.PORT ?? 8402}`,
    corsOrigins: (process.env.XORV_CORS_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    feeBps: Number(process.env.XORV_FEE_BPS ?? 0),
    facilitatorMode: process.env.XORV_FACILITATOR?.trim() || "self",
    dbFile: process.env.XORV_DB?.trim() || path.resolve(here, "../../../data/xorv.db"),
    mongoUri: process.env.XORV_MONGO_URI?.trim() || null,
    mongoDb: process.env.XORV_MONGO_DB?.trim() || "xorv",
    escrowAddress,
    registryAddress: configuredRegistry(network),
    escrowDeadlineSeconds,
    escrowFundingWaitMs: 60_000,
    escrowRetries: 3,
    escrowRetryDelayMs: 3_000,
  };
}
