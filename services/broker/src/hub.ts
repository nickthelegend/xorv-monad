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
    this.wss = new WebSocketServer({ noServer: true });

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
      let message: UpMessage;
      try {
        message = JSON.parse(String(raw)) as UpMessage;
      } catch {
        return;
      }
      this.handle(providerId, message);
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
