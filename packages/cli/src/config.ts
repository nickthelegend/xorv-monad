/**
 * Node configuration, stored under `~/.xorv/`.
 *
 * The payout key lives here in plaintext, with the file mode locked to 0600 and
 * the directory to 0700. That is a deliberate, stated trade-off rather than an
 * oversight: this is a hot key that has to sign on every job with no human
 * present, so a passphrase would either be typed once and held in memory anyway
 * or written next to the key. What actually protects an operator is that the
 * account is theirs alone, holds only earnings, and can be rotated with
 * `xorv wallet new`. `XORV_PRIVATE_KEY` overrides the file for anyone running
 * under a real secret manager.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HEDERA_TESTNET_CAIP2, type AdapterKind, type Capability } from "@xorv/protocol";

export interface NodeConfig {
  /** Stable identity across restarts, so the broker re-uses the provider slot. */
  nodeId: string;
  label: string;
  network: string;
  brokerUrl: string;
  accountId: string;
  /** Empty when the key is supplied via XORV_PRIVATE_KEY instead. */
  privateKey: string;
  capabilities: Capability[];
  region?: string | null;
  tunnel: { enabled: boolean; hostname?: string | null };
  /** Working directory jobs run in; kept away from the operator's real projects. */
  sandboxDir: string;
  /** Set after a successful registration, for `xorv status` without re-registering. */
  providerId?: string | null;
  token?: string | null;
}

export const XORV_HOME = process.env.XORV_HOME
  ? path.resolve(process.env.XORV_HOME)
  : path.join(os.homedir(), ".xorv");

const CONFIG_PATH = path.join(XORV_HOME, "config.json");
const EARNINGS_PATH = path.join(XORV_HOME, "earnings.jsonl");

export function configPath(): string {
  return CONFIG_PATH;
}

export function earningsPath(): string {
  return EARNINGS_PATH;
}

export function ensureHome(): void {
  fs.mkdirSync(XORV_HOME, { recursive: true, mode: 0o700 });
  // A pre-existing directory keeps its old mode, so tighten it explicitly.
  try {
    fs.chmodSync(XORV_HOME, 0o700);
  } catch {
    /* best effort — Windows and some mounts don't support it */
  }
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

export function loadConfig(): NodeConfig | null {
  if (!configExists()) return null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as NodeConfig;
    return withDefaults(parsed);
  } catch (err) {
    throw new Error(
      `could not read ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Load or fail with the message that tells the operator what to run. */
export function requireConfig(): NodeConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error("this machine isn't set up yet — run `xorv init` first");
  }
  return config;
}

export function saveConfig(config: NodeConfig): void {
  ensureHome();
  const body = JSON.stringify(config, null, 2);
  // Write-then-rename so a crash mid-write can't leave a truncated config that
  // locks the operator out of their own payout account.
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* best effort */
  }
}

function withDefaults(config: Partial<NodeConfig>): NodeConfig {
  return {
    nodeId: config.nodeId ?? "",
    label: config.label ?? "xorv-node",
    network: config.network ?? HEDERA_TESTNET_CAIP2,
    brokerUrl: config.brokerUrl ?? "http://localhost:8402",
    accountId: config.accountId ?? "",
    privateKey: config.privateKey ?? "",
    capabilities: config.capabilities ?? [],
    region: config.region ?? null,
    tunnel: config.tunnel ?? { enabled: false, hostname: null },
    sandboxDir: config.sandboxDir ?? path.join(XORV_HOME, "jobs"),
    providerId: config.providerId ?? null,
    token: config.token ?? null,
  };
}

/** The signing key, preferring the environment over the file. */
export function resolvePrivateKey(config: NodeConfig): string {
  const fromEnv = process.env.XORV_PRIVATE_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (!config.privateKey) {
    throw new Error(
      "no payout key configured — run `xorv init`, or set XORV_PRIVATE_KEY in the environment",
    );
  }
  return config.privateKey;
}

/** The broker URL, preferring the environment so one config can target many. */
export function resolveBrokerUrl(config: NodeConfig): string {
  return (process.env.XORV_BROKER_URL?.trim() || config.brokerUrl).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Earnings ledger — append-only, local, so `xorv earnings` works offline
// ---------------------------------------------------------------------------

export interface EarningRow {
  at: number;
  jobId: string;
  asset: "usdc" | "hbar";
  amount: string;
  usdMicros: number;
  durationMs: number;
  ok: boolean;
  transactionId?: string;
  adapter?: string;
}

export function appendEarning(row: EarningRow): void {
  ensureHome();
  try {
    fs.appendFileSync(EARNINGS_PATH, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch {
    // The ledger is a convenience; the ledger of record is on Hedera. Never let
    // a disk problem here fail a job that already ran and already got paid.
  }
}

export function readEarnings(limit = 500): EarningRow[] {
  if (!fs.existsSync(EARNINGS_PATH)) return [];
  const lines = fs.readFileSync(EARNINGS_PATH, "utf8").trim().split("\n").filter(Boolean);
  const rows: EarningRow[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      rows.push(JSON.parse(line) as EarningRow);
    } catch {
      /* skip a partial line from an interrupted append */
    }
  }
  return rows;
}

/**
 * Suggested defaults for a capability.
 *
 * These are priced from what the jobs actually cost. A measured Claude Code
 * run — one small function, six seconds — reported `total_cost_usd` of $0.16,
 * so the original $0.01 default had every provider selling at a sixteenth of
 * cost and losing money on every job they won. A default that loses money is a
 * bug in the default, not a decision for the market.
 *
 * Agentic coding jobs are not micropayments; simple generation is. The spread
 * below reflects that, and `xorv test` warns when a configured price is under
 * the cost the CLI reports.
 */
export function defaultCapability(adapter: AdapterKind): Capability {
  const presets: Record<AdapterKind, { name: string; price: number }> = {
    "claude-code": { name: "Claude Code", price: 250_000 },
    codex: { name: "Codex", price: 200_000 },
    grok: { name: "Grok Code", price: 100_000 },
    opencode: { name: "OpenCode", price: 50_000 },
    // Local models cost electricity, not tokens — this one can be genuinely tiny.
    "openai-compatible": { name: "OpenAI-compatible endpoint", price: 5_000 },
    echo: { name: "Echo (test)", price: 1_000 },
  };
  const preset = presets[adapter];
  return {
    id: adapter,
    adapter,
    displayName: preset.name,
    model: null,
    priceUsdMicros: preset.price,
    maxConcurrency: adapter === "echo" ? 4 : 1,
  };
}
