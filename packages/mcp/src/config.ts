/**
 * Environment → configuration for the MCP server.
 *
 * Configuration is environment-only, because an MCP server is launched by
 * another program (Claude Code, Claude Desktop, …) and has no terminal to
 * prompt at. Everything is parsed here, once, as a pure function of the
 * environment, so the rules are unit-testable and the rest of the server
 * never touches `process.env`.
 *
 * A bad value does not crash the process. A server that exits at launch shows
 * up in the client as a bare "failed to start", with the reason buried in a
 * log file nobody opens; a server that boots and answers every tool call with
 * "XORV_NETWORK=hedera:testnet is not supported — use eip155:10143" puts the
 * fix in front of the person (or model) who can act on it. So fundamental
 * problems are collected into `problems`, and the tools refuse with them.
 */

import { DEFAULT_NETWORK, formatUsd, isSupportedNetwork, parseUsd, type MonadNetwork } from "@xorv/protocol";
import { resolveSignerConfig, type SignerConfig } from "./signer.js";

export type Env = Record<string, string | undefined>;

/** Per-job ceiling when `XORV_MAX_PRICE` is unset. */
export const DEFAULT_MAX_PRICE_USD = "0.05";

/** Cumulative ceiling for one server process when `XORV_SESSION_BUDGET_USD` is unset. */
export const DEFAULT_SESSION_BUDGET_USD = "0.50";

export interface McpConfig {
  brokerUrl: string;
  network: MonadNetwork;
  /**
   * A hard spending ceiling per job, in micro-USD.
   *
   * An MCP server is driven by a model, and a model that can spend without a
   * bound is a model that can empty a wallet through a loop it didn't mean to
   * write. The tool schema lets the caller ask for less than this; nothing
   * lets it ask for more.
   */
  maxPriceUsdMicros: number;
  /**
   * The most this process will spend in total, in micro-USD; null for no
   * cumulative cap (only when explicitly configured as `unlimited`).
   *
   * The per-job ceiling bounds one call. It does not bound a model that calls
   * a $0.05 tool two hundred times, and neither can a Privy policy: Privy's
   * typed-data rules cap each *signature*, and its rolling-window spend
   * aggregations only cover transaction signing, not the EIP-712
   * authorizations x402 uses. So the cumulative cap lives here.
   */
  sessionBudgetUsdMicros: number | null;
  signer: SignerConfig;
  /** Fundamental misconfiguration; every tool refuses with these until fixed. */
  problems: string[];
}

function readVar(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Parse a USD amount from the environment, recording a problem (and returning
 * the fallback) instead of throwing.
 */
function usdVar(env: Env, names: string[], fallback: string, problems: string[]): number {
  for (const name of names) {
    const raw = readVar(env, name);
    if (raw === undefined) continue;
    try {
      const micros = parseUsd(raw);
      if (micros <= 0) throw new Error("must be greater than zero");
      return micros;
    } catch (err) {
      problems.push(`${name}="${raw}" is not a usable dollar amount (${err instanceof Error ? err.message : String(err)}) — use e.g. ${fallback}`);
      return parseUsd(fallback);
    }
  }
  return parseUsd(fallback);
}

export function loadConfig(env: Env): McpConfig {
  const problems: string[] = [];

  const brokerUrl = (readVar(env, "XORV_BROKER_URL") ?? "http://localhost:8402").replace(/\/+$/, "");

  const rawNetwork = readVar(env, "XORV_NETWORK") ?? DEFAULT_NETWORK;
  let network: MonadNetwork = DEFAULT_NETWORK;
  if (isSupportedNetwork(rawNetwork)) {
    network = rawNetwork;
  } else {
    problems.push(
      `XORV_NETWORK="${rawNetwork}" is not supported — Xorv runs on Monad: set eip155:10143 (testnet) or eip155:143 (mainnet)` +
        (rawNetwork.startsWith("hedera") ? ". The Hedera prototype's settings do not carry over." : ""),
    );
  }

  // XORV_MAX_PRICE is the name; XORV_MAX_USD is what 0.1 called it, still
  // honoured so an existing client config keeps its ceiling rather than
  // silently falling back to the default.
  const maxPriceUsdMicros = usdVar(env, ["XORV_MAX_PRICE", "XORV_MAX_USD"], DEFAULT_MAX_PRICE_USD, problems);

  let sessionBudgetUsdMicros: number | null;
  const rawBudget = readVar(env, "XORV_SESSION_BUDGET_USD");
  if (rawBudget && /^(unlimited|off|none)$/i.test(rawBudget)) {
    sessionBudgetUsdMicros = null;
  } else {
    sessionBudgetUsdMicros = usdVar(env, ["XORV_SESSION_BUDGET_USD"], DEFAULT_SESSION_BUDGET_USD, problems);
  }

  return {
    brokerUrl,
    network,
    maxPriceUsdMicros,
    sessionBudgetUsdMicros,
    signer: resolveSignerConfig(env),
    problems,
  };
}

/** One line for the startup log (stderr) — never includes a secret. */
export function describeConfig(config: McpConfig, signerLine: string): string {
  const budget =
    config.sessionBudgetUsdMicros === null ? "no session budget" : `session budget ${formatUsd(config.sessionBudgetUsdMicros)}`;
  return `broker ${config.brokerUrl}, network ${config.network}, cap ${formatUsd(config.maxPriceUsdMicros)}/job, ${budget}, payer: ${signerLine}`;
}
