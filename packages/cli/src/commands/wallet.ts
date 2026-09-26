/**
 * `xorv wallet` — the payout address.
 *
 * On Monad there is nothing to set up before an address can be paid: any
 * address can receive an ERC-20, so the Hedera-era chores (token association,
 * funding an account into existence) are gone. What is left to show is what the
 * address holds and where to look it up.
 *
 * Both balances are shown, with what each is for, because they are easy to
 * confuse: USDC is what jobs pay in; MON is gas, which a provider only needs
 * for the optional `xorv identity register` (the facilitator pays the gas on
 * every settlement, so earning never costs MON).
 */

import {
  explorerAddress,
  explorerToken,
  fetchBalances,
  formatMon,
  formatUsdc,
  networkConfig,
  networkLabel,
  type AccountBalances,
} from "@xorv/protocol";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig, payoutAddress, requireConfig, saveConfig, type NodeConfig } from "../config.js";
import * as ui from "../ui.js";

/** The rows `xorv wallet` shows — pure, so the layout is tested without an RPC. */
export function walletRows(config: Pick<NodeConfig, "network" | "address" | "privateKey" | "agentId">, balances: AccountBalances): Array<[string, string]> {
  const cfg = networkConfig(config.network);
  const address = config.address;
  const rows: Array<[string, string]> = [
    ["address", ui.c.bold(address)],
    ["network", `${cfg.name} ${ui.c.muted(`(${cfg.caip2})`)}`],
    ["usdc", `${ui.c.money(formatUsdc(balances.usdcUnits))} ${ui.c.muted("— what jobs pay you in")}`],
    [
      "mon",
      `${formatMon(balances.monWei)} ${ui.c.muted(
        BigInt(balances.monWei) === 0n ? "— none needed to earn; gas only for `xorv identity register`" : "— gas, for `xorv identity register`",
      )}`,
    ],
    ["key", config.privateKey ? ui.c.muted("stored locally (0600)") : ui.c.muted("none on this machine — address-only")],
    ["identity", config.agentId ? `agent #${config.agentId}` : ui.c.muted("none — `xorv identity register`")],
    ["token", ui.c.muted(`${cfg.usdc.symbol} ${explorerToken(cfg.caip2, cfg.usdc.address)}`)],
    ["explorer", ui.c.muted(explorerAddress(cfg.caip2, address))],
  ];
  if (cfg.faucets.usdc || cfg.faucets.mon) {
    rows.push([
      "faucets",
      ui.c.muted([cfg.faucets.usdc && `USDC ${cfg.faucets.usdc}`, cfg.faucets.mon && `MON ${cfg.faucets.mon}`].filter(Boolean).join(" · ")),
    ]);
  }
  return rows;
}

export async function walletShow(): Promise<void> {
  const config = requireConfig();
  const address = payoutAddress(config);
  console.log(ui.banner("payout wallet"));

  const spin = ui.spinner(`reading ${address} on Monad ${networkLabel(config.network)}…`);
  try {
    const balances = await fetchBalances(config.network, address);
    spin.stop();
    console.log(ui.box(ui.kv(walletRows({ ...config, address }, balances)), { title: "wallet", color: ui.BRAND.mint }));
  } catch (err) {
    spin.fail(`could not reach ${networkConfig(config.network).rpcUrl}: ${err instanceof Error ? err.message : String(err)}`);
    ui.muted(`  ${explorerAddress(config.network, address)}`);
    process.exitCode = 1;
  }
  ui.blank();
}

/**
 * Rotate to a fresh keypair.
 *
 * The old address keeps whatever it already earned — this changes where future
 * payouts land, it does not move money, and it says so rather than implying a
 * sweep happened. An ERC-8004 identity is bound to the old address, so it is
 * cleared here too: keeping it would register the node under an agent whose
 * wallet no longer matches, and XorvLedger would refuse every receipt for it.
 */
export async function walletNew(): Promise<void> {
  const config = loadConfig() ?? requireConfig();
  console.log(ui.banner("new payout keypair"));

  if (config.address) {
    ui.warn(`this node currently pays out to ${ui.c.bold(config.address)}`);
    ui.muted("  generating a new key does NOT move existing funds — the old address keeps them");
    if (config.agentId) {
      ui.muted(`  agent #${config.agentId} stays bound to the old address; register a new identity afterwards`);
    }
    const go = await ui.confirm("generate a new keypair anyway?", false);
    if (!go) {
      ui.blank();
      return;
    }
  }

  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  saveConfig({ ...config, address, privateKey: key, agentId: null });

  const cfg = networkConfig(config.network);
  console.log(
    ui.box(
      [
        ui.c.bold("new payout keypair"),
        "",
        ...ui.kv([
          ["address", ui.c.accent(address)],
          ["private key", ui.c.muted(`saved to the node config (0600) — back it up: xorv config --path`)],
        ]),
        "",
        "  Nothing to fund: any Monad address can receive USDC.",
        ...(cfg.faucets.mon ? [`  (MON for an identity: ${cfg.faucets.mon})`] : []),
      ],
      { title: "keypair", color: ui.BRAND.amber },
    ),
  );
  ui.blank();
  ui.ok(`payouts now go to ${ui.c.bold(address)}`);
  ui.info(`restart ${ui.c.accent("xorv start")} so the broker pays the new address`);
  ui.blank();
}
