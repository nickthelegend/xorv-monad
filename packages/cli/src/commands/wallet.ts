/**
 * `xorv wallet` — the payout account.
 *
 * The question that matters is "can this account actually be paid in USDC?",
 * and it has two possible yeses. Explicit association is one. The other is
 * automatic association slots (HIP-904), where a token lands without any prior
 * opt-in — which is how every account `pnpm setup:hedera` creates is
 * configured.
 *
 * Reporting only on explicit association told those operators they could not be
 * paid and sent them to spend HBAR on a transaction they did not need. So both
 * this and `doctor` read `canReceiveUsdc`, which mirrors what x402's own
 * preflight checks before it will settle.
 */

import { PrivateKey } from "@hiero-ledger/sdk";
import {
  associateToken,
  fetchBalances,
  formatUsd,
  hashscanAccount,
  hashscanToken,
  hederaClient,

  networkLabel,
  parsePrivateKey,
  usdcTokenId,
} from "@xorv/protocol";
import { loadConfig, requireConfig, resolvePrivateKey, saveConfig } from "../config.js";
import * as ui from "../ui.js";

export async function walletShow(): Promise<void> {
  const config = requireConfig();
  console.log(ui.banner("payout wallet"));

  const spin = ui.spinner(`querying ${config.accountId}…`);
  try {
    const balances = await fetchBalances(config.network, config.accountId);
    spin.stop();
    console.log(
      ui.box(
        ui.kv([
          ["account", ui.c.bold(config.accountId)],
          ["network", `${config.network} ${ui.c.muted(`(${networkLabel(config.network)})`)}`],
          ["usdc", ui.c.money(formatUsd(Number(balances.usdcUnits)))],
          ["hbar", `${(Number(balances.hbarTinybars) / 1e8).toFixed(4)} ℏ`],
          [
            "can be paid",
            balances.canReceiveUsdc
              ? `${ui.c.ok("yes")} ${ui.c.muted(
                  balances.usdcAssociated ? "(associated)" : "(automatic association)",
                )}`
              : `${ui.c.bad("no")} ${ui.c.muted("→ xorv wallet associate")}`,
          ],
          ["token", ui.c.muted(`${usdcTokenId(config.network)}  ${hashscanToken(config.network, usdcTokenId(config.network))}`)],
          ["hashscan", ui.c.muted(hashscanAccount(config.network, config.accountId))],
        ]),
        { title: "wallet", color: ui.BRAND.mint },
      ),
    );
  } catch (err) {
    spin.fail(`could not read the account: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  ui.blank();
}

export async function walletAssociate(): Promise<void> {
  const config = requireConfig();
  const token = usdcTokenId(config.network);

  console.log(ui.banner("associate USDC"));

  const balances = await fetchBalances(config.network, config.accountId).catch(() => null);
  if (balances?.usdcAssociated) {
    ui.ok(`${config.accountId} is already associated with USDC (${token})`);
    ui.blank();
    return;
  }
  if (balances?.canReceiveUsdc) {
    // Spending HBAR to opt into a token the account would auto-associate
    // anyway is pure waste, so say so rather than doing it.
    ui.ok(`${config.accountId} can already receive USDC via automatic association`);
    ui.muted(
      `  ${balances.maxAutoAssociations === -1 ? "unlimited" : balances.maxAutoAssociations} automatic slot(s) — no transaction needed`,
    );
    ui.blank();
    return;
  }

  ui.info(`associating ${ui.c.bold(config.accountId)} with USDC ${ui.c.muted(token)}`);
  ui.muted("  this costs a fraction of a cent in HBAR and only has to be done once");
  ui.blank();

  const spin = ui.spinner("submitting TokenAssociateTransaction…");
  let client;
  try {
    const key = parsePrivateKey(resolvePrivateKey(config));
    client = hederaClient(config.network, config.accountId, key);
    const result = await associateToken(client, config.accountId, token);
    spin.succeed("associated");
    if (result.transactionId) {
      ui.muted(`  tx ${result.transactionId}`);
    }
    ui.blank();
    ui.ok(`${config.accountId} can now receive USDC — it will show up in \`xorv earnings\``);
  } catch (err) {
    spin.fail(`association failed: ${err instanceof Error ? err.message : String(err)}`);
    const message = err instanceof Error ? err.message : "";
    if (message.includes("INSUFFICIENT_PAYER_BALANCE") || message.includes("INSUFFICIENT_TX_FEE")) {
      ui.blank();
      ui.warn("this account has no HBAR to pay the association fee");
      ui.muted(`  fund it at https://portal.hedera.com/faucet, then run this again`);
    }
    process.exitCode = 1;
  } finally {
    client?.close();
  }
  ui.blank();
}

/**
 * Rotate to a fresh keypair.
 *
 * The old account keeps whatever it already earned — this changes where future
 * payouts land, it does not move money, and it says so rather than implying a
 * sweep happened.
 */
export async function walletNew(): Promise<void> {
  const config = loadConfig();
  console.log(ui.banner("new payout keypair"));

  if (config?.accountId) {
    ui.warn(`this node currently pays out to ${ui.c.bold(config.accountId)}`);
    ui.muted("  generating a new key does NOT move existing funds — the old account keeps them");
    const go = await ui.confirm("generate a new keypair anyway?", false);
    if (!go) {
      ui.blank();
      return;
    }
  }

  const key = PrivateKey.generateECDSA();
  const evm = `0x${key.publicKey.toEvmAddress()}`;

  console.log(
    ui.box(
      [
        ui.c.bold("new ECDSA keypair"),
        "",
        ...ui.kv([
          ["evm address", ui.c.accent(evm)],
          ["private key", ui.c.bold(key.toStringRaw())],
        ]),
        "",
        ui.c.warn("Write the private key down now — it is not shown again."),
        "",
        `  1. fund the EVM address at ${ui.c.accent("https://portal.hedera.com/faucet")}`,
        `  2. copy the account id it returns (0.0.…)`,
        `  3. paste it below to point this node at the new account`,
      ],
      { title: "keypair", color: ui.BRAND.amber },
    ),
  );
  ui.blank();

  const accountId = await ui.ask("  new account id (blank to skip)");
  if (!accountId.trim()) {
    ui.info("keypair not saved — nothing changed");
    ui.blank();
    return;
  }
  if (!/^\d+\.\d+\.\d+$/.test(accountId.trim())) {
    ui.bad("that doesn't look like a Hedera account id — nothing changed");
    process.exitCode = 1;
    return;
  }

  const next = { ...(config ?? requireConfig()), accountId: accountId.trim(), privateKey: key.toStringRaw() };
  saveConfig(next);
  ui.ok(`payouts now go to ${ui.c.bold(next.accountId)}`);
  ui.info(`run ${ui.c.accent("xorv wallet associate")} so it can receive USDC`);
  ui.blank();
}
