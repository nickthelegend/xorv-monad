/**
 * @xorv/protocol/web — the browser-safe entry point.
 *
 * Everything a Next.js page needs to agree with the broker — the domain and
 * wire types, money math, Monad chain config and explorer links, address
 * helpers, the XorvLedger ABI and rating typed data, ERC-8004 file shapes, and
 * the buyer-side x402 client a Privy wallet pays with — and nothing that drags
 * Node built-ins or server code into a client bundle: no `node:crypto`, no
 * in-process facilitator, no LLM client (API keys have no business in a
 * browser tab).
 *
 * The Node entry (`@xorv/protocol`) re-exports all of this, so server code can
 * import from one place.
 */

export * from "./constants.js";
export * from "./types.js";
export * from "./money.js";
export * from "./format.js";
export * from "./json.js";
export * from "./chains.js";
export * from "./explorer.js";
export * from "./evm.js";
export * from "./ledger.js";
export * from "./erc8004.js";
export * from "./x402-client.js";
