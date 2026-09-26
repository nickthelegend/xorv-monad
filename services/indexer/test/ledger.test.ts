/**
 * XorvLedger handlers and the aggregates they maintain, driven through envio's test
 * indexer with simulated events (no network, no database).
 */

import { describe, expect, it } from "vitest";
import {
  DAY,
  LEDGER,
  NO_AGENT,
  Sim,
  T0,
  addr,
  hash32,
  id32,
  identity,
  ledger,
  reputation,
} from "./harness.js";

const BROKER = addr(0xb0);
const OWNER = addr(0x0e);
const PAYEE_A = addr(0xa1);
const PAYEE_B = addr(0xa2);
const BUYER_1 = addr(0xc1);
const BUYER_2 = addr(0xc2);
const NODE_A = id32("node-alpha");
const NODE_B = id32("node-beta");
const AGENT_A = 7n;

const usdc = (n: number) => BigInt(Math.round(n * 1_000_000));

describe("roles", () => {
  it("tracks the broker and owner, and retires a rotated broker", async () => {
    const sim = new Sim();
    await sim.run(ledger.ownershipTransferred(addr(0), OWNER), ledger.brokerSet(BROKER));

    const first = await sim.indexer.Ledger.getOrThrow(LEDGER);
    expect(first).toMatchObject({ broker: BROKER, owner: OWNER, brokerChanges: 1 });
    expect(await sim.indexer.Broker.getOrThrow(BROKER)).toMatchObject({
      active: true,
      ledger_id: LEDGER,
      until: undefined,
    });

    const next = addr(0xb1);
    await sim.run(ledger.brokerSet(next));
    expect(await sim.indexer.Broker.getOrThrow(BROKER)).toMatchObject({ active: false, until: sim.time });
    expect(await sim.indexer.Broker.getOrThrow(next)).toMatchObject({ active: true, since: sim.time });
    expect((await sim.indexer.Ledger.getOrThrow(LEDGER)).brokerChanges).toBe(2);
  });
});

describe("ProviderRegistered", () => {
  it("creates a provider with its offers and links its ERC-8004 agent", async () => {
    const sim = new Sim();
    await sim.run(identity.mint(PAYEE_A, AGENT_A), identity.registered(AGENT_A, PAYEE_A));
    const tx = await sim.run(
      ledger.providerRegistered({
        providerId: NODE_A,
        payTo: PAYEE_A,
        agentId: AGENT_A,
        label: "alpha (Claude Code)",
        capabilities: "claude-code:10000, qwen:5000,broken,:1,kimi:abc",
      }),
    );

    const provider = await sim.indexer.Provider.getOrThrow(NODE_A);
    expect(provider).toMatchObject({
      payTo: PAYEE_A,
      agent_id: "7",
      label: "alpha (Claude Code)",
      adapters: ["claude-code", "qwen"],
      registrations: 1,
      registeredAt: sim.time,
      registeredTx: tx,
      jobsTotal: 0,
      earnedUsdc: 0n,
      successRate: 0,
    });
    expect(await sim.indexer.ProviderCapability.getOrThrow(`${NODE_A}-qwen`)).toMatchObject({
      adapter: "qwen",
      priceUsdMicros: 5000n,
      active: true,
    });
    expect(await sim.indexer.ProviderCapability.get(`${NODE_A}-kimi`)).toBeUndefined();

    const agent = await sim.indexer.Agent.getOrThrow("7");
    expect(agent).toMatchObject({ isXorvProvider: true, provider_id: NODE_A });

    const stats = await sim.indexer.NetworkStats.getOrThrow("global");
    expect(stats).toMatchObject({ providers: 1, agentsLinked: 1, agentsTotal: 1 });
    expect((await sim.indexer.DailyStats.getOrThrow("2026-09-26")).newProviders).toBe(1);
  });

  it("re-registration updates metadata, retires dropped offers and never double counts", async () => {
    const sim = new Sim();
    await sim.run(
      ledger.providerRegistered({ providerId: NODE_A, payTo: PAYEE_A, agentId: AGENT_A, capabilities: "claude-code:10000,qwen:5000" }),
    );
    const firstSeen = sim.time;
    await sim.run(
      ledger.providerRegistered({
        providerId: NODE_A,
        payTo: PAYEE_A,
        agentId: AGENT_A,
        label: "alpha v2",
        capabilities: "claude-code:12000",
      }),
    );

    const provider = await sim.indexer.Provider.getOrThrow(NODE_A);
    expect(provider).toMatchObject({
      label: "alpha v2",
      adapters: ["claude-code"],
      registrations: 2,
      registeredAt: firstSeen,
      updatedAt: sim.time,
    });
    expect(await sim.indexer.ProviderCapability.getOrThrow(`${NODE_A}-qwen`)).toMatchObject({ active: false });
    expect(await sim.indexer.ProviderCapability.getOrThrow(`${NODE_A}-claude-code`)).toMatchObject({
      active: true,
      priceUsdMicros: 12000n,
    });
    expect(await sim.indexer.NetworkStats.getOrThrow("global")).toMatchObject({ providers: 1, agentsLinked: 1 });
  });

  it("does not touch any agent for a NO_AGENT provider", async () => {
    const sim = new Sim();
    await sim.run(identity.registered(0n, PAYEE_B));
    await sim.run(ledger.providerRegistered({ providerId: NODE_B, payTo: PAYEE_B }));

    expect((await sim.indexer.Provider.getOrThrow(NODE_B)).agent_id).toBeUndefined();
    expect((await sim.indexer.Agent.getOrThrow("0")).isXorvProvider).toBe(false);
    expect((await sim.indexer.NetworkStats.getOrThrow("global")).agentsLinked).toBe(0);
  });
});

describe("ProviderHeartbeat", () => {
  it("records liveness on the provider and the network", async () => {
    const sim = new Sim();
    await sim.run(ledger.providerRegistered({ providerId: NODE_A, payTo: PAYEE_A }));
    await sim.run(ledger.heartbeat(NODE_A, 2, 8, 3600));

    expect(await sim.indexer.Provider.getOrThrow(NODE_A)).toMatchObject({
      heartbeats: 1,
      lastHeartbeatAt: sim.time,
      activeJobs: 2,
      capacity: 8,
      uptimeSeconds: 3600,
    });
    await sim.run(ledger.heartbeat(NODE_B)); // never registered
    expect(await sim.indexer.Provider.get(NODE_B)).toBeUndefined();
    expect((await sim.indexer.NetworkStats.getOrThrow("global")).heartbeats).toBe(2);
    expect((await sim.indexer.DailyStats.getOrThrow("2026-09-26")).heartbeats).toBe(2);
  });
});

describe("JobRecorded", () => {
  it("folds receipts into provider, buyer, network and daily aggregates", async () => {
    const sim = new Sim();
    await sim.run(ledger.providerRegistered({ providerId: NODE_A, payTo: PAYEE_A, agentId: AGENT_A }));

    sim.tx(ledger.jobRecorded({ jobId: id32("j1"), agentId: AGENT_A, buyer: BUYER_1, payTo: PAYEE_A, amount: usdc(0.25), durationMs: 1000 }));
    sim.tx(ledger.jobRecorded({ jobId: id32("j2"), agentId: AGENT_A, buyer: BUYER_2, payTo: PAYEE_A, amount: usdc(0.5), durationMs: 3000 }));
    // Paid but failed: settled to the provider, not earned.
    sim.tx(ledger.jobRecorded({ jobId: id32("j3"), agentId: AGENT_A, buyer: BUYER_1, payTo: PAYEE_A, amount: usdc(1), durationMs: 90_000, ok: false }));
    // Recorded but never paid: a job, not volume.
    sim.tx(ledger.jobRecorded({ jobId: id32("j4"), agentId: AGENT_A, buyer: BUYER_1, payTo: PAYEE_A, amount: usdc(2), durationMs: 2000, paid: false }));
    await sim.flush();

    const provider = await sim.indexer.Provider.getOrThrow(NODE_A);
    expect(provider).toMatchObject({
      jobsTotal: 4,
      jobsOk: 3,
      jobsFailed: 1,
      successRate: 0.75,
      earnedUsdc: usdc(0.75),
      settledUsdc: usdc(1.75),
      totalDurationMs: 6000n,
      avgDurationMs: 2000,
      lastJobAt: sim.time,
    });

    const job = await sim.indexer.Job.getOrThrow(id32("j3"));
    expect(job).toMatchObject({
      provider_id: NODE_A,
      agent_id: "7",
      buyer_id: BUYER_1,
      payTo: PAYEE_A,
      amount: usdc(1),
      paid: true,
      ok: false,
      rated: false,
      durationMs: 90_000,
      day: "2026-09-26",
      attributionKey: "agent:7",
    });
    expect((await sim.indexer.Job.getOrThrow(id32("j4"))).paid).toBe(false);

    expect(await sim.indexer.Buyer.getOrThrow(BUYER_1)).toMatchObject({
      jobsTotal: 3,
      jobsOk: 2,
      spentUsdc: usdc(1.25),
    });

    expect(await sim.indexer.NetworkStats.getOrThrow("global")).toMatchObject({
      jobs: 4,
      okJobs: 3,
      failedJobs: 1,
      paidJobs: 3,
      buyers: 2,
      volumeUsdc: usdc(1.75),
      earnedUsdc: usdc(0.75),
      successRate: 0.75,
      lastBlock: sim.block,
      lastUpdated: sim.time,
    });

    expect(await sim.indexer.DailyStats.getOrThrow("2026-09-26")).toMatchObject({
      dayStart: Math.floor(T0 / DAY) * DAY,
      jobs: 4,
      okJobs: 3,
      failedJobs: 1,
      volumeUsdc: usdc(1.75),
      uniqueBuyers: 2,
      newBuyers: 2,
      activeProviders: 1,
    });
    expect(await sim.indexer.ProviderDay.getOrThrow(`${NODE_A}-2026-09-26`)).toMatchObject({
      jobs: 4,
      okJobs: 3,
      earnedUsdc: usdc(0.75),
    });
  });

  it("splits daily stats at the UTC day boundary and keeps distinct counts exact", async () => {
    const sim = new Sim();
    await sim.run(ledger.providerRegistered({ providerId: NODE_A, payTo: PAYEE_A, agentId: AGENT_A }));
    sim.tx(ledger.jobRecorded({ jobId: id32("d1"), agentId: AGENT_A, buyer: BUYER_1, payTo: PAYEE_A, amount: usdc(1) }));
    sim.tx(ledger.jobRecorded({ jobId: id32("d2"), agentId: AGENT_A, buyer: BUYER_1, payTo: PAYEE_A, amount: usdc(1) }));
    sim.advance(DAY);
    sim.tx(ledger.jobRecorded({ jobId: id32("d3"), agentId: AGENT_A, buyer: BUYER_1, payTo: PAYEE_A, amount: usdc(3) }));
    await sim.flush();

    expect(await sim.indexer.DailyStats.getOrThrow("2026-09-26")).toMatchObject({
      jobs: 2,
      uniqueBuyers: 1,
      newBuyers: 1,
      activeProviders: 1,
      volumeUsdc: usdc(2),
    });
    expect(await sim.indexer.DailyStats.getOrThrow("2026-09-27")).toMatchObject({
      jobs: 1,
      uniqueBuyers: 1,
      newBuyers: 0,
      activeProviders: 1,
      volumeUsdc: usdc(3),
    });
    expect((await sim.indexer.BuyerDay.getOrThrow(`${BUYER_1}-2026-09-27`)).spentUsdc).toBe(usdc(3));
    expect((await sim.indexer.ProviderDay.getOrThrow(`${NODE_A}-2026-09-27`)).earnedUsdc).toBe(usdc(3));
  });

  it("attributes NO_AGENT receipts by payee", async () => {
    const sim = new Sim();
    await sim.run(ledger.providerRegistered({ providerId: NODE_B, payTo: PAYEE_B }));
    await sim.run(ledger.jobRecorded({ jobId: id32("nb"), buyer: BUYER_1, payTo: PAYEE_B, amount: usdc(0.1) }));

    expect(await sim.indexer.Job.getOrThrow(id32("nb"))).toMatchObject({
      provider_id: NODE_B,
      agent_id: undefined,
      attributionKey: `payto:${PAYEE_B}`,
    });
    expect((await sim.indexer.Provider.getOrThrow(NODE_B)).earnedUsdc).toBe(usdc(0.1));
  });

  it("ignores a replayed receipt", async () => {
    const sim = new Sim();
    await sim.run(ledger.providerRegistered({ providerId: NODE_A, payTo: PAYEE_A, agentId: AGENT_A }));
    const receipt = ledger.jobRecorded({ jobId: id32("dup"), agentId: AGENT_A, buyer: BUYER_1, payTo: PAYEE_A, amount: usdc(1) });
    await sim.run(receipt);
    await sim.run(receipt);

    expect((await sim.indexer.Provider.getOrThrow(NODE_A)).jobsTotal).toBe(1);
    expect((await sim.indexer.NetworkStats.getOrThrow("global")).volumeUsdc).toBe(usdc(1));
  });

  it("back-fills receipts recorded before their provider registration was indexed", async () => {
    const sim = new Sim();
    const buyerSig = addr(0x51);
    // Receipts and a rating for agent 7 arrive before any ProviderRegistered for it.
    sim.tx(ledger.jobRecorded({ jobId: id32("o1"), agentId: AGENT_A, buyer: buyerSig, payTo: PAYEE_A, amount: usdc(0.4), durationMs: 500 }));
    sim.tx(ledger.jobRecorded({ jobId: id32("o2"), agentId: AGENT_A, buyer: buyerSig, payTo: PAYEE_A, amount: usdc(0.6), durationMs: 1500 }));
    sim.tx(ledger.jobRated({ jobId: id32("o1"), agentId: AGENT_A, buyer: buyerSig, value: 60 }));
    await sim.flush();
    expect((await sim.indexer.Job.getOrThrow(id32("o1"))).provider_id).toBeUndefined();
    expect((await sim.indexer.DailyStats.getOrThrow("2026-09-26")).activeProviders).toBe(0);

    await sim.run(ledger.providerRegistered({ providerId: NODE_A, payTo: PAYEE_A, agentId: AGENT_A }));

    expect((await sim.indexer.Job.getOrThrow(id32("o1"))).provider_id).toBe(NODE_A);
    expect((await sim.indexer.Job.getOrThrow(id32("o2"))).provider_id).toBe(NODE_A);
    expect((await sim.indexer.Rating.getOrThrow(id32("o1"))).provider_id).toBe(NODE_A);
    expect(await sim.indexer.Provider.getOrThrow(NODE_A)).toMatchObject({
      jobsTotal: 2,
      jobsOk: 2,
      earnedUsdc: usdc(1),
      avgDurationMs: 1000,
      ratingsCount: 1,
      avgRating: 60,
    });
    expect(await sim.indexer.ProviderDay.getOrThrow(`${NODE_A}-2026-09-26`)).toMatchObject({
      jobs: 2,
      ratings: 1,
      ratingSum: 60,
    });
    const day = await sim.indexer.DailyStats.getOrThrow("2026-09-26");
    expect(day).toMatchObject({ activeProviders: 1, jobs: 2, ratings: 1 });
  });

  it("hands an agent's new receipts to a newer provider without taking the old ones", async () => {
    const sim = new Sim();
    await sim.run(ledger.providerRegistered({ providerId: NODE_A, payTo: PAYEE_A, agentId: AGENT_A }));
    await sim.run(ledger.jobRecorded({ jobId: id32("before"), agentId: AGENT_A, buyer: BUYER_1, payTo: PAYEE_A, amount: usdc(1) }));
    // The same node re-registers under a new broker-side id with the same identity.
    await sim.run(ledger.providerRegistered({ providerId: NODE_B, payTo: PAYEE_A, agentId: AGENT_A }));
    await sim.run(ledger.jobRecorded({ jobId: id32("after"), agentId: AGENT_A, buyer: BUYER_1, payTo: PAYEE_A, amount: usdc(2) }));

    expect((await sim.indexer.Job.getOrThrow(id32("before"))).provider_id).toBe(NODE_A);
    expect((await sim.indexer.Job.getOrThrow(id32("after"))).provider_id).toBe(NODE_B);
    expect(await sim.indexer.Provider.getOrThrow(NODE_A)).toMatchObject({ jobsTotal: 1, earnedUsdc: usdc(1) });
    expect(await sim.indexer.Provider.getOrThrow(NODE_B)).toMatchObject({ jobsTotal: 1, earnedUsdc: usdc(2) });
    expect((await sim.indexer.Agent.getOrThrow("7")).provider_id).toBe(NODE_B);
    expect(await sim.indexer.NetworkStats.getOrThrow("global")).toMatchObject({ providers: 2, agentsLinked: 1, jobs: 2 });
  });
});

describe("JobRated", () => {
  it("records ratings, averages them and links the relayed ERC-8004 feedback", async () => {
    const sim = new Sim();
    await sim.run(ledger.brokerSet(BROKER));
    await sim.run(ledger.providerRegistered({ providerId: NODE_A, payTo: PAYEE_A, agentId: AGENT_A }));
    sim.tx(ledger.jobRecorded({ jobId: id32("r1"), agentId: AGENT_A, buyer: BUYER_1, payTo: PAYEE_A, amount: usdc(1) }));
    sim.tx(ledger.jobRecorded({ jobId: id32("r2"), agentId: AGENT_A, buyer: BUYER_2, payTo: PAYEE_A, amount: usdc(1) }));
    await sim.flush();

    // rateJob: the ledger relays giveFeedback (NewFeedback, client = ledger), then emits JobRated.
    const fh1 = hash32(0x1111);
    const rateTx = sim.tx(
      reputation.newFeedback({ agentId: AGENT_A, client: LEDGER, index: 1n, value: 80n, tag1: "starred", feedbackHash: fh1 }),
      ledger.jobRated({ jobId: id32("r1"), agentId: AGENT_A, buyer: BUYER_1, value: 80, feedbackHash: fh1 }),
    );
    const fh2 = hash32(0x2222);
    sim.tx(
      reputation.newFeedback({ agentId: AGENT_A, client: LEDGER, index: 2n, value: 100n, tag1: "starred", feedbackHash: fh2 }),
      ledger.jobRated({ jobId: id32("r2"), agentId: AGENT_A, buyer: BUYER_2, value: 100, feedbackHash: fh2 }),
    );
    await sim.flush();

    const feedbackId = `7-${LEDGER}-1`;
    expect(await sim.indexer.Rating.getOrThrow(id32("r1"))).toMatchObject({
      job_id: id32("r1"),
      provider_id: NODE_A,
      agent_id: "7",
      buyer_id: BUYER_1,
      value: 80,
      feedbackHash: fh1,
      feedback_id: feedbackId,
      txHash: rateTx,
    });
    const feedback = await sim.indexer.Feedback.getOrThrow(feedbackId);
    expect(feedback).toMatchObject({ kind: "BUYER_RATING", job_id: id32("r1"), txHash: rateTx });
    // Same transaction and block, the relayed feedback logged first.
    const rating = await sim.indexer.Rating.getOrThrow(id32("r1"));
    expect(rating.blockNumber).toBe(feedback.blockNumber);
    expect(rating.logIndex).toBeGreaterThan(feedback.logIndex);
    expect(await sim.indexer.Job.getOrThrow(id32("r1"))).toMatchObject({ rated: true, rating: 80 });
    expect(await sim.indexer.Provider.getOrThrow(NODE_A)).toMatchObject({
      ratingsCount: 2,
      ratingSum: 180,
      avgRating: 90,
    });
    expect((await sim.indexer.Agent.getOrThrow("7")).buyerRatingAvg).toBe(90);
    expect((await sim.indexer.Buyer.getOrThrow(BUYER_1)).ratingsGiven).toBe(1);
    expect(await sim.indexer.NetworkStats.getOrThrow("global")).toMatchObject({
      ratings: 2,
      ratingSum: 180,
      avgRating: 90,
    });
    expect(await sim.indexer.DailyStats.getOrThrow("2026-09-26")).toMatchObject({ ratings: 2, avgRating: 90 });
    expect(await sim.indexer.ProviderDay.getOrThrow(`${NODE_A}-2026-09-26`)).toMatchObject({ ratings: 2, ratingSum: 180 });
  });

  it("does not link feedback from another transaction", async () => {
    const sim = new Sim();
    await sim.run(ledger.brokerSet(BROKER));
    await sim.run(ledger.providerRegistered({ providerId: NODE_A, payTo: PAYEE_A, agentId: AGENT_A }));
    await sim.run(ledger.jobRecorded({ jobId: id32("x1"), agentId: AGENT_A, buyer: BUYER_1, payTo: PAYEE_A, amount: usdc(1) }));
    await sim.run(reputation.newFeedback({ agentId: AGENT_A, client: LEDGER, index: 1n, value: 50n, tag1: "starred" }));
    await sim.run(ledger.jobRated({ jobId: id32("x1"), agentId: AGENT_A, buyer: BUYER_1, value: 50 }));

    expect((await sim.indexer.Rating.getOrThrow(id32("x1"))).feedback_id).toBeUndefined();
    expect((await sim.indexer.Provider.getOrThrow(NODE_A)).avgRating).toBe(50);
  });

  it("counts a job's rating once", async () => {
    const sim = new Sim();
    await sim.run(ledger.providerRegistered({ providerId: NODE_A, payTo: PAYEE_A, agentId: AGENT_A }));
    await sim.run(ledger.jobRecorded({ jobId: id32("once"), agentId: AGENT_A, buyer: BUYER_1, payTo: PAYEE_A, amount: usdc(1) }));
    const rating = ledger.jobRated({ jobId: id32("once"), agentId: AGENT_A, buyer: BUYER_1, value: 40 });
    await sim.run(rating);
    await sim.run(rating);

    expect((await sim.indexer.Provider.getOrThrow(NODE_A)).ratingsCount).toBe(1);
    expect((await sim.indexer.NetworkStats.getOrThrow("global")).ratings).toBe(1);
  });
});

it("reads NO_AGENT as the uint256 max sentinel", () => {
  expect(NO_AGENT).toBe(115792089237316195423570985008687907853269984665640564039457584007913129639935n);
});
