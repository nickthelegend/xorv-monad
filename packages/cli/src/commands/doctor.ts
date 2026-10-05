/**
 * `xorv doctor` — every reason this node might not earn, in one screen.
 *
 * Ordered by what actually blocks money: config, then containment, then the
 * payout account, then the broker, then the agent CLIs. Each failed check says
 * what to run next, because "✖ token not associated" without the fix is just a
 * nicer way of being stuck.
 *
 * The checks are pure functions over data that has already been fetched, so
 * they can be unit tested against a mirror-node response or a broker payload
 * without a network. Rendering happens once, at the end, over the result — the
 * shape borrowed from Loom's `doctor`, which got this right.
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
  fetchBalances,
  formatGas,
  formatUsd,
  formatUnits,
  explorerAddress,
  networkLabel,
  verifyStablecoinDomains,
  type AdapterKind,
  type DomainCheck,
} from "@xorv/protocol";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectAvailable } from "../adapters/index.js";
import { safeMode } from "../adapters/base.js";
import { agentCredentials, credentialsExpired } from "../credentials.js";
import { describeSandbox, detectSandbox, withheldEnvKeys, type SandboxTier } from "../sandbox.js";
import { configPath, defaultCapability, loadConfig, resolveBrokerUrl, type NodeConfig } from "../config.js";
import { cloudflaredAvailable, CLOUDFLARED_INSTALL_HINT } from "../tunnel.js";
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
        config.capabilities.map((c) => `${c.displayName} @ ${formatUsd(c.priceUsdMicros)}`).join(", "),
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
    checks.push(fail("payout", "no payout account — jobs cannot be paid for", "xorv init"));
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

export interface BalanceLike {
  /** MON for gas, in wei. */
  gasWei: string | bigint | number;
  /** One entry per configured stablecoin, default first. */
  stablecoins: Array<{ symbol: string; units: string | bigint | number }>;
}

/**
 * What can be wrong with a payout account.
 *
 * On Hedera this was three checks and the important one asked whether the
 * account could receive the token *at all* — an account without an association
 * or an automatic slot silently cannot be paid. That check is gone: every
 * ERC-20 address can receive AUSD or USDC, so the question has one answer and
 * asking it is noise.
 *
 * What is left is reporting, plus the check that actually decides whether a
 * buyer's payment will verify: each stablecoin's configured EIP-712 domain
 * against the contract's `DOMAIN_SEPARATOR()`. A mismatch means every
 * signature in that token is rejected with an opaque "invalid signature", and
 * nothing else would tell the operator why.
 *
 * Gas is MON, and a provider needs none: it only receives, and the broker's
 * facilitator pays the gas on every settlement. Flagging an empty balance —
 * stablecoin or MON — would send people to a faucet they do not need.
 */
export function payoutChecks(
  network: string,
  address: string,
  balances: BalanceLike,
  domains: DomainCheck[] = [],
): Check[] {
  const checks: Check[] = [
    ok("account", `${address} on ${networkLabel(network)} · ${explorerAddress(network, address)}`),
  ];

  const held = balances.stablecoins.map((s) => `${formatUnits(String(s.units))} ${s.symbol}`).join(" · ");
  const empty = balances.stablecoins.every((s) => BigInt(s.units) === 0n);
  checks.push(ok("balance", `${held || "no stablecoin configured"}${empty ? " (nothing needed — this account only receives)" : ""}`));

  checks.push(
    ok(
      "gas",
      `${formatGas(String(balances.gasWei))} — none needed: the broker's facilitator pays the gas, providers and buyers never do`,
    ),
  );

  for (const d of domains) {
    if (d.ok) {
      checks.push(ok("stablecoin", `${d.symbol} ${d.address} · EIP-712 "${d.eip712.name}"/"${d.eip712.version}" matches the contract`));
    } else if (d.actual) {
      checks.push(
        fail(
          "stablecoin",
          `${d.symbol} ${d.address}: configured EIP-712 domain "${d.eip712.name}"/"${d.eip712.version}" ` +
            `does not match its DOMAIN_SEPARATOR — every payment in ${d.symbol} will be rejected`,
          "unset XORV_STABLECOIN, or set XORV_STABLECOIN_NAME / XORV_STABLECOIN_VERSION to the token's domain",
        ),
      );
    } else {
      checks.push(warn("stablecoin", `${d.symbol} ${d.address}: could not check its EIP-712 domain (${d.error ?? "no DOMAIN_SEPARATOR()"})`));
    }
  }

  return checks;
}

export interface NetworkInfo {
  network: string;
  facilitator: { description: string; feePayer: string };
  stats: { providersLive: number };
}

export function brokerChecks(url: string, info: NetworkInfo, nodeNetwork: string): Check[] {
  const checks: Check[] = [ok("broker", url)];

  if (info.network !== nodeNetwork) {
    checks.push(
      fail(
        "network",
        `broker is on ${info.network}, this node is on ${nodeNetwork} — every settlement will fail`,
        `set "network": "${info.network}" in ${configPath()}`,
      ),
    );
  } else {
    checks.push(ok("network", `${networkLabel(info.network)} · both sides agree`));
  }

  checks.push(ok("facilitator", `${info.facilitator.description} · fee payer ${info.facilitator.feePayer}`));
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
export function probeAuth(kind: AdapterKind, home = os.homedir()): AuthProbe {
  const exists = (...parts: string[]): boolean => fs.existsSync(path.join(home, ...parts));

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
    case "codex":
      return exists(".codex", "auth.json")
        ? { authed: true, hint: "" }
        : { authed: false, hint: "run `codex` once and sign in" };
    case "opencode":
      return exists(".local", "share", "opencode", "auth.json") || exists(".config", "opencode", "auth.json")
        ? { authed: true, hint: "" }
        : { authed: null, hint: "run `opencode auth login` if jobs fail" };
    case "grok":
      return process.env.XAI_API_KEY || process.env.GROK_API_KEY
        ? { authed: true, hint: "" }
        : { authed: null, hint: "set XAI_API_KEY if jobs fail" };
    case "openai-compatible":
      return process.env.XORV_OPENAI_BASE_URL
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
          ? fail(s.kind, `${s.label} is sold by this node but not installed`, `install ${s.label}`)
          : warn(s.kind, `${s.label} not installed`),
      );
      continue;
    }
    if (!s.selling) {
      checks.push(warn(s.kind, `${s.label} installed but not being sold`, "xorv init"));
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
 * as unfixable rather than guessed at. A `--fix` that spends money without being
 * asked is worse than one that does nothing.
 */
export function fixNode(): { fixed: string[]; unfixable: string[] } {
  const fixed: string[] = [];
  const unfixable: string[] = [];

  const dir = path.dirname(configPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fixed.push(`created ${dir}`);
  }

  // The config holds the payout private key. A permissive mode on it is a real
  // finding and the repair is unambiguous.
  const file = configPath();
  if (fs.existsSync(file)) {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== 0o600) {
      fs.chmodSync(file, 0o600);
      fixed.push(`tightened ${file} from ${mode.toString(8)} to 600 — it holds your payout key`);
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

  const config = loadConfig();
  if (config && !config.address) unfixable.push("no payout account — run `xorv init`");
  if (config && config.capabilities.length === 0) unfixable.push("no capabilities — run `xorv init`");

  return { fixed, unfixable };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function doctorCommand(opts: { json?: boolean; fix?: boolean } = {}): Promise<void> {
  const checks: Check[] = [];
  const config = loadConfig();

  if (opts.fix) {
    const { fixed, unfixable } = fixNode();
    if (!opts.json) {
      for (const f of fixed) ui.ok(f);
      for (const u of unfixable) ui.warn(u);
      if (!fixed.length && !unfixable.length) ui.info("nothing needed fixing");
      ui.blank();
    }
  }

  checks.push(...configChecks(config));
  checks.push(...sandboxChecks(detectSandbox(), withheldEnvKeys().length, safeMode()));

  if (config?.address) {
    try {
      const [balances, domains] = await Promise.all([
        fetchBalances(config.network, config.address),
        verifyStablecoinDomains(config.network).catch(() => []),
      ]);
      checks.push(...payoutChecks(config.network, config.address, balances, domains));
    } catch (err) {
      checks.push(
        fail(
          "account",
          `could not read balances for ${config.address}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          "check the address, XORV_RPC_URL and your connection",
        ),
      );
    }
  }

  if (config) {
    const url = resolveBrokerUrl(config);
    try {
      const res = await fetch(`${url}/api/network`, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      checks.push(...brokerChecks(url, (await res.json()) as NetworkInfo, config.network));
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
          label: defaultCapability(adapter.kind).displayName,
          installed: available,
          selling: selling.has(adapter.kind),
          auth: available ? probeAuth(adapter.kind) : { authed: null, hint: "" },
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
        // A signed-out agent stops *that* capability, not the node: when
        // something is still selling, saying "cannot earn" sent operators
        // chasing a node that was earning fine.
        checks.some((c) => c.status === "ok" && c.detail.endsWith("· selling"))
          ? `  ${report.summary.failures} problem${report.summary.failures > 1 ? "s" : ""} — the rest of this node is selling, but fix ${report.summary.failures > 1 ? "these" : "this"} to earn from everything configured`
          : `  ${report.summary.failures} problem${report.summary.failures > 1 ? "s" : ""} — this node cannot earn until they're fixed`,
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
