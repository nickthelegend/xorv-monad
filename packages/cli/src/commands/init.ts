/**
 * `xorv init` — the ninety-second path from "I have a Claude subscription" to
 * "my machine is earning".
 *
 * The wizard's job is to make the two genuinely hard parts painless: which of
 * the operator's agent CLIs actually work right now (probed, not asked), and
 * getting them an address that can receive USDG or USDC on Arbitrum
 * (generated, with nothing to fund).
 */

import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_NETWORK,
  accountFor,
  fetchBalances,
  formatUsd,
  explorerAddress,
  networkLabel,
  parseUsd,
  formatUnits,
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
  const network = previous?.network ?? DEFAULT_NETWORK;
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
    address: wallet.address,
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
          ["payout", `${config.address} ${ui.c.muted(`(${networkLabel(network)})`)}`],
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
  address: string;
  privateKey: string;
}

/**
 * Get the operator an address that can receive the stablecoin.
 *
 * This function used to be the hardest part of onboarding and is now the
 * easiest, and the difference is worth stating because it is the migration's
 * clearest user-facing win.
 *
 * On Hedera it had to: generate an **ECDSA** key specifically (ED25519 yields
 * no EVM address, and the faucet only accepts one), send the operator to the
 * portal faucet, wait while they funded it — because an account that has never
 * received HBAR *does not exist on Hedera* — have them copy back the `0.0.…`
 * account id the faucet assigned, validate it, and then tell them to run
 * `xorv wallet associate` before they could be paid at all.
 *
 * On Arbitrum: generate a key. The address is a function of the key, the
 * account needs no funding to exist — not even ETH — and it can receive USDG or
 * USDC immediately. A provider only ever receives, so there is nothing left
 * for them to do.
 */
async function setupWallet(previous: NodeConfig | null, network: string): Promise<WalletChoice> {
  if (previous?.address && previous.privateKey) {
    const keep = await ui.confirm(
      `reuse the existing payout account ${ui.c.bold(previous.address)}?`,
      true,
    );
    if (keep) return { address: previous.address, privateKey: previous.privateKey };
  }

  const choice = await ui.select("how do you want to get paid?", [
    {
      label: "Generate a new payout key for me",
      hint: "instant — nothing to fund, nothing to opt into",
      mode: "generate" as const,
    },
    {
      label: "I have an EVM key already",
      hint: "paste a private key",
      mode: "import" as const,
    },
  ]);

  if (choice.mode === "import") {
    while (true) {
      // A key, not an address: the address is derived, so the two can never
      // disagree. The Hedera version asked for both and could not check that
      // they matched — a mismatched pair failed at settlement and nowhere else.
      const privateKey = await ui.ask("  private key (0x…, 32 bytes of hex)");
      let account;
      try {
        account = accountFor(privateKey);
      } catch (err) {
        ui.bad(`  ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      ui.ok(`  that key controls ${ui.c.bold(account.address)}`);
      await reportBalances(network, account.address);
      return { address: account.address, privateKey: privateKey.trim() };
    }
  }

  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);

  ui.blank();
  console.log(
    ui.box(
      [
        ui.c.bold("a new payout key for this node"),
        "",
        ...ui.kv([
          ["address", ui.c.accent(account.address)],
          ["private key", ui.c.muted(`${key.slice(0, 14)}…  (saved to ${configPath()})`)],
        ]),
        "",
        "  Ready now. It can receive USDG or USDC immediately — there is nothing",
        "  to fund (no ETH either) and nothing to opt into: it only receives.",
      ],
      { title: "payout account", color: ui.BRAND.mint },
    ),
  );
  ui.blank();

  return { address: account.address, privateKey: key };
}

/** Show what the account holds. Informational — an empty one is perfectly fine. */
async function reportBalances(network: string, address: string): Promise<void> {
  const spin = ui.spinner(`checking ${address} on ${networkLabel(network)}…`);
  try {
    const balances = await fetchBalances(network, address);
    spin.stop();
    const held = balances.stablecoins.map((t) => `${formatUnits(t.units)} ${t.symbol}`).join(" · ");
    ui.ok(`  holds ${ui.c.money(held)}`);
    ui.muted(`  ${explorerAddress(network, address)}`);
  } catch (err) {
    spin.stop();
    ui.warn(`  couldn't reach the RPC to verify (${err instanceof Error ? err.message : String(err)})`);
    ui.muted("  continuing — `xorv doctor` will re-check this later");
  }
}
