/**
 * `pnpm --filter @xorv/broker nansen:probe <address> [<other address>]`
 *
 * One Nansen trust lookup, exactly as the broker makes it, printed for a
 * human: the score and what it is made of, the first funder, the flags, and —
 * in live mode — the x402 payments on Monad mainnet that bought the data,
 * as explorer links. With a second address it also runs the wash-rating
 * check between the two, which is what the broker does before relaying a
 * rating.
 *
 *   XORV_NANSEN_MODE=live      real calls: pays ~$0.01 per call (≤ $0.03 per wallet)
 *                              in USDC on Monad mainnet from XORV_NANSEN_PAYER_KEY,
 *                              or bills NANSEN_API_KEY credits when that is set
 *
 * Off (the default) means not configured, and the probe says so rather than
 * printing made-up data. `--mode live` overrides the environment; `--json` prints the raw
 * public view instead. The smart-money list is not fetched: it is internal
 * matching data and would cost $0.05 for nothing shown here.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { isEvmAddress, normalizeAddress } from "@xorv/protocol";
import { loadNansenConfig } from "../config.js";
import {
  NANSEN_PRICE_UNITS,
  NANSEN_PATHS,
  createNansenTrust,
  type NansenFixtureSource,
  publicRelatedCheck,
  publicTrustView,
  usdcString,
  type NansenConfig,
  type NansenStatus,
  type PublicRelatedCheck,
  type PublicTrustSignal,
} from "../trust/index.js";

export interface ProbeResult {
  signal: PublicTrustSignal;
  check: PublicRelatedCheck | null;
  status: NansenStatus;
}

export async function probe(opts: {
  addresses: string[];
  config: NansenConfig;
  fetch?: typeof fetch;
  /** Tests only: fixture answers for `mode: "fixture"`. */
  fixtures?: NansenFixtureSource;
  print?: (line: string) => void;
}): Promise<ProbeResult> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const [address, other] = opts.addresses;
  if (!address) throw new Error("usage: nansen:probe <address> [<other address>]");
  const trust = createNansenTrust({ ...opts.config, smartMoney: false }, { fetch: opts.fetch, fixtures: opts.fixtures });

  const signal = publicTrustView(await trust.signal(address));
  const check = other ? publicRelatedCheck(await trust.checkRelated(other, address)) : null;
  const status = trust.status();

  print("");
  print(`  ▁▂▃  Nansen trust · ${signal.address}`);
  print("");
  print(`  mode          ${status.mode}${status.auth === "x402" ? ` — x402 on Monad mainnet from ${status.payer?.address}` : status.auth === "api-key" ? " — NANSEN_API_KEY" : ""}`);
  print(`  score         ${signal.score}/100 (${signal.band})${signal.degraded ? " — degraded: some lookups failed, missing data is never a penalty" : ""}`);
  print(`  first seen    ${signal.firstSeen ?? "no record"}${signal.walletAgeDays !== null ? ` (${signal.walletAgeDays} days)` : ""}`);
  print(
    `  first funder  ${signal.firstFunder ? `${signal.firstFunder.address}${signal.firstFunder.label ? ` (${signal.firstFunder.label})` : ""} on ${signal.firstFunder.chain ?? "?"}` : "none on record"}`,
  );
  print(`  monad txs     ${signal.txCount}${signal.txCountCapped ? "+" : ""} in the last 90 days`);
  print(`  related       ${signal.relatedWalletCount} wallet${signal.relatedWalletCount === 1 ? "" : "s"}`);
  print(`  labels        ${signal.labels.join(", ") || "—"}`);
  print(`  risk flags    ${signal.riskFlags.join(", ") || "none"}`);
  if (check) {
    print("");
    print(`  vs ${other}`);
    print(
      `  related?      ${check.related ? `YES — a rating between these wallets would be refused: ${check.reasons.map((r) => r.message).join("; ")}` : check.degraded ? "unknown (lookup degraded) — would not block a rating" : "no — a rating would be relayed"}`,
    );
  }
  print("");
  if (signal.paidTx.length || status.recentPaidTx.length) {
    const paid = status.recentPaidTx.length ? status.recentPaidTx : signal.paidTx;
    print(`  Xorv paid Nansen $${status.spentTodayUsdc} over x402 on Monad:`);
    for (const p of paid) print(`    $${p.amountUsdc}  ${p.endpoint.replace("/api/v1/", "")}  ${p.url}`);
  } else {
    print(`  no payments (${status.mode === "fixture" ? "fixture data" : status.auth === "api-key" ? "API-key credits" : "nothing paid"})`);
  }
  if (status.lastError) print(`  last error    ${status.lastError}`);
  print(`  ${signal.attribution} — ${signal.attributionUrl}`);
  print("");
  return { signal, check, status };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const json = argv.includes("--json");
  const modeFlag = argv.indexOf("--mode");
  const modeArg = modeFlag >= 0 ? argv[modeFlag + 1] : undefined;
  const addresses = argv.filter((a, i) => !a.startsWith("--") && !(modeFlag >= 0 && i === modeFlag + 1));
  for (const a of addresses) {
    if (!isEvmAddress(a)) throw new Error(`not an EVM address: ${a}`);
  }
  if (modeArg) process.env.XORV_NANSEN_MODE = modeArg;
  const config = loadNansenConfig();
  if (config.mode === "off") {
    console.error(
      "  Nansen is not configured. Set XORV_NANSEN_MODE=live with NANSEN_API_KEY, or XORV_NANSEN_PAYER_KEY " +
        "(a Monad MAINNET key holding a few USDC), or pass --mode live.",
    );
    process.exitCode = 2;
    return;
  }
  if (config.mode === "live" && !config.apiKey) {
    const most = [NANSEN_PATHS.firstFunder, NANSEN_PATHS.relatedWallets, NANSEN_PATHS.transactions]
      .map((p) => NANSEN_PRICE_UNITS[p])
      .reduce((a, b) => a + b, 0n) * BigInt(addresses.length);
    console.error(`  live: this pays Nansen at most $${usdcString(most)} in USDC on Monad mainnet from ${config.payer?.address}.`);
  }
  const result = await probe({
    addresses: addresses.map((a) => normalizeAddress(a)),
    config,
    print: json ? () => {} : undefined,
  });
  if (json) console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error("failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
