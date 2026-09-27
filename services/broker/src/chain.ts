/**
 * The broker's on-chain half: writes to XorvLedger on Monad.
 *
 * Four kinds of write, all from the operator EOA:
 *
 *  - `registerProvider` when a node joins,
 *  - a *sampled* `heartbeat` (see the note on `heartbeat` below),
 *  - `recordJobs`, **batched** — one receipt per paid job, several per tx,
 *  - `rateJob`, relaying a buyer's gasless EIP-712 rating into ERC-8004.
 *
 * Everything but the rating relay is best-effort by construction: a failed or
 * slow write resolves to null, lands in `lastPublishError` for /api/network,
 * and never throws into — or waits on — the request that triggered it. A job
 * poster must get their answer whether or not the audit trail kept up.
 *
 * ## Money on Monad, and why writes are shaped the way they are
 *
 * Monad bills the gas *limit*, not gas used. So every write carries an
 * explicit limit of `estimateGas` + 15% (protocol `withGasHeadroom`): a padded
 * constant would overpay on every transaction, and viem's bare estimate can
 * run short if state moves between estimate and inclusion.
 *
 * Receipts are batched because the fixed cost of a transaction (21k base gas,
 * a signature, an RPC round-trip) is most of the cost of a small one: a
 * receipt alone is ~104k gas, twenty in one call are ~41k each.
 *
 * Nonces: the operator EOA may also be the facilitator's (XORV_FACILITATOR_KEY
 * falls back to it). Every broadcast goes through the protocol's
 * `withSignerLock`, a per-address queue shared process-wide, plus viem's
 * `nonceManager` on the account — so a settlement and a receipt batch that
 * fire in the same millisecond get consecutive nonces instead of racing for
 * one.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type Transport,
} from "viem";
import {
  MAX_LOG_BLOCK_RANGE,
  NO_AGENT,
  XORV_LEDGER_ABI,
  explorerAddress,
  explorerTx,
  jobReceipt,
  ledgerEventAbi,
  providerIdHash,
  registerProviderArgs,
  walletClientFor,
  withGasHeadroom,
  withSignerLock,
  type JobReceiptStruct,
  type LedgerEventKind,
  type Provider,
  type RatingMessage,
  type XorvWalletClient,
} from "@xorv/protocol";

/** How long a write may wait for its receipt before it counts as failed. */
const RECEIPT_TIMEOUT_MS = 30_000;
/**
 * How far back a receipt that reverted as a duplicate is looked for, in
 * blocks (≈10 minutes of Monad). Duplicates come from this broker retrying
 * its own receipt, so the original is recent; past this the receipt is still
 * known to be recorded (`jobs(jobId)` says so), just without its tx hash.
 */
const DUPLICATE_SCAN_BLOCKS = 2_000;

export interface PublishResult {
  /** The XorvLedger address the write went to. */
  contract: string;
  /** Empty only for `alreadyRecorded` when the original transaction could not be found. */
  txHash: string;
  explorerUrl: string;
  blockNumber: string | null;
  /**
   * The receipt was recorded by an earlier transaction (a retry after a
   * timeout or a restart reverted as `DuplicateJob`). `txHash` is that earlier
   * transaction when it could be found.
   */
  alreadyRecorded?: boolean;
}

/**
 * A write that was broadcast but whose inclusion could not be confirmed (the
 * wait timed out, or the RPC failed mid-wait). It may still land, so its hash
 * is kept: re-sending blindly would revert as a duplicate, at the full gas
 * limit Monad bills, and sink any honest receipts batched with it.
 */
export class UnconfirmedWrite extends Error {
  constructor(
    readonly hash: Hex,
    cause: unknown,
  ) {
    super(`transaction ${hash} was sent but not confirmed: ${describe(cause)}`);
    this.name = "UnconfirmedWrite";
  }
}

/** The chain reads that tell "already recorded" apart from "failed". Tests stub them. */
export interface LedgerReads {
  /** Where a sent transaction stands. `unknown` means the node has never heard of it (dropped). */
  txStatus(hash: Hex): Promise<{ status: "success"; blockNumber: bigint } | { status: "reverted" | "pending" | "unknown" }>;
  /** `XorvLedger.jobs(jobId)`: the recorded buyer (zero when no receipt landed) and agent. */
  recordedJob(jobId: Hex): Promise<{ buyer: string; agentId: bigint }>;
  /** The `JobRecorded` log for this job id among recent blocks, newest first, or null. */
  findRecorded(jobId: Hex): Promise<{ txHash: Hex; blockNumber: bigint } | null>;
}

/** A liveness sample, in the units the contract takes. */
export interface HeartbeatSample {
  providerId: string;
  activeJobs: number;
  capacity: number;
  uptimeSeconds: number;
}

/** Everything a receipt is built from; hashing happens in `jobReceipt`. */
export type ReceiptInput = Parameters<typeof jobReceipt>[0];

export type LedgerMode = "off" | "read-only" | "write";

/**
 * What the HTTP layer needs from the chain.
 *
 * An interface so the app can be booted against a stub: the alternative —
 * reaching for the real writer — means every integration test needs a funded
 * key, a live RPC and a deployed contract, which is a good way to end up with
 * no integration tests at all.
 */
export interface ChainLike {
  readonly network: string;
  /** The XorvLedger address, or null when none is configured. */
  readonly ledgerAddress: string | null;
  /** The EOA ledger writes are signed by, or null when read-only. */
  readonly writerAddress: string | null;
  mode(): LedgerMode;
  counts(): Record<LedgerEventKind, number>;
  /** Receipts waiting for their batch. */
  pendingReceipts(): number;
  lastPublishError(): string | null;
  registerProvider(provider: Provider): Promise<PublishResult | null>;
  heartbeat(sample: HeartbeatSample): Promise<PublishResult | null>;
  /** Queue a receipt; resolves when its batch lands (or null if it didn't). */
  recordJob(input: ReceiptInput): Promise<PublishResult | null>;
  /**
   * Relay a buyer's signed rating. Unlike the other writes this one throws on
   * failure: the caller is the buyer, waiting to hear whether it landed.
   */
  rateJob(rating: RatingMessage, signature: Hex): Promise<PublishResult>;
  /**
   * Check a typed-data signature on-chain (ERC-1271 smart accounts, ERC-6492
   * counterfactual ones). Returns false when there is no RPC to ask.
   */
  verifyTypedDataOnChain(args: {
    address: string;
    typedData: Record<string, unknown>;
    signature: Hex;
  }): Promise<boolean>;
  /** Send whatever receipts are queued now, and wait for them. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface QueuedReceipt {
  struct: JobReceiptStruct;
  resolve: (result: PublishResult | null) => void;
}

type WriteFunction = "registerProvider" | "heartbeat" | "recordJobs" | "rateJob";

export interface LedgerWriterOptions {
  network: string;
  ledgerAddress: Address | null;
  account: PrivateKeyAccount | null;
  batchMs: number;
  batchMax: number;
  rpcUrl?: string;
  transport?: Transport;
  /**
   * Replace the broadcast-and-wait step. Tests use it to exercise batching,
   * splitting and fallbacks without an RPC; production leaves it unset.
   */
  submit?: (functionName: WriteFunction, args: readonly unknown[]) => Promise<PublishResult>;
  /** Replace the chain reads (see `LedgerReads`); defaults to reads over the wallet's RPC. */
  reads?: LedgerReads;
  /** The ledger's deploy block: the duplicate-receipt search never looks below it. */
  fromBlock?: bigint | null;
  log?: (line: string) => void;
}

/** The custom error a failed write reverted with (e.g. "DuplicateJob"), if it did revert. */
export function revertName(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return null;
  return revert.data?.errorName ?? revert.reason ?? "reverted";
}

function describe(err: unknown): string {
  if (err instanceof BaseError) {
    const reverted = revertName(err);
    const message = err.shortMessage || err.message;
    return reverted && !message.includes(reverted) ? `${message} (${reverted})` : message;
  }
  return err instanceof Error ? err.message : String(err);
}

export class LedgerWriter implements ChainLike {
  readonly network: string;
  readonly ledgerAddress: Address | null;
  readonly writerAddress: Address | null;
  private readonly account: PrivateKeyAccount | null;
  private readonly wallet: XorvWalletClient | null;
  private readonly batchMs: number;
  private readonly batchMax: number;
  private readonly submitOverride: LedgerWriterOptions["submit"];
  private readonly log: (line: string) => void;

  private lastError: string | null = null;
  private published: Record<LedgerEventKind, number> = {
    registrations: 0,
    heartbeats: 0,
    receipts: 0,
    ratings: 0,
  };
  private queue: QueuedReceipt[] = [];
  private readonly reads: LedgerReads | null;
  private readonly fromBlock: bigint | null;
  /** Receipt batches that were sent but not confirmed, by receipt job id (bytes32). */
  private readonly unconfirmed = new Map<string, Hex>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private closed = false;

  constructor(opts: LedgerWriterOptions) {
    this.network = opts.network;
    this.ledgerAddress = opts.ledgerAddress;
    this.account = opts.ledgerAddress ? opts.account : null;
    this.writerAddress = this.account?.address ?? null;
    this.batchMs = opts.batchMs;
    this.batchMax = Math.max(1, opts.batchMax);
    this.submitOverride = opts.submit;
    this.log = opts.log ?? ((line) => console.error(line));
    this.wallet =
      this.account && !opts.submit
        ? walletClientFor(opts.network, this.account, { rpcUrl: opts.rpcUrl, transport: opts.transport })
        : null;
    this.fromBlock = opts.fromBlock ?? null;
    this.reads = opts.reads ?? (this.wallet && this.ledgerAddress ? this.rpcReads(this.wallet, this.ledgerAddress) : null);
  }

  mode(): LedgerMode {
    if (!this.ledgerAddress) return "off";
    return this.account ? "write" : "read-only";
  }

  counts(): Record<LedgerEventKind, number> {
    return { ...this.published };
  }

  pendingReceipts(): number {
    return this.queue.length;
  }

  lastPublishError(): string | null {
    return this.lastError;
  }

  /** Announce a provider joining the network. */
  async registerProvider(provider: Provider): Promise<PublishResult | null> {
    if (this.mode() !== "write") return null;
    try {
      const args = registerProviderArgs({
        providerId: provider.id,
        address: provider.address,
        agentId: provider.agentId,
        label: provider.label,
        capabilities: provider.capabilities,
      });
      const result = await this.submit("registerProvider", args);
      this.published.registrations += 1;
      return result;
    } catch (err) {
      this.recordError("registerProvider", err);
      return null;
    }
  }

  /**
   * Record a liveness beat.
   *
   * The caller samples (`XORV_HEARTBEAT_PUBLISH_EVERY`, one in 20 by default):
   * at one beat per provider per 15 s, publishing every one would be several
   * thousand transactions a day per node, each paying for its full gas limit —
   * noise rather than evidence. A periodic sample is still a checkable proof
   * that a node was up, at a twentieth of the cost.
   */
  async heartbeat(sample: HeartbeatSample): Promise<PublishResult | null> {
    if (this.mode() !== "write") return null;
    try {
      const uint32 = (n: number) => Math.min(Math.max(0, Math.round(n)), 0xffff_ffff);
      const result = await this.submit("heartbeat", [
        providerIdHash(sample.providerId),
        uint32(sample.activeJobs),
        uint32(sample.capacity),
        uint32(sample.uptimeSeconds),
      ]);
      this.published.heartbeats += 1;
      return result;
    } catch (err) {
      this.recordError("heartbeat", err);
      return null;
    }
  }

  /**
   * Queue one receipt. It goes out with the next batch: after `batchMs`, or
   * immediately once `batchMax` receipts are waiting.
   */
  recordJob(input: ReceiptInput): Promise<PublishResult | null> {
    if (this.mode() !== "write" || this.closed) return Promise.resolve(null);
    let struct: JobReceiptStruct;
    try {
      struct = jobReceipt(input);
    } catch (err) {
      // A malformed input (a non-address payTo) must not poison a whole batch.
      this.recordError("recordJobs", err);
      return Promise.resolve(null);
    }
    // An earlier batch carrying this receipt was sent but never confirmed.
    // Find out what happened to it before sending the receipt again.
    const sent = this.unconfirmed.get(struct.jobId.toLowerCase());
    if (sent) return this.settleUnconfirmed(struct, sent);
    return this.enqueue(struct);
  }

  private enqueue(struct: JobReceiptStruct): Promise<PublishResult | null> {
    return new Promise((resolve) => {
      this.queue.push({ struct, resolve });
      if (this.queue.length >= this.batchMax) {
        void this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.flush();
        }, this.batchMs);
        this.timer.unref?.();
      }
    });
  }

  /**
   * A retry for a receipt whose earlier transaction was never confirmed:
   * landed → answer with it; still pending → don't pile a second transaction
   * on top (null, retried later); reverted or dropped → send it again.
   */
  private async settleUnconfirmed(struct: JobReceiptStruct, hash: Hex): Promise<PublishResult | null> {
    const key = struct.jobId.toLowerCase();
    let state: Awaited<ReturnType<LedgerReads["txStatus"]>>;
    try {
      if (!this.reads) throw new Error("no RPC to ask");
      state = await this.reads.txStatus(hash);
    } catch (err) {
      this.recordError(`recordJobs (checking ${hash})`, err);
      return null;
    }
    if (state.status === "success") {
      this.unconfirmed.delete(key);
      this.published.receipts += 1;
      return this.resultFor(hash, state.blockNumber);
    }
    if (state.status === "pending") return null;
    this.unconfirmed.delete(key);
    return this.enqueue(struct);
  }

  /**
   * A single receipt reverted as `DuplicateJob`: XorvLedger already holds a
   * receipt for this job id. That is this broker's own earlier receipt — sent
   * before a restart, or confirmed after the wait gave up — as long as the
   * recorded buyer is this receipt's buyer, and then it is a success, not a
   * failure: treating it as one left the job without a receipt forever, and
   * so unratable, although the ledger had it.
   */
  private async alreadyRecorded(struct: JobReceiptStruct): Promise<PublishResult | null> {
    if (!this.reads || !this.ledgerAddress) return null;
    try {
      const recorded = await this.reads.recordedJob(struct.jobId);
      if (/^0x0{40}$/i.test(recorded.buyer) || recorded.buyer.toLowerCase() !== struct.buyer.toLowerCase()) return null;
      const sent = this.unconfirmed.get(struct.jobId.toLowerCase());
      if (sent) {
        const state = await this.reads.txStatus(sent).catch(() => null);
        if (state?.status === "success") {
          this.unconfirmed.delete(struct.jobId.toLowerCase());
          return { ...this.resultFor(sent, state.blockNumber), alreadyRecorded: true };
        }
      }
      this.unconfirmed.delete(struct.jobId.toLowerCase());
      const found = await this.reads.findRecorded(struct.jobId).catch(() => null);
      if (found) return { ...this.resultFor(found.txHash, found.blockNumber), alreadyRecorded: true };
      return { contract: this.ledgerAddress, txHash: "", explorerUrl: "", blockNumber: null, alreadyRecorded: true };
    } catch (err) {
      this.recordError(`recordJobs (checking ${struct.jobId})`, err);
      return null;
    }
  }

  private resultFor(hash: string, blockNumber: bigint | null): PublishResult {
    return {
      contract: this.ledgerAddress ?? "",
      txHash: hash,
      explorerUrl: explorerTx(this.network, hash),
      blockNumber: blockNumber === null ? null : blockNumber.toString(),
    };
  }

  /** The default `LedgerReads`, over the writer's own RPC. */
  private rpcReads(wallet: XorvWalletClient, ledger: Address): LedgerReads {
    const event = ledgerEventAbi("receipts");
    return {
      txStatus: async (hash) => {
        const receipt = await wallet.getTransactionReceipt({ hash }).catch((err: unknown) => {
          if (err instanceof TransactionReceiptNotFoundError) return null;
          throw err;
        });
        if (receipt) {
          return receipt.status === "success"
            ? { status: "success", blockNumber: receipt.blockNumber }
            : { status: "reverted" };
        }
        const tx = await wallet.getTransaction({ hash }).catch((err: unknown) => {
          if (err instanceof TransactionNotFoundError) return null;
          throw err;
        });
        return { status: tx ? "pending" : "unknown" };
      },
      recordedJob: async (jobId) => {
        const [buyer, agentId] = (await wallet.readContract({
          address: ledger,
          abi: XORV_LEDGER_ABI,
          functionName: "jobs",
          args: [jobId],
        })) as readonly [string, bigint, boolean];
        return { buyer, agentId };
      },
      findRecorded: async (jobId) => {
        // Public Monad RPCs cap eth_getLogs at 100 blocks, so walk back in
        // windows, a few at a time, newest first.
        const latest = await wallet.getBlockNumber();
        const floor = [latest - BigInt(DUPLICATE_SCAN_BLOCKS) + 1n, this.fromBlock ?? 0n, 0n].reduce((a, b) =>
          a > b ? a : b,
        );
        const windows: Array<[bigint, bigint]> = [];
        for (let to = latest; to >= floor; ) {
          const from = to - BigInt(MAX_LOG_BLOCK_RANGE) + 1n > floor ? to - BigInt(MAX_LOG_BLOCK_RANGE) + 1n : floor;
          windows.push([from, to]);
          to = from - 1n;
        }
        for (let i = 0; i < windows.length; i += 4) {
          const results = await Promise.all(
            windows
              .slice(i, i + 4)
              .map(([fromBlock, toBlock]) =>
                wallet.getLogs({ address: ledger, event, args: { jobId }, fromBlock, toBlock } as never),
              ),
          );
          for (const logs of results) {
            const log = (logs as Array<{ transactionHash: Hex | null; blockNumber: bigint | null; removed?: boolean }>).find(
              (l) => !l.removed && l.transactionHash && l.blockNumber !== null,
            );
            if (log?.transactionHash && log.blockNumber !== null) {
              return { txHash: log.transactionHash, blockNumber: log.blockNumber };
            }
          }
        }
        return null;
      },
    };
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // One flush at a time. A caller who arrives mid-flush queues another pass
    // behind it: the running loop may already have seen an empty queue, and a
    // receipt added in that gap must not wait for the next timer.
    if (this.flushing) return this.flushing.then(() => this.flush());
    if (this.queue.length === 0) return Promise.resolve();
    this.flushing = (async () => {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchMax);
        await this.sendBatch(batch);
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /**
   * Send one batch, isolating bad receipts.
   *
   * `recordJobs` is all-or-nothing on-chain, so one receipt that reverts (a
   * duplicate after a retry, an agent whose wallet changed since the quote)
   * would sink every honest receipt batched with it. On a *revert* the batch
   * is split in half and each half retried, down to single receipts; any other
   * failure (RPC down, out of gas money) fails the batch as a whole, since
   * splitting would only multiply the same error.
   */
  private async sendBatch(batch: QueuedReceipt[]): Promise<void> {
    try {
      const result = await this.submit("recordJobs", [batch.map((b) => b.struct)]);
      this.published.receipts += batch.length;
      for (const item of batch) item.resolve(result);
      return;
    } catch (err) {
      const reverted = revertName(err);
      if (reverted && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        await this.sendBatch(batch.slice(0, mid));
        await this.sendBatch(batch.slice(mid));
        return;
      }
      const only = batch[0];
      // The provider's agent wallet no longer matches the address the buyer
      // paid (the agent NFT moved, or its wallet was re-pointed). The payment
      // is still a fact worth recording — just not attributable to that
      // identity — so record it once more under NO_AGENT.
      if (batch.length === 1 && only && reverted === "PayToNotAgentWallet" && only.struct.agentId !== NO_AGENT) {
        this.log(`[ledger] receipt ${only.struct.jobId}: payTo is no longer the agent's wallet — recording without an agent`);
        only.struct = { ...only.struct, agentId: NO_AGENT };
        await this.sendBatch([only]);
        return;
      }
      if (batch.length === 1 && only && reverted === "DuplicateJob") {
        const landed = await this.alreadyRecorded(only.struct);
        if (landed) {
          this.log(`[ledger] receipt ${only.struct.jobId} was already recorded${landed.txHash ? ` in ${landed.txHash}` : ""}`);
          only.resolve(landed);
          return;
        }
      }
      // Sent but not confirmed: it may still land, so remember the hash and
      // check it before this receipt is ever sent again.
      if (err instanceof UnconfirmedWrite) {
        for (const item of batch) this.unconfirmed.set(item.struct.jobId.toLowerCase(), err.hash);
      }
      this.recordError(`recordJobs (${batch.length} receipt${batch.length === 1 ? "" : "s"})`, err);
      for (const item of batch) item.resolve(null);
    }
  }

  async rateJob(rating: RatingMessage, signature: Hex): Promise<PublishResult> {
    if (this.mode() !== "write") {
      throw new Error(
        this.ledgerAddress
          ? "the broker is read-only (no XORV_OPERATOR_KEY), so it cannot relay ratings"
          : "no XorvLedger is configured (XORV_LEDGER_ADDRESS), so there is nothing to rate against",
      );
    }
    try {
      const result = await this.submit("rateJob", [rating, signature]);
      this.published.ratings += 1;
      return result;
    } catch (err) {
      this.recordError("rateJob", err);
      const reverted = revertName(err);
      throw new Error(reverted ? `the ledger refused the rating: ${reverted}` : describe(err));
    }
  }

  async verifyTypedDataOnChain(args: {
    address: string;
    typedData: Record<string, unknown>;
    signature: Hex;
  }): Promise<boolean> {
    if (!this.wallet) return false;
    try {
      return await this.wallet.verifyTypedData({
        ...args.typedData,
        address: args.address as Address,
        signature: args.signature,
      } as never);
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    // Give queued receipts one last chance rather than dropping them on a
    // routine restart; bounded so a dead RPC can't hold shutdown hostage.
    await Promise.race([this.flush(), new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())]);
  }

  // -------------------------------------------------------------------------

  private submit(functionName: WriteFunction, args: readonly unknown[]): Promise<PublishResult> {
    if (this.submitOverride) return this.submitOverride(functionName, args);
    return this.broadcast(functionName, args);
  }

  /**
   * Estimate, sign and send under the signer lock; wait for the receipt
   * outside it.
   *
   * Only the send needs serializing — nonces are assigned at send time — so
   * waiting for inclusion outside the lock keeps throughput at one tx per RPC
   * round-trip rather than one per block.
   */
  private async broadcast(functionName: WriteFunction, args: readonly unknown[]): Promise<PublishResult> {
    const wallet = this.wallet;
    const account = this.account;
    const address = this.ledgerAddress;
    if (!wallet || !account || !address) throw new Error("ledger writer is not configured for writes");

    const request = {
      address,
      abi: XORV_LEDGER_ABI,
      functionName,
      args,
      account,
    } as const;

    let hash: Hex;
    try {
      hash = await withSignerLock(account.address, async () => {
        const gas = withGasHeadroom(await wallet.estimateContractGas(request as never));
        return wallet.writeContract({ ...request, gas } as never);
      });
    } catch (err) {
      // A send that failed after the nonce manager handed out a nonce leaves
      // its local counter one ahead of the chain; resync from the node so the
      // next write doesn't sit behind a gap forever.
      account.nonceManager?.reset({ address: account.address, chainId: wallet.chain.id });
      throw err;
    }

    let receipt: Awaited<ReturnType<typeof wallet.waitForTransactionReceipt>>;
    try {
      receipt = await wallet.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    } catch (err) {
      throw new UnconfirmedWrite(hash, err);
    }
    if (receipt.status !== "success") {
      throw new Error(`${functionName} reverted on-chain (${hash})`);
    }
    return {
      contract: address,
      txHash: hash,
      explorerUrl: explorerTx(this.network, hash),
      blockNumber: receipt.blockNumber.toString(),
    };
  }

  private recordError(what: string, err: unknown): void {
    const message = describe(err);
    this.lastError = `${what}: ${message}`;
    this.log(`[ledger] ${what} failed: ${message}`);
  }
}

/** Explorer link for the ledger contract, for the network panel. */
export function describeLedger(chain: ChainLike): { address: string; url: string; mode: LedgerMode } | null {
  if (!chain.ledgerAddress) return null;
  return {
    address: chain.ledgerAddress,
    url: explorerAddress(chain.network, chain.ledgerAddress),
    mode: chain.mode(),
  };
}
