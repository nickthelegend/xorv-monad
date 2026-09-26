/**
 * Day-to-day operator commands.
 *
 * The things you reach for once the node has been running for a week: what did
 * it actually do, what is it charging, stop taking work for a bit, and does
 * this adapter still function.
 */

import fs from "node:fs";
import path from "node:path";
import {
  XORV_HOME,
  loadConfig,
  readEarnings,
  requireConfig,
  resolveBrokerUrl,
  saveConfig,
} from "../config.js";
import { createAdapter, detectAvailable } from "../adapters/index.js";
import { makeJobDir, removeJobDir } from "../adapters/base.js";
import { formatDuration, formatUsd, parseUsd } from "@xorv/protocol";
import * as ui from "../ui.js";

/**
 * The pause flag.
 *
 * A file rather than a signal or a socket: `xorv pause` has to work from a
 * different terminal than the one running `xorv start`, possibly a different
 * session, and the running node checks it on each heartbeat. One path, no IPC,
 * and it survives a node restart — which is what you want from "stop taking
 * work" when you're heading into a meeting.
 */
export function pauseFlagPath(): string {
  return path.join(XORV_HOME, "paused");
}

export function isPaused(): boolean {
  return fs.existsSync(pauseFlagPath());
}

export async function pauseCommand(): Promise<void> {
  requireConfig();
  fs.mkdirSync(XORV_HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(pauseFlagPath(), new Date().toISOString(), { mode: 0o600 });
  ui.blank();
  ui.ok("paused — this node will finish jobs in flight and take no new ones");
  ui.muted(`  resume with ${ui.c.accent("xorv resume")}`);
  ui.blank();
}

export async function resumeCommand(): Promise<void> {
  requireConfig();
  try {
    fs.unlinkSync(pauseFlagPath());
  } catch {
    /* already running */
  }
  ui.blank();
  ui.ok("resumed — taking jobs again");
  ui.blank();
}

// ---------------------------------------------------------------------------
// xorv jobs
// ---------------------------------------------------------------------------

interface BrokerJob {
  id: string;
  status: string;
  prompt: string;
  createdAt: number;
  completedAt: number | null;
  startedAt: number | null;
  priceUsdMicros: number | null;
  providerLabel: string | null;
  payment: { transactionId: string; asset: string; hashscanUrl: string } | null;
}

export async function jobsCommand(opts: { json?: boolean; limit?: string; all?: boolean }): Promise<void> {
  const config = requireConfig();
  const brokerUrl = resolveBrokerUrl(config);
  const limit = Number(opts.limit ?? 20) || 20;

  const query = opts.all || !config.providerId ? "" : `&providerId=${config.providerId}`;
  const res = await fetch(`${brokerUrl}/api/jobs?limit=${limit}${query}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`broker returned ${res.status}`);
  const { jobs } = (await res.json()) as { jobs: BrokerJob[] };

  if (opts.json) {
    console.log(JSON.stringify(jobs, null, 2));
    return;
  }

  console.log(ui.banner(opts.all ? "every job on the network" : "jobs this node ran"));

  if (jobs.length === 0) {
    ui.muted(
      config.providerId
        ? "  nothing yet — leave `xorv start` running and jobs will land here"
        : "  this node hasn't registered yet — run `xorv start` first",
    );
    ui.blank();
    return;
  }

  console.log(
    ui.table(
      [
        { header: "" },
        { header: "job" },
        { header: "prompt" },
        { header: "took", align: "right" },
        { header: "earned", align: "right" },
      ],
      jobs.map((job) => {
        const took =
          job.completedAt && job.startedAt ? formatDuration(job.completedAt - job.startedAt) : "—";
        const mark =
          job.status === "completed"
            ? ui.glyph.ok()
            : job.status === "failed"
              ? ui.glyph.bad()
              : ui.glyph.idle();
        return [
          mark,
          job.id.slice(0, 14),
          ui.c.muted(job.prompt.replace(/\s+/g, " ").slice(0, 44)),
          ui.c.muted(took),
          job.status === "completed"
            ? ui.c.money(formatUsd(job.priceUsdMicros ?? 0))
            : ui.c.muted("—"),
        ];
      }),
    ),
  );
  ui.blank();
}

// ---------------------------------------------------------------------------
// xorv price
// ---------------------------------------------------------------------------

export async function priceCommand(
  capabilityId: string | undefined,
  amount: string | undefined,
  opts: { json?: boolean },
): Promise<void> {
  const config = requireConfig();

  if (opts.json && !capabilityId) {
    console.log(JSON.stringify(config.capabilities, null, 2));
    return;
  }

  // No arguments: show what this node charges.
  if (!capabilityId) {
    console.log(ui.banner("pricing"));
    console.log(
      ui.table(
        [{ header: "capability" }, { header: "adapter" }, { header: "per job", align: "right" }],
        config.capabilities.map((c) => [
          c.displayName,
          ui.c.muted(c.adapter),
          ui.c.money(formatUsd(c.priceUsdMicros)),
        ]),
      ),
    );
    ui.blank();
    ui.muted(`  change one with ${ui.c.accent("xorv price <capability> <usd>")}`);
    ui.muted(`  e.g. ${ui.c.accent("xorv price claude-code 0.02")}`);
    ui.blank();
    return;
  }

  const capability = config.capabilities.find(
    (c) => c.id === capabilityId || c.adapter === capabilityId,
  );
  if (!capability) {
    throw new Error(
      `no capability "${capabilityId}" — this node sells: ${config.capabilities.map((c) => c.id).join(", ") || "nothing yet"}`,
    );
  }
  if (!amount) {
    throw new Error(`give a price, e.g. \`xorv price ${capabilityId} 0.02\``);
  }

  const previous = capability.priceUsdMicros;
  capability.priceUsdMicros = parseUsd(amount);
  if (capability.priceUsdMicros <= 0) throw new Error("price must be greater than zero");
  saveConfig(config);

  ui.blank();
  ui.ok(
    `${capability.displayName}: ${ui.c.muted(formatUsd(previous))} → ${ui.c.money(formatUsd(capability.priceUsdMicros))}`,
  );
  ui.muted("  restart `xorv start` for the network to see the new price");
  ui.blank();
}

// ---------------------------------------------------------------------------
// xorv test
// ---------------------------------------------------------------------------

/**
 * Run a real job through each configured adapter, locally, for free.
 *
 * This is the command that answers "is my node actually going to earn, or is it
 * going to take someone's money and fail?" — which `doctor` can only guess at,
 * because a CLI being installed is not the same as it being signed in and able
 * to answer.
 */
export async function testCommand(opts: { prompt?: string; adapter?: string }): Promise<void> {
  const config = requireConfig();
  console.log(ui.banner("self-test — runs locally, costs nothing"));

  const prompt = opts.prompt ?? "Reply with exactly the word: ok";
  const targets = config.capabilities.filter(
    (c) => !opts.adapter || c.adapter === opts.adapter || c.id === opts.adapter,
  );

  if (targets.length === 0) {
    ui.bad("no matching capability on this node");
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(config.sandboxDir, { recursive: true, mode: 0o700 });
  let failures = 0;
  let belowCost = 0;

  for (const capability of targets) {
    const spin = ui.spinner(`${capability.displayName} — running "${prompt.slice(0, 40)}"…`);
    const adapter = createAdapter(capability.adapter);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const cwd = makeJobDir(config.sandboxDir, `selftest-${capability.id}-${Date.now()}`);
    const started = Date.now();
    let reportedCost: number | null = null;

    try {
      if (!(await adapter.available())) {
        spin.fail(`${capability.displayName} — CLI not available`);
        ui.muted(`  ${adapter.installHint}`);
        failures += 1;
        continue;
      }
      const result = await adapter.run({
        prompt,
        cwd,
        timeoutMs: 120_000,
        signal: controller.signal,
        emit: () => {},
        model: capability.model ?? null,
        onCost: (usd) => {
          reportedCost = usd;
        },
      });
      spin.succeed(
        `${capability.displayName} — ok in ${formatDuration(Date.now() - started)}`,
      );
      ui.muted(`  ${result.replace(/\s+/g, " ").slice(0, 120)}`);

      // The whole reason this command exists beyond "does it run". A provider
      // cannot see that they're selling below cost until the subscription bill
      // arrives, and by then they've done it a thousand times.
      if (reportedCost !== null) {
        const costMicros = Math.round((reportedCost as number) * 1_000_000);
        const margin = capability.priceUsdMicros - costMicros;
        if (margin < 0) {
          belowCost += 1;
          ui.bad(
            `  selling at ${formatUsd(capability.priceUsdMicros)} but this job cost you ` +
              `${formatUsd(costMicros)} — losing ${formatUsd(-margin)} per job`,
          );
          ui.muted(
            `  raise it: xorv price ${capability.id} ${(costMicros * 1.4 / 1_000_000).toFixed(2)}`,
          );
        } else {
          ui.muted(
            `  cost ${formatUsd(costMicros)} · price ${formatUsd(capability.priceUsdMicros)} · margin ${formatUsd(margin)}`,
          );
        }
      }
    } catch (err) {
      spin.fail(
        `${capability.displayName} — ${err instanceof Error ? err.message : String(err)}`,
      );
      failures += 1;
    } finally {
      clearTimeout(timer);
      removeJobDir(cwd);
    }
  }

  ui.blank();
  if (failures === 0 && belowCost === 0) {
    console.log(
      ui.box(
        [
          `${ui.glyph.ok()} ${ui.c.bold("every capability works, and every price covers its cost")}`,
          "",
          `  This node will earn. ${ui.c.accent("xorv start")} to go live.`,
        ],
        { title: "healthy" },
      ),
    );
  } else if (failures === 0) {
    console.log(
      ui.box(
        [
          `${ui.glyph.warn()} ${ui.c.bold(`${belowCost} capability(s) priced below cost`)}`,
          "",
          "  Everything runs, but you would lose money on every job you win.",
          `  Raise the prices above, or run ${ui.c.accent("xorv price")} to see them all.`,
        ],
        { title: "check your pricing", color: ui.BRAND.amber },
      ),
    );
    process.exitCode = 1;
  } else {
    console.log(
      ui.box(
        [
          `${ui.glyph.bad()} ${ui.c.bold(`${failures} of ${targets.length} capabilities failed`)}`,
          "",
          "  Selling a capability that fails costs you reputation and refunds",
          "  the buyer's job to someone else. Fix or remove them first.",
        ],
        { title: "not ready", color: ui.BRAND.rose },
      ),
    );
    process.exitCode = 1;
  }
  ui.blank();
}

// ---------------------------------------------------------------------------
// xorv logs
// ---------------------------------------------------------------------------

export async function logsCommand(opts: { json?: boolean; limit?: string }): Promise<void> {
  const rows = readEarnings(Number(opts.limit ?? 50) || 50);
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(ui.banner("local job log"));
  if (rows.length === 0) {
    ui.muted("  nothing recorded yet");
    ui.blank();
    return;
  }

  for (const row of rows.slice(-30)) {
    const mark = row.ok ? ui.glyph.ok() : ui.glyph.bad();
    console.log(
      `${mark} ${ui.c.muted(new Date(row.at).toLocaleString())} ${row.jobId.slice(0, 14)} ` +
        `${ui.c.muted((row.adapter ?? "—").padEnd(18))} ${formatDuration(row.durationMs).padStart(7)} ` +
        `${row.ok ? ui.c.money(formatUsd(row.usdMicros)) : ui.c.bad("failed")}`,
    );
  }
  ui.blank();
  ui.muted(`  ${rows.length} entries · this file is local; the ledger of record is on Hedera`);
  ui.blank();
}

// ---------------------------------------------------------------------------
// xorv config
// ---------------------------------------------------------------------------

export async function configCommand(opts: { json?: boolean; path?: boolean }): Promise<void> {
  const config = loadConfig();
  const { configPath } = await import("../config.js");

  if (opts.path) {
    console.log(configPath());
    return;
  }
  if (!config) {
    throw new Error("this machine isn't set up yet — run `xorv init` first");
  }
  if (opts.json) {
    // The private key never goes to stdout — this output gets pasted into
    // issues and chat windows.
    console.log(JSON.stringify({ ...config, privateKey: "[redacted]" }, null, 2));
    return;
  }

  console.log(ui.banner("configuration"));
  console.log(
    ui.box(
      ui.kv([
        ["file", configPath()],
        ["node", config.label],
        ["node id", config.nodeId],
        ["network", config.network],
        ["broker", config.brokerUrl],
        ["payout", config.accountId],
        ["key", ui.c.muted("[stored locally, 0600]")],
        ["region", config.region ?? ui.c.muted("not set")],
        ["sandbox", config.sandboxDir],
        ["tunnel", config.tunnel.enabled ? ui.c.ok("enabled") : ui.c.muted("disabled")],
        ["paused", isPaused() ? ui.c.warn("yes") : ui.c.muted("no")],
        [
          "selling",
          config.capabilities
            .map((c) => `${c.displayName} ${ui.c.money(formatUsd(c.priceUsdMicros))}`)
            .join(", ") || ui.c.muted("nothing"),
        ],
      ]),
      { title: "config" },
    ),
  );
  ui.blank();
}

// ---------------------------------------------------------------------------
// xorv completion
// ---------------------------------------------------------------------------

const COMMANDS = [
  "init",
  "start",
  "status",
  "earnings",
  "doctor",
  "run",
  "wallet",
  "jobs",
  "price",
  "test",
  "logs",
  "config",
  "pause",
  "resume",
  "completion",
];

export async function completionCommand(shell: string | undefined): Promise<void> {
  const target = (shell ?? process.env.SHELL?.split("/").pop() ?? "bash").toLowerCase();

  if (target.includes("zsh")) {
    console.log(`#compdef xorv
# Add to your shell:  xorv completion zsh > "\${fpath[1]}/_xorv"
_xorv() {
  local -a commands
  commands=(${COMMANDS.map((c) => `'${c}'`).join(" ")})
  _arguments '1: :->cmd' '*: :->args'
  case $state in
    cmd) _describe 'command' commands ;;
  esac
}
_xorv "$@"`);
    return;
  }

  if (target.includes("fish")) {
    console.log(`# Add to your shell:  xorv completion fish > ~/.config/fish/completions/xorv.fish
${COMMANDS.map((c) => `complete -c xorv -n __fish_use_subcommand -a ${c}`).join("\n")}`);
    return;
  }

  console.log(`# Add to your shell:  xorv completion bash >> ~/.bashrc
_xorv_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${COMMANDS.join(" ")}" -- "$cur") )
  fi
}
complete -F _xorv_completions xorv`);
}

// ---------------------------------------------------------------------------
// xorv cancel
// ---------------------------------------------------------------------------

export async function cancelCommand(jobId: string, opts: { broker?: string }): Promise<void> {
  const config = loadConfig();
  const brokerUrl = (
    opts.broker ?? (config ? resolveBrokerUrl(config) : "http://localhost:8402")
  ).replace(/\/+$/, "");

  const res = await fetch(`${brokerUrl}/api/jobs/${jobId}/cancel`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { error?: string; status?: string };
  ui.blank();
  if (!res.ok) {
    ui.bad(body.error ?? `broker returned ${res.status}`);
    process.exitCode = 1;
  } else {
    ui.ok(`cancelled ${jobId}`);
    ui.muted("  note: this does not refund — settlement already happened on-chain");
  }
  ui.blank();
}
