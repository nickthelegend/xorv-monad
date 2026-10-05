/**
 * `pnpm --filter @xorv/broker privy:setup` — give the operator a Privy server wallet.
 *
 * Creates the operator policy (`operatorPolicy` in @xorv/protocol: the escrow,
 * log, registry and settlement-token calls the broker makes, on this chain, at
 * zero value) and a server wallet that runs under it, then prints the env lines
 * that switch the broker to it. Run once per deployment, after the contracts
 * are deployed, because the policy names their addresses.
 *
 *   PRIVY_APP_ID=… PRIVY_APP_SECRET=… pnpm --filter @xorv/broker privy:setup
 *   … privy:setup --print     only print the policy JSON; no Privy call
 *   … privy:setup --policy-id <id>   update that policy's rules instead of creating one
 *
 * Gas sponsorship is switched on in the Privy dashboard (Gas sponsorship →
 * Monad Testnet); the broker then sends with `sponsor: true` and the wallet
 * needs no MON. Granting the escrow's attester and the registry's operator role
 * to the new address is an owner transaction on those contracts, printed below.
 */
import { config as loadDotenv } from "dotenv";
import { operatorPolicy, escrowAddress, logAddress, registryAddress, DEFAULT_NETWORK } from "@xorv/protocol";

const envFile = process.env.XORV_ENV_FILE?.trim();
loadDotenv({ path: envFile || new URL("../../../../.env", import.meta.url).pathname, quiet: true });

const args = process.argv.slice(2);
const network = process.env.XORV_NETWORK?.trim() || DEFAULT_NETWORK;
const policy = operatorPolicy({
  network,
  escrow: escrowAddress(network),
  log: process.env.XORV_LOG_ADDRESS?.trim() || logAddress(),
  registry: registryAddress(network),
});

if (args.includes("--print")) {
  console.log(JSON.stringify(policy, null, 2));
  process.exit(0);
}

const appId = process.env.PRIVY_APP_ID?.trim();
const appSecret = process.env.PRIVY_APP_SECRET?.trim();
if (!appId || !appSecret) {
  console.error("Set PRIVY_APP_ID and PRIVY_APP_SECRET (dashboard.privy.io → your app → App settings → API keys).");
  console.error("`--print` shows the policy that would be created without calling Privy.");
  process.exit(2);
}

const { PrivyClient } = await import("@privy-io/node");
const privy = new PrivyClient({ appId, appSecret });

const at = args.indexOf("--policy-id");
const existing = at >= 0 ? args[at + 1] : undefined;
const policyId = existing
  ? (await privy.policies().update(existing, { name: policy.name, rules: policy.rules } as never), existing)
  : (await privy.policies().create(policy as never)).id;
console.log(`policy   ${policyId}  "${policy.name}", ${policy.rules.length} ALLOW rules (anything else is denied)`);

const wallet = await privy.wallets().create({ chain_type: "ethereum", policy_ids: [policyId], display_name: "xorv-operator" } as never);
console.log(`wallet   ${wallet.id}  ${wallet.address}`);
console.log("");
console.log("Add to .env:");
console.log("  XORV_SIGNER=privy");
console.log(`  XORV_PRIVY_WALLET_ID=${wallet.id}`);
console.log(`  XORV_PRIVY_WALLET_ADDRESS=${wallet.address}`);
console.log("");
console.log("Then, from the contracts' owner, hand the operator roles to the wallet:");
const escrow = escrowAddress(network);
const registry = registryAddress(network);
if (escrow) console.log(`  cast send ${escrow} "setAttester(address)" ${wallet.address}`);
if (registry) console.log(`  cast send ${registry} "setOperator(address)" ${wallet.address}`);
