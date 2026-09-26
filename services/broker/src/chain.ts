/**
 * The Hedera side of the broker: the audit trail, and the money.
 *
 * Two responsibilities that both need the operator's key, kept together so
 * there is exactly one Hedera client in the process.
 */

import { type Client, type PrivateKey } from "@hiero-ledger/sdk";
import {
  envelope,
  hashscanTopic,
  hashscanTx,
  hederaClient,
  submitMessageSafe,
  type HcsHeartbeat,
  type HcsJobReceipt,
  type HcsProviderRegistered,
  type Provider,
} from "@xorv/protocol";
import type { BrokerConfig } from "./config.js";

export interface PublishResult {
  topicId: string;
  transactionId: string;
  hashscanUrl: string;
  sequenceNumber?: string;
}

/**
 * What the HTTP layer actually needs from the chain.
 *
 * Stated as an interface so the app can be booted against a stub in tests. The
 * alternative — reaching for the real `Chain` — means every integration test
 * needs Hedera credentials, a network round-trip and real HBAR, which is a good
 * way to end up with no integration tests at all.
 */
export interface ChainLike {
  readonly network: string;
  readonly operatorId: string;
  readonly settlementClient: Client;
  describeTopics(): Record<string, { id: string; url: string } | null>;
  counts(): { registry: number; heartbeat: number; receipts: number };
  lastPublishError(): string | null;
  publishRegistration(provider: Provider): Promise<PublishResult | null>;
  publishHeartbeat(data: HcsHeartbeat): Promise<PublishResult | null>;
  publishReceipt(data: HcsJobReceipt): Promise<PublishResult | null>;
  close(): void;
}

export class Chain implements ChainLike {
  /** Client for the audit trail (HCS writes). */
  readonly client: Client;
  /**
   * A second, dedicated client for payment settlement.
   *
   * The facilitator and the HCS writer must not share one SDK client. They ran
   * on the same one at first, and the symptom was ugly and intermittent: a
   * receipt published seconds after a settlement would fail with "transaction
   * must have been frozen", while the identical call in isolation succeeded.
   * `TopicMessageSubmitTransaction` is chunked and re-freezes itself inside
   * `executeAll`, so it is sensitive to client state being mutated underneath it
   * by a concurrent execute — which, on the settlement path, is exactly what
   * happens.
   *
   * Two clients cost two gRPC connection pools and remove the whole class of
   * problem. Money and audit have no reason to share mutable state anyway.
   */
  readonly settlementClient: Client;
  readonly network: string;
  readonly operatorId: string;
  readonly operatorKey: PrivateKey;
  private readonly topics: BrokerConfig["topics"];
  /** Publish failures, kept for /api/network so a misconfig is visible. */
  private lastError: string | null = null;
  private published = { registry: 0, heartbeat: 0, receipts: 0 };

  constructor(config: BrokerConfig) {
    this.network = config.network;
    this.operatorId = config.operatorId;
    this.operatorKey = config.operatorKey;
    this.topics = config.topics;
    this.client = hederaClient(config.network, config.operatorId, config.operatorKey);
    this.settlementClient = hederaClient(config.network, config.operatorId, config.operatorKey);
  }

  /** Topic ids plus their HashScan links, for the network panel. */
  describeTopics(): Record<string, { id: string; url: string } | null> {
    const describe = (id: string | null) =>
      id ? { id, url: hashscanTopic(this.network, id) } : null;
    return {
      registry: describe(this.topics.registry),
      heartbeat: describe(this.topics.heartbeat),
      receipts: describe(this.topics.receipts),
    };
  }

  counts(): { registry: number; heartbeat: number; receipts: number } {
    return { ...this.published };
  }

  lastPublishError(): string | null {
    return this.lastError;
  }

  private async publish(
    topicId: string | null,
    kind: Parameters<typeof envelope>[0],
    data: unknown,
    counter: keyof typeof this.published,
  ): Promise<PublishResult | null> {
    const result = await submitMessageSafe(this.client, topicId, envelope(kind, data), (err) => {
      this.lastError = `${kind}: ${err.message}`;
      // Keep the stack for the operator; the message alone ("cannot read
      // properties of undefined") is unactionable when it comes from deep
      // inside the SDK.
      console.error(`[broker] HCS ${kind} publish failed:`, err.stack ?? err.message);
    });
    if (!result) return null;
    this.published[counter] += 1;
    return {
      topicId: result.topicId,
      transactionId: result.transactionId,
      hashscanUrl: hashscanTx(this.network, result.transactionId),
      sequenceNumber: result.sequenceNumber,
    };
  }

  /** Announce a provider joining the network. */
  async publishRegistration(provider: Provider): Promise<PublishResult | null> {
    const data: HcsProviderRegistered = {
      providerId: provider.id,
      label: provider.label.slice(0, 64),
      accountId: provider.accountId,
      capabilities: provider.capabilities.map((c) => ({
        id: c.id,
        adapter: c.adapter,
        priceUsdMicros: c.priceUsdMicros,
      })),
      version: provider.version,
    };
    return this.publish(this.topics.registry, "provider.registered", data, "registry");
  }

  /**
   * Record a liveness beat.
   *
   * Not every beat: at one message per provider per 15s this would be several
   * thousand transactions a day per node, which is noise rather than evidence.
   * The caller samples (see `HEARTBEAT_PUBLISH_EVERY`) so the topic carries a
   * periodic, checkable proof of uptime without paying to write a heartbeat
   * nobody will ever read.
   */
  async publishHeartbeat(data: HcsHeartbeat): Promise<PublishResult | null> {
    return this.publish(this.topics.heartbeat, "provider.heartbeat", data, "heartbeat");
  }

  /** Record what a job paid, and to whom. */
  async publishReceipt(data: HcsJobReceipt): Promise<PublishResult | null> {
    return this.publish(this.topics.receipts, "job.receipt", data, "receipts");
  }

  close(): void {
    this.client.close();
    this.settlementClient.close();
  }
}
