/**
 * A tiny driver over envio's createTestIndexer: queue events grouped into transactions,
 * then flush them through the `simulate` source. Each transaction gets its own block,
 * a strictly increasing timestamp and a deterministic tx hash, which is what the handlers
 * key on (JobRated links to the NewFeedback of the same tx hash).
 */

import { createTestIndexer, type TestIndexerProcessConfig } from "envio";
import { keccak256, toBytes, toHex } from "viem";

export const CHAIN_ID = 10143;

/** Must match vitest.config.ts (ENVIO_XORV_LEDGER_ADDRESS). */
export const LEDGER = "0x1ed9e7c0a5f4c3b2a19d8e7f6a5b4c3d2e1f0a9b";
/** Must match vitest.config.ts (ENVIO_XORV_VERIFIER_ADDRESSES). */
export const CONFIGURED_VERIFIER = "0x00000000000000000000000000000000000000ee";
export const IDENTITY = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
export const REPUTATION = "0x8004b663056a597dffe9eccc1965a193b7388713";

export const NO_AGENT = 2n ** 256n - 1n;
export const ZERO32 = `0x${"0".repeat(64)}` as const;
export const ZERO_ADDRESS = `0x${"0".repeat(40)}` as const;

/** 2026-09-26 12:00:00 UTC */
export const T0 = Date.UTC(2026, 8, 26, 12, 0, 0) / 1000;
export const DAY = 86_400;

export const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
export const id32 = (label: string) => keccak256(toBytes(label));
export const hash32 = (n: number) => toHex(n, { size: 32 });

type ChainConfig = NonNullable<TestIndexerProcessConfig["chains"][typeof CHAIN_ID]>;
export type SimItem = NonNullable<ChainConfig["simulate"]>[number];

/** An event without its block/transaction placement; `tx()` adds those. */
export interface SimEvent {
  contract: "XorvLedger" | "IdentityRegistry" | "ReputationRegistry";
  event: string;
  params: Record<string, unknown>;
  srcAddress?: string;
}

export class Sim {
  readonly indexer = createTestIndexer();
  block = 100;
  time = T0;
  private txCount = 0;
  private queue: SimItem[] = [];
  lastTxHash = "";

  /** Queue events that share one transaction: same block, same hash, rising logIndex. */
  tx(...events: SimEvent[]): string {
    this.block += 1;
    this.time += 2;
    const hash = hash32(0xa000 + ++this.txCount);
    this.lastTxHash = hash;
    for (const e of events) {
      this.queue.push({
        ...e,
        block: { number: this.block, timestamp: this.time },
        transaction: { hash },
      } as unknown as SimItem);
    }
    return hash;
  }

  /** Move the clock (e.g. to the next UTC day) for the transactions queued after this. */
  advance(seconds: number): void {
    this.time += seconds;
  }

  async flush(): Promise<void> {
    const simulate = this.queue;
    this.queue = [];
    await this.indexer.process({ chains: { [CHAIN_ID]: { simulate } } });
  }

  /** tx() + flush() for the common one-transaction step. */
  async run(...events: SimEvent[]): Promise<string> {
    const hash = this.tx(...events);
    await this.flush();
    return hash;
  }
}

// ---- event builders -------------------------------------------------------------------

export const ledger = {
  brokerSet: (broker: string): SimEvent => ({
    contract: "XorvLedger",
    event: "BrokerSet",
    params: { broker },
  }),
  ownershipTransferred: (previousOwner: string, newOwner: string): SimEvent => ({
    contract: "XorvLedger",
    event: "OwnershipTransferred",
    params: { previousOwner, newOwner },
  }),
  providerRegistered: (p: {
    providerId: string;
    payTo: string;
    agentId?: bigint;
    label?: string;
    capabilities?: string;
  }): SimEvent => ({
    contract: "XorvLedger",
    event: "ProviderRegistered",
    params: {
      providerId: p.providerId,
      payTo: p.payTo,
      agentId: p.agentId ?? NO_AGENT,
      label: p.label ?? "node",
      capabilities: p.capabilities ?? "claude-code:10000",
    },
  }),
  heartbeat: (providerId: string, activeJobs = 1, capacity = 4, uptimeSeconds = 60): SimEvent => ({
    contract: "XorvLedger",
    event: "ProviderHeartbeat",
    params: { providerId, activeJobs: BigInt(activeJobs), capacity: BigInt(capacity), uptimeSeconds: BigInt(uptimeSeconds) },
  }),
  jobRecorded: (j: {
    jobId: string;
    agentId?: bigint;
    buyer: string;
    payTo: string;
    amount: bigint;
    paid?: boolean;
    durationMs?: number;
    ok?: boolean;
  }): SimEvent => ({
    contract: "XorvLedger",
    event: "JobRecorded",
    params: {
      jobId: j.jobId,
      agentId: j.agentId ?? NO_AGENT,
      buyer: j.buyer,
      payTo: j.payTo,
      amount: j.amount,
      paymentTx: j.paid === false ? ZERO32 : hash32(0xbeef),
      requestHash: hash32(1),
      resultHash: hash32(2),
      durationMs: BigInt(j.durationMs ?? 1000),
      ok: j.ok ?? true,
    },
  }),
  jobRated: (r: { jobId: string; agentId: bigint; buyer: string; value: number; feedbackHash?: string }): SimEvent => ({
    contract: "XorvLedger",
    event: "JobRated",
    params: {
      jobId: r.jobId,
      agentId: r.agentId,
      buyer: r.buyer,
      value: BigInt(r.value),
      feedbackHash: r.feedbackHash ?? hash32(0xfeed),
    },
  }),
};

export const identity = {
  mint: (to: string, agentId: bigint): SimEvent => ({
    contract: "IdentityRegistry",
    event: "Transfer",
    params: { from: ZERO_ADDRESS, to, tokenId: agentId },
  }),
  transfer: (from: string, to: string, agentId: bigint): SimEvent => ({
    contract: "IdentityRegistry",
    event: "Transfer",
    params: { from, to, tokenId: agentId },
  }),
  registered: (agentId: bigint, owner: string, agentURI = `https://broker.xorv.test/agents/${agentId}.json`): SimEvent => ({
    contract: "IdentityRegistry",
    event: "Registered",
    params: { agentId, agentURI, owner },
  }),
  uriUpdated: (agentId: bigint, newURI: string, updatedBy: string): SimEvent => ({
    contract: "IdentityRegistry",
    event: "URIUpdated",
    params: { agentId, newURI, updatedBy },
  }),
  metadataSet: (agentId: bigint, key: string, value: string): SimEvent => ({
    contract: "IdentityRegistry",
    event: "MetadataSet",
    params: { agentId, indexedMetadataKey: keccak256(toBytes(key)), metadataKey: key, metadataValue: value },
  }),
};

export const reputation = {
  newFeedback: (f: {
    agentId: bigint;
    client: string;
    index: bigint;
    value: bigint;
    decimals?: number;
    tag1: string;
    tag2?: string;
    feedbackHash?: string;
  }): SimEvent => ({
    contract: "ReputationRegistry",
    event: "NewFeedback",
    params: {
      agentId: f.agentId,
      clientAddress: f.client,
      feedbackIndex: f.index,
      value: f.value,
      valueDecimals: BigInt(f.decimals ?? 0),
      indexedTag1: keccak256(toBytes(f.tag1)),
      tag1: f.tag1,
      tag2: f.tag2 ?? "claude-code",
      endpoint: "https://broker.xorv.test/api/jobs",
      feedbackURI: "https://broker.xorv.test/feedback/job.json",
      feedbackHash: f.feedbackHash ?? hash32(0xfeed),
    },
  }),
  revoked: (agentId: bigint, client: string, index: bigint): SimEvent => ({
    contract: "ReputationRegistry",
    event: "FeedbackRevoked",
    params: { agentId, clientAddress: client, feedbackIndex: index },
  }),
  response: (agentId: bigint, client: string, index: bigint, responder: string): SimEvent => ({
    contract: "ReputationRegistry",
    event: "ResponseAppended",
    params: {
      agentId,
      clientAddress: client,
      feedbackIndex: index,
      responder,
      responseURI: "ipfs://response",
      responseHash: hash32(0xabc),
    },
  }),
};
