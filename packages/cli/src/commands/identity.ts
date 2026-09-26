/**
 * `xorv identity` — this node's ERC-8004 agent identity.
 *
 * An ERC-8004 identity is an NFT on Monad's canonical Identity Registry whose
 * `agentWallet` is the address the agent is paid at. Registering one does two
 * things for a provider:
 *
 *  - **Receipts bind to it.** XorvLedger records a job against the agent id
 *    only when the job's `payTo` equals the registry's `agentWallet`, so "this
 *    agent was paid for this job" is enforced on-chain, not asserted by us.
 *  - **Reputation becomes portable.** Buyer ratings and the Kimi verifier's
 *    scores land in the public Reputation Registry under the agent id, where
 *    any marketplace can read them — not in Xorv's database.
 *
 * Registration is one transaction from the payout key itself:
 * `register(agentURI)` makes the caller the owner *and* the agent wallet, so no
 * second `setAgentWallet` call (and no signature dance) is needed. That is also
 * why it needs the key and a little MON: it is the one thing in Xorv a provider
 * pays gas for. An address-only node can still earn without it; it just earns
 * without an on-chain identity.
 *
 * The agentURI points at the broker (`<broker>/agents/<nodeId>.json`), which
 * serves the ERC-8004 registration file — a URL that stays stable, so the
 * registration never needs a follow-up `setAgentURI` write when the node's
 * details change.
 */

import {
  IDENTITY_ABI,
  accountFromKey,
  explorerAddress,
  explorerAgent,
  explorerTx,
  fetchBalances,
  formatMon,
  networkConfig,
  networkLabel,
  normalizeAddress,
  publicClientFor,
  sameAddress,
  walletClientFor,
  withGasHeadroom,
  type ClientOptions,
} from "@xorv/protocol";
import { parseEventLogs, zeroAddress, type Address, type Hex, type PrivateKeyAccount } from "viem";
import {
  payoutAddress,
  requireConfig,
  resolveBrokerUrl,
  resolvePrivateKey,
  saveConfig,
  type NodeConfig,
} from "../config.js";
import * as ui from "../ui.js";

/** The registration file URL this node's identity points at. */
export function agentUri(brokerUrl: string, nodeId: string): string {
  return `${brokerUrl.replace(/\/+$/, "")}/agents/${encodeURIComponent(nodeId)}.json`;
}

/** A URI nobody but this machine can resolve — worth a warning before it goes on-chain for good. */
export function isLocalUri(uri: string): boolean {
  try {
    const host = new URL(uri).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".local");
  } catch {
    return true;
  }
}

export interface GasCheck {
  gas: bigint;
  /** Worst-case fee for this transaction, in wei (gas limit × max fee — Monad bills the limit). */
  costWei: bigint;
  balanceWei: bigint;
  enough: boolean;
}

/**
 * Can this address afford `register(agentURI)`?
 *
 * Monad charges the gas *limit*, not gas used, so the cost that matters is
 * limit × max fee per gas — the same padded limit the send will use.
 */
export async function checkRegisterGas(opts: {
  network: string;
  account: Address;
  agentURI: string;
  client?: ClientOptions;
}): Promise<GasCheck> {
  const client = publicClientFor(opts.network, opts.client);
  const { identity } = networkConfig(opts.network).erc8004;
  const [balanceWei, estimate, fees] = await Promise.all([
    client.getBalance({ address: opts.account }),
    client.estimateContractGas({
      address: identity,
      abi: IDENTITY_ABI,
      functionName: "register",
      args: [opts.agentURI],
      account: opts.account,
    }),
    client.estimateFeesPerGas(),
  ]);
  const gas = withGasHeadroom(estimate);
  const perGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
  const costWei = gas * perGas;
  return { gas, costWei, balanceWei, enough: balanceWei >= costWei };
}

/**
 * Send `IdentityRegistry.register(agentURI)` from `account` and return the new
 * agent id, read from the `Registered` event in the receipt.
 *
 * The id comes from the event rather than a pre-send simulation's return
 * value: ids are sequential, so another registration landing first would make
 * a simulated id wrong.
 */
export async function registerAgent(opts: {
  network: string;
  account: PrivateKeyAccount;
  agentURI: string;
  gas: bigint;
  client?: ClientOptions;
}): Promise<{ agentId: string; txHash: Hex }> {
  const wallet = walletClientFor(opts.network, opts.account, opts.client);
  const { identity } = networkConfig(opts.network).erc8004;
  const txHash = await wallet.writeContract({
    address: identity,
    abi: IDENTITY_ABI,
    functionName: "register",
    args: [opts.agentURI],
    gas: opts.gas,
  });
  // No replacement check: this key sends nothing else concurrently, and
  // skipping it saves a transaction lookup per poll.
  const receipt = await wallet.waitForTransactionReceipt({ hash: txHash, checkReplacement: false, timeout: 60_000 });
  if (receipt.status !== "success") {
    throw new Error(`register() reverted — ${explorerTx(opts.network, txHash)}`);
  }
  const events = parseEventLogs({ abi: IDENTITY_ABI, eventName: "Registered", logs: receipt.logs }).filter((log) =>
    sameAddress(log.address, identity),
  );
  const mine = events.find((log) => sameAddress(log.args.owner, opts.account.address)) ?? events[0];
  if (!mine) {
    throw new Error(`register() succeeded but emitted no Registered event — ${explorerTx(opts.network, txHash)}`);
  }
  return { agentId: mine.args.agentId.toString(), txHash };
}

export interface IdentityState {
  agentId: string;
  owner: Address | null;
  /** Null when the registry has cleared it (it does on every NFT transfer). */
  wallet: Address | null;
  uri: string | null;
  /** The payout address this node is configured with. */
  payout: Address;
  /** `wallet == payout` — the condition XorvLedger enforces on every receipt. */
  walletMatches: boolean;
  ownerMatches: boolean;
}

/**
 * Read an agent back from the registry and compare it to the payout address.
 *
 * `ownerOf` reverts for an id that does not exist; that surfaces as a thrown
 * error, which is the right answer for a config pointing at a phantom agent.
 */
export async function readIdentity(opts: {
  network: string;
  agentId: string;
  payout: string;
  client?: ClientOptions;
}): Promise<IdentityState> {
  const client = publicClientFor(opts.network, opts.client);
  const { identity } = networkConfig(opts.network).erc8004;
  const id = BigInt(opts.agentId);
  const [owner, wallet, uri] = await Promise.all([
    client.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "ownerOf", args: [id] }),
    client.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "getAgentWallet", args: [id] }),
    client
      .readContract({ address: identity, abi: IDENTITY_ABI, functionName: "tokenURI", args: [id] })
      .catch(() => null),
  ]);
  const payout = normalizeAddress(opts.payout);
  const walletAddr = wallet === zeroAddress ? null : normalizeAddress(wallet);
  return {
    agentId: id.toString(),
    owner: normalizeAddress(owner),
    wallet: walletAddr,
    uri,
    payout,
    walletMatches: sameAddress(walletAddr, payout),
    ownerMatches: sameAddress(owner, payout),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface IdentityRegisterOptions {
  uri?: string;
  force?: boolean;
  yes?: boolean;
}

export async function identityRegisterCommand(opts: IdentityRegisterOptions = {}): Promise<void> {
  const config = requireConfig();
  const network = config.network;
  const cfg = networkConfig(network);
  console.log(ui.banner("ERC-8004 identity"));

  if (config.agentId && !opts.force) {
    ui.ok(`this node is already agent ${ui.c.bold(`#${config.agentId}`)}`);
    ui.muted(`  ${explorerAgent(network, config.agentId)}`);
    ui.info(`check it with ${ui.c.accent("xorv identity show")}, or pass --force to register a new one`);
    ui.blank();
    return;
  }

  const payout = payoutAddress(config);
  const account = accountFromKey(resolvePrivateKey(config));
  if (!sameAddress(account.address, payout)) {
    // The registry makes the *sender* the agent wallet, so registering from any
    // other key would bind the identity to an address this node is not paid at
    // — and XorvLedger would refuse every receipt for it.
    throw new Error(
      `the configured key controls ${account.address}, not the payout address ${payout} — ` +
        "the identity must be registered from the payout key itself",
    );
  }

  const uri = opts.uri?.trim() || agentUri(resolveBrokerUrl(config), config.nodeId);
  ui.muted(`  registry  ${cfg.erc8004.identity} (${cfg.name})`);
  ui.muted(`  agentURI  ${uri}`);
  ui.muted(`  wallet    ${payout}`);
  ui.blank();
  if (isLocalUri(uri)) {
    ui.warn("that agentURI only resolves on this machine — nobody else can read the registration file");
    ui.muted("  point the node at a public broker (xorv init), or pass --uri <public url>");
    ui.blank();
  }

  const spin = ui.spinner(`checking ${ui.c.bold(payout)} can pay the gas…`);
  let gas: GasCheck;
  try {
    const balances = await fetchBalances(network, payout);
    if (BigInt(balances.monWei) === 0n) {
      spin.fail("this address holds no MON — registering an identity is the one thing a provider pays gas for");
      faucetHint(config);
      process.exitCode = 1;
      return;
    }
    gas = await checkRegisterGas({ network, account: payout, agentURI: uri });
  } catch (err) {
    spin.fail(`could not reach ${cfg.rpcUrl}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  if (!gas.enough) {
    spin.fail(`needs up to ${formatMon(gas.costWei)} for gas, holds ${formatMon(gas.balanceWei)}`);
    faucetHint(config);
    process.exitCode = 1;
    return;
  }
  spin.succeed(`gas up to ${formatMon(gas.costWei)} · balance ${formatMon(gas.balanceWei)}`);

  if (!opts.yes) {
    const go = await ui.confirm(`register an ERC-8004 identity for ${ui.c.bold(config.label)}?`, true);
    if (!go) {
      ui.info("nothing sent");
      ui.blank();
      return;
    }
  }

  const send = ui.spinner("sending register(agentURI)…");
  try {
    const { agentId, txHash } = await registerAgent({ network, account, agentURI: uri, gas: gas.gas });
    send.succeed(`registered as agent ${ui.c.bold(`#${agentId}`)}`);
    saveConfig({ ...config, agentId });
    ui.blank();
    console.log(
      ui.box(
        ui.kv([
          ["agent", ui.c.bold(`#${agentId}`)],
          ["wallet", payout],
          ["identity", ui.c.accent(explorerAgent(network, agentId))],
          ["tx", ui.c.muted(explorerTx(network, txHash))],
        ]),
        { title: "identity", color: ui.BRAND.mint },
      ),
    );
    ui.blank();
    ui.info(`restart ${ui.c.accent("xorv start")} so the broker records jobs against agent #${agentId}`);
  } catch (err) {
    send.fail(`registration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  ui.blank();
}

export async function identityShowCommand(opts: { json?: boolean } = {}): Promise<void> {
  const config = requireConfig();
  const network = config.network;
  const payout = payoutAddress(config);

  if (!config.agentId) {
    if (opts.json) {
      console.log(JSON.stringify({ agentId: null, payout, network }, null, 2));
      return;
    }
    console.log(ui.banner("ERC-8004 identity"));
    ui.warn("this node has no ERC-8004 identity yet");
    ui.muted("  it can still earn; an identity makes its receipts and reputation verifiable on-chain");
    ui.info(`register one with ${ui.c.accent("xorv identity register")} (one transaction, a little MON)`);
    ui.blank();
    return;
  }

  const state = await readIdentity({ network, agentId: config.agentId, payout });
  if (opts.json) {
    console.log(JSON.stringify({ ...state, network, explorer: explorerAgent(network, state.agentId) }, null, 2));
    if (!state.walletMatches) process.exitCode = 1;
    return;
  }

  console.log(ui.banner("ERC-8004 identity"));
  console.log(
    ui.box(
      ui.kv([
        ["agent", `${ui.c.bold(`#${state.agentId}`)} ${ui.c.muted(`(${networkLabel(network)})`)}`],
        ["owner", `${state.owner ?? "—"} ${state.ownerMatches ? ui.c.ok("· payout key") : ui.c.warn("· not this node's payout address")}`],
        [
          "agent wallet",
          state.wallet
            ? `${state.wallet} ${state.walletMatches ? ui.c.ok("· matches payout") : ui.c.bad("· does NOT match payout")}`
            : ui.c.bad("cleared (the NFT was transferred) — re-verify the wallet"),
        ],
        ["payout", `${payout} ${ui.c.muted(explorerAddress(network, payout))}`],
        ["agentURI", state.uri ? ui.c.muted(state.uri) : ui.c.muted("—")],
        ["explorer", ui.c.accent(explorerAgent(network, state.agentId))],
      ]),
      { title: "identity", color: state.walletMatches ? ui.BRAND.mint : ui.BRAND.rose },
    ),
  );
  ui.blank();
  if (!state.walletMatches) {
    // XorvLedger refuses a receipt whose payTo is not the agent's wallet, so a
    // mismatch means jobs are paid but never recorded against this identity.
    ui.bad("the registry's agent wallet is not this node's payout address — receipts will not bind to this agent");
    ui.muted("  register a new identity from the payout key: xorv identity register --force");
    process.exitCode = 1;
    ui.blank();
  }
}

function faucetHint(config: NodeConfig): void {
  const faucet = networkConfig(config.network).faucets.mon;
  ui.blank();
  if (faucet) {
    ui.info(`get testnet MON at ${ui.c.accent(faucet)} for ${ui.c.bold(config.address)}`);
    ui.muted("  a fraction of one MON covers the registration");
  } else {
    ui.info(`send a little MON to ${ui.c.bold(config.address)} to pay for the registration`);
  }
}
