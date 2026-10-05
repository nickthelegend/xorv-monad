/**
 * On-chain reputation, as the broker uses it.
 *
 * XorvRegistry (Stylus) is written by the escrow, not by the broker: every
 * release adds a completed job and the amount earned, every attester refund or
 * reassignment adds a failure. So it is the one track record a buyer can check
 * without trusting this broker's database — and the matcher should rank on it.
 *
 * Contract reads are async and the matcher is synchronous (it runs inside a
 * quote request), so this keeps a cache on each provider record: filled when a
 * provider registers, refreshed on a timer for live providers and right after
 * any escrow settlement that moved their numbers.
 */

import {
  readReputation,
  sponsorRegistration,
  type OnchainReputation,
  type Provider,
} from "@xorv/protocol";
import { getAddress, type Address } from "viem";
import type { ChainLike } from "./chain.js";

export interface ReputationSource {
  readonly address: string;
  read(provider: string): Promise<OnchainReputation>;
  /** Register a provider on its behalf; the broker pays the gas. */
  sponsor(provider: string, nodeId: string, metadataUri: string): Promise<string>;
}

export function chainReputation(chain: ChainLike, address: string): ReputationSource {
  const registry = getAddress(address);
  const clients = { public: chain.publicClient, wallet: chain.walletClient };
  return {
    address: registry,
    read: (provider) => readReputation(clients.public, registry, getAddress(provider) as Address),
    async sponsor(provider, nodeId, metadataUri) {
      chain.noteWrite?.("start");
      try {
        return await sponsorRegistration(clients, registry, getAddress(provider) as Address, nodeId, metadataUri);
      } finally {
        chain.noteWrite?.("end");
      }
    },
  };
}

type ReputationTarget = Pick<Provider, "id" | "address" | "onchain"> & { nodeId?: string };

/** Keeps `provider.onchain` fresh without ever blocking a request on the chain. */
export class ReputationBook {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly source: ReputationSource,
    private readonly opts: { log?: (msg: string) => void } = {},
  ) {}

  get address(): string {
    return this.source.address;
  }

  /** Read and cache one provider's record. Concurrent calls for one address share a read. */
  refresh(provider: ReputationTarget): Promise<void> {
    const key = provider.address.toLowerCase();
    const running = this.inflight.get(key);
    if (running) return running;
    const task = this.source
      .read(provider.address)
      .then((rep) => {
        provider.onchain = { ...rep, sponsorTx: provider.onchain?.sponsorTx ?? null };
      })
      .catch((err) => {
        this.opts.log?.(`reputation read for ${provider.address} failed: ${(err as Error).message}`);
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  /**
   * Make sure a newly joined provider exists in the registry.
   *
   * Sponsored rather than self-service so that joining the network never
   * requires holding ETH: the provider is paid in stablecoins by the escrow and
   * should need nothing else. Skipped when the record already exists.
   */
  async onRegistered(provider: ReputationTarget, metadataUri: string): Promise<void> {
    await this.refresh(provider);
    if (provider.onchain?.registered && provider.onchain.active) return;
    try {
      const tx = await this.source.sponsor(provider.address, provider.nodeId ?? provider.id, metadataUri);
      await this.refresh(provider);
      if (provider.onchain) provider.onchain.sponsorTx = tx;
    } catch (err) {
      this.opts.log?.(`sponsored registration for ${provider.address} failed: ${(err as Error).message}`);
    }
  }
}
