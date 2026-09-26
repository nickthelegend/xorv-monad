/**
 * Prometheus metrics.
 *
 * Hand-rolled rather than pulled from a client library, for the same reason the
 * CLI's colour code is hand-rolled: the exposition format is a dozen lines of
 * text, and a broker that handles money should carry as few dependencies as it
 * can justify.
 *
 * Counters only ever go up, gauges are sampled at scrape time from the real
 * registry and job store, so there is no second copy of the truth to drift.
 */

import type { JobStore } from "./jobs.js";
import type { Registry } from "./registry.js";
import type { ChainLike } from "./chain.js";

export class Metrics {
  private counters = new Map<string, number>();
  private histograms = new Map<string, number[]>();
  readonly startedAt = Date.now();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = seriesKey(name, labels);
    const samples = this.histograms.get(key) ?? [];
    samples.push(value);
    // Bounded: this is a summary, not an archive. Keeping the most recent
    // window is what makes the quantiles mean anything anyway.
    if (samples.length > 1_000) samples.splice(0, samples.length - 1_000);
    this.histograms.set(key, samples);
  }

  /** Render the exposition format, sampling live gauges as we go. */
  render(deps: { registry: Registry; jobs: JobStore; chain: ChainLike; connected: number }): string {
    const lines: string[] = [];

    const help = (name: string, text: string, type: "counter" | "gauge" | "summary"): void => {
      lines.push(`# HELP ${name} ${text}`);
      lines.push(`# TYPE ${name} ${type}`);
    };

    help("xorv_uptime_seconds", "Broker uptime.", "gauge");
    lines.push(`xorv_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`);

    const providers = deps.registry.list();
    help("xorv_providers", "Providers by status.", "gauge");
    for (const status of ["online", "busy", "offline"] as const) {
      lines.push(
        `xorv_providers{status="${status}"} ${providers.filter((p) => p.status === status).length}`,
      );
    }

    help("xorv_providers_connected", "Providers holding a control socket.", "gauge");
    lines.push(`xorv_providers_connected ${deps.connected}`);

    help("xorv_capacity", "Advertised capabilities across live providers.", "gauge");
    lines.push(
      `xorv_capacity ${deps.registry.live().reduce((n, p) => n + p.capabilities.length, 0)}`,
    );

    const jobs = deps.jobs.list({ limit: 10_000 });
    help("xorv_jobs", "Jobs by status.", "gauge");
    const byStatus = new Map<string, number>();
    for (const job of jobs) byStatus.set(job.status, (byStatus.get(job.status) ?? 0) + 1);
    for (const [status, count] of byStatus) {
      lines.push(`xorv_jobs{status="${status}"} ${count}`);
    }

    help("xorv_settled_usd_micros_total", "Total settled, in micro-USD.", "counter");
    lines.push(
      `xorv_settled_usd_micros_total ${jobs
        .filter((j) => j.payment)
        .reduce((sum, j) => sum + (j.priceUsdMicros ?? 0), 0)}`,
    );

    const hcs = deps.chain.counts();
    help("xorv_hcs_messages_total", "Messages published to Hedera Consensus Service.", "counter");
    for (const [topic, count] of Object.entries(hcs)) {
      lines.push(`xorv_hcs_messages_total{topic="${topic}"} ${count}`);
    }

    for (const [key, value] of this.counters) {
      const { name } = parseKey(key);
      if (!lines.some((l) => l.startsWith(`# TYPE ${name} `))) {
        help(name, "Xorv counter.", "counter");
      }
      lines.push(`${key} ${value}`);
    }

    for (const [key, samples] of this.histograms) {
      if (samples.length === 0) continue;
      const { name, labelPart } = parseKey(key);
      help(`${name}_seconds`, "Xorv duration summary.", "summary");
      const sorted = [...samples].sort((a, b) => a - b);
      for (const q of [0.5, 0.9, 0.99]) {
        const value = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
        const labels = labelPart ? `${labelPart.slice(0, -1)},quantile="${q}"}` : `{quantile="${q}"}`;
        lines.push(`${name}_seconds${labels} ${(value / 1000).toFixed(3)}`);
      }
      lines.push(`${name}_seconds_count${labelPart} ${samples.length}`);
      lines.push(
        `${name}_seconds_sum${labelPart} ${(samples.reduce((a, b) => a + b, 0) / 1000).toFixed(3)}`,
      );
    }

    return `${lines.join("\n")}\n`;
  }
}

function seriesKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return name;
  const rendered = entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",");
  return `${name}{${rendered}}`;
}

function parseKey(key: string): { name: string; labelPart: string } {
  const brace = key.indexOf("{");
  if (brace === -1) return { name: key, labelPart: "" };
  return { name: key.slice(0, brace), labelPart: key.slice(brace) };
}

/** Prometheus label values can't carry raw backslashes, quotes or newlines. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
