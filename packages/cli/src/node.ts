/**
 * The provider node.
 *
 * Registers with a broker, holds a control socket open, reports liveness, and
 * runs whatever work comes down the wire. Everything here is written to survive
 * a laptop: the socket reconnects with backoff, a lost broker doesn't lose
 * in-flight jobs' results, and a suspended machine rejoins rather than
 * duplicating itself (the node id is stable — see config.ts).
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import WebSocket from "ws";
import {
  HEARTBEAT_INTERVAL_MS,
  formatUsd,
  type Capability,
  type DispatchedJob,
  type JobEvent,
  type RegisterRequest,
} from "@xorv/protocol";
import { createAdapter } from "./adapters/index.js";
import { makeJobDir, removeJobDir, type JobAdapter } from "./adapters/base.js";
import { appendEarning, resolveBrokerUrl, type NodeConfig } from "./config.js";
import { isPaused } from "./commands/manage.js";

export interface RegisterResult {
  providerId: string;
  token: string;
  wsUrl: string;
  registry: { topicId: string; transactionId: string; hashscanUrl: string } | null;
  network: string;
  usdc: string;
}

export interface RunningJob {
  jobId: string;
  capabilityId: string;
  prompt: string;
  startedAt: number;
  priceUsdMicros: number;
  controller: AbortController;
  lastEvent?: string;
}

export interface NodeStats {
  jobsCompleted: number;
  jobsFailed: number;
  earnedUsdMicros: number;
  startedAt: number;
  connected: boolean;
  reconnects: number;
  lastHeartbeatAt: number | null;
  lastError: string | null;
}

/** Typed events the CLI's live view listens to. */
export interface ProviderNodeEvents {
  log: [{ level: "info" | "ok" | "warn" | "bad"; text: string }];
  state: [];
  jobStarted: [RunningJob];
  jobEvent: [{ jobId: string; event: JobEvent }];
  jobFinished: [{ jobId: string; ok: boolean; durationMs: number; usdMicros: number; error?: string }];
}

export class ProviderNode extends EventEmitter<ProviderNodeEvents> {
  readonly config: NodeConfig;
  private brokerUrl: string;
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = 1_000;
  private stopped = false;
  private adapters = new Map<string, JobAdapter>();

  providerId: string | null = null;
  token: string | null = null;
  registryReceipt: RegisterResult["registry"] = null;
  readonly running = new Map<string, RunningJob>();
  readonly stats: NodeStats = {
    jobsCompleted: 0,
    jobsFailed: 0,
    earnedUsdMicros: 0,
    startedAt: Date.now(),
    connected: false,
    reconnects: 0,
    lastHeartbeatAt: null,
    lastError: null,
  };
  /** Public URL of this node, when a tunnel is up. */
  publicUrl: string | null = null;
  private wasPaused = false;

  /** True while `xorv pause` is in effect. */
  get paused(): boolean {
    return this.wasPaused;
  }

  constructor(config: NodeConfig) {
    super();
    this.config = config;
    this.brokerUrl = resolveBrokerUrl(config);
    for (const capability of config.capabilities) {
      this.adapters.set(capability.id, createAdapter(capability.adapter));
    }
  }

  private log(level: "info" | "ok" | "warn" | "bad", text: string): void {
    this.emit("log", { level, text });
  }

  /** Announce this node to the broker and take its bearer token. */
  async register(endpoint: string): Promise<RegisterResult> {
    const body: RegisterRequest = {
      label: this.config.label,
      accountId: this.config.accountId,
      endpoint,
      capabilities: this.config.capabilities,
      version: VERSION,
      region: this.config.region ?? null,
      nodeId: this.config.nodeId,
    };

    const res = await fetch(`${this.brokerUrl}/api/providers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`registration failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const result = (await res.json()) as {
      provider: { id: string };
      token: string;
      wsUrl: string;
      registry: RegisterResult["registry"];
      network: string;
      usdc: string;
    };

    this.providerId = result.provider.id;
    this.token = result.token;
    this.registryReceipt = result.registry;

    return {
      providerId: result.provider.id,
      token: result.token,
      wsUrl: result.wsUrl,
      registry: result.registry,
      network: result.network,
      usdc: result.usdc,
    };
  }

  /** Open the control channel and start reporting in. */
  start(wsUrl: string): void {
    this.stopped = false;
    this.connect(wsUrl);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    void this.heartbeat();
  }

  private connect(wsUrl: string): void {
    if (this.stopped) return;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.stats.connected = true;
      this.backoffMs = 1_000;
      this.log("ok", "control channel open");
      this.emit("state");
    });

    ws.on("message", (raw) => {
      let message: { type: string; job?: DispatchedJob; jobId?: string; reason?: string };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        return;
      }
      if (message.type === "job.dispatch" && message.job) {
        void this.runJob(message.job);
      } else if (message.type === "job.cancel" && message.jobId) {
        const job = this.running.get(message.jobId);
        job?.controller.abort();
        this.log("warn", `job ${message.jobId} cancelled: ${message.reason ?? "no reason given"}`);
      }
    });

    ws.on("close", () => {
      this.stats.connected = false;
      this.emit("state");
      if (this.stopped) return;
      this.stats.reconnects += 1;
      // Exponential backoff, capped — a broker that's down for a while
      // shouldn't be hammered, and a node left running overnight should still
      // rejoin promptly when it comes back.
      this.log("warn", `control channel lost — retrying in ${Math.round(this.backoffMs / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.connect(wsUrl), this.backoffMs);
      this.reconnectTimer.unref?.();
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });

    ws.on("error", (err) => {
      this.stats.lastError = err instanceof Error ? err.message : String(err);
    });
  }

  private async heartbeat(): Promise<void> {
    if (!this.providerId || !this.token) return;
    // A paused node stays registered and keeps heartbeating — it just stops
    // advertising capacity, so the matcher skips it. Going offline instead
    // would drop it out of the fleet view and look like a crash.
    const paused = isPaused();
    const available: Record<string, boolean> = {};
    for (const capability of this.config.capabilities) {
      const running = [...this.running.values()].filter(
        (job) => job.capabilityId === capability.id,
      ).length;
      available[capability.id] =
        !paused && running < Math.max(1, capability.maxConcurrency);
    }
    if (paused !== this.wasPaused) {
      this.log(paused ? "warn" : "ok", paused ? "paused — not taking new jobs" : "resumed");
      this.wasPaused = paused;
    }

    try {
      const res = await fetch(`${this.brokerUrl}/api/providers/${this.providerId}/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          activeJobs: this.running.size,
          uptimeSeconds: Math.round((Date.now() - this.stats.startedAt) / 1000),
          available,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        this.stats.lastHeartbeatAt = Date.now();
        this.stats.lastError = null;
      } else if (res.status === 401 || res.status === 404) {
        // The broker restarted and forgot us. Re-register rather than beating
        // against a dead session forever.
        this.log("warn", "broker no longer recognises this node — re-registering");
        const endpoint = this.publicUrl ?? "local";
        const result = await this.register(endpoint).catch(() => null);
        if (result) {
          this.ws?.close();
          this.connect(result.wsUrl);
        }
      }
    } catch (err) {
      this.stats.lastError = err instanceof Error ? err.message : String(err);
    }
    this.emit("state");
  }

  private send(message: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run one dispatched job.
   *
   * Results are reported over the socket when it's up and over HTTP when it
   * isn't: the work is already done and the provider has already been paid, so
   * a dropped socket must not be the reason a poster never gets their answer.
   */
  private async runJob(dispatched: DispatchedJob): Promise<void> {
    const capability = this.config.capabilities.find((c) => c.id === dispatched.capabilityId);
    const adapter = this.adapters.get(dispatched.capabilityId);
    if (!capability || !adapter) {
      this.reportError(dispatched.jobId, `this node has no capability "${dispatched.capabilityId}"`, 0);
      return;
    }

    const controller = new AbortController();
    const job: RunningJob = {
      jobId: dispatched.jobId,
      capabilityId: dispatched.capabilityId,
      prompt: dispatched.prompt,
      startedAt: Date.now(),
      priceUsdMicros: dispatched.priceUsdMicros,
      controller,
    };
    this.running.set(job.jobId, job);
    this.send({ type: "job.accepted", jobId: job.jobId });
    this.emit("jobStarted", job);
    this.log("info", `job ${short(job.jobId)} → ${capability.displayName} (${formatUsd(dispatched.priceUsdMicros)})`);

    const timeout = setTimeout(() => controller.abort(), dispatched.timeoutMs);
    timeout.unref?.();

    fs.mkdirSync(this.config.sandboxDir, { recursive: true, mode: 0o700 });
    const cwd = makeJobDir(this.config.sandboxDir, job.jobId);

    const emit = (event: Omit<JobEvent, "at">): void => {
      const full: JobEvent = { ...event, at: Date.now() };
      job.lastEvent = event.text.slice(0, 120);
      this.emit("jobEvent", { jobId: job.jobId, event: full });
      if (!this.send({ type: "job.event", jobId: job.jobId, event: full })) {
        void this.postJson(`/api/jobs/${job.jobId}/events`, full);
      }
      this.emit("state");
    };

    try {
      const result = await adapter.run({
        prompt: dispatched.prompt,
        cwd,
        timeoutMs: dispatched.timeoutMs,
        signal: controller.signal,
        emit,
        model: capability.model ?? null,
      });

      const durationMs = Date.now() - job.startedAt;
      this.stats.jobsCompleted += 1;
      this.stats.earnedUsdMicros += dispatched.priceUsdMicros;

      if (!this.send({ type: "job.result", jobId: job.jobId, result, durationMs })) {
        await this.postJson(`/api/jobs/${job.jobId}/result`, { result, durationMs });
      }

      appendEarning({
        at: Date.now(),
        jobId: job.jobId,
        asset: "usdc",
        amount: String(dispatched.priceUsdMicros),
        usdMicros: dispatched.priceUsdMicros,
        durationMs,
        ok: true,
        adapter: capability.adapter,
      });

      this.log("ok", `job ${short(job.jobId)} done in ${(durationMs / 1000).toFixed(1)}s — earned ${formatUsd(dispatched.priceUsdMicros)}`);
      this.emit("jobFinished", {
        jobId: job.jobId,
        ok: true,
        durationMs,
        usdMicros: dispatched.priceUsdMicros,
      });
    } catch (err) {
      const durationMs = Date.now() - job.startedAt;
      const message = err instanceof Error ? err.message : String(err);
      this.stats.jobsFailed += 1;
      this.reportError(job.jobId, message, durationMs);
      this.log("bad", `job ${short(job.jobId)} failed: ${message.slice(0, 160)}`);
      this.emit("jobFinished", {
        jobId: job.jobId,
        ok: false,
        durationMs,
        usdMicros: 0,
        error: message,
      });
    } finally {
      clearTimeout(timeout);
      this.running.delete(job.jobId);
      removeJobDir(cwd);
      this.emit("state");
    }
  }

  private reportError(jobId: string, error: string, durationMs: number): void {
    if (!this.send({ type: "job.error", jobId, error, durationMs })) {
      void this.postJson(`/api/jobs/${jobId}/result`, { error, durationMs });
    }
  }

  private async postJson(path: string, body: unknown): Promise<void> {
    if (!this.token) return;
    try {
      await fetch(`${this.brokerUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Both channels are down. The job is lost to the poster; the broker's
      // own timeout sweeper will fail it and refund attention elsewhere.
    }
  }

  /** Which capabilities can actually run right now. */
  async probeCapabilities(): Promise<Array<{ capability: Capability; available: boolean }>> {
    return Promise.all(
      this.config.capabilities.map(async (capability) => ({
        capability,
        available: await (this.adapters.get(capability.id)?.available() ?? Promise.resolve(false)),
      })),
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const job of this.running.values()) job.controller.abort();
    this.ws?.close(1000, "node shutting down");
  }
}

function short(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

/** Kept in sync with package.json by the build; used in the registration. */
export const VERSION = "0.1.0";
