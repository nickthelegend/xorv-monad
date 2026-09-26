/**
 * ERC-8004 ReputationRegistry (v2.0.0) handlers.
 *
 * giveFeedback is open to any address, so raw feedback is Sybil-prone. Each entry is
 * classified once, when it arrives, and only two kinds feed Xorv scores:
 *   BUYER_RATING   tag1 "starred" whose client is the XorvLedger: rateJob relays exactly
 *                  one per paid job, authorised by the buyer who paid for it.
 *   XORV_VERIFIED  tag1 "xorv-verified" whose client is the ledger's broker at that
 *                  moment (Broker.active): the Kimi result verifier.
 * Everything else is kept (it is still public reputation) as OTHER. Who counts as the
 * ledger or the verifier is decided in lib/trust.ts.
 */

import { indexer, type Feedback } from "envio";
import { TAG_STARRED, TAG_VERIFIED } from "../lib/constants.js";
import {
  DailyStatsCache,
  loadAgent,
  loadNetworkStats,
  saveNetworkStats,
  type Context,
} from "../lib/entities.js";
import { isLedgerClient, isVerifierClient } from "../lib/trust.js";
import { feedbackId, lower, normalizeFeedbackValue, ratio } from "../lib/util.js";

async function classify(context: Context, client: string, tag1: string): Promise<Feedback["kind"]> {
  if (tag1 === TAG_STARRED && (await isLedgerClient(context, client))) return "BUYER_RATING";
  if (tag1 === TAG_VERIFIED && (await isVerifierClient(context, client))) return "XORV_VERIFIED";
  return "OTHER";
}

indexer.onEvent(
  {
    contract: "ReputationRegistry",
    event: "NewFeedback",
    fields: { block: ["timestamp"], transaction: ["hash"] },
  },
  async ({ event, context }) => {
    const p = event.params;
    const ts = event.block.timestamp;
    const client = lower(p.clientAddress);
    const id = feedbackId(p.agentId, client, p.feedbackIndex);
    if (await context.Feedback.get(id)) {
      context.log.warn("duplicate NewFeedback ignored", { id });
      return;
    }

    const decimals = Number(p.valueDecimals);
    const normalized = normalizeFeedbackValue(p.value, decimals);
    const kind = await classify(context, client, p.tag1);

    context.Feedback.set({
      id,
      agent_id: p.agentId.toString(),
      client,
      feedbackIndex: p.feedbackIndex,
      value: p.value,
      decimals,
      normalizedValue: normalized,
      tag1: p.tag1,
      tag2: p.tag2,
      endpoint: p.endpoint,
      feedbackURI: p.feedbackURI,
      feedbackHash: lower(p.feedbackHash),
      kind,
      revoked: false,
      revokedAt: undefined,
      responsesCount: 0,
      job_id: undefined,
      blockNumber: event.block.number,
      blockTimestamp: ts,
      txHash: lower(event.transaction.hash),
      logIndex: event.logIndex,
    });

    const agent = await loadAgent(context, p.agentId);
    agent.feedbackCount += 1;
    agent.feedbackSum += normalized;
    agent.feedbackAvg = ratio(agent.feedbackSum, agent.feedbackCount);
    agent.lastFeedbackAt = ts;

    const stats = await loadNetworkStats(context);
    stats.feedbacks += 1;

    if (kind === "BUYER_RATING") {
      agent.buyerRatingCount += 1;
      agent.buyerRatingSum += normalized;
      agent.buyerRatingAvg = ratio(agent.buyerRatingSum, agent.buyerRatingCount);
      // XorvLedger emits JobRated right after this, in the same tx; it links back via this.
      agent.lastLedgerFeedbackId = id;
    } else if (kind === "XORV_VERIFIED") {
      agent.verifiedCount += 1;
      agent.verifiedSum += normalized;
      agent.verifiedScore = ratio(agent.verifiedSum, agent.verifiedCount);
      stats.verifiedFeedbacks += 1;
      const broker = await context.Broker.get(client);
      if (broker) context.Broker.set({ ...broker, verifiedFeedbacks: broker.verifiedFeedbacks + 1 });
    }
    context.Agent.set(agent);

    const days = new DailyStatsCache(context);
    (await days.get(ts)).feedbacks += 1;
    days.saveAll();
    saveNetworkStats(context, stats, event.block);
  },
);

indexer.onEvent(
  { contract: "ReputationRegistry", event: "FeedbackRevoked", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const p = event.params;
    const id = feedbackId(p.agentId, p.clientAddress, p.feedbackIndex);
    const feedback = await context.Feedback.get(id);
    // Unknown (predates the start block) or already revoked: nothing to take back.
    if (!feedback || feedback.revoked) return;

    context.Feedback.set({ ...feedback, revoked: true, revokedAt: event.block.timestamp });

    // Undo exactly what NewFeedback added, using the kind stored then: whether the client
    // is still the broker today does not change what the entry counted as.
    const n = feedback.normalizedValue;
    const agent = await loadAgent(context, p.agentId);
    agent.feedbackCount = Math.max(0, agent.feedbackCount - 1);
    agent.feedbackRevoked += 1;
    agent.feedbackSum -= n;
    agent.feedbackAvg = ratio(agent.feedbackSum, agent.feedbackCount);

    const stats = await loadNetworkStats(context);
    stats.feedbacks = Math.max(0, stats.feedbacks - 1);

    if (feedback.kind === "BUYER_RATING") {
      agent.buyerRatingCount = Math.max(0, agent.buyerRatingCount - 1);
      agent.buyerRatingSum -= n;
      agent.buyerRatingAvg = ratio(agent.buyerRatingSum, agent.buyerRatingCount);
    } else if (feedback.kind === "XORV_VERIFIED") {
      agent.verifiedCount = Math.max(0, agent.verifiedCount - 1);
      agent.verifiedSum -= n;
      agent.verifiedScore = ratio(agent.verifiedSum, agent.verifiedCount);
      stats.verifiedFeedbacks = Math.max(0, stats.verifiedFeedbacks - 1);
      const broker = await context.Broker.get(feedback.client);
      if (broker) {
        context.Broker.set({ ...broker, verifiedFeedbacks: Math.max(0, broker.verifiedFeedbacks - 1) });
      }
    }
    // Float sums drift by ~1e-15 per add/subtract pair; snap an emptied bucket to 0.
    if (agent.feedbackCount === 0) agent.feedbackSum = 0;
    if (agent.buyerRatingCount === 0) agent.buyerRatingSum = 0;
    if (agent.verifiedCount === 0) agent.verifiedSum = 0;
    context.Agent.set(agent);
    saveNetworkStats(context, stats, event.block);
  },
);

indexer.onEvent(
  {
    contract: "ReputationRegistry",
    event: "ResponseAppended",
    fields: { block: ["timestamp"], transaction: ["hash"] },
  },
  async ({ event, context }) => {
    const p = event.params;
    const target = feedbackId(p.agentId, p.clientAddress, p.feedbackIndex);
    context.FeedbackResponse.set({
      id: `${event.block.number}-${event.logIndex}`,
      feedback_id: target,
      responder: lower(p.responder),
      responseURI: p.responseURI,
      responseHash: lower(p.responseHash),
      blockTimestamp: event.block.timestamp,
      txHash: lower(event.transaction.hash),
    });
    const feedback = await context.Feedback.get(target);
    if (feedback) context.Feedback.set({ ...feedback, responsesCount: feedback.responsesCount + 1 });
  },
);
