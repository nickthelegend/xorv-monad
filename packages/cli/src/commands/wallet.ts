/**
 * `xorv wallet` — the payout account.
 *
 * ## The command that no longer exists
 *
 * On Hedera this file had a second command, `xorv wallet associate`, and a long
 * comment about why: an account must opt in to a token before it can receive
 * it, or the transfer dies at consensus with `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`.
 * Worse, opting in cost HBAR — so a new provider had to acquire the gas token
 * and spend it before they could earn anything, and the failure if they skipped
 * it was invisible until someone's payment bounced.
 *
 * ERC-20 has no such concept. Every address can receive USDG or USDC,
 * immediately, having done nothing — and on Arbitrum it needs no ETH to do so,
 * because the broker's facilitator pays the gas. So the command is gone, along with the `canReceiveUsdc`
 * check that `doctor` used to run and the "can be paid: no" row this used to
 * print. Nothing replaced them, because there is nothing left to be wrong.
 *
 * What remains is the one honest question — how much is in there, per
 * stablecoin — plus a way to rotate the key.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  explorerAddress,
  explorerName,
  explorerToken,
  fetchBalances,
  formatEth,
  formatUnits,
  networkInfo,
} from "@xorv/protocol";
import { loadConfig, requireConfig, saveConfig } from "../config.js";
import * as ui from "../ui.js";

export async function walletShow(): Promise<void> {
  const config = requireConfig();
  console.log(ui.banner("payout wallet"));

  const spin = ui.spinner(`querying ${config.address}…`);
  try {
    const balances = await fetchBalances(config.network, config.address);
    spin.stop();
    const rows: Array<[string, string]> = [
      ["address", ui.c.bold(config.address)],
      ["network", `${networkInfo(config.network).name} ${ui.c.muted(`(${config.network})`)}`],
    ];
    balances.stablecoins.forEach((token, i) => {
      rows.push([
        token.symbol.toLowerCase(),
        `${ui.c.money(formatUnits(token.units))} ${ui.c.muted(`${token.symbol}${i === 0 ? " · default" : ""}`)}`,
      ]);
    });
    // ETH is shown for completeness, not because it is needed: a provider only
    // receives, and the broker's facilitator pays the gas on every settlement.
    rows.push(["eth", `${ui.c.muted(formatEth(balances.ethWei))} ${ui.c.muted("(none needed — gas is paid by the facilitator)")}`]);
    for (const token of balances.stablecoins) {
      rows.push([`${token.symbol.toLowerCase()} token`, ui.c.muted(`${token.address}  ${explorerToken(config.network, token.address)}`)]);
    }
    rows.push([explorerName(config.network).toLowerCase(), ui.c.muted(explorerAddress(config.network, config.address))]);
    console.log(ui.box(ui.kv(rows), { title: "wallet", color: ui.BRAND.mint }));
  } catch (err) {
    spin.fail(`could not read the account: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  ui.blank();
}

/**
 * Rotate to a fresh keypair.
 *
 * The old account keeps whatever it already earned — this changes where future
 * payouts land, it does not move money, and it says so rather than implying a
 * sweep happened.
 *
 * Note what is absent: the Hedera version generated a key, then sent the
 * operator to a faucet to *learn what account id the key had been given*, then
 * asked them to paste it back. An EVM address is a pure function of its key, so
 * the rotation completes here with no round-trip and nothing to mistype.
 */
export async function walletNew(): Promise<void> {
  const config = loadConfig();
  console.log(ui.banner("new payout keypair"));

  if (config?.address) {
    ui.warn(`this node currently pays out to ${ui.c.bold(config.address)}`);
    ui.muted("  generating a new key does NOT move existing funds — the old account keeps them");
    const go = await ui.confirm("generate a new keypair anyway?", false);
    if (!go) {
      ui.blank();
      return;
    }
  }

  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);

  console.log(
    ui.box(
      [
        ui.c.bold("new keypair"),
        "",
        ...ui.kv([
          ["address", ui.c.accent(account.address)],
          ["private key", ui.c.bold(key)],
        ]),
        "",
        ui.c.warn("Write the private key down now — it is not shown again."),
        "",
        "  It can receive USDG or USDC immediately. There is nothing to fund —",
        "  not even ETH — and nothing to opt into: this node only ever receives.",
      ],
      { title: "keypair", color: ui.BRAND.amber },
    ),
  );
  ui.blank();

  const go = await ui.confirm(`point this node's payouts at ${account.address}?`, true);
  if (!go) {
    ui.info("keypair not saved — nothing changed");
    ui.blank();
    return;
  }

  saveConfig({ ...(config ?? requireConfig()), address: account.address, privateKey: key });
  ui.ok(`payouts now go to ${ui.c.bold(account.address)}`);
  ui.blank();
}
