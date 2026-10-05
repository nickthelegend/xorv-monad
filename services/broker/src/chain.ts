/**
 * The chain side of the broker: the audit trail, and the money.
 *
 * Two responsibilities that both need the operator's key, kept together so
 * there is exactly one place in the process that can sign.
 *
 * ## One client, not two
 *
 * The Hedera version of this file ran two SDK clients on purpose, and the
 * comment explaining why was the longest in the codebase: the facilitator and
 * the audit writer could not share one, because `TopicMessageSubmitTransaction`
 * is chunked and re-freezes itself inside `executeAll`, so a concurrent
 * settlement mutating the client underneath it produced an intermittent
 * "transaction must have been frozen" on a call that succeeded in isolation.
 *
 * viem clients hold no per-transaction state. Both jobs use the same wallet
 * client, and the class of bug is gone rather than worked around. What remains
 * is ordinary nonce management, which the RPC handles.
 */

import {
  appendEntrySafe,
  envelope,
  explorerAddress,
  explorerTx,
  logAddress,
  operatorWallet,
  readClient,
  type LogHeartbeat,
  type PrivyPolicy,
  type LogJobReceipt,
  type LogMessageKind,
  type LogProviderRegistered,
  type Provider,
} from "@xorv/protocol";
import type { PublicClient, WalletClient } from "viem";
import type { BrokerConfig } from "./config.js";

/**
 * How long after a write background readers keep waiting. A write is several
 * RPC calls (gas price, nonce, send, receipt polls) and the rate limit counts
 * the burst for a few seconds after it ends.
 */
const WRITE_COOLDOWN_MS = 5_000;

/** Longest a single write can hold background readers off: RPC retries included. */
const MAX_WRITE_MS = 120_000;

/** viem's short message plus the RPC's own reason, without the request dump. */
export function summarizeError(err: Error): string {
  const e = err as Error & { shortMessage?: string; details?: string };
  const head = e.shortMessage ?? err.message.split("\n")[0] ?? err.message;
  return e.details && !head.includes(e.details) ? `${head} (${e.details})` : head;
}

export interface PublishResult {
  contract: string;
  transactionHash: string;
  explorerUrl: string;
  blockNumber?: string;
}

/**
 * What the HTTP layer actually needs from the chain.
 *
 * Stated as an interface so the app can be booted against a stub in tests. The
 * alternative — reaching for the real `Chain` — means every integration test
 * needs a funded account and a network round-trip, which is a good way to end
 * up with no integration tests at all.
 */
export interface ChainLike {
  readonly network: string;
  readonly operatorAddress: string;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly signerMode?: string;
  readonly signerDescription?: string;
  readonly signerPolicy?: PrivyPolicy | null;
  readonly policyRefusals?: ReadonlyArray<{ at: string; to: string | null; reason: string }>;
  describeLog(): { address: string; url: string } | null;
  counts(): { registry: number; heartbeat: number; receipts: number };
  lastPublishError(): string | null;
  /**
   * True while the broker is writing to the chain, or just finished. Background
   * readers (the log index) check it and wait, so they never spend the RPC's
   * rate budget out from under a settlement or an audit entry.
   */
  writing?(): boolean;
  /** Mark a write the chain class doesn't make itself (a facilitator settle). */
  noteWrite?(phase: "start" | "end"): void;
  publishRegistration(provider: Provider): Promise<PublishResult | null>;
  publishHeartbeat(data: LogHeartbeat): Promise<PublishResult | null>;
  publishReceipt(data: LogJobReceipt): Promise<PublishResult | null>;
  close(): void;
}

export class Chain implements ChainLike {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly network: string;
  readonly operatorAddress: string;
  /** Who signs: "local key", a Privy server wallet, or PRIVY MOCK MODE. */
  readonly signerMode: string;
  readonly signerDescription: string;
  /** The policy the operator runs under, when Privy (or its mock) signs. */
  readonly signerPolicy: PrivyPolicy | null;
  /** Transactions the policy refused, newest last, for /api/network. */
  readonly policyRefusals: Array<{ at: string; to: string | null; reason: string }> = [];
  private readonly contract: string | null;
  /** Publish failures, kept for /api/network so a misconfig is visible. */
  private lastError: string | null = null;
  private published = { registry: 0, heartbeat: 0, receipts: 0 };
  private inFlight = 0;
  private lastStartAt = 0;
  private lastWriteAt = 0;

  constructor(config: BrokerConfig) {
    this.network = config.network;
    this.operatorAddress = config.operatorAddress;
    this.contract = config.logAddress ?? logAddress();
    this.publicClient = readClient(config.network);
    const signer = config.signer ?? { mode: "key" as const };
    const op = operatorWallet(
      signer,
      {
        network: config.network,
        escrow: config.escrowAddress,
        log: this.contract,
        registry: config.registryAddress,
      },
      config.operatorKey,
      {
        onVerdict: (v, tx) => {
          if (v.allowed) return;
          this.policyRefusals.push({ at: new Date().toISOString(), to: tx.to ?? null, reason: v.reason });
          if (this.policyRefusals.length > 20) this.policyRefusals.shift();
          console.warn(`[broker] Privy policy refused a transaction to ${tx.to}: ${v.reason}`);
        },
      },
    );
    this.walletClient = op.wallet;
    this.signerMode = signer.mode;
    this.signerDescription = op.description;
    this.signerPolicy = op.policy;
  }

  /** The log contract plus its block-explorer link, for the network panel. */
  describeLog(): { address: string; url: string } | null {
    return this.contract
      ? { address: this.contract, url: explorerAddress(this.network, this.contract) }
      : null;
  }

  counts(): { registry: number; heartbeat: number; receipts: number } {
    return { ...this.published };
  }

  lastPublishError(): string | null {
    return this.lastError;
  }

  writing(): boolean {
    const now = Date.now();
    // A write whose end was never reported (a hook that didn't fire) stops
    // counting after a while, so it can't pause background readers for good.
    const active = this.inFlight > 0 && now - this.lastStartAt < MAX_WRITE_MS;
    return active || now - this.lastWriteAt < WRITE_COOLDOWN_MS;
  }

  noteWrite(phase: "start" | "end"): void {
    if (phase === "start") {
      this.inFlight += 1;
      this.lastStartAt = Date.now();
    } else {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastWriteAt = Date.now();
    }
  }

  private async publish(
    kind: LogMessageKind,
    subject: string,
    data: unknown,
    counter: keyof typeof this.published,
  ): Promise<PublishResult | null> {
    const contract = this.contract;
    this.noteWrite("start");
    const result = await appendEntrySafe(
      { wallet: this.walletClient, public: this.publicClient },
      contract,
      kind,
      subject,
      envelope(kind, data),
      (err) => {
        // /api/network is public: the one-line reason, not viem's full dump of
        // calldata and request arguments. The log keeps the whole stack.
        this.lastError = `${kind}: ${summarizeError(err)}`;
        console.error(`[broker] audit ${kind} publish failed:`, err.stack ?? err.message);
      },
    ).finally(() => this.noteWrite("end"));
    if (!result || !contract) return null;
    this.published[counter] += 1;
    return {
      contract,
      transactionHash: result.transactionHash,
      explorerUrl: explorerTx(this.network, result.transactionHash),
      blockNumber: result.blockNumber,
    };
  }

  /** Announce a provider joining the network. */
  async publishRegistration(provider: Provider): Promise<PublishResult | null> {
    const data: LogProviderRegistered = {
      providerId: provider.id,
      label: provider.label.slice(0, 64),
      address: provider.address,
      capabilities: provider.capabilities.map((c) => ({
        id: c.id,
        adapter: c.adapter,
        priceUsdMicros: c.priceUsdMicros,
      })),
      version: provider.version,
    };
    return this.publish("provider.registered", provider.id, data, "registry");
  }

  /**
   * Record a liveness beat.
   *
   * Not every beat: at one entry per provider per 15s this would be several
   * thousand transactions a day per node, which is noise rather than evidence —
   * and unlike a Hedera topic message, every one of them costs gas. The caller samples (see
   * `HEARTBEAT_PUBLISH_EVERY`) so the log carries a periodic, checkable proof of
   * uptime without paying to write a heartbeat nobody will ever read.
   */
  async publishHeartbeat(data: LogHeartbeat): Promise<PublishResult | null> {
    return this.publish("provider.heartbeat", data.providerId, data, "heartbeat");
  }

  /** Record what a job paid, and to whom. */
  async publishReceipt(data: LogJobReceipt): Promise<PublishResult | null> {
    return this.publish("job.receipt", data.jobId, data, "receipts");
  }

  close(): void {
    // viem clients hold an HTTP transport with no long-lived socket to release.
    // Kept on the interface so the shutdown path is identical across chains.
  }
}
