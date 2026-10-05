/**
 * `xorv status` — what the network looks like from here.
 *
 * Reads the broker rather than local state, so it answers the question an
 * operator actually has ("is my node visible to buyers, and who am I competing
 * with?") rather than the one their own process could answer alone.
 */

import { formatAgo, formatUsd, networkInfo, networkLabel } from "@xorv/protocol";
import { loadConfig, resolveBrokerUrl } from "../config.js";
import * as ui from "../ui.js";

interface NetworkInfo {
  network: string;
  facilitator: { mode: string; description: string; feePayer: string };
  operator: { address: string; url: string };
  stablecoins?: Array<{ symbol: string; address: string }>;
  log: { address: string; url: string } | null;
  logPublished: { registry: number; heartbeat: number; receipts: number };
  stats: {
    providersLive: number;
    providersConnected: number;
    capacity: number;
    jobsTotal: number;
    jobsCompleted: number;
    paidUsdMicros: number;
  };
}

interface ProviderInfo {
  id: string;
  label: string;
  address: string;
  status: string;
  connected: boolean;
  activeJobs: number;
  capabilities: Array<{ displayName: string; priceUsdMicros: number; adapter: string }>;
  lastHeartbeatAt: number;
  uptimeSeconds: number;
  region: string | null;
  stats: { jobsCompleted: number; jobsFailed: number; earnedUsdcMicros: number };
}

export async function statusCommand(opts: { broker?: string; json?: boolean }): Promise<void> {
  const config = loadConfig();
  const brokerUrl = (opts.broker ?? (config ? resolveBrokerUrl(config) : "http://localhost:8402")).replace(
    /\/+$/,
    "",
  );

  const spin = opts.json ? null : ui.spinner(`reading ${brokerUrl}…`);
  let network: NetworkInfo;
  let providers: ProviderInfo[];
  try {
    const [networkRes, providersRes] = await Promise.all([
      fetch(`${brokerUrl}/api/network`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${brokerUrl}/api/providers`, { signal: AbortSignal.timeout(10_000) }),
    ]);
    if (!networkRes.ok) throw new Error(`broker returned ${networkRes.status}`);
    network = (await networkRes.json()) as NetworkInfo;
    providers = ((await providersRes.json()) as { providers: ProviderInfo[] }).providers;
  } catch (err) {
    spin?.fail(`could not reach the broker at ${brokerUrl}`);
    if (opts.json) {
      console.log(JSON.stringify({ error: String(err) }, null, 2));
    } else {
      ui.muted(`  ${err instanceof Error ? err.message : String(err)}`);
      ui.blank();
      ui.info(`start one with ${ui.c.accent("pnpm broker")}, or pass ${ui.c.accent("--broker <url>")}`);
    }
    process.exitCode = 1;
    return;
  }
  spin?.stop();

  if (opts.json) {
    console.log(JSON.stringify({ network, providers }, null, 2));
    return;
  }

  console.log(ui.banner(`network status · ${networkLabel(network.network)}`));

  // -- the network ----------------------------------------------------------

  console.log(
    ui.box(
      ui.kv([
        ["network", `${networkInfo(network.network).name} ${ui.c.muted(`· ${network.network}`)}`],
        [
          "paid in",
          (network.stablecoins ?? [])
            .map((t, i) => `${i === 0 ? ui.c.bold(t.symbol) : t.symbol} ${ui.c.muted(t.address)}`)
            .join(ui.c.muted(" · ")) || ui.c.muted("—"),
        ],
        ["facilitator", `${network.facilitator.description} ${ui.c.muted(`· ETH gas paid by ${network.facilitator.feePayer}`)}`],
        ["providers", `${ui.c.ok(String(network.stats.providersLive))} live ${ui.c.muted(`· ${network.stats.providersConnected} connected · ${network.stats.capacity} capabilities`)}`],
        ["jobs", `${network.stats.jobsCompleted} completed ${ui.c.muted(`of ${network.stats.jobsTotal}`)}`],
        ["settled", ui.c.money(formatUsd(network.stats.paidUsdMicros))],
      ]),
      { title: "network" },
    ),
  );

  // -- the audit trail ------------------------------------------------------

  // One contract with three indexed streams, where Hedera had three separate
  // topics. Same three counters, so an operator reads this the same way.
  ui.heading("on-chain audit log");
  const streamRows = Object.entries(network.logPublished).map(([stream, count]) => [
    network.log ? ui.glyph.chain() : ui.glyph.off(),
    stream,
    String(count),
  ]);
  console.log(
    ui.table(
      [{ header: "" }, { header: "stream" }, { header: "written", align: "right" }],
      streamRows,
    ),
  );
  ui.muted(
    network.log
      ? `  ${network.log.address}  ${network.log.url}`
      : "  no audit contract configured — nothing is being recorded on chain",
  );

  // -- providers ------------------------------------------------------------

  ui.heading(`providers (${providers.length})`);
  if (providers.length === 0) {
    ui.muted("  nobody is online. Start one with `xorv start`.");
    ui.blank();
    return;
  }

  const mine = config?.providerId;
  const rows = providers.map((p) => {
    const dot =
      p.status === "online" ? ui.glyph.live() : p.status === "busy" ? ui.glyph.idle() : ui.glyph.off();
    const cheapest = p.capabilities.reduce(
      (min, c) => Math.min(min, c.priceUsdMicros),
      Number.POSITIVE_INFINITY,
    );
    const label = p.id === mine ? `${ui.c.bold(p.label)} ${ui.c.accent("(you)")}` : p.label;
    return [
      dot,
      label,
      ui.c.muted(p.capabilities.map((c) => c.adapter).join(", ").slice(0, 30)),
      Number.isFinite(cheapest) ? ui.c.money(formatUsd(cheapest)) : ui.c.muted("—"),
      String(p.stats.jobsCompleted),
      ui.c.money(formatUsd(p.stats.earnedUsdcMicros)),
      ui.c.muted(formatAgo(p.lastHeartbeatAt)),
    ];
  });

  console.log(
    ui.table(
      [
        { header: "" },
        { header: "provider" },
        { header: "sells" },
        { header: "from", align: "right" },
        { header: "jobs", align: "right" },
        { header: "earned", align: "right" },
        { header: "last beat", align: "right" },
      ],
      rows,
    ),
  );
  ui.blank();
}
