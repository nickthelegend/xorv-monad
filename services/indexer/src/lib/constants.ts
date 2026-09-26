/**
 * On-chain constants the handlers compare against. They mirror XorvLedger (SPEC §4) and
 * ERC-8004 v2.0.0 conventions; changing one here without the contract changing would
 * silently misclassify events.
 */

/** XorvLedger.NO_AGENT: a provider registered without an ERC-8004 identity. */
export const NO_AGENT = 2n ** 256n - 1n;

/** paymentTx of a receipt whose job was never paid. */
export const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

/**
 * tag1 XorvLedger.rateJob hard-codes when it relays a buyer's rating to the Reputation
 * Registry. Only counts as a buyer rating when the client is the ledger itself.
 */
export const TAG_STARRED = "starred";

/** tag1 the broker's Kimi verifier uses for its per-job score (0..100, decimals 0). */
export const TAG_VERIFIED = "xorv-verified";

/** The reserved IdentityRegistry metadata key holding the agent's payment wallet. */
export const AGENT_WALLET_KEY = "agentWallet";

/** Id of the NetworkStats singleton. */
export const GLOBAL_ID = "global";
