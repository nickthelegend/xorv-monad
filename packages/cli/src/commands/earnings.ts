/**
 * `xorv earnings` — what this machine has actually made.
 *
 * Reads the local append-only ledger written as each job settles, so it works
 * with the broker down and with no network at all. The authoritative record is
 * on Monad — the USDC transfer to the payout address, and the XorvLedger
 * receipt that names it; this is the operator's own copy, and the balance at
 * the bottom is read live from the chain.
 */

import {
  explorerAddress,
  fetchBalances,
  formatDuration,
  formatMon,
  formatUsd,
  formatUsdc,
  networkLabel,
} from "@xorv/protocol";
import { loadConfig, readEarnings, type EarningRow, type NodeConfig } from "../config.js";
import * as ui from "../ui.js";

export async function earningsCommand(opts: { json?: boolean; limit?: string }): Promise<void> {
  // The local ledger outlives any one config: a Hedera-era config should not
  // stop an operator reading what they earned under it.
  let config: NodeConfig | null = null;
  try {
    config = loadConfig();
  } catch {
    config = null;
  }
  const rows = readEarnings(Number(opts.limit ?? 500) || 500);

  if (opts.json) {
    console.log(JSON.stringify({ rows, total: total(rows) }, null, 2));
    return;
  }

  console.log(ui.banner("earnings"));

  if (rows.length === 0) {
    console.log(
      ui.box(
        [
          `${ui.glyph.money()} ${ui.c.bold("no jobs yet")}`,
          "",
          `  Run ${ui.c.accent("xorv start")} and leave it running.`,
          `  Every completed job appends a line here.`,
        ],
        { title: "earnings", color: ui.BRAND.slate },
      ),
    );
    ui.blank();
    return;
  }

  const ok = rows.filter((r) => r.ok);
  const failed = rows.filter((r) => !r.ok);
  const totalMicros = total(rows);
  const now = Date.now();
  const day = 86_400_000;
  const last24h = ok.filter((r) => now - r.at < day);
  const last7d = ok.filter((r) => now - r.at < 7 * day);

  // -- headline -------------------------------------------------------------

  console.log(
    ui.box(
      ui.kv([
        ["lifetime", ui.c.bold(ui.c.money(formatUsd(totalMicros)))],
        ["last 7 days", ui.c.money(formatUsd(total(last7d)))],
        ["last 24 hours", ui.c.money(formatUsd(total(last24h)))],
        ["jobs", `${ui.c.ok(String(ok.length))} completed ${failed.length ? ui.c.bad(`· ${failed.length} failed`) : ""}`],
        [
          "avg duration",
          ok.length
            ? formatDuration(ok.reduce((sum, r) => sum + r.durationMs, 0) / ok.length)
            : ui.c.muted("—"),
        ],
        [
          "avg per job",
          ok.length ? ui.c.money(formatUsd(Math.round(totalMicros / ok.length))) : ui.c.muted("—"),
        ],
      ]),
      { title: "totals" },
    ),
  );

  // -- daily shape ----------------------------------------------------------

  const days = 14;
  const buckets = new Array(days).fill(0) as number[];
  for (const row of ok) {
    const age = Math.floor((now - row.at) / day);
    if (age < days) buckets[days - 1 - age] = (buckets[days - 1 - age] ?? 0) + row.usdMicros;
  }
  if (buckets.some((v) => v > 0)) {
    ui.heading(`last ${days} days`);
    console.log(
      `  ${ui.sparkline(buckets)}  ${ui.c.muted(`peak ${formatUsd(Math.max(...buckets))}/day`)}`,
    );
  }

  // -- by adapter -----------------------------------------------------------

  const byAdapter = new Map<string, { count: number; micros: number }>();
  for (const row of ok) {
    const key = row.adapter ?? "unknown";
    const entry = byAdapter.get(key) ?? { count: 0, micros: 0 };
    entry.count += 1;
    entry.micros += row.usdMicros;
    byAdapter.set(key, entry);
  }
  if (byAdapter.size > 0) {
    ui.heading("by capability");
    const max = Math.max(...[...byAdapter.values()].map((e) => e.micros), 1);
    console.log(
      ui.table(
        [
          { header: "adapter" },
          { header: "jobs", align: "right" },
          { header: "earned", align: "right" },
          { header: "share" },
        ],
        [...byAdapter.entries()]
          .sort((a, b) => b[1].micros - a[1].micros)
          .map(([adapter, entry]) => [
            adapter,
            String(entry.count),
            ui.c.money(formatUsd(entry.micros)),
            ui.meter(entry.micros / max, 16),
          ]),
      ),
    );
  }

  const legacyRows = rows.filter((r) => r.asset === "hbar").length;
  if (legacyRows > 0) {
    ui.muted(`  includes ${legacyRows} job(s) from the Hedera prototype, paid in HBAR — totals are in USD either way`);
  }

  // -- recent ---------------------------------------------------------------

  ui.heading("recent jobs");
  console.log(
    ui.table(
      [
        { header: "when" },
        { header: "job" },
        { header: "adapter" },
        { header: "took", align: "right" },
        { header: "earned", align: "right" },
      ],
      rows
        .slice(-12)
        .reverse()
        .map((row) => [
          ui.c.muted(new Date(row.at).toLocaleString()),
          row.jobId.slice(0, 14),
          ui.c.muted(row.adapter ?? "—"),
          formatDuration(row.durationMs),
          row.ok ? ui.c.money(formatUsd(row.usdMicros)) : ui.c.bad("failed"),
        ]),
    ),
  );

  // -- on-chain balance -----------------------------------------------------

  if (config?.address) {
    ui.heading("on-chain");
    const spin = ui.spinner(`checking ${config.address}…`);
    try {
      const balances = await fetchBalances(config.network, config.address);
      spin.stop();
      console.log(
        ui.box(
          ui.kv([
            ["address", `${config.address} ${ui.c.muted(`(Monad ${networkLabel(config.network)})`)}`],
            ["usdc", ui.c.money(formatUsdc(balances.usdcUnits))],
            ["mon", formatMon(balances.monWei)],
            ["explorer", ui.c.muted(explorerAddress(config.network, config.address))],
          ]),
          { title: "wallet", color: ui.BRAND.mint },
        ),
      );
    } catch {
      spin.stop();
      ui.warn("  couldn't reach the Monad RPC for the live balance");
    }
  }
  ui.blank();
}

function total(rows: EarningRow[]): number {
  return rows.filter((r) => r.ok).reduce((sum, r) => sum + r.usdMicros, 0);
}
