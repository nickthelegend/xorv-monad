#!/usr/bin/env node
/**
 * Create a policy-bounded Privy server wallet for the Xorv MCP server.
 *
 *   pnpm --filter @xorv/mcp privy:setup -- --cap-usdc 0.50
 *
 * Needs a Privy app's credentials in the environment (`XORV_PRIVY_APP_ID`,
 * `XORV_PRIVY_APP_SECRET` — or `PRIVY_APP_ID` / `PRIVY_APP_SECRET`), then:
 *
 *  1. creates a policy that ALLOWs only `eth_signTypedData_v4` for USDC
 *     `TransferWithAuthorization` on the chosen Monad network with
 *     `value <= --cap-usdc` (plus XorvLedger ratings when the ledger address
 *     is known — see privy-policy.ts);
 *  2. creates an ethereum server wallet bound to that policy;
 *  3. prints the environment lines for the MCP client config and the address
 *     to fund with test USDC from Circle's faucet.
 *
 * The wallet needs USDC only — never MON: x402's facilitator submits the
 * signed authorization and pays the gas, and ratings are relayed by the broker.
 *
 * `--owner-key` also generates a P-256 authorization key and makes it the
 * owner of the wallet and the policy. Then the app secret alone can neither
 * sign nor loosen the policy; the MCP server needs `XORV_PRIVY_AUTH_KEY` too.
 *
 * `--dry-run` prints the policy JSON and exits without calling Privy.
 *
 * Importing this module does nothing; `main()` runs only when it is executed.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  DEFAULT_NETWORK,
  explorerAddress,
  formatUsdc,
  isSupportedNetwork,
  networkConfig,
  normalizeAddress,
} from "@xorv/protocol";
import { buildAgentPolicy, parseCapUsdc, type AgentPolicy } from "../privy-policy.js";

const USAGE = `Usage: pnpm --filter @xorv/mcp privy:setup -- --cap-usdc <dollars> [options]

Creates a Privy policy + server wallet the Xorv MCP server can pay from.

Options:
  --cap-usdc <n>       Required. Most any single payment may be, in USDC (e.g. 0.50).
  --network <caip2>    eip155:10143 (Monad testnet, default) or eip155:143 (mainnet).
  --ledger <0x…>       XorvLedger address, to also allow signing job ratings.
  --broker <url>       Read the ledger address from this broker's /api/network instead.
  --pay-to <0x…,…>     Only allow paying these provider addresses (default: any).
  --name <label>       Policy / wallet display name.
  --owner-key          Generate a P-256 owner key for the wallet and policy.
  --dry-run            Print the policy JSON and exit without calling Privy.
  -h, --help           Show this help.

Environment: XORV_PRIVY_APP_ID and XORV_PRIVY_APP_SECRET (or PRIVY_APP_ID / PRIVY_APP_SECRET).`;

export interface SetupOptions {
  capUnits: bigint;
  network: string;
  ledger: string | null;
  broker: string | null;
  payTo: string[];
  name: string | null;
  ownerKey: boolean;
  dryRun: boolean;
}

/** Parse argv (without node and script) into options; throws with a usable message. */
export function parseSetupArgs(argv: string[], env: Record<string, string | undefined> = {}): SetupOptions | "help" {
  // `pnpm run x -- --flag` forwards the `--` itself; npm swallows it. Accept both.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values } = parseArgs({
    args,
    options: {
      "cap-usdc": { type: "string" },
      network: { type: "string" },
      ledger: { type: "string" },
      broker: { type: "string" },
      "pay-to": { type: "string" },
      name: { type: "string" },
      "owner-key": { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return "help";
  if (!values["cap-usdc"]) {
    // No default on purpose: the per-signature cap is the one number this
    // whole setup exists to decide, so it should be a decision.
    throw new Error("--cap-usdc is required (the most any single payment may be, e.g. --cap-usdc 0.50)");
  }
  const network = values.network ?? env.XORV_NETWORK?.trim() ?? DEFAULT_NETWORK;
  if (!isSupportedNetwork(network)) {
    throw new Error(`--network must be eip155:10143 (Monad testnet) or eip155:143 (mainnet), got "${network}"`);
  }
  const decimals = networkConfig(network).usdc.decimals;
  return {
    capUnits: parseCapUsdc(values["cap-usdc"], decimals),
    network,
    ledger: values.ledger ? normalizeAddress(values.ledger) : null,
    broker: values.broker ?? null,
    payTo: (values["pay-to"] ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => normalizeAddress(a)),
    name: values.name ?? null,
    ownerKey: Boolean(values["owner-key"]),
    dryRun: Boolean(values["dry-run"]),
  };
}

/** The XorvLedger address a broker advertises, or null (with the reason logged). */
async function ledgerFromBroker(url: string, log: (line: string) => void): Promise<string | null> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/api/network`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = (await res.json()) as { ledger?: { address?: string } | null };
    if (!info.ledger?.address) {
      log(`  ${url} has no XorvLedger configured, so the rating rule is skipped.`);
      return null;
    }
    return normalizeAddress(info.ledger.address);
  } catch (err) {
    log(`  could not read ${url}/api/network (${err instanceof Error ? err.message : String(err)}); the rating rule is skipped.`);
    return null;
  }
}

function describePolicy(policy: AgentPolicy): string {
  return policy.rules.map((r) => `  - ALLOW ${r.method}: ${r.name}`).join("\n");
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const out = (line = "") => console.log(line);
  const err = (line: string) => console.error(line);

  let opts: SetupOptions | "help";
  try {
    opts = parseSetupArgs(argv, env);
  } catch (e) {
    err(`privy:setup: ${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  if (opts === "help") {
    out(USAGE);
    return 0;
  }

  const cfg = networkConfig(opts.network);
  const ledger = opts.ledger ?? (opts.broker ? await ledgerFromBroker(opts.broker, err) : null);
  const policy = buildAgentPolicy({
    network: cfg.caip2,
    capUnits: opts.capUnits,
    payTo: opts.payTo,
    ledger,
    name: opts.name ?? undefined,
  });

  if (opts.dryRun) {
    out(JSON.stringify(policy, null, 2));
    return 0;
  }

  const appId = env.XORV_PRIVY_APP_ID?.trim() || env.PRIVY_APP_ID?.trim();
  const appSecret = env.XORV_PRIVY_APP_SECRET?.trim() || env.PRIVY_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    err("privy:setup: set XORV_PRIVY_APP_ID and XORV_PRIVY_APP_SECRET (from dashboard.privy.io → your app → Settings).");
    return 2;
  }

  const { PrivyClient, generateP256KeyPair } = await import("@privy-io/node");
  const privy = new PrivyClient({ appId, appSecret });
  const owner = opts.ownerKey ? await generateP256KeyPair() : null;
  const ownerField = owner ? { owner: { public_key: owner.publicKey } } : {};

  out(`Creating a Privy policy for ${cfg.name} (${cfg.caip2})…`);
  const created = await privy.policies().create({ ...policy, ...ownerField });
  out(`  policy ${created.id}`);
  out(describePolicy(policy));
  if (!ledger) {
    out("  (no XorvLedger address given — xorv_rate_job signatures will be denied; re-run with --ledger or --broker to allow them)");
  }

  out("Creating a server wallet bound to it…");
  const wallet = await privy.wallets().create({
    chain_type: "ethereum",
    policy_ids: [created.id],
    display_name: opts.name ?? `xorv-mcp-agent-${cfg.label}`,
    ...ownerField,
  });
  const address = normalizeAddress(wallet.address);
  out(`  wallet ${wallet.id} ${address}`);
  out(`  ${explorerAddress(cfg.caip2, address)}`);

  const cap = formatUsdc(opts.capUnits);
  out();
  out("Add these to the Xorv MCP server's environment (e.g. the \"env\" block of your MCP client config):");
  out();
  out(`  XORV_NETWORK=${cfg.caip2}`);
  out(`  XORV_PRIVY_APP_ID=${appId}`);
  out("  XORV_PRIVY_APP_SECRET=<your Privy app secret>");
  out(`  XORV_PRIVY_WALLET_ID=${wallet.id}`);
  if (owner) out(`  XORV_PRIVY_AUTH_KEY=${owner.privateKey}`);
  out(`  XORV_MAX_PRICE=${cap.replace(/^\$/, "")}`);
  out();
  if (owner) {
    out("XORV_PRIVY_AUTH_KEY is the only copy of the wallet's owner key — store it like a password.");
  }
  out(`Privy will refuse any signature over ${cap}. It caps each payment, not the total: the MCP server's`);
  out("XORV_SESSION_BUDGET_USD (default $0.50) is what bounds cumulative spend per session.");
  out();
  if (cfg.faucets.usdc) {
    out(`Fund it with test USDC (no MON needed): ${cfg.faucets.usdc} → network "${cfg.name}" → ${address}`);
  } else {
    out(`Fund it with USDC on ${cfg.name} at ${address} (no MON needed — the facilitator pays gas).`);
  }
  return 0;
}

/** True when this file is the process entry point (tsx, node, or an npm bin shim). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const invoked = realpathSync(path.resolve(entry));
    return process.platform === "win32" ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(`privy:setup failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
