/**
 * XorvLedger handlers: provider registry, heartbeats, x402 job receipts, buyer ratings,
 * and the broker/owner roles.
 *
 * Every write here comes from the broker (onlyBroker) except rateJob, which the buyer
 * authorises. The ledger already rejects duplicate receipts and second ratings, so the
 * duplicate guards below are defensive: they keep aggregates honest if an event is ever
 * replayed outside Envio's own reorg handling.
 */

import { indexer, type Job, type Provider } from "envio";
import {
  creditJobToDay,
  creditJobToNetwork,
  creditJobToProvider,
  creditJobToProviderDay,
  creditRating,
  creditRatingToProvider,
} from "../lib/aggregates.js";
import { ZERO_ADDRESS } from "../lib/constants.js";
import {
  DailyStatsCache,
  emptyAgent,
  emptyBuyer,
  emptyProviderStats,
  loadAgent,
  loadBuyerDay,
  loadNetworkStats,
  loadProviderDay,
  saveNetworkStats,
  type Context,
} from "../lib/entities.js";
import {
  agentIdOrNone,
  attributionKey,
  dayOf,
  isZeroBytes32,
  lower,
  parseCapabilities,
  type Mutable,
} from "../lib/util.js";

// ---------------------------------------------------------------------------------------
// Roles. The broker address matters beyond bookkeeping: it is also the verifier EOA, so
// the Broker rows decide which "xorv-verified" feedback counts (ReputationRegistry.ts).

async function loadLedger(context: Context, id: string, timestamp: number) {
  const existing = await context.Ledger.get(id);
  return existing
    ? { ...existing }
    : { id, broker: ZERO_ADDRESS, owner: undefined, brokerChanges: 0, updatedAt: timestamp };
}

indexer.onEvent(
  { contract: "XorvLedger", event: "BrokerSet", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const ledger = await loadLedger(context, lower(event.srcAddress), ts);
    const broker = lower(event.params.broker);

    if (ledger.broker !== broker) {
      const previous = await context.Broker.get(ledger.broker);
      if (previous) context.Broker.set({ ...previous, active: false, until: ts });
    }
    const existing = await context.Broker.get(broker);
    context.Broker.set({
      id: broker,
      ledger_id: ledger.id,
      active: true,
      // A broker re-appointed later starts a new term; an idempotent re-set keeps its start.
      since: existing?.active ? existing.since : ts,
      until: undefined,
      verifiedFeedbacks: existing?.verifiedFeedbacks ?? 0,
    });

    ledger.broker = broker;
    ledger.brokerChanges += 1;
    ledger.updatedAt = ts;
    context.Ledger.set(ledger);
  },
);

indexer.onEvent(
  { contract: "XorvLedger", event: "OwnershipTransferred", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const ledger = await loadLedger(context, lower(event.srcAddress), event.block.timestamp);
    ledger.owner = lower(event.params.newOwner);
    ledger.updatedAt = event.block.timestamp;
    context.Ledger.set(ledger);
  },
);

// ---------------------------------------------------------------------------------------
// Providers

/**
 * The provider of an agent-less (NO_AGENT) receipt: the most recently registered
 * agent-less provider with that payee. Receipts with an agent use Agent.provider_id,
 * which always points at the latest provider registered with that agent.
 */
async function providerByPayTo(context: Context, payTo: string): Promise<Provider | undefined> {
  const candidates = await context.Provider.getWhere({ payTo: { _eq: payTo } });
  return candidates
    .filter((p) => p.agent_id === undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

indexer.onEvent(
  {
    contract: "XorvLedger",
    event: "ProviderRegistered",
    fields: { block: ["timestamp"], transaction: ["hash"] },
  },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const id = lower(event.params.providerId);
    const payTo = lower(event.params.payTo);
    const agentId = agentIdOrNone(event.params.agentId);
    const capabilities = parseCapabilities(event.params.capabilities);

    const existing = await context.Provider.get(id);
    const stats = await loadNetworkStats(context);
    const days = new DailyStatsCache(context);

    const provider: Mutable<Provider> = existing
      ? { ...existing }
      : {
          id,
          payTo,
          agent_id: agentId,
          label: event.params.label,
          capabilities: event.params.capabilities,
          adapters: [],
          registrations: 0,
          registeredAt: ts,
          registeredTx: lower(event.transaction.hash),
          updatedAt: ts,
          ...emptyProviderStats(),
        };
    const previousKey = existing ? attributionKey(existing.agent_id, existing.payTo) : undefined;
    const previousAgentId = existing?.agent_id;
    const previousAdapters = existing?.adapters ?? [];

    provider.payTo = payTo;
    provider.agent_id = agentId;
    provider.label = event.params.label;
    provider.capabilities = event.params.capabilities;
    provider.adapters = capabilities.map((c) => c.adapter);
    provider.registrations += 1;
    provider.updatedAt = ts;

    // Offers: upsert what is advertised now, retire what a re-registration dropped.
    for (const cap of capabilities) {
      context.ProviderCapability.set({
        id: `${id}-${cap.adapter}`,
        provider_id: id,
        adapter: cap.adapter,
        priceUsdMicros: cap.priceUsdMicros,
        active: true,
        updatedAt: ts,
      });
    }
    for (const adapter of previousAdapters) {
      if (provider.adapters.includes(adapter)) continue;
      const offer = await context.ProviderCapability.get(`${id}-${adapter}`);
      if (offer?.active) context.ProviderCapability.set({ ...offer, active: false, updatedAt: ts });
    }

    // Identity link. isXorvProvider is only ever set here, from a registration that
    // carried this agentId; the ledger checked getAgentWallet(agentId) == payTo first.
    if (agentId !== undefined) {
      const agent = await loadAgent(context, event.params.agentId);
      if (!agent.isXorvProvider) stats.agentsLinked += 1;
      agent.isXorvProvider = true;
      agent.provider_id = id;
      context.Agent.set(agent);
    }
    if (previousAgentId !== undefined && previousAgentId !== agentId) {
      // The provider moved to another identity (or dropped it). The old agent stays a
      // historical Xorv provider but no longer routes new receipts here.
      const old = await context.Agent.get(previousAgentId);
      if (old?.provider_id === id) context.Agent.set({ ...old, provider_id: undefined });
    }

    // Receipts recorded before this registration was indexed (or before the provider
    // moved to this agent/payee) have no provider yet. Claim them now so earnings and
    // success rate include them.
    const key = attributionKey(agentId, payTo);
    if (key !== previousKey) {
      const orphans = await context.Job.getWhere({ attributionKey: { _eq: key } });
      for (const job of orphans) {
        if (job.provider_id !== undefined) continue;
        const rating = job.rated ? job.rating : undefined;
        creditJobToProvider(provider, job);
        if (rating !== undefined) creditRatingToProvider(provider, rating);
        await creditJobToProviderDay(context, id, { ...job, rating }, days);
        context.Job.set({ ...job, provider_id: id });
        if (job.rated) {
          const record = await context.Rating.get(job.id);
          if (record && record.provider_id === undefined) {
            context.Rating.set({ ...record, provider_id: id });
          }
        }
      }
    }

    if (!existing) {
      stats.providers += 1;
      (await days.get(ts)).newProviders += 1;
    }

    context.Provider.set(provider);
    days.saveAll();
    saveNetworkStats(context, stats, event.block);
  },
);

indexer.onEvent(
  { contract: "XorvLedger", event: "ProviderHeartbeat", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const id = lower(event.params.providerId);
    const provider = await context.Provider.get(id);
    if (provider) {
      context.Provider.set({
        ...provider,
        heartbeats: provider.heartbeats + 1,
        lastHeartbeatAt: ts,
        activeJobs: Number(event.params.activeJobs),
        capacity: Number(event.params.capacity),
        uptimeSeconds: Number(event.params.uptimeSeconds),
      });
    } else {
      // The broker only heartbeats providers it registered, so this means the
      // registration is older than ENVIO_XORV_LEDGER_START_BLOCK.
      context.log.warn("heartbeat for an unindexed provider", { providerId: id });
    }

    const stats = await loadNetworkStats(context);
    stats.heartbeats += 1;
    const days = new DailyStatsCache(context);
    (await days.get(ts)).heartbeats += 1;
    days.saveAll();
    saveNetworkStats(context, stats, event.block);
  },
);

// ---------------------------------------------------------------------------------------
// Jobs

indexer.onEvent(
  {
    contract: "XorvLedger",
    event: "JobRecorded",
    fields: { block: ["timestamp"], transaction: ["hash"] },
  },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const id = lower(event.params.jobId);
    if (await context.Job.get(id)) {
      context.log.warn("duplicate JobRecorded ignored", { jobId: id });
      return;
    }

    const p = event.params;
    const agentId = agentIdOrNone(p.agentId);
    const payTo = lower(p.payTo);
    const buyerId = lower(p.buyer);

    let provider: Provider | undefined;
    if (agentId !== undefined) {
      const agent = await context.Agent.get(agentId);
      if (agent?.provider_id) provider = await context.Provider.get(agent.provider_id);
      // The Job.agent relation needs a row even when the mint predates the start block.
      if (!agent) context.Agent.set(emptyAgent(p.agentId));
    } else {
      provider = await providerByPayTo(context, payTo);
    }

    const job: Job = {
      id,
      provider_id: provider?.id,
      agent_id: agentId,
      attributionKey: attributionKey(agentId, payTo),
      buyer_id: buyerId,
      payTo,
      amount: p.amount,
      paid: !isZeroBytes32(p.paymentTx),
      paymentTx: lower(p.paymentTx),
      requestHash: lower(p.requestHash),
      resultHash: lower(p.resultHash),
      durationMs: Number(p.durationMs),
      ok: p.ok,
      rated: false,
      rating: undefined,
      ratedAt: undefined,
      day: dayOf(ts).id,
      blockNumber: event.block.number,
      blockTimestamp: ts,
      txHash: lower(event.transaction.hash),
      logIndex: event.logIndex,
    };
    context.Job.set(job);

    const stats = await loadNetworkStats(context);
    const days = new DailyStatsCache(context);
    const today = await days.get(ts);

    // Buyer and its day row (the row's first appearance is a unique buyer for the day).
    const existingBuyer = await context.Buyer.get(buyerId);
    const buyer = existingBuyer ? { ...existingBuyer } : emptyBuyer(buyerId, ts);
    buyer.jobsTotal += 1;
    if (job.ok) buyer.jobsOk += 1;
    if (job.paid) buyer.spentUsdc += job.amount;
    buyer.lastJobAt = Math.max(buyer.lastJobAt, ts);
    context.Buyer.set(buyer);
    if (!existingBuyer) {
      stats.buyers += 1;
      today.newBuyers += 1;
    }
    const buyerDay = await loadBuyerDay(context, buyerId, ts);
    buyerDay.row.jobs += 1;
    if (job.paid) buyerDay.row.spentUsdc += job.amount;
    context.BuyerDay.set(buyerDay.row);
    if (buyerDay.isNew) today.uniqueBuyers += 1;

    if (provider) {
      const updated = { ...provider };
      creditJobToProvider(updated, job);
      context.Provider.set(updated);
      await creditJobToProviderDay(context, provider.id, job, days);
    }

    creditJobToNetwork(stats, job);
    creditJobToDay(today, job);
    days.saveAll();
    saveNetworkStats(context, stats, event.block);
  },
);

indexer.onEvent(
  {
    contract: "XorvLedger",
    event: "JobRated",
    fields: { block: ["timestamp"], transaction: ["hash"] },
  },
  async ({ event, context }) => {
    const ts = event.block.timestamp;
    const jobId = lower(event.params.jobId);
    if (await context.Rating.get(jobId)) {
      context.log.warn("duplicate JobRated ignored", { jobId });
      return;
    }
    const value = Number(event.params.value);
    const txHash = lower(event.transaction.hash);
    const feedbackHash = lower(event.params.feedbackHash);
    const agentId = event.params.agentId.toString();
    const buyerId = lower(event.params.buyer);

    const job = await context.Job.get(jobId);
    const agent = await context.Agent.get(agentId);
    const providerId = job?.provider_id ?? (job ? undefined : agent?.provider_id);

    // rateJob relays giveFeedback first, so the ERC-8004 entry is already indexed, one
    // log earlier in this same transaction. Match on tx + hash, never on "latest" alone.
    let feedbackRef: string | undefined;
    if (agent?.lastLedgerFeedbackId) {
      const feedback = await context.Feedback.get(agent.lastLedgerFeedbackId);
      if (feedback && feedback.txHash === txHash && feedback.feedbackHash === feedbackHash) {
        feedbackRef = feedback.id;
        context.Feedback.set({ ...feedback, job_id: jobId });
      }
    }

    context.Rating.set({
      id: jobId,
      job_id: jobId,
      provider_id: providerId,
      agent_id: agentId,
      buyer_id: buyerId,
      value,
      feedbackHash,
      feedback_id: feedbackRef,
      blockNumber: event.block.number,
      blockTimestamp: ts,
      txHash,
      logIndex: event.logIndex,
    });
    if (job) context.Job.set({ ...job, rated: true, rating: value, ratedAt: ts });

    if (providerId) {
      const provider = await context.Provider.get(providerId);
      if (provider) {
        const updated = { ...provider };
        creditRatingToProvider(updated, value);
        context.Provider.set(updated);
      }
      if (job) {
        // Credit the day the rated work was done, so a ProviderDay only ever exists for
        // days the provider had jobs (it doubles as the activeProviders marker).
        const { row } = await loadProviderDay(context, providerId, job.blockTimestamp);
        row.ratings += 1;
        row.ratingSum += value;
        context.ProviderDay.set(row);
      }
    }

    const buyer = await context.Buyer.get(buyerId);
    if (buyer) context.Buyer.set({ ...buyer, ratingsGiven: buyer.ratingsGiven + 1 });

    const stats = await loadNetworkStats(context);
    creditRating(stats, value);
    const days = new DailyStatsCache(context);
    creditRating(await days.get(ts), value);
    days.saveAll();
    saveNetworkStats(context, stats, event.block);
  },
);
