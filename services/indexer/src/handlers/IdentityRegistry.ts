/**
 * ERC-8004 IdentityRegistry (v2.0.0) handlers. The registry is a chain-wide singleton, so
 * this indexes every agent on Monad, not only Xorv providers; Agent.isXorvProvider (set
 * by ProviderRegistered only) is what narrows it down.
 *
 * Log order inside one register() call is Transfer (mint), Registered, then
 * MetadataSet("agentWallet"); a transfer emits MetadataSet("agentWallet", "") before
 * Transfer. Each handler only sets the fields its event owns, so the order never matters.
 */

import { indexer } from "envio";
import { AGENT_WALLET_KEY } from "../lib/constants.js";
import { loadAgent, loadNetworkStats, saveNetworkStats } from "../lib/entities.js";
import { isZeroAddress, lower, walletFromMetadata } from "../lib/util.js";

indexer.onEvent(
  {
    contract: "IdentityRegistry",
    event: "Registered",
    fields: { block: ["timestamp"], transaction: ["hash"] },
  },
  async ({ event, context }) => {
    const agent = await loadAgent(context, event.params.agentId);
    const firstSeen = agent.registeredAt === undefined;
    agent.owner = lower(event.params.owner);
    agent.agentURI = event.params.agentURI;
    agent.registeredAt = event.block.timestamp;
    agent.registeredTx = lower(event.transaction.hash);
    context.Agent.set(agent);

    if (firstSeen) {
      const stats = await loadNetworkStats(context);
      stats.agentsTotal += 1;
      saveNetworkStats(context, stats, event.block);
    }
  },
);

indexer.onEvent(
  { contract: "IdentityRegistry", event: "URIUpdated", fields: { block: ["timestamp"] } },
  async ({ event, context }) => {
    const agent = await loadAgent(context, event.params.agentId);
    agent.agentURI = event.params.newURI;
    agent.uriUpdatedAt = event.block.timestamp;
    context.Agent.set(agent);
  },
);

indexer.onEvent(
  { contract: "IdentityRegistry", event: "MetadataSet" },
  async ({ event, context }) => {
    // Arbitrary metadata is the agent's business; only the reserved wallet key feeds a
    // Xorv invariant (XorvLedger requires payTo == getAgentWallet(agentId)).
    if (event.params.metadataKey !== AGENT_WALLET_KEY) return;
    const agent = await loadAgent(context, event.params.agentId);
    agent.wallet = walletFromMetadata(event.params.metadataValue);
    context.Agent.set(agent);
  },
);

indexer.onEvent(
  { contract: "IdentityRegistry", event: "Transfer" },
  async ({ event, context }) => {
    const agent = await loadAgent(context, event.params.tokenId);
    const to = lower(event.params.to);
    // A burn leaves no owner; a mint is not a transfer of an existing identity.
    agent.owner = isZeroAddress(to) ? undefined : to;
    if (!isZeroAddress(event.params.from)) agent.transfers += 1;
    context.Agent.set(agent);
  },
);
