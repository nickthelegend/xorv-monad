/**
 * ERC-8004 IdentityRegistry + ReputationRegistry handlers: agent directory, wallet
 * tracking, feedback classification, revocation and responses.
 */

import { describe, expect, it } from "vitest";
import { CONFIGURED_VERIFIER, LEDGER, Sim, addr, hash32, identity, ledger, reputation } from "./harness.js";

const OWNER = addr(0x0a);
const NEW_OWNER = addr(0x0b);
const BROKER = addr(0xb0);
const STRANGER = addr(0x5e);
const AGENT = 42n;

describe("IdentityRegistry", () => {
  it("builds the agent from a register() transaction", async () => {
    const sim = new Sim();
    // register(uri) logs: Transfer (mint), Registered, MetadataSet("agentWallet").
    const tx = await sim.run(
      identity.mint(OWNER, AGENT),
      identity.registered(AGENT, OWNER, "https://broker.xorv.test/agents/node-1.json"),
      identity.metadataSet(AGENT, "agentWallet", OWNER),
    );

    expect(await sim.indexer.Agent.getOrThrow("42")).toMatchObject({
      agentId: 42n,
      owner: OWNER,
      agentURI: "https://broker.xorv.test/agents/node-1.json",
      wallet: OWNER,
      registeredAt: sim.time,
      registeredTx: tx,
      transfers: 0,
      isXorvProvider: false,
    });
    expect((await sim.indexer.NetworkStats.getOrThrow("global")).agentsTotal).toBe(1);
  });

  it("follows URI updates, transfers and the wallet reset a transfer causes", async () => {
    const sim = new Sim();
    await sim.run(identity.mint(OWNER, AGENT), identity.registered(AGENT, OWNER), identity.metadataSet(AGENT, "agentWallet", OWNER));
    await sim.run(identity.uriUpdated(AGENT, "ipfs://bafy-new", OWNER));
    expect(await sim.indexer.Agent.getOrThrow("42")).toMatchObject({ agentURI: "ipfs://bafy-new", uriUpdatedAt: sim.time });

    // _update clears agentWallet (MetadataSet with empty bytes) before emitting Transfer.
    await sim.run(identity.metadataSet(AGENT, "agentWallet", "0x"), identity.transfer(OWNER, NEW_OWNER, AGENT));
    expect(await sim.indexer.Agent.getOrThrow("42")).toMatchObject({ owner: NEW_OWNER, wallet: undefined, transfers: 1 });

    // Other metadata keys never overwrite the wallet.
    await sim.run(identity.metadataSet(AGENT, "agentWallet", NEW_OWNER), identity.metadataSet(AGENT, "region", "0x6575"));
    expect((await sim.indexer.Agent.getOrThrow("42")).wallet).toBe(NEW_OWNER);
    // Registered is counted once per agent, not per event touching it.
    expect((await sim.indexer.NetworkStats.getOrThrow("global")).agentsTotal).toBe(1);
  });
});

describe("ReputationRegistry", () => {
  async function withBroker() {
    const sim = new Sim();
    await sim.run(ledger.brokerSet(BROKER));
    await sim.run(identity.mint(OWNER, AGENT), identity.registered(AGENT, OWNER));
    return sim;
  }

  it("classifies feedback by who sent it and keeps per-kind scores apart", async () => {
    const sim = await withBroker();
    sim.tx(reputation.newFeedback({ agentId: AGENT, client: LEDGER, index: 1n, value: 90n, tag1: "starred" }));
    sim.tx(reputation.newFeedback({ agentId: AGENT, client: BROKER, index: 1n, value: 70n, tag1: "xorv-verified" }));
    // Same tags from an arbitrary address carry no Xorv weight.
    sim.tx(reputation.newFeedback({ agentId: AGENT, client: STRANGER, index: 1n, value: 1n, tag1: "xorv-verified" }));
    sim.tx(reputation.newFeedback({ agentId: AGENT, client: STRANGER, index: 2n, value: 0n, tag1: "starred" }));
    // Decimals are normalised: uptime 9977/2 = 99.77.
    sim.tx(reputation.newFeedback({ agentId: AGENT, client: STRANGER, index: 3n, value: 9977n, decimals: 2, tag1: "uptime" }));
    await sim.flush();

    const kinds = await Promise.all(
      [`42-${LEDGER}-1`, `42-${BROKER}-1`, `42-${STRANGER}-1`, `42-${STRANGER}-2`, `42-${STRANGER}-3`].map(
        async (id) => (await sim.indexer.Feedback.getOrThrow(id)).kind,
      ),
    );
    expect(kinds).toEqual(["BUYER_RATING", "XORV_VERIFIED", "OTHER", "OTHER", "OTHER"]);

    const uptime = await sim.indexer.Feedback.getOrThrow(`42-${STRANGER}-3`);
    expect(uptime).toMatchObject({ value: 9977n, decimals: 2, normalizedValue: 99.77, tag1: "uptime", revoked: false });

    const agent = await sim.indexer.Agent.getOrThrow("42");
    expect(agent).toMatchObject({
      feedbackCount: 5,
      buyerRatingCount: 1,
      buyerRatingAvg: 90,
      verifiedCount: 1,
      verifiedScore: 70,
      lastFeedbackAt: sim.time,
    });
    expect(agent.feedbackSum).toBeCloseTo(90 + 70 + 1 + 0 + 99.77, 9);
    expect(agent.feedbackAvg).toBeCloseTo((90 + 70 + 1 + 0 + 99.77) / 5, 9);

    expect((await sim.indexer.Broker.getOrThrow(BROKER)).verifiedFeedbacks).toBe(1);
    expect(await sim.indexer.NetworkStats.getOrThrow("global")).toMatchObject({ feedbacks: 5, verifiedFeedbacks: 1 });
    expect((await sim.indexer.DailyStats.getOrThrow("2026-09-26")).feedbacks).toBe(5);
  });

  it("stops trusting a broker's verifications once it is rotated out", async () => {
    const sim = await withBroker();
    await sim.run(ledger.brokerSet(addr(0xb1)));
    await sim.run(reputation.newFeedback({ agentId: AGENT, client: BROKER, index: 1n, value: 100n, tag1: "xorv-verified" }));

    expect((await sim.indexer.Feedback.getOrThrow(`42-${BROKER}-1`)).kind).toBe("OTHER");
    expect((await sim.indexer.Agent.getOrThrow("42")).verifiedCount).toBe(0);
  });

  it("trusts the configured ledger and verifier before any ledger event is indexed", async () => {
    // Start block after the deploy: no BrokerSet, no Ledger row. ENVIO_XORV_LEDGER_ADDRESS
    // and ENVIO_XORV_VERIFIER_ADDRESSES still identify the trusted clients.
    const sim = new Sim();
    sim.tx(reputation.newFeedback({ agentId: AGENT, client: LEDGER, index: 1n, value: 75n, tag1: "starred" }));
    sim.tx(reputation.newFeedback({ agentId: AGENT, client: CONFIGURED_VERIFIER, index: 1n, value: 64n, tag1: "xorv-verified" }));
    // The tags are still required: the ledger's "xorv-verified" or the verifier's "starred" is OTHER.
    sim.tx(reputation.newFeedback({ agentId: AGENT, client: LEDGER, index: 2n, value: 1n, tag1: "xorv-verified" }));
    sim.tx(reputation.newFeedback({ agentId: AGENT, client: CONFIGURED_VERIFIER, index: 2n, value: 1n, tag1: "starred" }));
    await sim.flush();

    expect(await sim.indexer.Ledger.get(LEDGER)).toBeUndefined();
    const kinds = await Promise.all(
      [`42-${LEDGER}-1`, `42-${CONFIGURED_VERIFIER}-1`, `42-${LEDGER}-2`, `42-${CONFIGURED_VERIFIER}-2`].map(
        async (id) => (await sim.indexer.Feedback.getOrThrow(id)).kind,
      ),
    );
    expect(kinds).toEqual(["BUYER_RATING", "XORV_VERIFIED", "OTHER", "OTHER"]);
    expect(await sim.indexer.Agent.getOrThrow("42")).toMatchObject({
      buyerRatingCount: 1,
      buyerRatingAvg: 75,
      verifiedCount: 1,
      verifiedScore: 64,
    });
  });

  it("revocation takes back exactly what the entry added, once", async () => {
    const sim = await withBroker();
    sim.tx(reputation.newFeedback({ agentId: AGENT, client: BROKER, index: 1n, value: 60n, tag1: "xorv-verified" }));
    sim.tx(reputation.newFeedback({ agentId: AGENT, client: BROKER, index: 2n, value: 100n, tag1: "xorv-verified" }));
    sim.tx(reputation.newFeedback({ agentId: AGENT, client: STRANGER, index: 1n, value: 10n, tag1: "starred" }));
    await sim.flush();
    expect((await sim.indexer.Agent.getOrThrow("42")).verifiedScore).toBe(80);

    await sim.run(reputation.revoked(AGENT, BROKER, 2n));
    const revoked = await sim.indexer.Feedback.getOrThrow(`42-${BROKER}-2`);
    expect(revoked).toMatchObject({ revoked: true, revokedAt: sim.time });

    let agent = await sim.indexer.Agent.getOrThrow("42");
    expect(agent).toMatchObject({ feedbackCount: 2, feedbackRevoked: 1, verifiedCount: 1, verifiedScore: 60 });
    expect(agent.feedbackAvg).toBeCloseTo(35, 9);
    expect((await sim.indexer.Broker.getOrThrow(BROKER)).verifiedFeedbacks).toBe(1);
    expect(await sim.indexer.NetworkStats.getOrThrow("global")).toMatchObject({ feedbacks: 2, verifiedFeedbacks: 1 });

    // Revoking again, or revoking something never indexed, changes nothing.
    sim.tx(reputation.revoked(AGENT, BROKER, 2n));
    sim.tx(reputation.revoked(AGENT, STRANGER, 99n));
    await sim.flush();
    agent = await sim.indexer.Agent.getOrThrow("42");
    expect(agent).toMatchObject({ feedbackCount: 2, feedbackRevoked: 1, verifiedCount: 1 });

    // Emptying a bucket snaps its float sum back to exactly zero.
    await sim.run(reputation.revoked(AGENT, BROKER, 1n));
    agent = await sim.indexer.Agent.getOrThrow("42");
    expect(agent).toMatchObject({ verifiedCount: 0, verifiedSum: 0, verifiedScore: 0 });
  });

  it("revoking a buyer rating lowers the buyer-rating average", async () => {
    const sim = await withBroker();
    sim.tx(reputation.newFeedback({ agentId: AGENT, client: LEDGER, index: 1n, value: 40n, tag1: "starred" }));
    sim.tx(reputation.newFeedback({ agentId: AGENT, client: LEDGER, index: 2n, value: 80n, tag1: "starred" }));
    await sim.flush();
    await sim.run(reputation.revoked(AGENT, LEDGER, 2n));

    expect(await sim.indexer.Agent.getOrThrow("42")).toMatchObject({ buyerRatingCount: 1, buyerRatingAvg: 40 });
  });

  it("records responses and counts them on the feedback", async () => {
    const sim = await withBroker();
    await sim.run(reputation.newFeedback({ agentId: AGENT, client: STRANGER, index: 1n, value: 5n, tag1: "starred" }));
    const tx = await sim.run(reputation.response(AGENT, STRANGER, 1n, OWNER));

    const responses = await sim.indexer.FeedbackResponse.getAll();
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      feedback_id: `42-${STRANGER}-1`,
      responder: OWNER,
      responseURI: "ipfs://response",
      responseHash: hash32(0xabc),
      txHash: tx,
    });
    expect((await sim.indexer.Feedback.getOrThrow(`42-${STRANGER}-1`)).responsesCount).toBe(1);
  });

  it("creates a stub agent for feedback on an identity minted before the start block", async () => {
    const sim = new Sim();
    await sim.run(reputation.newFeedback({ agentId: 9n, client: STRANGER, index: 1n, value: 50n, tag1: "starred" }));

    expect(await sim.indexer.Agent.getOrThrow("9")).toMatchObject({ owner: undefined, feedbackCount: 1, feedbackAvg: 50 });
    // A stub is not a registration.
    expect((await sim.indexer.NetworkStats.getOrThrow("global")).agentsTotal).toBe(0);
  });
});
