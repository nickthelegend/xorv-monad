/**
 * The node's own little HTTP face.
 *
 * This is what a Cloudflare tunnel points at. It exposes liveness and what the
 * node is selling, and nothing else — no job payloads, no results, no keys.
 * Anyone on the internet can hit it, so it is read-only by construction: there
 * is no route here that changes anything.
 */

import http from "node:http";
import { formatUsd } from "@xorv/protocol";
import type { ProviderNode } from "./node.js";

export interface LocalServer {
  port: number;
  close(): void;
}

export function startLocalServer(node: ProviderNode, port: number): Promise<LocalServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        providerId: node.providerId,
        connected: node.stats.connected,
        activeJobs: node.running.size,
        uptimeSeconds: Math.round((Date.now() - node.stats.startedAt) / 1000),
      });
    }

    if (url.pathname === "/info") {
      return json(res, 200, {
        label: node.config.label,
        providerId: node.providerId,
        accountId: node.config.accountId,
        network: node.config.network,
        region: node.config.region,
        capabilities: node.config.capabilities.map((c) => ({
          id: c.id,
          adapter: c.adapter,
          displayName: c.displayName,
          model: c.model,
          priceUsdMicros: c.priceUsdMicros,
          priceLabel: formatUsd(c.priceUsdMicros),
          maxConcurrency: c.maxConcurrency,
        })),
        stats: {
          jobsCompleted: node.stats.jobsCompleted,
          jobsFailed: node.stats.jobsFailed,
          activeJobs: node.running.size,
        },
      });
    }

    if (url.pathname === "/") {
      return html(res, page(node));
    }

    return json(res, 404, { error: "not found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Bind to loopback only: the tunnel reaches it from this machine, and a
    // node with no tunnel should not be quietly listening on the LAN.
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({
        port: actual,
        close: () => server.close(),
      });
    });
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

/** A small dark status page, matching the rest of the brand. */
function page(node: ProviderNode): string {
  const uptime = Math.round((Date.now() - node.stats.startedAt) / 1000);
  const rows = node.config.capabilities
    .map(
      (c) => `<tr>
        <td>${escapeHtml(c.displayName)}</td>
        <td class="mono">${escapeHtml(c.adapter)}</td>
        <td class="mono right">${escapeHtml(formatUsd(c.priceUsdMicros))}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(node.config.label)} · Xorv node</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:48px 24px; background:#08080c; color:#e8e9f0;
         font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:640px; margin:0 auto; }
  .mark { font-size:12px; letter-spacing:.34em; text-transform:uppercase;
          background:linear-gradient(90deg,#7c5cff,#3ddcff); -webkit-background-clip:text;
          background-clip:text; color:transparent; font-weight:700; }
  h1 { margin:.4em 0 .1em; font-size:28px; letter-spacing:-.02em; }
  .sub { color:#7f869c; margin:0 0 32px; }
  .pill { display:inline-flex; align-items:center; gap:8px; padding:5px 12px; border-radius:999px;
          font-size:13px; border:1px solid #22242e; background:#101119; }
  .dot { width:8px; height:8px; border-radius:50%; background:${node.stats.connected ? "#50f0c8" : "#ffb84c"}; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin:28px 0; }
  .card { border:1px solid #1c1e28; background:#0d0e14; border-radius:12px; padding:14px 16px; }
  .card .k { font-size:11px; text-transform:uppercase; letter-spacing:.1em; color:#6d738a; }
  .card .v { font-size:22px; font-weight:600; margin-top:4px; }
  table { width:100%; border-collapse:collapse; margin-top:8px; }
  th,td { text-align:left; padding:9px 10px; border-bottom:1px solid #1a1c25; font-size:14px; }
  th { color:#6d738a; font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
  .right { text-align:right; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:#9aa1b8; font-size:13px; }
  a { color:#3ddcff; }
  footer { margin-top:36px; color:#575d72; font-size:13px; }
</style></head><body><div class="wrap">
  <div class="mark">Xorv provider node</div>
  <h1>${escapeHtml(node.config.label)}</h1>
  <p class="sub">Selling idle AI capacity, paid per job in USDC over x402 on Hedera.</p>
  <span class="pill"><span class="dot"></span>${node.stats.connected ? "connected to the network" : "reconnecting"}</span>
  <div class="grid">
    <div class="card"><div class="k">Jobs done</div><div class="v">${node.stats.jobsCompleted}</div></div>
    <div class="card"><div class="k">Running</div><div class="v">${node.running.size}</div></div>
    <div class="card"><div class="k">Earned</div><div class="v">${escapeHtml(formatUsd(node.stats.earnedUsdMicros))}</div></div>
    <div class="card"><div class="k">Uptime</div><div class="v">${uptime < 3600 ? `${Math.round(uptime / 60)}m` : `${(uptime / 3600).toFixed(1)}h`}</div></div>
  </div>
  <table><thead><tr><th>Capability</th><th>Adapter</th><th class="right">Price / job</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <footer>Payouts to <span class="mono">${escapeHtml(node.config.accountId)}</span> on ${escapeHtml(node.config.network)}.
  <br>Run your own: <span class="mono">npm i -g @xorv/cli &amp;&amp; xorv init</span></footer>
</div></body></html>`;
}
