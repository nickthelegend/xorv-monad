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
  isValidEncryptTo,
  sameAddress,
  sealResult,
  shortHex,
  type Capability,
  type DispatchedJob,
  type JobEvent,
  type RegisterRequest,
  type RegisterResponse,
} from "@xorv/protocol";
import { createAdapter } from "./adapters/index.js";
import { makeJobDir, removeJobDir, type JobAdapter } from "./adapters/base.js";
import { appendEarning, payoutAddress, resolveBrokerUrl, type NodeConfig } from "./config.js";
import { isPaused } from "./commands/manage.js";

/** What the broker's `/api/providers/register` hands back, as the node uses it. */
export interface RegisterResult {
  providerId: string;
  token: string;
  wsUrl: string;
  /**
   * The XorvLedger `registerProvider` write, when the broker has already made
   * it. Null when the ledger is not configured or the write is still queued —
   * the broker batches ledger writes and never blocks registration on one.
   */
  registry: NonNullable<RegisterResponse["registry"]> | null;
  /** The broker's CAIP-2 network — must equal this node's, or no payment verifies. */
  network: string;
  /** The stablecoin contract the broker prices in (USDC's address). */
  usdc: string | null;
  /** The ERC-8004 agent id the broker registered this node under, if any. */
  agentId: string | null;
}

export interface RunningJob {
  jobId: string;
  capabilityId: string;
  prompt: string;
  startedAt: number;
  priceUsdMicros: number;
  controller: AbortController;
  lastEvent?: string;
  /** A private job: its result is sealed to the buyer's passkey before it leaves this node. */
  sealed?: boolean;
}

/** How often a private job may send the broker a coarse progress line. */
const PRIVATE_PROGRESS_MS = 2_000;

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
  /** A registration succeeded; `xorv start` saves the token so a restart can present it. */
  registered: [{ providerId: string; token: string }];
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
  private reregistering = false;
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

  /**
   * Longest this node waits for a live session under its own node id to go
   * offline before retrying registration once (the broker says how long).
   */
  liveSessionWaitMaxMs = 60_000;

  /**
   * Announce this node to the broker and take its bearer token.
   *
   * The broker only lets the node id alone claim a slot nobody holds. When a
   * session for this node id is still live, re-registering needs that
   * session's token, so the node presents the one it holds (this process's,
   * or the one the last run saved to config). A node restarted without it
   * gets a 409 `node_live` naming when the old session goes offline, and
   * waits for that once rather than failing to start.
   */
  async register(endpoint: string): Promise<RegisterResult> {
    const body: RegisterRequest = {
      label: this.config.label,
      address: payoutAddress(this.config),
      agentId: this.config.agentId ?? null,
      endpoint,
      capabilities: this.config.capabilities,
      version: VERSION,
      region: this.config.region ?? null,
      nodeId: this.config.nodeId,
    };

    let res = await this.postRegistration(body);
    if (res.status === 409) {
      const refusal = (await res
        .clone()
        .json()
        .catch(() => null)) as { code?: string; retryAfterMs?: number } | null;
      if (refusal?.code === "node_live") {
        const wait = Math.min(Math.max(Number(refusal.retryAfterMs) || 0, 1_000), this.liveSessionWaitMaxMs);
        this.log("warn", `the broker still holds a live session for this node id — retrying in ${Math.ceil(wait / 1000)}s`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        res = await this.postRegistration(body);
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`registration failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const result = (await res.json()) as RegisterResponse & {
      wsUrl: string;
      network?: string;
      usdc?: string | { address?: string } | null;
    };

    this.providerId = result.provider.id;
    this.token = result.token;
    this.registryReceipt = result.registry ?? null;
    this.emit("registered", { providerId: result.provider.id, token: result.token });

    const usdc = typeof result.usdc === "string" ? result.usdc : (result.usdc?.address ?? null);
    return {
      providerId: result.provider.id,
      token: result.token,
      wsUrl: result.wsUrl,
      registry: result.registry ?? null,
      network: result.network ?? this.config.network,
      usdc,
      agentId: result.registry?.agentId ?? result.provider.agentId ?? null,
    };
  }

  private postRegistration(body: RegisterRequest): Promise<Response> {
    const token = this.token ?? this.config.token ?? null;
    return fetch(`${this.brokerUrl}/api/providers/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
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
        // One at a time: a registration can wait out a live session (see
        // `register`), and the next beats must not pile more on top.
        if (this.reregistering) return;
        this.reregistering = true;
        try {
          this.log("warn", "broker no longer recognises this node — re-registering");
          const endpoint = this.publicUrl ?? "local";
          const result = await this.register(endpoint).catch((err: unknown) => {
            this.stats.lastError = err instanceof Error ? err.message : String(err);
            return null;
          });
          if (result) {
            this.ws?.close();
            this.connect(result.wsUrl);
          }
        } finally {
          this.reregistering = false;
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
   *
   * A private job (`encryptTo` set) runs the same adapter, but what leaves
   * this machine changes: the result is sealed to the buyer's passkey-derived
   * inbox key before it is reported, the broker hears only coarse status
   * lines while it runs (no reasoning, no streamed text, no tool calls), and a
   * failure is reported without the adapter's own message, which can quote the
   * prompt or a partial answer. The operator's own live view still shows
   * everything: the provider necessarily sees the job it runs; the point is
   * that the broker, its database and its public API never see the result.
   */
  private async runJob(dispatched: DispatchedJob): Promise<void> {
    const capability = this.config.capabilities.find((c) => c.id === dispatched.capabilityId);
    const adapter = this.adapters.get(dispatched.capabilityId);
    if (!capability || !adapter) {
      this.reportError(dispatched.jobId, `this node has no capability "${dispatched.capabilityId}"`, 0);
      return;
    }
    const sealTo = dispatched.encryptTo ?? null;
    if (sealTo !== null && !isValidEncryptTo(sealTo)) {
      // Refuse before running: a private job we cannot seal must not produce a
      // plaintext result that then has nowhere safe to go.
      this.reportError(dispatched.jobId, "private job carries an invalid encryptTo key, so it was not run", 0);
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
      sealed: sealTo !== null,
    };
    this.running.set(job.jobId, job);
    this.send({ type: "job.accepted", jobId: job.jobId });
    this.emit("jobStarted", job);
    this.log(
      "info",
      `job ${short(job.jobId)} → ${capability.displayName} (${formatUsd(dispatched.priceUsdMicros)})` +
        (sealTo ? " · private, result sealed to the buyer" : ""),
    );

    const timeout = setTimeout(() => controller.abort(), dispatched.timeoutMs);
    timeout.unref?.();

    fs.mkdirSync(this.config.sandboxDir, { recursive: true, mode: 0o700 });
    const cwd = makeJobDir(this.config.sandboxDir, job.jobId);

    const forward = (event: JobEvent): void => {
      if (!this.send({ type: "job.event", jobId: job.jobId, event })) {
        void this.postJson(`/api/jobs/${job.jobId}/events`, event);
      }
    };
    const status = (text: string): JobEvent => ({ kind: "status", text, at: Date.now() });

    // For a private job the broker gets a step counter, at most every couple
    // of seconds: enough for the buyer to see it is alive, nothing about what
    // it is doing.
    let privateSteps = 0;
    let lastProgressAt = 0;
    if (sealTo) forward(status("private job: the result is sealed to the buyer's passkey before it leaves the provider"));

    const emit = (event: Omit<JobEvent, "at">): void => {
      const full: JobEvent = { ...event, at: Date.now() };
      job.lastEvent = event.text.slice(0, 120);
      this.emit("jobEvent", { jobId: job.jobId, event: full });
      if (!sealTo) {
        forward(full);
      } else {
        privateSteps += 1;
        if (full.at - lastProgressAt >= PRIVATE_PROGRESS_MS) {
          lastProgressAt = full.at;
          forward(status(`working privately · ${privateSteps} step${privateSteps === 1 ? "" : "s"}`));
        }
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

      // Sealed here, on the provider, the moment the adapter returns: the
      // plaintext never crosses the wire, and the broker's receipt hash
      // commits to exactly these ciphertext bytes.
      const reported = sealTo ? sealResult(sealTo, result, job.jobId) : result;
      if (sealTo) forward(status("result sealed to the buyer (X25519 → AES-256-GCM)"));

      const durationMs = Date.now() - job.startedAt;
      const earned = receivedFor(dispatched, payoutAddress(this.config));
      this.stats.jobsCompleted += 1;
      this.stats.earnedUsdMicros += earned.usdMicros;

      if (!this.send({ type: "job.result", jobId: job.jobId, result: reported, durationMs })) {
        await this.postJson(`/api/jobs/${job.jobId}/result`, { result: reported, durationMs });
      }

      appendEarning({
        at: Date.now(),
        jobId: job.jobId,
        asset: "usdc",
        // micro-USD and USDC's smallest unit are the same integer (6 decimals).
        amount: String(earned.usdMicros),
        usdMicros: earned.usdMicros,
        durationMs,
        ok: true,
        ...(earned.transactionId ? { transactionId: earned.transactionId } : {}),
        adapter: capability.adapter,
      });

      this.log(
        "ok",
        `job ${short(job.jobId)} done in ${(durationMs / 1000).toFixed(1)}s — ` +
          (earned.paidTo === null || earned.usdMicros > 0
            ? `earned ${formatUsd(earned.usdMicros)}`
            : `unpaid: reassigned here after the buyer paid ${shortHex(earned.paidTo)}`),
      );
      this.emit("jobFinished", {
        jobId: job.jobId,
        ok: true,
        durationMs,
        usdMicros: earned.usdMicros,
      });
    } catch (err) {
      const durationMs = Date.now() - job.startedAt;
      const message = err instanceof Error ? err.message : String(err);
      this.stats.jobsFailed += 1;
      this.reportError(job.jobId, sealTo ? privateFailure(controller.signal) : message, durationMs);
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

/**
 * What this node was actually paid for a job it completed.
 *
 * Payment settles upfront, to the quoted provider. When the broker says who it
 * paid, that is the answer: the settled amount (with its transaction) when it
 * was this node's payout address, nothing when it was another provider's — a
 * job reassigned here after that provider failed it. A broker that does not
 * say leaves the quoted price, which is what every job earned before
 * reassignment existed.
 */
export function receivedFor(
  dispatched: Pick<DispatchedJob, "priceUsdMicros" | "payment">,
  payout: string,
): { usdMicros: number; transactionId: string | null; paidTo: string | null } {
  const payment = dispatched.payment;
  if (!payment) return { usdMicros: dispatched.priceUsdMicros, transactionId: null, paidTo: null };
  if (!sameAddress(payment.payTo, payout)) return { usdMicros: 0, transactionId: null, paidTo: payment.payTo };
  // USDC's smallest unit is a micro-dollar (6 decimals).
  return { usdMicros: Number(payment.amount), transactionId: payment.txHash, paidTo: payment.payTo };
}

function short(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

/**
 * What the broker is told when a private job fails. An adapter's error text
 * can quote the prompt, a partial answer or a tool's output, all of which the
 * buyer asked to keep off the broker, so only the kind of failure travels;
 * the full message stays in the operator's own log.
 */
export function privateFailure(signal: AbortSignal): string {
  return signal.aborted
    ? "private job stopped (cancelled or timed out)"
    : "private job failed on the provider (details stay on the provider for private jobs)";
}

/** Kept in sync with package.json; sent in the registration and shown by `--version`. */
export const VERSION = "0.2.0";
