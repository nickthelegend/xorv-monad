/**
 * `xorv init` — the ninety-second path from "I have a Claude subscription" to
 * "my machine is earning".
 *
 * The wizard's job is to make the two genuinely hard parts painless: which of
 * the operator's agent CLIs actually work right now (probed, not asked), and
 * getting them a Hedera account that can receive USDC (generated, with the one
 * manual step spelled out precisely).
 */

import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PrivateKey } from "@hiero-ledger/sdk";
import {
  HEDERA_TESTNET_CAIP2,
  fetchBalances,
  formatUsd,
  hashscanAccount,
  isAccountId,
  networkLabel,
  parseUsd,
  usdcTokenId,
  type AdapterKind,
  type Capability,
} from "@xorv/protocol";
import { detectAvailable } from "../adapters/index.js";
import {
  XORV_HOME,
  configExists,
  configPath,
  defaultCapability,
  loadConfig,
  saveConfig,
  type NodeConfig,
} from "../config.js";
import * as ui from "../ui.js";

export async function initCommand(opts: { broker?: string; force?: boolean }): Promise<void> {
  console.log(ui.banner("set up this machine as a provider node"));

  if (configExists() && !opts.force) {
    const existing = loadConfig();
    ui.warn(`this machine is already set up as ${ui.c.bold(existing?.label ?? "a node")}`);
    ui.muted(`  config: ${configPath()}`);
    const again = await ui.confirm("reconfigure it?", false);
    if (!again) {
      ui.blank();
      ui.info(`run ${ui.c.accent("xorv start")} to go live, or ${ui.c.accent("xorv status")} to check in`);
      return;
    }
  }

  const previous = loadConfig();

  // -- 1. identity ----------------------------------------------------------

  ui.heading("1 · identity");
  const label = await ui.ask(
    "what should this node be called?",
    previous?.label ?? `${os.hostname().split(".")[0]}-xorv`,
  );
  const region = await ui.ask(
    "region hint (optional, shown in the job board)",
    previous?.region ?? "",
  );

  // -- 2. capacity ----------------------------------------------------------

  ui.heading("2 · what are you selling?");
  const spin = ui.spinner("probing the agent CLIs on this machine…");
  const detected = await detectAvailable();
  spin.stop();

  const rows = detected.map(({ adapter, available }) => [
    available ? ui.glyph.ok() : ui.glyph.off(),
    ui.c.bold(adapter.kind),
    available ? ui.c.ok("ready") : ui.c.muted("not found"),
    available ? "" : ui.c.muted(adapter.installHint),
  ]);
  console.log(
    ui.table(
      [{ header: "" }, { header: "adapter" }, { header: "status" }, { header: "how to get it" }],
      rows,
    ),
  );
  ui.blank();

  const options = detected.map(({ adapter, available }) => ({
    label: adapter.kind,
    hint: available ? "ready now" : "not installed — you can still list it",
    kind: adapter.kind,
    available,
  }));
  const defaults = options
    .map((opt, i) => (opt.available && opt.kind !== "echo" ? i : -1))
    .filter((i) => i >= 0);
  // A fresh machine with nothing installed still gets a working node: echo is
  // the one adapter that always runs, so the operator can complete the flow and
  // see a real payment land before installing anything.
  if (defaults.length === 0) {
    const echoIndex = options.findIndex((o) => o.kind === "echo");
    if (echoIndex >= 0) defaults.push(echoIndex);
  }

  const chosen = await ui.multiSelect("which will this node sell?", options, defaults);

  ui.blank();
  ui.muted("  set a price per job. Sub-cent is normal — x402 exists for exactly this.");
  ui.blank();

  const capabilities: Capability[] = [];
  for (const option of chosen) {
    const preset = defaultCapability(option.kind as AdapterKind);
    const prior = previous?.capabilities.find((c) => c.adapter === option.kind);
    const priceAnswer = await ui.ask(
      `  price per job for ${ui.c.bold(preset.displayName)}`,
      formatUsd(prior?.priceUsdMicros ?? preset.priceUsdMicros).replace("$", ""),
    );
    let priceUsdMicros: number;
    try {
      priceUsdMicros = parseUsd(priceAnswer);
      if (priceUsdMicros <= 0) throw new Error("must be positive");
    } catch {
      ui.warn(`  couldn't read "${priceAnswer}" — using ${formatUsd(preset.priceUsdMicros)}`);
      priceUsdMicros = preset.priceUsdMicros;
    }
    const model = await ui.ask(
      `  pin a model for ${preset.displayName}? (blank = the CLI's default)`,
      prior?.model ?? "",
    );
    capabilities.push({
      ...preset,
      priceUsdMicros,
      model: model.trim() || null,
      maxConcurrency: prior?.maxConcurrency ?? preset.maxConcurrency,
    });
  }

  // -- 3. payout account ----------------------------------------------------

  ui.heading("3 · where should the money go?");
  const network = previous?.network ?? HEDERA_TESTNET_CAIP2;
  const wallet = await setupWallet(previous, network);

  // -- 4. broker ------------------------------------------------------------

  ui.heading("4 · network");
  const brokerUrl = await ui.ask(
    "broker URL",
    opts.broker ?? previous?.brokerUrl ?? "http://localhost:8402",
  );

  const config: NodeConfig = {
    nodeId: previous?.nodeId || randomBytes(12).toString("hex"),
    label: label.trim() || "xorv-node",
    network,
    brokerUrl: brokerUrl.replace(/\/+$/, ""),
    accountId: wallet.accountId,
    privateKey: wallet.privateKey,
    capabilities,
    region: region.trim() || null,
    tunnel: previous?.tunnel ?? { enabled: false, hostname: null },
    sandboxDir: previous?.sandboxDir ?? path.join(XORV_HOME, "jobs"),
    providerId: previous?.providerId ?? null,
    token: previous?.token ?? null,
  };

  saveConfig(config);

  // -- done -----------------------------------------------------------------

  ui.blank();
  console.log(
    ui.box(
      [
        `${ui.glyph.ok()} ${ui.c.bold("this machine is ready to earn")}`,
        "",
        ...ui.kv([
          ["node", ui.c.bold(config.label)],
          ["selling", capabilities.map((c) => `${c.displayName} ${ui.c.money(formatUsd(c.priceUsdMicros))}`).join(", ")],
          ["payout", `${config.accountId} ${ui.c.muted(`(${networkLabel(network)})`)}`],
          ["broker", config.brokerUrl],
          ["config", configPath()],
        ]),
        "",
        `${ui.c.muted("next:")}  ${ui.c.accent("xorv start")}   ${ui.c.muted("— go live and start taking jobs")}`,
      ],
      { title: "ready" },
    ),
  );
  ui.blank();
}

interface WalletChoice {
  accountId: string;
  privateKey: string;
}

/**
 * Get the operator a Hedera account that can receive USDC.
 *
 * Importing is offered first because anyone who already has a testnet account
 * from the portal is one paste away from done. Generating is the fallback, and
 * it deliberately stops and shows the funding step rather than pretending an
 * unfunded account is finished — an account that has never received HBAR does
 * not exist on Hedera yet, and a node registered against one would look healthy
 * right up until the first payment failed.
 */
async function setupWallet(
  previous: NodeConfig | null,
  network: string,
): Promise<WalletChoice> {
  if (previous?.accountId && previous.privateKey) {
    const keep = await ui.confirm(
      `reuse the existing payout account ${ui.c.bold(previous.accountId)}?`,
      true,
    );
    if (keep) return { accountId: previous.accountId, privateKey: previous.privateKey };
  }

  const choice = await ui.select("how do you want to get paid?", [
    {
      label: "I have a Hedera account already",
      hint: "paste an account id + private key",
      mode: "import" as const,
    },
    {
      label: "Generate a new keypair for me",
      hint: "then fund it from the faucet",
      mode: "generate" as const,
    },
  ]);

  if (choice.mode === "import") {
    while (true) {
      const accountId = await ui.ask("  Hedera account id (0.0.…)");
      if (!isAccountId(accountId)) {
        ui.bad("  that doesn't look like a Hedera account id");
        continue;
      }
      const privateKey = await ui.ask("  private key (hex or DER)");
      if (!privateKey.trim()) {
        ui.bad("  a private key is required to sign payouts");
        continue;
      }
      await reportBalances(network, accountId);
      return { accountId: accountId.trim(), privateKey: privateKey.trim() };
    }
  }

  // Generate. ECDSA, because it yields an EVM address the faucet accepts.
  const key = PrivateKey.generateECDSA();
  const evmAddress = `0x${key.publicKey.toEvmAddress()}`;

  ui.blank();
  console.log(
    ui.box(
      [
        ui.c.bold("a new keypair for this node"),
        "",
        ...ui.kv([
          ["evm address", ui.c.accent(evmAddress)],
          ["private key", ui.c.muted(`${key.toStringRaw().slice(0, 14)}…  (saved to ${configPath()})`)],
        ]),
        "",
        ui.c.warn("Hedera creates the account when it first receives HBAR."),
        "",
        `  1. open ${ui.c.accent(`https://portal.hedera.com/faucet`)}`,
        `  2. paste the EVM address above and request ${networkLabel(network)} HBAR`,
        `  3. copy the ${ui.c.bold("account id")} it gives you back (0.0.…) and paste it below`,
      ],
      { title: "fund this account", color: ui.BRAND.amber },
    ),
  );
  ui.blank();

  while (true) {
    const accountId = await ui.ask("  account id from the faucet (0.0.…)");
    if (!isAccountId(accountId)) {
      ui.bad("  that doesn't look like a Hedera account id — it looks like 0.0.12345");
      continue;
    }
    await reportBalances(network, accountId);
    return { accountId: accountId.trim(), privateKey: key.toStringRaw() };
  }
}

/** Show what the account holds, and whether it can receive USDC at all. */
async function reportBalances(network: string, accountId: string): Promise<void> {
  const spin = ui.spinner(`checking ${accountId} on ${networkLabel(network)}…`);
  try {
    const balances = await fetchBalances(network, accountId);
    spin.stop();
    const hbar = (Number(balances.hbarTinybars) / 1e8).toFixed(4);
    ui.ok(`  account found — ${ui.c.money(`${hbar} ℏ`)}`);
    if (balances.usdcAssociated) {
      ui.ok(`  associated with USDC ${ui.c.muted(`(${usdcTokenId(network)})`)}`);
    } else {
      ui.warn(
        `  not associated with USDC yet — run ${ui.c.accent("xorv wallet associate")} before taking USDC-priced jobs`,
      );
    }
    ui.muted(`  ${hashscanAccount(network, accountId)}`);
  } catch (err) {
    spin.stop();
    ui.warn(
      `  couldn't reach the mirror node to verify (${err instanceof Error ? err.message : String(err)})`,
    );
    ui.muted("  continuing — `xorv doctor` will re-check this later");
  }
}
