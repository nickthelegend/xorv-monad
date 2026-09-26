/**
 * `pnpm setup:hedera` — provision everything Xorv needs on Hedera, once.
 *
 * Creates the three HCS topics, and optionally a provider account and a buyer
 * account so the demo has two distinct parties (a transfer from an account to
 * itself nets zero and is not a payment).
 *
 * Both generated accounts are created with unlimited automatic token
 * associations. That is the single most useful thing you can do for a Hedera
 * account that is going to receive a stablecoin: without it, USDC cannot land
 * and the x402 preflight rejects the payment before it is ever submitted.
 */

import {
  AccountCreateTransaction,
  Hbar,
  PrivateKey,
  TransferTransaction,
  AccountId,
} from "@hiero-ledger/sdk";
import {
  createTopic,
  hashscanAccount,
  hashscanTopic,
  hederaClient,
  networkLabel,
  usdcTokenId,
} from "@xorv/protocol";
import { loadConfig } from "../config.js";

const config = loadConfig();
const client = hederaClient(config.network, config.operatorId, config.operatorKey);

const args = new Set(process.argv.slice(2));
const wantTopics = args.has("--topics") || args.size === 0;
const wantAccounts = args.has("--accounts") || args.size === 0;

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function createAccount(name: string, hbar: number): Promise<{ id: string; key: string }> {
  const key = PrivateKey.generateECDSA();
  const tx = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key.publicKey)
    .setInitialBalance(new Hbar(hbar))
    // -1 = unlimited automatic token associations (HIP-904). Without this the
    // account must explicitly associate USDC before it can be paid.
    .setMaxAutomaticTokenAssociations(-1)
    .setAccountMemo(`xorv ${name}`)
    .execute(client);
  const receipt = await tx.getReceipt(client);
  const id = receipt.accountId;
  if (!id) throw new Error(`${name} account creation returned no id`);
  return { id: id.toString(), key: key.toStringRaw() };
}

async function main(): Promise<void> {
  console.log("");
  console.log(`  ▁▂▃  XORV setup — ${config.network} (${networkLabel(config.network)})`);
  console.log("");
  line("operator", config.operatorId);
  line("usdc token", usdcTokenId(config.network));
  console.log("");

  const env: Record<string, string> = {};

  if (wantTopics) {
    console.log("  creating HCS topics…");
    const topics: Array<[string, string, string]> = [
      ["XORV_TOPIC_REGISTRY", "registry", "xorv:registry:v1 - provider registrations"],
      ["XORV_TOPIC_HEARTBEAT", "heartbeat", "xorv:heartbeat:v1 - provider liveness and capacity"],
      ["XORV_TOPIC_RECEIPTS", "receipts", "xorv:receipts:v1 - settled job receipts"],
    ];
    for (const [envName, label, memo] of topics) {
      const id = await createTopic(client, memo);
      env[envName] = id;
      line(label, `${id}   ${hashscanTopic(config.network, id)}`);
    }
    console.log("");
  }

  if (wantAccounts) {
    console.log("  creating demo accounts (unlimited auto-association)…");
    const provider = await createAccount("provider payout", 5);
    line("provider", `${provider.id}   ${hashscanAccount(config.network, provider.id)}`);
    env.XORV_DEMO_PROVIDER_ID = provider.id;
    env.XORV_DEMO_PROVIDER_KEY = provider.key;

    const payer = await createAccount("demo buyer", 20);
    line("buyer", `${payer.id}   ${hashscanAccount(config.network, payer.id)}`);
    env.XORV_DEMO_PAYER_ID = payer.id;
    env.XORV_DEMO_PAYER_KEY = payer.key;
    console.log("");
  }

  console.log("  paste into .env:");
  console.log("");
  for (const [key, value] of Object.entries(env)) {
    console.log(`${key}=${value}`);
  }
  console.log("");
  client.close();
}

main().catch((err) => {
  console.error("\n  setup failed:", err instanceof Error ? err.message : err);
  client.close();
  process.exit(1);
});

export { createAccount, TransferTransaction, AccountId };
