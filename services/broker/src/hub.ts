/**
 * The control channel between the broker and provider nodes.
 *
 * Provider nodes hold an outbound WebSocket to the broker rather than the
 * broker calling *in* to them. That inverts the usual marketplace shape for a
 * reason: someone sharing their laptop's Claude subscription is behind NAT, on
 * hotel wifi, on a machine that sleeps. An outbound socket works from all of
 * those with no port forwarding, no tunnel, and no inbound attack surface on
 * their machine.
 *
 * A Cloudflare tunnel is still supported and still useful — it gives the node a
 * public URL for health checks and direct access — but job delivery does not
 * depend on it, so a provider whose tunnel drops keeps earning.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import type { DispatchedJob, JobEvent } from "@xorv/protocol";
import type { Registry } from "./registry.js";

/** Broker → node. */
export type DownMessage =
  | { type: "welcome"; providerId: string; brokerEpoch: number }
  | { type: "job.dispatch"; job: DispatchedJob }
  | { type: "job.cancel"; jobId: string; reason: string }
  | { type: "pong"; at: number };

/** Node → broker. */
export type UpMessage =
  | { type: "job.event"; jobId: string; event: JobEvent }
  | { type: "job.result"; jobId: string; result: string; durationMs: number }
  | { type: "job.error"; jobId: string; error: string; durationMs: number }
  | { type: "job.accepted"; jobId: string }
  | { type: "ping"; at: number };

/**
 * The largest frame a node may send (a job result is the big one). ws
 * defaults to 100 MiB, which one socket could make the broker buffer.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const EVENT_KINDS = new Set<JobEvent["kind"]>(["status", "message", "tool_call", "file_edit", "error", "reasoning"]);

/**
 * Parse one frame from a node, or null when it is not a well-formed
 * `UpMessage`. Frames come from any registered node, and registration is
 * open, so nothing here trusts the shape: `null`, an array or a message whose
 * fields have the wrong types would otherwise throw inside the ws listener,
 * where nothing catches it, and take the whole broker down.
 */
export function parseUpMessage(raw: string): UpMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  const jobId = typeof m.jobId === "string" && m.jobId.length > 0 && m.jobId.length <= 128 ? m.jobId : null;
  const durationMs = typeof m.durationMs === "number" && Number.isFinite(m.durationMs) ? Math.max(0, m.durationMs) : null;
  switch (m.type) {
    case "ping":
      return { type: "ping", at: typeof m.at === "number" && Number.isFinite(m.at) ? m.at : 0 };
    case "job.accepted":
      return jobId ? { type: "job.accepted", jobId } : null;
    case "job.result":
      return jobId && typeof m.result === "string" && durationMs !== null
        ? { type: "job.result", jobId, result: m.result, durationMs }
        : null;
    case "job.error":
      return jobId && typeof m.error === "string" && durationMs !== null
        ? { type: "job.error", jobId, error: m.error, durationMs }
        : null;
    case "job.event": {
      const e = m.event;
      if (!jobId || !e || typeof e !== "object" || Array.isArray(e)) return null;
      const ev = e as Record<string, unknown>;
      if (typeof ev.kind !== "string" || !EVENT_KINDS.has(ev.kind as JobEvent["kind"]) || typeof ev.text !== "string") {
        return null;
      }
      const at = typeof ev.at === "number" && Number.isFinite(ev.at) ? ev.at : 0;
      return { type: "job.event", jobId, event: { at, kind: ev.kind as JobEvent["kind"], text: ev.text } };
    }
    default:
      return null;
  }
}

export interface HubHandlers {
  onEvent(providerId: string, jobId: string, event: JobEvent): void;
  onResult(providerId: string, jobId: string, result: string, durationMs: number): void;
  onError(providerId: string, jobId: string, error: string, durationMs: number): void;
  onAccepted(providerId: string, jobId: string): void;
  onConnect(providerId: string): void;
  onDisconnect(providerId: string): void;
}

export class Hub {
  private wss: WebSocketServer;
  private sockets = new Map<string, WebSocket>();
  readonly epoch = Date.now();

  constructor(
    server: Server,
    private readonly registry: Registry,
    private readonly handlers: HubHandlers,
  ) {
    // `noServer` + a manual upgrade hook, so the HTTP app and the socket share
    // one port and Hono keeps serving every non-/ws path untouched.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws/provider") {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get("token") ?? "";
      const provider = this.registry.byAuthToken(token);
      if (!provider) {
        // 401 before the handshake completes: an unauthenticated socket never
        // gets far enough to send us a frame.
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.attach(ws, provider.id, req);
      });
    });
  }

  private attach(ws: WebSocket, providerId: string, _req: IncomingMessage): void {
    // One socket per provider. A reconnect after a network blip would otherwise
    // leave the stale socket registered and jobs dispatched into a black hole.
    this.sockets.get(providerId)?.close(4000, "superseded by a newer connection");
    this.sockets.set(providerId, ws);
    this.handlers.onConnect(providerId);

    this.send(providerId, { type: "welcome", providerId, brokerEpoch: this.epoch });

    ws.on("message", (raw) => {
      const message = parseUpMessage(String(raw));
      if (!message) return;
      // A handler that throws must not escape into ws, which does not catch
      // listener errors: that would be an uncaught exception, and the broker
      // exits on those.
      try {
        this.handle(providerId, message);
      } catch (err) {
        console.error(`[broker] frame from ${providerId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    ws.on("close", () => {
      if (this.sockets.get(providerId) === ws) {
        this.sockets.delete(providerId);
        this.handlers.onDisconnect(providerId);
      }
    });

    ws.on("error", () => {
      /* close fires next; nothing useful to add here */
    });
  }

  private handle(providerId: string, message: UpMessage): void {
    switch (message.type) {
      case "job.event":
        this.handlers.onEvent(providerId, message.jobId, message.event);
        break;
      case "job.result":
        this.handlers.onResult(providerId, message.jobId, message.result, message.durationMs);
        break;
      case "job.error":
        this.handlers.onError(providerId, message.jobId, message.error, message.durationMs);
        break;
      case "job.accepted":
        this.handlers.onAccepted(providerId, message.jobId);
        break;
      case "ping":
        this.send(providerId, { type: "pong", at: Date.now() });
        break;
    }
  }

  /**
   * Close a provider's control channel, if it has one. Used when its token is
   * replaced: a socket authenticates once, at the upgrade, so without this the
   * holder of the old token would keep receiving that provider's jobs.
   */
  disconnect(providerId: string, reason: string): void {
    const ws = this.sockets.get(providerId);
    if (!ws) return;
    this.sockets.delete(providerId);
    ws.close(4001, reason.slice(0, 120));
    this.handlers.onDisconnect(providerId);
  }

  /** True when this provider currently holds a live control channel. */
  isConnected(providerId: string): boolean {
    return this.sockets.get(providerId)?.readyState === 1;
  }

  connectedCount(): number {
    return [...this.sockets.values()].filter((ws) => ws.readyState === 1).length;
  }

  /** Send to a node; false when it isn't connected. */
  send(providerId: string, message: DownMessage): boolean {
    const ws = this.sockets.get(providerId);
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    for (const ws of this.sockets.values()) ws.close(1001, "broker shutting down");
    this.sockets.clear();
    this.wss.close();
  }
}
