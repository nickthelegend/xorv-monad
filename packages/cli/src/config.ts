/**
 * Node configuration, stored under `~/.xorv/` (or `$XORV_HOME`).
 *
 * On Monad a provider needs a payout *address*, not a key. Nothing on the
 * provider's side signs per job: the buyer signs an EIP-3009 authorization, the
 * facilitator submits it and pays the gas, and USDC lands at `address`. So the
 * safest node is one that keeps no key on disk at all — `xorv init` offers
 * exactly that for an address the operator already controls elsewhere (a Privy
 * wallet from the web app, a hardware wallet), and a key that is not on the
 * machine cannot be read by a hostile prompt.
 *
 * A key is only needed for two things: buying with `xorv run`, and registering
 * an ERC-8004 identity from the payout address (`xorv identity register`).
 * When one is kept it lives here in plaintext, the file mode locked to 0600 and
 * the directory to 0700 — a stated trade-off rather than an oversight: a
 * passphrase would be typed once and held in memory anyway, or written next to
 * the key. `XORV_PRIVATE_KEY` overrides the file for anyone running under a
 * real secret manager.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_NETWORK,
  LLM_PRESETS,
  normalizeAddress,
  parsePrivateKey,
  type AdapterKind,
  type Address,
  type Capability,
} from "@xorv/protocol";

export interface NodeConfig {
  /** Stable identity across restarts, so the broker re-uses the provider slot. */
  nodeId: string;
  label: string;
  /** CAIP-2 network id, e.g. `eip155:10143` (Monad testnet). */
  network: string;
  brokerUrl: string;
  /** Checksummed payout address — where buyers' USDC lands (x402 `payTo`). */
  address: string;
  /**
   * 0x-prefixed secp256k1 key for `address`, or "" when the node keeps none
   * (address-only setup, or the key comes from XORV_PRIVATE_KEY instead).
   */
  privateKey: string;
  /** ERC-8004 agent id (decimal string) once `xorv identity register` has run. */
  agentId: string | null;
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

// ---------------------------------------------------------------------------
// Legacy (Hedera) configs
// ---------------------------------------------------------------------------

/** What a config written by the Hedera prototype looked like, as far as detection needs. */
export interface LegacyConfigInfo {
  /** `hedera:testnet`, `hedera:mainnet`, or whatever was there. */
  network: string | null;
  /** The `0.0.N` account the node was paid at. */
  accountId: string | null;
}

/**
 * Thrown when `~/.xorv/config.json` was written by the Hedera version of Xorv.
 *
 * The two versions share a binary name and a home directory, so an operator
 * who upgrades lands here with a config that *parses* — and would then fail
 * obscurely: a `0.0.N` account the broker rejects, an ED25519 key viem cannot
 * read, a network string the protocol refuses. Detecting it up front turns all
 * of that into one sentence that says what to run.
 */
export class LegacyConfigError extends Error {
  readonly legacy: LegacyConfigInfo;
  constructor(legacy: LegacyConfigInfo) {
    const where = [
      legacy.accountId ? `account ${legacy.accountId}` : null,
      legacy.network ? `on ${legacy.network}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    super(
      `${CONFIG_PATH} was written by the Hedera version of Xorv${where ? ` (${where})` : ""}. ` +
        "Xorv now runs on Monad — run `xorv init` to set up a Monad payout address " +
        "(your node name, capabilities and prices are kept)",
    );
    this.name = "LegacyConfigError";
    this.legacy = legacy;
  }
}

const HEDERA_ACCOUNT = /^\d+\.\d+\.\d+$/;

/** A parsed config object that came from the Hedera prototype, or null. */
export function detectLegacy(raw: Record<string, unknown>): LegacyConfigInfo | null {
  const network = typeof raw.network === "string" ? raw.network : null;
  const accountId = typeof raw.accountId === "string" ? raw.accountId.trim() : null;
  const hederaNetwork = network !== null && network.startsWith("hedera:");
  const hederaAccount = accountId !== null && HEDERA_ACCOUNT.test(accountId);
  if (!hederaNetwork && !hederaAccount) return null;
  return { network, accountId: hederaAccount ? accountId : null };
}

function readRaw(): Record<string, unknown> | null {
  if (!configExists()) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `could not read ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The current config, or null when there is none.
 *
 * Throws `LegacyConfigError` for a Hedera-era config — every command that needs
 * a working node should stop there and send the operator to `xorv init`.
 */
export function loadConfig(): NodeConfig | null {
  const raw = readRaw();
  if (!raw) return null;
  const legacy = detectLegacy(raw);
  if (legacy) throw new LegacyConfigError(legacy);
  return withDefaults(raw as Partial<NodeConfig>);
}

/**
 * What `xorv init` builds on: the current config, or — for a Hedera-era one —
 * the parts that still mean something on Monad (name, capabilities, prices,
 * region, broker, node id), with the chain-specific fields dropped.
 *
 * Never throws for a legacy config; that is the one command that fixes it.
 */
export function loadPreviousConfig(): { config: NodeConfig | null; legacy: LegacyConfigInfo | null } {
  const raw = readRaw();
  if (!raw) return { config: null, legacy: null };
  const legacy = detectLegacy(raw);
  if (!legacy) return { config: withDefaults(raw as Partial<NodeConfig>), legacy: null };
  const carried = withDefaults({
    ...(raw as Partial<NodeConfig>),
    network: DEFAULT_NETWORK,
    address: "",
    privateKey: "",
    agentId: null,
    // The broker's slot and token belonged to the Hedera registration.
    providerId: null,
    token: null,
  });
  return { config: carried, legacy };
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
  // locks the operator out of their own payout key.
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
    network: config.network ?? DEFAULT_NETWORK,
    brokerUrl: config.brokerUrl ?? "http://localhost:8402",
    address: config.address ?? "",
    privateKey: config.privateKey ?? "",
    agentId: normalizeAgentId(config.agentId),
    capabilities: config.capabilities ?? [],
    region: config.region ?? null,
    tunnel: config.tunnel ?? { enabled: false, hostname: null },
    sandboxDir: config.sandboxDir ?? path.join(XORV_HOME, "jobs"),
    providerId: config.providerId ?? null,
    token: config.token ?? null,
  };
}

/** Agent ids are uint256s; carry them as decimal strings, whatever JSON handed us. */
function normalizeAgentId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim()).toString();
  return null;
}

/**
 * The payout address, checksummed. Throws with the fix when there is none —
 * which only happens to a hand-edited config.
 */
export function payoutAddress(config: Pick<NodeConfig, "address">): Address {
  if (!config.address) {
    throw new Error("no payout address configured — run `xorv init`");
  }
  return normalizeAddress(config.address);
}

/**
 * The signing key, preferring the environment over the file, as `0x` hex.
 *
 * Only `xorv run` and `xorv identity register` need one; a provider that set up
 * with an address alone gets a message saying so rather than a parse error.
 */
export function resolvePrivateKey(config: Pick<NodeConfig, "privateKey">): `0x${string}` {
  const fromEnv = process.env.XORV_PRIVATE_KEY?.trim();
  const raw = fromEnv || config.privateKey?.trim();
  if (!raw) {
    throw new Error(
      "no private key on this machine — this node was set up address-only, which is all a " +
        "provider needs. To buy jobs or register an identity, set XORV_PRIVATE_KEY, or re-run " +
        "`xorv init` and import the key",
    );
  }
  try {
    return parsePrivateKey(raw);
  } catch (err) {
    const source = fromEnv ? "XORV_PRIVATE_KEY" : configPath();
    throw new Error(`the key in ${source} is unusable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The broker URL, preferring the environment so one config can target many. */
export function resolveBrokerUrl(config: Pick<NodeConfig, "brokerUrl">): string {
  return (process.env.XORV_BROKER_URL?.trim() || config.brokerUrl).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Earnings ledger — append-only, local, so `xorv earnings` works offline
// ---------------------------------------------------------------------------

export interface EarningRow {
  at: number;
  jobId: string;
  /**
   * Always "usdc" for rows written on Monad. "hbar" survives in ledgers
   * written by the Hedera prototype; they are read, never written.
   */
  asset: "usdc" | "hbar";
  amount: string;
  usdMicros: number;
  durationMs: number;
  ok: boolean;
  /** Settlement tx hash (0x…) when known; Hedera-era rows hold `0.0.x@s.n`. */
  transactionId?: string;
  adapter?: string;
}

export function appendEarning(row: EarningRow): void {
  try {
    ensureHome();
    fs.appendFileSync(EARNINGS_PATH, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch {
    // The ledger is a convenience; the record of payment is the USDC transfer
    // on Monad. Never let a disk problem here fail a job that already ran and
    // already got paid.
  }
}

export function readEarnings(limit = 500): EarningRow[] {
  if (!fs.existsSync(EARNINGS_PATH)) return [];
  const lines = fs.readFileSync(EARNINGS_PATH, "utf8").trim().split("\n").filter(Boolean);
  const rows: EarningRow[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      const row = JSON.parse(line) as EarningRow;
      if (row && typeof row === "object" && typeof row.jobId === "string") rows.push(row);
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
 * the cost the adapter reports. The hosted-model presets are priced from the
 * providers' published per-token rates (Qwen $2/$6, Kimi $3/$15, Hunyuan
 * ~$0.83/$2.50 per million tokens in/out) for a few-thousand-token answer with
 * its reasoning, plus margin; Qwen Code runs many turns and is priced like the
 * agentic CLI it is.
 */
export function defaultCapability(adapter: AdapterKind): Capability {
  const presets: Record<AdapterKind, { name: string; price: number; model?: string }> = {
    "claude-code": { name: "Claude Code", price: 250_000 },
    codex: { name: "Codex", price: 200_000 },
    grok: { name: "Grok Code", price: 100_000 },
    opencode: { name: "OpenCode", price: 50_000 },
    qwen: { name: "Qwen 3.8 Max", price: 40_000, model: LLM_PRESETS.qwen.defaultModel },
    kimi: { name: "Kimi K3", price: 80_000, model: LLM_PRESETS.kimi.defaultModel },
    hunyuan: { name: "Hunyuan hy4", price: 20_000, model: LLM_PRESETS.hunyuan.defaultModel },
    "qwen-code": { name: "Qwen Code", price: 200_000, model: LLM_PRESETS.qwen.defaultModel },
    // Local models cost electricity, not tokens — this one can be genuinely tiny.
    "openai-compatible": { name: "OpenAI-compatible endpoint", price: 5_000 },
    echo: { name: "Echo (test)", price: 1_000 },
  };
  const preset = presets[adapter];
  return {
    id: adapter,
    adapter,
    displayName: preset.name,
    // The hosted-model adapters name their model up front, so the job board
    // shows exactly what runs (qwen3.8-max, kimi-k3, hy4-preview) instead of
    // a blank that means "whatever the default is today".
    model: preset.model ?? null,
    priceUsdMicros: preset.price,
    maxConcurrency: adapter === "echo" ? 4 : 1,
  };
}
