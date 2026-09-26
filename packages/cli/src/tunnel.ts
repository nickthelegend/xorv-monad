/**
 * Cloudflare Tunnel integration.
 *
 * A Xorv node does **not** need a tunnel to earn: job delivery rides the
 * outbound control socket the node opens to the broker, which works from behind
 * NAT with no inbound ports (see hub.ts for why that shape was chosen). The
 * tunnel is an optional extra that gives the node a public URL, which buys two
 * real things:
 *
 *   - anyone can health-check the node directly, so "is this provider actually
 *     there?" is answerable without trusting the broker;
 *   - the broker gains a second delivery path when a socket is flapping.
 *
 * It uses `cloudflared`'s quick-tunnel mode, which needs no Cloudflare account
 * — one binary, one flag, a public `*.trycloudflare.com` hostname in seconds.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { cliAvailable } from "./adapters/base.js";

export interface Tunnel {
  url: string;
  stop(): void;
}

export async function cloudflaredAvailable(): Promise<boolean> {
  return cliAvailable("cloudflared", ["--version"]);
}

export const CLOUDFLARED_INSTALL_HINT =
  "brew install cloudflared  (or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)";

/**
 * Start a quick tunnel to a local port and resolve once its hostname appears.
 *
 * cloudflared announces the URL on stderr, in a box, some time after start —
 * there is no "ready" signal to wait on other than that line, so this watches
 * for it and gives up after `timeoutMs` rather than hanging a node startup on a
 * tunnel that will never come up.
 */
export function startTunnel(port: number, timeoutMs = 30_000): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(
        "cloudflared",
        ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let settled = false;
    let buffer = "";

    const finish = (tunnel: Tunnel): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(tunnel);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      reject(err);
    };

    const timer = setTimeout(
      () => fail(new Error(`cloudflared did not report a URL within ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
    timer.unref?.();

    const scan = (chunk: Buffer): void => {
      buffer = (buffer + chunk.toString()).slice(-8_000);
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        finish({
          url: match[0],
          stop: () => {
            try {
              child.kill("SIGTERM");
            } catch {
              /* already gone */
            }
          },
        });
      }
    };

    child.stderr?.on("data", scan);
    child.stdout?.on("data", scan);

    child.on("error", (err) =>
      fail(
        new Error(
          `could not start cloudflared: ${err.message}. Install it with: ${CLOUDFLARED_INSTALL_HINT}`,
        ),
      ),
    );

    child.on("close", (code) => {
      if (!settled) fail(new Error(`cloudflared exited ${code} before reporting a URL`));
    });
  });
}
