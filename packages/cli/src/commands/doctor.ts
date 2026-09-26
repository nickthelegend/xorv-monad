/**
 * `xorv doctor` — every reason this node might not earn, in one screen.
 *
 * Ordered by what actually blocks money: config, then containment, then the
 * chain (is the RPC up and on the chain we think?), the payout address and its
 * identity, then the broker, then the agents. Each failed check says what to
 * run next, because "✖ network mismatch" without the fix is just a nicer way of
 * being stuck.
 *
 * The checks are pure functions over data that has already been fetched, so
 * they can be unit tested against an RPC answer or a broker payload without a
 * network. Rendering happens once, at the end, over the result — the shape
 * borrowed from Loom's `doctor`, which got this right.
 *
 * Two distinctions this command refuses to blur:
 *
 *   - **Installed is not usable.** A signed-out agent CLI answers `--version`
 *     cheerfully and then fails every paid job. Detecting that here is the
 *     difference between a node that earns and one that quietly returns errors
 *     to strangers who paid for them.
 *   - **Broken is not unconfigured.** "All clear" printed over a screen of
 *     warnings is the lie that teaches people to stop reading this command.
 */

import {
  LLM_PRESETS,
  explorerAddress,
  explorerAgent,
  fetchBalances,
  formatMon,
  formatUsd,
  formatUsdc,
  isLlmPresetKind,
  networkConfig,
  networkLabel,
  publicClientFor,
  resolvePreset,
  type AdapterKind,
} from "@xorv/protocol";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { http } from "viem";
import { detectAvailable } from "../adapters/index.js";
import { safeMode } from "../adapters/base.js";
import { agentCredentials, canAuthenticate, credentialsExpired } from "../credentials.js";
import { describeSandbox, detectSandbox, withheldEnvKeys, type SandboxTier } from "../sandbox.js";
import {
  LegacyConfigError,
  configPath,
  defaultCapability,
  loadConfig,
  resolveBrokerUrl,
  type NodeConfig,
} from "../config.js";
import { cloudflaredAvailable, CLOUDFLARED_INSTALL_HINT } from "../tunnel.js";
import { readIdentity, type IdentityState } from "./identity.js";
import * as ui from "../ui.js";

export type Status = "ok" | "warn" | "fail";

export interface Check {
  /** Short group label, left-aligned in the report. */
  name: string;
  status: Status;
  detail: string;
  /** A command that would resolve this, when exactly one would. */
  fix?: string;
}

export interface DoctorReport {
  checks: Check[];
  summary: { ok: boolean; warnings: number; failures: number };
}

export function doctorReport(checks: Check[]): DoctorReport {
  const warnings = checks.filter((c) => c.status === "warn").length;
  const failures = checks.filter((c) => c.status === "fail").length;
  return { checks, summary: { ok: failures === 0, warnings, failures } };
}

const ok = (name: string, detail: string): Check => ({ name, status: "ok", detail });
const warn = (name: string, detail: string, fix?: string): Check => ({
  name,
  status: "warn",
  detail,
  fix,
});
const fail = (name: string, detail: string, fix?: string): Check => ({
  name,
  status: "fail",
  detail,
  fix,
});

// ---------------------------------------------------------------------------
// Pure checks
// ---------------------------------------------------------------------------

export function configChecks(config: NodeConfig | null): Check[] {
  if (!config) return [fail("config", "this node is not configured", "xorv init")];

  const checks: Check[] = [ok("config", configPath())];

  if (config.capabilities.length === 0) {
    checks.push(fail("capabilities", "nothing to sell — no capabilities configured", "xorv init"));
  } else {
    checks.push(
      ok(
        "capabilities",
        config.capabilities
          .map((c) => `${c.displayName}${c.model ? ` (${c.model})` : ""} @ ${formatUsd(c.priceUsdMicros)}`)
          .join(", "),
      ),
    );
    // A price below what the job costs to serve turns every sale into a loss,
    // and the node will happily run at that price forever without saying so.
    const freebies = config.capabilities.filter((c) => c.priceUsdMicros < 1_000);
    if (freebies.length > 0) {
      checks.push(
        warn(
          "pricing",
          `${freebies.map((c) => c.displayName).join(", ")} priced under $0.001 — likely below cost`,
          "xorv price",
        ),
      );
    }
  }

  if (!config.address) {
    checks.push(fail("payout", "no payout address — jobs cannot be paid for", "xorv init"));
  }

  return checks;
}

/**
 * Containment, named rather than assumed.
 *
 * A provider is running strangers' prompts against their own machine. Saying
 * "sandboxed" without saying which mechanism lets someone believe they have a
 * filesystem boundary on a host that has none.
 */
export function sandboxChecks(tier: SandboxTier, withheld: number, safe: boolean): Check[] {
  const checks: Check[] = [];

  checks.push(
    safe
      ? warn("mode", "XORV_SAFE_MODE is on — tools disabled, text generation only")
      : ok("mode", "full agent mode — prompts come from strangers, see SECURITY.md"),
  );

  const weak = tier === "none" || tier === "env";
  checks.push({
    name: "sandbox",
    status: weak ? "warn" : "ok",
    detail: describeSandbox(tier),
    fix: weak ? "XORV_SANDBOX=container xorv start" : undefined,
  });

  checks.push(
    weak
      ? warn("isolation", "a hostile prompt could read any file this user can read")
      : ok(
          "isolation",
          `payout key, ssh keys, cloud credentials and keychain unreadable · ${withheld} env var(s) withheld`,
        ),
  );

  return checks;
}

/** What the RPC answered, or why it didn't. */
export type RpcProbe = { chainId: number; latencyMs: number } | { error: string };

/**
 * Is the RPC reachable, and is it the chain this node thinks it is on?
 *
 * The chain id is signed into every EIP-712 payment, so an RPC on the wrong
 * chain (a stale `XORV_RPC_URL` left pointing at another network) is not a
 * cosmetic problem: balances read wrong and identities register on the wrong
 * chain.
 */
export function rpcChecks(network: string, rpcUrl: string, probe: RpcProbe): Check[] {
  const expected = networkConfig(network).chainId;
  if ("error" in probe) {
    return [fail("rpc", `${rpcUrl} is not reachable: ${probe.error}`, "check XORV_RPC_URL and your connection")];
  }
  if (probe.chainId !== expected) {
    return [
      fail(
        "rpc",
        `${rpcUrl} is chain ${probe.chainId}, but this node is on ${network} (chain ${expected})`,
        "point XORV_RPC_URL at a Monad RPC for this network, or unset it",
      ),
    ];
  }
  return [ok("rpc", `${rpcUrl} · chain ${probe.chainId} · ${probe.latencyMs}ms`)];
}

export interface BalanceLike {
  /** Native MON, in wei. */
  monWei: string | bigint | number;
  /** USDC smallest units. */
  usdcUnits: string | bigint | number;
}

export function payoutChecks(network: string, address: string, balances: BalanceLike): Check[] {
  const mon = BigInt(balances.monWei);
  return [
    ok("payout", `${address} on Monad ${networkLabel(network)} · ${explorerAddress(network, address)}`),
    ok(
      "balance",
      // A provider is *paid*, so it needs no MON to operate — the facilitator
      // covers the gas on every settlement, and any address can receive USDC
      // without opting in. Zero is fine here, and flagging it sends people to
      // a faucet they do not need.
      `${formatUsdc(balances.usdcUnits)} USDC · ${formatMon(mon)}` +
        (mon === 0n ? " (no MON needed — the facilitator pays gas)" : ""),
    ),
  ];
}

/**
 * The ERC-8004 identity, when there is one, checked against the payout address.
 *
 * `state` is what the registry returned, or the error reading it. No identity
 * is a warning, not a failure: the node earns without one, it just earns
 * without on-chain receipts bound to an agent.
 */
export function identityChecks(
  network: string,
  config: Pick<NodeConfig, "agentId" | "address" | "privateKey">,
  state: IdentityState | { error: string } | null,
): Check[] {
  if (!config.agentId) {
    return [
      warn(
        "identity",
        "no ERC-8004 identity — receipts and reputation won't be bound to an on-chain agent",
        config.privateKey
          ? "xorv identity register"
          : "register one from the wallet that holds the payout key (this node keeps no key)",
      ),
    ];
  }
  if (!state || "error" in state) {
    return [
      fail(
        "identity",
        `agent #${config.agentId} could not be read: ${state ? state.error : "no answer"}`,
        "xorv identity show",
      ),
    ];
  }
  if (!state.walletMatches) {
    return [
      fail(
        "identity",
        `agent #${state.agentId}'s wallet is ${state.wallet ?? "cleared"}, not the payout address — receipts won't bind to it`,
        "xorv identity register --force",
      ),
    ];
  }
  return [ok("identity", `agent #${state.agentId} · wallet = payout · ${explorerAgent(network, state.agentId)}`)];
}

/** The fields of the broker's `GET /api/network` these checks read. */
export interface BrokerNetworkInfo {
  network: string;
  facilitator: { description: string; address?: string | null; mode?: string };
  ledger?: { address: string; url?: string } | null;
  ai?: {
    router: { model: string } | null;
    screener: { model: string } | null;
    verifier: { model: string } | null;
  } | null;
  stats: { providersLive: number };
}

export function brokerChecks(url: string, info: BrokerNetworkInfo, nodeNetwork: string): Check[] {
  const checks: Check[] = [ok("broker", url)];

  if (info.network !== nodeNetwork) {
    checks.push(
      fail(
        "network",
        // Not a cosmetic mismatch: the chain id is inside every signed EIP-712
        // payment, so a buyer paying this node would sign for the wrong chain.
        `broker is on ${info.network}, this node is on ${nodeNetwork} — every settlement will fail`,
        `set "network": "${info.network}" in ${configPath()}`,
      ),
    );
  } else {
    checks.push(ok("network", `Monad ${networkLabel(info.network)} (${info.network}) · both sides agree`));
  }

  const payer = info.facilitator.address ? ` · gas paid by ${info.facilitator.address}` : "";
  checks.push(ok("facilitator", `${info.facilitator.description}${payer}`));
  checks.push(
    info.ledger
      ? ok("ledger", `XorvLedger ${info.ledger.address}`)
      : warn("ledger", "broker has no XorvLedger configured — no on-chain receipts for your jobs"),
  );
  if (info.ai) {
    const roles = (
      [
        ["router", info.ai.router],
        ["screener", info.ai.screener],
        ["verifier", info.ai.verifier],
      ] as const
    )
      .filter(([, role]) => role)
      .map(([name, role]) => `${name} ${role!.model}`);
    if (roles.length) checks.push(ok("ai roles", roles.join(" · ")));
  }
  checks.push(ok("network size", `${info.stats.providersLive} provider(s) live`));
  return checks;
}

// ---------------------------------------------------------------------------
// "Installed" is not "usable"
// ---------------------------------------------------------------------------

export interface AuthProbe {
  /** true signed in, false signed out, null couldn't tell. */
  authed: boolean | null;
  /** What to do about it, when the answer isn't yes. */
  hint: string;
}

/**
 * Whether an agent CLI can actually take a job.
 *
 * Cheap by design — reading a credential file beats spending a real API call on
 * a diagnostic. A `null` is an honest "couldn't tell" rather than an optimistic
 * yes, because the failure mode of a wrong yes is a stranger paying for an
 * error message.
 */
export function probeAuth(
  kind: AdapterKind,
  home = os.homedir(),
  env: Record<string, string | undefined> = process.env,
): AuthProbe {
  const exists = (...parts: string[]): boolean => fs.existsSync(path.join(home, ...parts));

  if (isLlmPresetKind(kind)) {
    // The hosted models authenticate with an API key and nothing else.
    const preset = resolvePreset(kind, env);
    return preset.apiKey
      ? { authed: true, hint: "" }
      : { authed: false, hint: `set ${LLM_PRESETS[kind].keyEnvs.join(" or ")}` };
  }

  switch (kind) {
    case "claude-code": {
      const has = Object.keys(agentCredentials(kind)).length > 0;
      if (!has) {
        return {
          authed: process.platform === "darwin" ? false : null,
          hint: "run `claude` once and sign in, or export CLAUDE_CODE_OAUTH_TOKEN",
        };
      }
      // A token that exists but has expired is worse than none: the node keeps
      // accepting jobs, the buyer is charged, and every one of them comes back
      // `401 OAuth access token has expired`. Report it as signed out.
      if (credentialsExpired(kind)) {
        return {
          authed: false,
          hint: "session expired — run `claude` once to refresh it (no node restart needed)",
        };
      }
      return { authed: true, hint: "" };
    }
    case "qwen-code":
      // Qwen's OAuth tier is gone; the CLI runs on the Qwen preset's API key,
      // which the node hands it as OPENAI_API_KEY.
      return canAuthenticate(kind)
        ? { authed: true, hint: "" }
        : { authed: false, hint: `set ${LLM_PRESETS.qwen.keyEnvs.join(" or ")}` };
    case "codex":
      return exists(".codex", "auth.json")
        ? { authed: true, hint: "" }
        : { authed: false, hint: "run `codex` once and sign in" };
    case "opencode":
      return exists(".local", "share", "opencode", "auth.json") || exists(".config", "opencode", "auth.json")
        ? { authed: true, hint: "" }
        : { authed: null, hint: "run `opencode auth login` if jobs fail" };
    case "grok":
      return env.XAI_API_KEY || env.GROK_API_KEY
        ? { authed: true, hint: "" }
        : { authed: null, hint: "set XAI_API_KEY if jobs fail" };
    case "openai-compatible":
      return env.XORV_OPENAI_BASE_URL
        ? { authed: true, hint: "" }
        : { authed: false, hint: "set XORV_OPENAI_BASE_URL and XORV_OPENAI_MODEL" };
    default:
      return { authed: true, hint: "" };
  }
}

export interface AdapterState {
  kind: AdapterKind;
  label: string;
  installed: boolean;
  selling: boolean;
  auth: AuthProbe;
}

export function adapterChecks(states: AdapterState[]): Check[] {
  const checks: Check[] = [];

  for (const s of states) {
    if (!s.installed) {
      // Only a problem if the node is trying to sell it. An uninstalled CLI the
      // operator never listed is not a fault, it is a choice.
      checks.push(
        s.selling
          ? fail(s.kind, `${s.label} is sold by this node but not set up`, s.auth.hint || `set up ${s.label}`)
          : warn(s.kind, `${s.label} not set up`),
      );
      continue;
    }
    if (!s.selling) {
      checks.push(warn(s.kind, `${s.label} ready but not being sold`, "xorv init"));
      continue;
    }
    if (s.auth.authed === false) {
      checks.push(fail(s.kind, `${s.label} is installed but signed out — every job will fail`, s.auth.hint));
    } else if (s.auth.authed === null) {
      checks.push(warn(s.kind, `${s.label} selling · could not confirm sign-in`, s.auth.hint));
    } else {
      checks.push(ok(s.kind, `${s.label} · signed in · selling`));
    }
  }

  if (states.every((s) => !s.installed)) {
    checks.push(fail("agents", "no agent CLI installed — this node cannot run any job", "xorv init"));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// --fix
// ---------------------------------------------------------------------------

/**
 * Repair what has exactly one safe repair, and report the rest.
 *
 * Anything that costs money, moves funds, or needs a human decision is listed
 * as unfixable rather than guessed at. A `--fix` that spends MON on an
 * identity registration without being asked is worse than one that does
 * nothing.
 */
export function fixNode(): { fixed: string[]; unfixable: string[] } {
  const fixed: string[] = [];
  const unfixable: string[] = [];

  const dir = path.dirname(configPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fixed.push(`created ${dir}`);
  }

  // The config can hold a private key. A permissive mode on it is a real
  // finding and the repair is unambiguous — on POSIX. Windows reports every
  // file as 0666 and ignores chmod, so "tightening" there would be a claim
  // repeated on every run and true on none.
  const file = configPath();
  if (process.platform !== "win32" && fs.existsSync(file)) {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== 0o600) {
      fs.chmodSync(file, 0o600);
      fixed.push(`tightened ${file} from ${mode.toString(8)} to 600 — it can hold your key`);
    }
  }

  const jobs = path.join(dir, "jobs");
  if (fs.existsSync(jobs)) {
    // Job directories are deleted when a job ends; survivors are crash debris.
    const stale = fs.readdirSync(jobs);
    if (stale.length > 0) {
      for (const entry of stale) fs.rmSync(path.join(jobs, entry), { recursive: true, force: true });
      fixed.push(`removed ${stale.length} leftover job director${stale.length === 1 ? "y" : "ies"}`);
    }
  }

  let config: NodeConfig | null = null;
  try {
    config = loadConfig();
  } catch (err) {
    unfixable.push(`${err instanceof Error ? err.message : String(err)}`);
  }
  if (config && !config.address) unfixable.push("no payout address — run `xorv init`");
  if (config && config.capabilities.length === 0) unfixable.push("no capabilities — run `xorv init`");

  return { fixed, unfixable };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/** Doctor-sized RPC calls: fail in seconds, not after the client's 30s-and-retries default. */
const PROBE_TIMEOUT_MS = 8_000;

export async function doctorCommand(opts: { json?: boolean; fix?: boolean } = {}): Promise<void> {
  const checks: Check[] = [];

  if (opts.fix) {
    const { fixed, unfixable } = fixNode();
    if (!opts.json) {
      for (const f of fixed) ui.ok(f);
      for (const u of unfixable) ui.warn(u);
      if (!fixed.length && !unfixable.length) ui.info("nothing needed fixing");
      ui.blank();
    }
  }

  let config: NodeConfig | null = null;
  try {
    config = loadConfig();
    checks.push(...configChecks(config));
  } catch (err) {
    checks.push(
      fail("config", err instanceof Error ? err.message : String(err), err instanceof LegacyConfigError ? "xorv init" : undefined),
    );
  }
  checks.push(...sandboxChecks(detectSandbox(), withheldEnvKeys().length, safeMode()));

  if (config) {
    let rpcOk = false;
    let cfg: ReturnType<typeof networkConfig> | null = null;
    try {
      cfg = networkConfig(config.network);
    } catch (err) {
      checks.push(fail("network", err instanceof Error ? err.message : String(err), "xorv init"));
    }

    if (cfg) {
      const client = publicClientFor(cfg.caip2, {
        transport: http(cfg.rpcUrl, { timeout: PROBE_TIMEOUT_MS, retryCount: 0 }),
      });
      let probe: RpcProbe;
      const started = Date.now();
      try {
        probe = { chainId: await client.getChainId(), latencyMs: Date.now() - started };
      } catch (err) {
        probe = { error: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
      }
      checks.push(...rpcChecks(cfg.caip2, cfg.rpcUrl, probe));
      rpcOk = !("error" in probe) && probe.chainId === cfg.chainId;

      if (config.address && rpcOk) {
        try {
          const balances = await fetchBalances(cfg.caip2, config.address, { client });
          checks.push(...payoutChecks(cfg.caip2, config.address, balances));
        } catch (err) {
          checks.push(
            fail(
              "payout",
              `could not read ${config.address}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
              "check the address and your connection",
            ),
          );
        }

        let identity: IdentityState | { error: string } | null = null;
        if (config.agentId) {
          try {
            identity = await readIdentity({
              network: cfg.caip2,
              agentId: config.agentId,
              payout: config.address,
              client: { transport: http(cfg.rpcUrl, { timeout: PROBE_TIMEOUT_MS, retryCount: 0 }) },
            });
          } catch (err) {
            identity = { error: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
          }
        }
        checks.push(...identityChecks(cfg.caip2, config, identity));
      }
    }

    const url = resolveBrokerUrl(config);
    try {
      const res = await fetch(`${url}/api/network`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      checks.push(...brokerChecks(url, (await res.json()) as BrokerNetworkInfo, config.network));
    } catch (err) {
      checks.push(
        fail("broker", `${url} is not reachable: ${err instanceof Error ? err.message : String(err)}`, "pnpm broker"),
      );
    }

    const detected = await detectAvailable();
    const selling = new Set(config.capabilities.map((c) => c.adapter));
    checks.push(
      ...adapterChecks(
        detected.map(({ adapter, available }) => ({
          kind: adapter.kind,
          label: labelFor(adapter.kind),
          installed: available,
          selling: selling.has(adapter.kind),
          auth: available ? probeAuth(adapter.kind) : { authed: null, hint: adapter.installHint },
        })),
      ),
    );
  }

  checks.push(
    (await cloudflaredAvailable())
      ? ok("tunnel", "cloudflared installed — this node can accept jobs from outside your network")
      : warn("tunnel", "cloudflared not installed — local network only", CLOUDFLARED_INSTALL_HINT),
  );

  const report = doctorReport(checks);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    if (report.summary.failures) process.exitCode = 1;
    return;
  }

  console.log(ui.banner("diagnostics"));
  render(checks);
  ui.blank();

  if (report.summary.failures) {
    ui.blank();
    console.log(
      ui.c.bad(
        `  ${report.summary.failures} problem${report.summary.failures > 1 ? "s" : ""} — this node cannot earn until they're fixed`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  if (report.summary.warnings) {
    // "All clear" over a screen of warnings is a lie, and it's the lie that
    // teaches people to stop reading this command. Nothing is broken; several
    // things aren't set up. Those are different sentences.
    console.log(
      ui.c.warn(
        `  nothing broken · ${report.summary.warnings} thing${report.summary.warnings > 1 ? "s" : ""} not set up (see above)`,
      ),
    );
    return;
  }
  console.log(ui.c.ok("  all clear — this node is ready to earn"));
}

/** "Qwen 3.8 Max (qwen3.8-max)" — the model id shown exactly, where there is one. */
function labelFor(kind: AdapterKind): string {
  const preset = defaultCapability(kind);
  return preset.model ? `${preset.displayName} (${preset.model})` : preset.displayName;
}

function render(checks: Check[]): void {
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const icon = c.status === "ok" ? ui.c.ok("✔") : c.status === "warn" ? ui.c.warn("!") : ui.c.bad("✖");
    const name = ui.c.muted(c.name.padEnd(width));
    const detail = c.status === "ok" ? ui.c.muted(c.detail) : c.detail;
    console.log(`  ${icon} ${name}  ${detail}`);
    if (c.fix) console.log(`  ${" ".repeat(width + 3)}${ui.c.accent(`→ ${c.fix}`)}`);
  }
}
