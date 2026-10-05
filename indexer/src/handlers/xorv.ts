/**
 * Xorv's three contracts, folded into the entities the product shows.
 *
 * XorvEscrow   → Job (whole lifecycle), Buyer, and the money side of Provider
 * XorvRegistry → Provider (registration, liveness, the on-chain score)
 * XorvLog      → Receipt (the broker's public job.receipt entries)
 *
 * and Network / DailyStat totals across all of them.
 */
import { indexer } from "envio";
import type { Buyer, DailyStat, Job, Network, Provider } from "envio";
import { dayOf, laplaceBps } from "../lib.js";

const NETWORK_ID = "monad-testnet";
const KIND_RECEIPT = 3n;
const TX = { transaction: ["hash"], block: ["timestamp"] } as const;

/** The slice of the handler context the shared helpers below use. */
interface Ops<T> {
  get(id: string): Promise<T | undefined>;
  getOrCreate(entity: T): Promise<T>;
  set(entity: T): void;
}
interface Ctx {
  Network: Ops<Network>;
  DailyStat: Ops<DailyStat>;
  Provider: Ops<Provider>;
}

const lower = (a: string) => a.toLowerCase();

async function network(context: Ctx): Promise<Network> {
  return context.Network.getOrCreate({
    id: NETWORK_ID,
    jobsFunded: 0,
    jobsReleased: 0,
    jobsRefunded: 0,
    refundsAtFault: 0,
    volume: 0n,
    paidToProviders: 0n,
    fees: 0n,
    refunded: 0n,
    providers: 0,
    buyers: 0,
    receipts: 0,
    registryCallFailures: 0,
    meanSecondsToSettle: 0n,
    settledCount: 0,
  });
}

async function daily(context: Ctx, timestamp: number): Promise<DailyStat> {
  const day = dayOf(timestamp);
  return context.DailyStat.getOrCreate({
    id: day,
    day,
    jobsFunded: 0,
    jobsReleased: 0,
    jobsRefunded: 0,
    volume: 0n,
    paidToProviders: 0n,
    activeProviders: 0,
  });
}

/** A provider row, created on first sight whether that is a registration or a payment. */
async function provider(context: Ctx, address: string): Promise<{ row: Provider; isNew: boolean }> {
  const id = lower(address);
  const existing = await context.Provider.get(id);
  if (existing) return { row: existing, isNew: false };
  return {
    isNew: true,
    row: {
      id,
      nodeId: undefined,
      registered: false,
      active: false,
      registeredAt: undefined,
      lastHeartbeat: undefined,
      heartbeats: 0,
      completed: 0n,
      failed: 0n,
      scoreBps: 5000,
      earned: 0n,
      jobsAssigned: 0,
      refundsAtFault: 0,
    },
  };
}

/** Running mean of seconds from funding to settlement. */
function withSettleTime(net: Network, seconds: bigint): Network {
  const n = BigInt(net.settledCount);
  return {
    ...net,
    settledCount: net.settledCount + 1,
    meanSecondsToSettle: (net.meanSecondsToSettle * n + seconds) / (n + 1n),
  };
}

// ---------------------------------------------------------------- escrow

indexer.onEvent({ contract: "XorvEscrow", event: "JobFunded", fields: TX }, async ({ event, context }) => {
  const { jobId, buyer, provider: payee, token, amount, deadline } = event.params;
  const at = BigInt(event.block.timestamp);

  const job: Job = {
    id: jobId,
    buyer_id: lower(buyer),
    provider_id: lower(payee),
    token: lower(token),
    amount,
    deadline,
    status: "Funded",
    fundedAt: at,
    fundedBlock: BigInt(event.block.number),
    fundTx: event.transaction.hash,
    reassignments: 0,
    providerAmount: undefined,
    fee: undefined,
    resultHash: undefined,
    releasedBy: undefined,
    providerAtFault: undefined,
    settledAt: undefined,
    settleTx: undefined,
    secondsToSettle: undefined,
  };
  context.Job.set(job);

  const prior = await context.Buyer.get(lower(buyer));
  const b: Buyer = prior
    ? { ...prior, jobs: prior.jobs + 1, lastJobAt: at }
    : { id: lower(buyer), jobs: 1, spent: 0n, refunded: 0n, firstJobAt: at, lastJobAt: at };
  context.Buyer.set(b);

  const p = await provider(context, payee);
  context.Provider.set({ ...p.row, jobsAssigned: p.row.jobsAssigned + 1 });

  const net = await network(context);
  context.Network.set({
    ...net,
    jobsFunded: net.jobsFunded + 1,
    volume: net.volume + amount,
    buyers: net.buyers + (prior ? 0 : 1),
    providers: net.providers + (p.isNew ? 1 : 0),
  });

  const day = await daily(context, event.block.timestamp);
  context.DailyStat.set({ ...day, jobsFunded: day.jobsFunded + 1, volume: day.volume + amount });
});

indexer.onEvent({ contract: "XorvEscrow", event: "JobReleased", fields: TX }, async ({ event, context }) => {
  const { jobId, provider: payee, providerAmount, fee, resultHash, releasedBy } = event.params;
  const at = BigInt(event.block.timestamp);
  const job = await context.Job.get(jobId);
  if (!job) {
    context.log.warn(`release for unknown job ${jobId}`);
    return;
  }
  const seconds = at - job.fundedAt;
  context.Job.set({
    ...job,
    status: "Released",
    providerAmount,
    fee,
    resultHash,
    releasedBy: lower(releasedBy),
    settledAt: at,
    settleTx: event.transaction.hash,
    secondsToSettle: seconds,
  });

  const b = await context.Buyer.get(job.buyer_id);
  if (b) context.Buyer.set({ ...b, spent: b.spent + job.amount });

  const p = await provider(context, payee);
  context.Provider.set({ ...p.row, earned: p.row.earned + providerAmount });

  const net = await network(context);
  context.Network.set(
    withSettleTime(
      {
        ...net,
        jobsReleased: net.jobsReleased + 1,
        paidToProviders: net.paidToProviders + providerAmount,
        fees: net.fees + fee,
        providers: net.providers + (p.isNew ? 1 : 0),
      },
      seconds,
    ),
  );

  const day = await daily(context, event.block.timestamp);
  context.DailyStat.set({
    ...day,
    jobsReleased: day.jobsReleased + 1,
    paidToProviders: day.paidToProviders + providerAmount,
  });
});

indexer.onEvent({ contract: "XorvEscrow", event: "JobRefunded", fields: TX }, async ({ event, context }) => {
  const { jobId, amount, providerAtFault } = event.params;
  const at = BigInt(event.block.timestamp);
  const job = await context.Job.get(jobId);
  if (!job) {
    context.log.warn(`refund for unknown job ${jobId}`);
    return;
  }
  const seconds = at - job.fundedAt;
  context.Job.set({
    ...job,
    status: "Refunded",
    providerAtFault,
    settledAt: at,
    settleTx: event.transaction.hash,
    secondsToSettle: seconds,
  });

  const b = await context.Buyer.get(job.buyer_id);
  if (b) context.Buyer.set({ ...b, refunded: b.refunded + amount });

  if (providerAtFault) {
    const p = await context.Provider.get(job.provider_id);
    if (p) context.Provider.set({ ...p, refundsAtFault: p.refundsAtFault + 1 });
  }

  const net = await network(context);
  context.Network.set(
    withSettleTime(
      {
        ...net,
        jobsRefunded: net.jobsRefunded + 1,
        refundsAtFault: net.refundsAtFault + (providerAtFault ? 1 : 0),
        refunded: net.refunded + amount,
      },
      seconds,
    ),
  );

  const day = await daily(context, event.block.timestamp);
  context.DailyStat.set({ ...day, jobsRefunded: day.jobsRefunded + 1 });
});

indexer.onEvent({ contract: "XorvEscrow", event: "JobReassigned" }, async ({ event, context }) => {
  const { jobId, newProvider } = event.params;
  const job = await context.Job.get(jobId);
  if (!job) return;
  context.Job.set({ ...job, provider_id: lower(newProvider), reassignments: job.reassignments + 1 });
  const p = await provider(context, newProvider);
  context.Provider.set({ ...p.row, jobsAssigned: p.row.jobsAssigned + 1 });
  if (p.isNew) {
    const net = await network(context);
    context.Network.set({ ...net, providers: net.providers + 1 });
  }
});

indexer.onEvent({ contract: "XorvEscrow", event: "RegistryCallFailed" }, async ({ context }) => {
  const net = await network(context);
  context.Network.set({ ...net, registryCallFailures: net.registryCallFailures + 1 });
});

// ---------------------------------------------------------------- registry

indexer.onEvent(
  { contract: "XorvRegistry", event: "ProviderRegistered", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const p = await provider(context, event.params.provider);
    context.Provider.set({
      ...p.row,
      nodeId: event.params.nodeId,
      registered: true,
      active: true,
      registeredAt: p.row.registeredAt ?? BigInt(event.block.timestamp),
    });
    if (p.isNew) {
      const net = await network(context);
      context.Network.set({ ...net, providers: net.providers + 1 });
    }
  },
);

indexer.onEvent({ contract: "XorvRegistry", event: "ProviderDeactivated" }, async ({ event, context }) => {
  const p = await context.Provider.get(lower(event.params.provider));
  if (p) context.Provider.set({ ...p, active: false });
});

indexer.onEvent({ contract: "XorvRegistry", event: "Heartbeat" }, async ({ event, context }) => {
  const p = await provider(context, event.params.provider);
  context.Provider.set({
    ...p.row,
    lastHeartbeat: event.params.timestamp,
    heartbeats: p.row.heartbeats + 1,
  });
  // Count each provider once per day it was alive.
  const key = `${p.row.id}-${dayOf(event.params.timestamp)}`;
  if (!(await context.ProviderDay.get(key))) {
    context.ProviderDay.set({ id: key });
    const day = await daily(context, Number(event.params.timestamp));
    context.DailyStat.set({ ...day, activeProviders: day.activeProviders + 1 });
  }
});

indexer.onEvent({ contract: "XorvRegistry", event: "OutcomeRecorded" }, async ({ event, context }) => {
  const { completed, failed } = event.params;
  const p = await provider(context, event.params.provider);
  // The registry emits its own counters after the update, so these are exact, not tallied.
  context.Provider.set({ ...p.row, completed, failed, scoreBps: laplaceBps(completed, failed) });
});

// ---------------------------------------------------------------- audit log

interface ReceiptEnvelope {
  kind?: string;
  data?: {
    jobId?: string;
    providerAddress?: string;
    amount?: string;
    transactionHash?: string;
    resultHash?: string;
    ok?: boolean;
    settlement?: { state?: string };
  };
}

indexer.onEvent({ contract: "XorvLog", event: "Entry", fields: TX }, async ({ event, context }) => {
  if (event.params.kind !== KIND_RECEIPT) return;
  let envelope: ReceiptEnvelope = {};
  try {
    envelope = JSON.parse(event.params.payload) as ReceiptEnvelope;
  } catch {
    context.log.warn(`unparseable receipt payload in ${event.transaction.hash}`);
  }
  const d = envelope.data ?? {};
  // A receipt names the funding transaction; the escrowed job funded by it is the one it settles.
  const funded = d.transactionHash
    ? await context.Job.getWhere({ fundTx: { _eq: d.transactionHash.toLowerCase() } })
    : [];
  const fundedExact = funded.length
    ? funded
    : d.transactionHash
      ? await context.Job.getWhere({ fundTx: { _eq: d.transactionHash } })
      : [];

  context.Receipt.set({
    id: `${event.block.number}_${event.logIndex}`,
    job_id: fundedExact[0]?.id,
    seq: event.params.seq,
    author: lower(event.params.author),
    providerAddress: d.providerAddress ? lower(d.providerAddress) : undefined,
    amount: d.amount && /^\d+$/.test(d.amount) ? BigInt(d.amount) : undefined,
    resultHash: d.resultHash,
    ok: d.ok,
    settlementState: d.settlement?.state,
    at: BigInt(event.block.timestamp),
    tx: event.transaction.hash,
  });

  const net = await network(context);
  context.Network.set({ ...net, receipts: net.receipts + 1 });
});
