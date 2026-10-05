/**
 * The broker's side of XorvEscrow: the three verbs that move a funded job's
 * money after the x402 payment has put it there.
 *
 * Funding happens inside the facilitator (see `@xorv/protocol` escrow scheme),
 * because it has to consume the buyer's authorization before it expires.
 * Everything after that — release on delivery, reassign when a provider
 * drops, refund when nobody can do the job — is decided here, minutes later,
 * by the job lifecycle in app.ts.
 *
 * Stated as an interface for the same reason `ChainLike` is: the integration
 * tests boot the whole broker against an in-memory escrow, so they exercise
 * every settlement decision without a funded key or a network.
 */

import {
  cancelEscrow,
  readEscrowJob,
  reassignEscrow,
  refundEscrow,
  releaseEscrow,
  type EscrowJob,
  type EscrowStatus,
} from "@xorv/protocol";
import { getAddress, parseAbiItem, type Address, type Hex } from "viem";
import type { ChainLike } from "./chain.js";

export interface EscrowOps {
  readonly address: string;
  release(jobId: Hex, resultSha256: string): Promise<string>;
  refund(jobId: Hex): Promise<string>;
  /** Refund because the buyer called it off: no reputation mark. */
  cancel(jobId: Hex): Promise<string>;
  reassign(jobId: Hex, provider: string): Promise<string>;
  read(jobId: Hex): Promise<Pick<EscrowJob, "status" | "provider" | "deadline">>;
  /**
   * The transaction that released or refunded a job — whoever sent it. Used to
   * reconcile settlements the broker didn't make: a buyer's own release, a
   * keeper's refund after the deadline.
   */
  settlement(jobId: Hex, fromTx?: string): Promise<{ tx: string; by: string } | null>;
}

const RELEASED = parseAbiItem(
  "event JobReleased(bytes32 indexed jobId, address indexed provider, uint256 providerAmount, uint256 fee, bytes32 resultHash, address releasedBy)",
);
const REFUNDED = parseAbiItem(
  "event JobRefunded(bytes32 indexed jobId, address indexed buyer, uint256 amount, bool providerAtFault)",
);

/** The real thing: the operator key, which is also the escrow's attester. */
export function chainEscrow(chain: ChainLike, address: string): EscrowOps {
  const clients = { public: chain.publicClient, wallet: chain.walletClient };
  const escrow = getAddress(address);
  // Every write marks itself so the log indexer stays off the RPC meanwhile.
  const write = async <T>(fn: () => Promise<T>): Promise<T> => {
    chain.noteWrite?.("start");
    try {
      return await fn();
    } finally {
      chain.noteWrite?.("end");
    }
  };
  return {
    address: escrow,
    release: (jobId, hash) => write(() => releaseEscrow(clients, escrow, jobId, hash)),
    refund: (jobId) => write(() => refundEscrow(clients, escrow, jobId)),
    cancel: (jobId) => write(() => cancelEscrow(clients, escrow, jobId)),
    reassign: (jobId, provider) =>
      write(() => reassignEscrow(clients, escrow, jobId, provider as Address)),
    read: (jobId) => readEscrowJob(clients.public, escrow, jobId),
    async settlement(jobId, fromTx) {
      const pub = clients.public;
      // Scan forward from the funding transaction's block, in windows public
      // RPCs accept. A job's life is bounded by its deadline, so this is short.
      const start = fromTx
        ? (await pub.getTransactionReceipt({ hash: fromTx as Hex })).blockNumber
        : 0n;
      const head = await pub.getBlockNumber();
      const window = 9_000n;
      for (let from = start; from <= head; from += window + 1n) {
        const to = from + window > head ? head : from + window;
        const [released, refunded] = await Promise.all(
          [RELEASED, REFUNDED].map((event) =>
            pub.getLogs({ address: escrow, event, args: { jobId }, fromBlock: from, toBlock: to }),
          ),
        );
        const logs = [...(released ?? []), ...(refunded ?? [])];
        const hit = logs[0];
        if (hit) {
          const tx = await pub.getTransaction({ hash: hit.transactionHash });
          return { tx: hit.transactionHash, by: tx.from };
        }
      }
      return null;
    },
  };
}

/**
 * An in-memory escrow with the contract's state machine, for tests.
 *
 * It enforces the same transitions the contract does (only a funded job can
 * move, reassign keeps it funded), so a broker bug that would revert on chain
 * throws here too instead of passing silently.
 */
export class MemoryEscrow implements EscrowOps {
  readonly address = getAddress("0x00000000000000000000000000000000000e5c20");
  readonly jobs = new Map<string, { status: EscrowStatus; provider: string; deadline: number }>();
  readonly calls: { op: string; jobId: string; arg?: string }[] = [];
  private tx = 0;

  /** What the facilitator's `fund` would have written. */
  fund(jobId: string, provider: string, deadline: number): void {
    this.jobs.set(jobId.toLowerCase(), { status: "funded", provider, deadline });
  }

  private funded(jobId: string) {
    const job = this.jobs.get(jobId.toLowerCase());
    if (!job || job.status !== "funded") {
      throw new Error(`JobNotFunded(${jobId}, ${job?.status ?? "none"})`);
    }
    return job;
  }

  private hash(): string {
    return `0x${(++this.tx).toString(16).padStart(64, "0")}`;
  }

  async release(jobId: Hex, resultSha256: string): Promise<string> {
    this.funded(jobId).status = "released";
    this.calls.push({ op: "release", jobId, arg: resultSha256 });
    return this.hash();
  }

  async refund(jobId: Hex): Promise<string> {
    this.funded(jobId).status = "refunded";
    this.calls.push({ op: "refund", jobId });
    return this.hash();
  }

  async cancel(jobId: Hex): Promise<string> {
    this.funded(jobId).status = "refunded";
    this.calls.push({ op: "cancel", jobId });
    return this.hash();
  }

  async reassign(jobId: Hex, provider: string): Promise<string> {
    const job = this.funded(jobId);
    if (job.provider.toLowerCase() === provider.toLowerCase()) throw new Error("InvalidParties");
    job.provider = provider;
    this.calls.push({ op: "reassign", jobId, arg: provider });
    return this.hash();
  }

  async settlement(jobId: Hex): Promise<{ tx: string; by: string } | null> {
    const job = this.jobs.get(jobId.toLowerCase());
    if (!job || job.status === "funded" || job.status === "none") return null;
    return this.external.get(jobId.toLowerCase()) ?? { tx: this.hash(), by: this.address };
  }

  /** Settlements made by someone other than the broker, keyed by job id. */
  readonly external = new Map<string, { tx: string; by: string }>();

  /** What a third party's on-chain refund after the deadline does. */
  refundExternally(jobId: string, by: string): string {
    const job = this.jobs.get(jobId.toLowerCase());
    if (!job || job.status !== "funded") throw new Error("not funded");
    job.status = "refunded";
    const tx = this.hash();
    this.external.set(jobId.toLowerCase(), { tx, by });
    return tx;
  }

  async read(jobId: Hex) {
    const job = this.jobs.get(jobId.toLowerCase());
    return {
      status: job?.status ?? ("none" as EscrowStatus),
      provider: (job?.provider ?? "0x0000000000000000000000000000000000000000") as Address,
      deadline: job?.deadline ?? 0,
    };
  }
}
