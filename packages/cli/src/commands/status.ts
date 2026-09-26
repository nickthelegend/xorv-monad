/**
 * `xorv status` — what the network looks like from here.
 *
 * Reads the broker rather than local state, so it answers the question an
 * operator actually has ("is my node visible to buyers, and who am I competing
 * with?") rather than the one their own process could answer alone.
 */

import {
  explorerAddress,
  formatAgo,
  formatUsd,
  networkLabel,
  shortHex,
  type LedgerEventKind,
  type NetworkInfo,
  type PublicProvider,
} from "@xorv/protocol";
import { loadConfig, resolveBrokerUrl, type NodeConfig } from "../config.js";
import * as ui from "../ui.js";

/** The feeds XorvLedger publishes, in the order an operator reads them. */
const FEEDS: Array<[LedgerEventKind, string]> = [
  ["registrations", "ProviderRegistered"],
  ["heartbeats", "ProviderHeartbeat"],
  ["receipts", "JobRecorded"],
  ["ratings", "JobRated"],
];

export async function statusCommand(opts: { broker?: string; json?: boolean }): Promise<void> {
  // Status reads the broker, not the node; a stale (e.g. Hedera-era) config
  // should not stop anyone from looking at the network.
  let config: NodeConfig | null = null;
  try {
    config = loadConfig();
  } catch {
    config = null;
  }
  const brokerUrl = (opts.broker ?? (config ? resolveBrokerUrl(config) : "http://localhost:8402")).replace(
    /\/+$/,
    "",
  );

  const spin = opts.json ? null : ui.spinner(`reading ${brokerUrl}…`);
  let network: NetworkInfo;
  let providers: PublicProvider[];
  try {
    const [networkRes, providersRes] = await Promise.all([
      fetch(`${brokerUrl}/api/network`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`${brokerUrl}/api/providers`, { signal: AbortSignal.timeout(10_000) }),
    ]);
    if (!networkRes.ok) throw new Error(`broker returned ${networkRes.status}`);
    network = (await networkRes.json()) as NetworkInfo;
    providers = ((await providersRes.json()) as { providers: PublicProvider[] }).providers;
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

  const rows: Array<[string, string]> = [
    ["network", `Monad ${network.label ?? networkLabel(network.network)} ${ui.c.muted(`· ${network.network}`)}`],
    ["usdc", `${network.usdc.address} ${ui.c.muted(explorerAddress(network.network, network.usdc.address))}`],
    [
      "facilitator",
      `${network.facilitator.description}${network.facilitator.address ? ` ${ui.c.muted(`· gas paid by ${shortHex(network.facilitator.address)}`)}` : ""}`,
    ],
    ["identity", ui.c.muted(`ERC-8004 registry ${network.erc8004.identity}`)],
  ];
  const ai = network.ai
    ? (
        [
          ["router", network.ai.router],
          ["screener", network.ai.screener],
          ["verifier", network.ai.verifier],
        ] as const
      )
        .filter(([, role]) => role)
        .map(([name, role]) => `${name} ${ui.c.bold(role!.model)}`)
    : [];
  if (ai.length) rows.push(["ai", ai.join(ui.c.muted(" · "))]);
  rows.push(
    ["providers", `${ui.c.ok(String(network.stats.providersLive))} live ${ui.c.muted(`· ${network.stats.providersConnected} connected · ${network.stats.capacity} capabilities`)}`],
    ["jobs", `${network.stats.jobsCompleted} completed ${ui.c.muted(`of ${network.stats.jobsTotal}`)}`],
    ["settled", ui.c.money(formatUsd(network.stats.paidUsdMicros))],
  );
  console.log(ui.box(ui.kv(rows), { title: "network" }));

  // -- the audit trail ------------------------------------------------------

  ui.heading("on-chain audit log");
  if (!network.ledger) {
    ui.muted("  this broker has no XorvLedger configured — payments settle on-chain, receipts stay off-chain");
  } else {
    ui.muted(`  XorvLedger ${network.ledger.address}  ${network.ledger.url}`);
    console.log(
      ui.table(
        [{ header: "" }, { header: "feed" }, { header: "event" }, { header: "sent", align: "right" }],
        FEEDS.map(([kind, event]) => [
          ui.glyph.chain(),
          kind,
          ui.c.muted(event),
          String(network.published?.[kind] ?? 0),
        ]),
      ),
    );
    if (network.lastPublishError) ui.warn(`  last ledger write failed: ${network.lastPublishError}`);
  }

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
      p.agentId ? ui.c.accent(`#${p.agentId}`) : ui.c.muted("—"),
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
        { header: "agent" },
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
