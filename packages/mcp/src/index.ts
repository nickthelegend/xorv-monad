#!/usr/bin/env node
/**
 * Xorv as an MCP server.
 *
 * This is the part of the story x402 was actually invented for: an agent that
 * needs work done finds capacity, pays for it, and gets the result — without a
 * human opening a browser, creating an account, or pasting a card number. The
 * agent signs a USDC authorization on Monad, the network's facilitator
 * settles it (and pays the gas), and the job runs on a stranger's machine.
 *
 * The agent can pay from a Privy server wallet whose policy caps every
 * signature, so a model with a spending tool is bounded by rules enforced
 * outside the process it runs in — see signer.ts and `pnpm privy:setup`.
 *
 * Point any MCP client at it:
 *
 *   claude mcp add xorv -- npx -y @xorv/mcp
 *
 * Configuration is environment-only (config.ts, README.md):
 *
 *   XORV_BROKER_URL          broker to buy from (default http://localhost:8402)
 *   XORV_NETWORK             eip155:10143 (Monad testnet, default) or eip155:143
 *   XORV_MAX_PRICE           hard ceiling per job in USD, default 0.05
 *   XORV_SESSION_BUDGET_USD  cumulative ceiling for this process, default 0.50
 *   XORV_PRIVATE_KEY         local payer key (0x hex), or …
 *   XORV_PRIVY_APP_ID, XORV_PRIVY_APP_SECRET, XORV_PRIVY_WALLET_ID
 *                            … a Privy server wallet (+ XORV_PRIVY_AUTH_KEY if owner-keyed)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SessionBudget } from "./budget.js";
import { brokerClient } from "./broker.js";
import { describeConfig, loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { createPayerSigner } from "./signer.js";

// stderr, never stdout: stdout is the JSON-RPC channel and anything else on it
// corrupts the protocol.
const log = (line: string) => console.error(`[xorv-mcp] ${line}`);

const config = loadConfig(process.env);
const signer = createPayerSigner(config.signer);
const budget = new SessionBudget(config.sessionBudgetUsdMicros);
const server = createServer({ config, broker: brokerClient(config.brokerUrl), signer, budget });

await server.connect(new StdioServerTransport());

log(`ready — ${describeConfig(config, signer.describe())}`);
for (const problem of config.problems) log(`config problem: ${problem}`);
if (config.signer.mode === "none") {
  log(`read-only: ${config.signer.problem}`);
} else {
  // Build the payer now rather than on the first paid call, so a bad key or
  // Privy credential shows up in the client's server log at launch. Failure
  // is not memoised; the paying tools retry and report it themselves.
  signer.resolve().then(
    (payer) => log(`payer: ${payer.label}`),
    (err: unknown) => log(`payer unavailable: ${err instanceof Error ? err.message : String(err)}`),
  );
}
