/**
 * `xorv start` — go live.
 *
 * Brings up the node, registers, opens the control channel, optionally raises a
 * Cloudflare tunnel, and then hands the terminal over to a live dashboard that
 * repaints in place while jobs come and go.
 */

import {
  formatAgo,
  formatDuration,
  formatUsd,
  explorerAddress,
  networkLabel,
} from "@xorv/protocol";
import { requireConfig, resolveBrokerUrl } from "../config.js";
import { ProviderNode, type RunningJob } from "../node.js";
import { sweepJobDirs } from "../adapters/base.js";
import { startLocalServer } from "../local-server.js";
import { CLOUDFLARED_INSTALL_HINT, cloudflaredAvailable, startTunnel } from "../tunnel.js";
import * as ui from "../ui.js";

interface StartOptions {
  broker?: string;
  tunnel?: boolean;
  port?: string;
  quiet?: boolean;
}

export async function startCommand(opts: StartOptions): Promise<void> {
  const config = requireConfig();
  if (opts.broker) config.brokerUrl = opts.broker;
  const brokerUrl = resolveBrokerUrl(config);

  console.log(ui.banner(`${config.label} · ${networkLabel(config.network)}`));

  const swept = sweepJobDirs(config.sandboxDir);
  if (swept > 0) ui.info(`removed ${swept} job director${swept === 1 ? "y" : "ies"} left by a previous run`);

  const node = new ProviderNode(config);
  const logLines: Array<{ level: string; text: string; at: number }> = [];
  node.on("log", ({ level, text }) => {
    logLines.push({ level, text, at: Date.now() });
    if (logLines.length > 200) logLines.shift();
    // Off a terminal nothing repaints, so each entry is printed once, as it happens.
    if (!process.stdout.isTTY) {
      console.log(`${new Date().toISOString()} ${level} ${ui.stripAnsi(text)}`);
    }
  });

  // -- preflight ------------------------------------------------------------

  const probe = ui.spinner("checking what this node can actually run…");
  const probed = await node.probeCapabilities();
  const ready = probed.filter((p) => p.available);
  if (ready.length === 0) {
    probe.fail("none of this node's capabilities are runnable right now");
    ui.blank();
    for (const { capability } of probed) {
      ui.bad(`  ${capability.displayName} — the underlying CLI isn't installed, or isn't signed in`);
    }
    ui.blank();
    ui.info(`run ${ui.c.accent("xorv doctor")} for the specifics, or ${ui.c.accent("xorv init")} to re-pick`);
    process.exitCode = 1;
    return;
  }
  probe.succeed(
    `${ready.length}/${probed.length} capabilities ready — ${ready.map((r) => r.capability.displayName).join(", ")}`,
  );

  // -- local face + optional tunnel ----------------------------------------

  const port = Number(opts.port ?? 0) || 0;
  const local = await startLocalServer(node, port);
  ui.ok(`node status page on ${ui.c.muted(`http://localhost:${local.port}`)}`);

  let stopTunnel: (() => void) | null = null;
  let endpoint = `http://localhost:${local.port}`;

  const wantsTunnel = opts.tunnel ?? config.tunnel.enabled;
  if (wantsTunnel) {
    if (!(await cloudflaredAvailable())) {
      ui.warn(`cloudflared isn't installed — running without a public URL`);
      ui.muted(`  ${CLOUDFLARED_INSTALL_HINT}`);
    } else {
      const spin = ui.spinner("raising a Cloudflare tunnel…");
      try {
        const tunnel = await startTunnel(local.port);
        stopTunnel = tunnel.stop;
        endpoint = tunnel.url;
        node.publicUrl = tunnel.url;
        spin.succeed(`public at ${ui.c.accent(tunnel.url)}`);
      } catch (err) {
        spin.fail(`tunnel failed: ${err instanceof Error ? err.message : String(err)}`);
        ui.muted("  job delivery doesn't need it — carrying on over the control socket");
      }
    }
  }

  // -- register -------------------------------------------------------------

  const reg = ui.spinner(`registering with ${brokerUrl}…`);
  let wsUrl: string;
  try {
    const result = await node.register(endpoint);
    wsUrl = result.wsUrl;
    reg.succeed(`registered as ${ui.c.bold(result.providerId)}`);
    if (result.registry) {
      ui.ok(
        `${ui.glyph.chain()} registration recorded on chain ${ui.c.muted(result.registry.contract)}`,
      );
      ui.muted(`  ${result.registry.explorerUrl}`);
    }
  } catch (err) {
    reg.fail(`registration failed: ${err instanceof Error ? err.message : String(err)}`);
    ui.blank();
    ui.info(`is the broker running? ${ui.c.accent("pnpm broker")} in the xorv repo`);
    local.close();
    stopTunnel?.();
    process.exitCode = 1;
    return;
  }

  node.start(wsUrl);

  // -- live dashboard -------------------------------------------------------

  ui.blank();
  const region = ui.liveRegion();
  const interactive = Boolean(process.stdout.isTTY);
  const paint = (): void => region.render(dashboard(node, logLines, endpoint));

  // A terminal gets a dashboard repainted in place. Anything else — a service
  // manager, a log file, `xorv start > node.log` — has no screen to repaint:
  // the old fallback reprinted the footer line every second, thousands of
  // identical lines an hour burying the real events. There the dashboard is
  // printed once and log entries stream as they happen (above).
  const ticker = interactive ? setInterval(paint, 1_000) : null;
  ticker?.unref?.();
  if (interactive) {
    node.on("state", paint);
    node.on("jobStarted", paint);
    node.on("jobFinished", paint);
    paint();
  } else {
    for (const line of dashboard(node, logLines, endpoint)) console.log(ui.stripAnsi(line));
  }

  const shutdown = (): void => {
    if (ticker) clearInterval(ticker);
    region.done();
    ui.blank();
    ui.info("shutting down…");
    node.stop();
    local.close();
    stopTunnel?.();
    ui.blank();
    console.log(
      ui.box(
        [
          `${ui.glyph.money()} ${ui.c.bold("session summary")}`,
          "",
          ...ui.kv([
            ["jobs done", String(node.stats.jobsCompleted)],
            ["jobs failed", String(node.stats.jobsFailed)],
            ["earned", ui.c.money(formatUsd(node.stats.earnedUsdMicros))],
            ["uptime", formatDuration(Date.now() - node.stats.startedAt)],
          ]),
        ],
        { title: "offline", color: ui.BRAND.slate },
      ),
    );
    ui.blank();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Build the whole repainted block. */
function dashboard(
  node: ProviderNode,
  logLines: Array<{ level: string; text: string; at: number }>,
  endpoint: string,
): string[] {
  const width = ui.width();
  const lines: string[] = [];
  const uptime = formatDuration(Date.now() - node.stats.startedAt);

  // Status strip
  const dot = node.stats.connected ? ui.glyph.live() : ui.glyph.idle();
  const state = node.stats.connected
    ? ui.c.ok("LIVE")
    : node.stats.reconnects > 0
      ? ui.c.warn("RECONNECTING")
      : ui.c.muted("CONNECTING");
  const beat = node.stats.lastHeartbeatAt
    ? ui.c.muted(`beat ${formatAgo(node.stats.lastHeartbeatAt)}`)
    : ui.c.muted("no beat yet");
  lines.push(
    `${dot} ${ui.c.bold(state)}  ${ui.c.muted("│")} ${ui.c.bold(node.config.label)}  ${ui.c.muted("│")} ${beat}  ${ui.c.muted("│")} up ${uptime}`,
  );

  // Earnings strip
  lines.push(
    `${ui.glyph.money()} earned ${ui.c.money(ui.c.bold(formatUsd(node.stats.earnedUsdMicros)))}` +
      `  ${ui.c.muted("│")} ${ui.c.ok(String(node.stats.jobsCompleted))} done` +
      `  ${ui.c.muted("│")} ${node.stats.jobsFailed > 0 ? ui.c.bad(String(node.stats.jobsFailed)) : ui.c.muted("0")} failed` +
      `  ${ui.c.muted("│")} ${ui.c.accent(String(node.running.size))} running`,
  );
  lines.push(ui.c.muted("─".repeat(width)));

  // Capabilities
  lines.push(ui.c.muted("  selling"));
  for (const capability of node.config.capabilities) {
    const active = [...node.running.values()].filter(
      (j) => j.capabilityId === capability.id,
    ).length;
    const busy = active > 0 ? ui.c.accent(`${active} running`) : ui.c.muted("idle");
    lines.push(
      `  ${ui.glyph.dot()} ${capability.displayName.padEnd(28)} ${ui.c.money(formatUsd(capability.priceUsdMicros).padStart(9))}  ${busy}`,
    );
  }

  // Running jobs
  if (node.running.size > 0) {
    lines.push("");
    lines.push(ui.c.muted("  in flight"));
    for (const job of node.running.values()) {
      lines.push(...renderRunningJob(job, width));
    }
  }

  // Log tail
  lines.push("");
  lines.push(ui.c.muted("  recent"));
  const tail = logLines.slice(-6);
  if (tail.length === 0) {
    lines.push(ui.c.muted("  waiting for work…"));
  }
  for (const entry of tail) {
    const mark =
      entry.level === "ok"
        ? ui.glyph.ok()
        : entry.level === "bad"
          ? ui.glyph.bad()
          : entry.level === "warn"
            ? ui.glyph.warn()
            : ui.glyph.dot();
    const text = ui.stripAnsi(entry.text).slice(0, width - 16);
    lines.push(`  ${mark} ${ui.c.muted(new Date(entry.at).toLocaleTimeString())} ${text}`);
  }

  lines.push("");
  lines.push(
    ui.c.muted(
      `  payout ${node.config.address} · ${endpoint.replace(/^https?:\/\//, "")} · ctrl-c to stop`,
    ),
  );
  return lines;
}

function renderRunningJob(job: RunningJob, width: number): string[] {
  const elapsed = Date.now() - job.startedAt;
  const head = `  ${ui.glyph.bolt()} ${ui.c.bold(job.jobId.slice(0, 14))} ${ui.c.muted(job.capabilityId)} ${ui.c.money(formatUsd(job.priceUsdMicros))} ${ui.c.muted(formatDuration(elapsed))}`;
  const detail = job.lastEvent
    ? `      ${ui.c.muted(ui.stripAnsi(job.lastEvent).slice(0, width - 10))}`
    : `      ${ui.c.muted("starting…")}`;
  return [head, detail];
}
