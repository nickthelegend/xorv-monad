/**
 * The broker's side of XorvEscrow: the verbs that move a funded job's money
 * after the x402 payment has put it there.
 *
 * Funding happens inside the facilitator (the protocol's escrow scheme),
 * because it has to consume the buyer's authorization before it expires.
 * Everything after that (release on delivery, reassign when a provider drops,
 * refund when nobody can do the job, cancel when the buyer calls it off) is
 * decided by the job lifecycle in app.ts.
 *
 * Stated as an interface so the integration tests can boot the whole broker
 * against an in-memory escrow with the contract's state machine.
 */

import {
  cancelEscrow,
  escrowWriter,
  publicClientFor,
  readEscrowJob,
  reassignEscrow,
  refundEscrow,
  releaseEscrow,
  walletClientFor,
  type EscrowJob,
  type EscrowStatus,
} from "@xorv/protocol";
import { getAddress, parseAbiItem, type Account, type Address, type Hex, type PublicClient } from "viem";

export interface EscrowOps {
  readonly address: string;
  release(jobId: Hex, resultSha256: string): Promise<string>;
  refund(jobId: Hex): Promise<string>;
  /** Refund because the buyer called it off: no fault on the provider. */
  cancel(jobId: Hex): Promise<string>;
  reassign(jobId: Hex, provider: string): Promise<string>;
  read(jobId: Hex): Promise<Pick<EscrowJob, "status" | "provider" | "deadline">>;
  /**
   * The transaction that released or refunded a job, whoever sent it: a
   * buyer's own release, or a keeper's (Chainlink CRE) refund after the deadline.
   */
  settlement(jobId: Hex, fromTx?: string): Promise<{ tx: string; by: string; via: string | null } | null>;
}

const RELEASED = parseAbiItem(
  "event JobReleased(bytes32 indexed jobId, address indexed provider, uint256 providerAmount, uint256 fee, bytes32 resultHash, address releasedBy)",
);
const REFUNDED = parseAbiItem(
  "event JobRefunded(bytes32 indexed jobId, address indexed buyer, uint256 amount, bool providerAtFault)",
);

/** Monad's public RPC answers at most 100 blocks per eth_getLogs. */
const LOG_WINDOW = 99n;

/**
 * The real thing. `account` is the escrow's attester: the broker's settlement
 * key (XORV_FACILITATOR_KEY, else the operator). Writes share the signer lock
 * with the facilitator, so a release and a funding can't race on a nonce.
 */
export function chainEscrow(network: string, address: string, account: Account): EscrowOps {
  const escrow = getAddress(address);
  const pub = publicClientFor(network) as PublicClient;
  const wallet = escrowWriter(walletClientFor(network, account), account);
  const clients = { public: pub, wallet };
  return {
    address: escrow,
    release: (jobId, hash) => releaseEscrow(clients, escrow, jobId, hash),
    refund: (jobId) => refundEscrow(clients, escrow, jobId),
    cancel: (jobId) => cancelEscrow(clients, escrow, jobId),
    reassign: (jobId, provider) => reassignEscrow(clients, escrow, jobId, provider as Address),
    read: (jobId) => readEscrowJob(pub, escrow, jobId),
    async settlement(jobId, fromTx) {
      // Scan forward from the funding block; a job's life is bounded by its deadline.
      const start = fromTx ? (await pub.getTransactionReceipt({ hash: fromTx as Hex })).blockNumber : 0n;
      const head = await pub.getBlockNumber();
      for (let from = start; from <= head; from += LOG_WINDOW + 1n) {
        const to = from + LOG_WINDOW > head ? head : from + LOG_WINDOW;
        const [released, refunded] = await Promise.all(
          [RELEASED, REFUNDED].map((event) =>
            pub.getLogs({ address: escrow, event, args: { jobId }, fromBlock: from, toBlock: to }),
          ),
        );
        const hit = [...(released ?? []), ...(refunded ?? [])][0];
        if (hit) {
          const tx = await pub.getTransaction({ hash: hit.transactionHash });
          // `by` sent it; `via` is the contract it called (XorvRefundKeeper, when the CRE keeper refunded it).
          return { tx: hit.transactionHash, by: tx.from, via: tx.to ?? null };
        }
      }
      return null;
    },
  };
}

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

  async settlement(jobId: Hex): Promise<{ tx: string; by: string; via: string | null } | null> {
    const job = this.jobs.get(jobId.toLowerCase());
    if (!job || job.status === "funded" || job.status === "none") return null;
    return this.external.get(jobId.toLowerCase()) ?? { tx: this.hash(), by: this.address, via: this.address };
  }

  /** Settlements made by someone other than the broker, keyed by job id. */
  readonly external = new Map<string, { tx: string; by: string; via: string | null }>();

  /** What a third party's on-chain refund after the deadline does (`via`: the contract it called, e.g. the CRE keeper). */
  refundExternally(jobId: string, by: string, via: string | null = null): string {
    const job = this.jobs.get(jobId.toLowerCase());
    if (!job || job.status !== "funded") throw new Error("not funded");
    job.status = "refunded";
    const tx = this.hash();
    this.external.set(jobId.toLowerCase(), { tx, by, via });
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
