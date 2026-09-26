/**
 * `xorv init` — the ninety-second path from "I have a Claude subscription" to
 * "my machine is earning".
 *
 * The wizard's job is to make the two genuinely hard parts painless: which of
 * the operator's agent CLIs and model keys actually work right now (probed, not
 * asked), and where the money goes.
 *
 * On Monad the second part got much smaller. A payout destination is just an
 * address — nothing to fund, nothing to opt into — so there are three honest
 * ways to supply one:
 *
 *  - **generate** a fresh key here (quickest; the key lives in the node config),
 *  - **import** a key the operator already has, or
 *  - **address only** — paste an address whose key lives somewhere else (the
 *    Privy wallet from the Xorv web app, a hardware wallet). No key is written
 *    to this machine at all, which is the safest node there is: a prompt that
 *    escapes the sandbox finds nothing worth stealing. A provider never signs
 *    anything to get paid, so it loses nothing but `xorv run` and
 *    `xorv identity register`, which need a key.
 */

import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_NETWORK,
  explorerAddress,
  fetchBalances,
  formatMon,
  formatUsd,
  formatUsdc,
  networkConfig,
  networkLabel,
  normalizeAddress,
  parsePrivateKey,
  parseUsd,
  type AdapterKind,
  type Capability,
} from "@xorv/protocol";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { detectAvailable } from "../adapters/index.js";
import {
  XORV_HOME,
  configExists,
  configPath,
  defaultCapability,
  loadPreviousConfig,
  saveConfig,
  type NodeConfig,
} from "../config.js";
import * as ui from "../ui.js";

/** The prompts the wizard needs — the `ui` module in real use, a script in tests. */
export interface Prompter {
  ask(question: string, fallback?: string): Promise<string>;
  confirm(question: string, fallback?: boolean): Promise<boolean>;
  select<T extends { label: string; hint?: string }>(question: string, options: T[]): Promise<T>;
}

export async function initCommand(opts: { broker?: string; force?: boolean }): Promise<void> {
  console.log(ui.banner("set up this machine as a provider node"));

  const { config: previous, legacy } = loadPreviousConfig();

  if (legacy) {
    ui.warn("this machine was set up by the Hedera version of Xorv");
    ui.muted(
      `  ${legacy.accountId ? `account ${legacy.accountId}` : "the old account"}${legacy.network ? ` on ${legacy.network}` : ""} ` +
        "can't be paid on Monad — this sets up a Monad payout address instead",
    );
    ui.muted("  your node name, capabilities and prices carry over");
    ui.blank();
  } else if (configExists() && !opts.force) {
    ui.warn(`this machine is already set up as ${ui.c.bold(previous?.label ?? "a node")}`);
    ui.muted(`  config: ${configPath()}`);
    const again = await ui.confirm("reconfigure it?", false);
    if (!again) {
      ui.blank();
      ui.info(`run ${ui.c.accent("xorv start")} to go live, or ${ui.c.accent("xorv status")} to check in`);
      return;
    }
  }

  // -- 1. identity ----------------------------------------------------------

  ui.heading("1 · this node");
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
  const spin = ui.spinner("probing the agent CLIs and model keys on this machine…");
  const detected = await detectAvailable();
  spin.stop();

  const rows = detected.map(({ adapter, available }) => [
    available ? ui.glyph.ok() : ui.glyph.off(),
    ui.c.bold(adapter.kind),
    available ? ui.c.ok("ready") : ui.c.muted("not set up"),
    available ? "" : ui.c.muted(adapter.installHint),
  ]);
  console.log(
    ui.table(
      [{ header: "" }, { header: "adapter" }, { header: "status" }, { header: "how to get it" }],
      rows,
    ),
  );
  ui.blank();

  const options = detected.map(({ adapter, available }) => {
    const preset = defaultCapability(adapter.kind);
    return {
      label: preset.model ? `${adapter.kind} ${ui.c.muted(`(${preset.model})`)}` : adapter.kind,
      hint: available ? "ready now" : "not set up — you can still list it",
      kind: adapter.kind,
      available,
    };
  });
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
      `  pin a model for ${preset.displayName}? (blank = the ${preset.model ? "preset" : "CLI's"} default)`,
      prior?.model ?? preset.model ?? "",
    );
    capabilities.push({
      ...preset,
      priceUsdMicros,
      model: model.trim() || null,
      maxConcurrency: prior?.maxConcurrency ?? preset.maxConcurrency,
    });
  }

  // -- 3. payout address ----------------------------------------------------

  ui.heading("3 · where should the money go?");
  const network = previous?.network ?? DEFAULT_NETWORK;
  const wallet = await setupWallet(previous, ui);
  await reportBalances(network, wallet.address);

  // -- 4. broker ------------------------------------------------------------

  ui.heading("4 · network");
  const brokerUrl = await ui.ask(
    "broker URL",
    opts.broker ?? previous?.brokerUrl ?? "http://localhost:8402",
  );

  // An identity is bound to the address it was registered from; a new payout
  // address makes the old one meaningless for this node.
  const keepAgent = previous?.agentId && previous.address && wallet.address === previous.address;

  const config: NodeConfig = {
    nodeId: previous?.nodeId || randomBytes(12).toString("hex"),
    label: label.trim() || "xorv-node",
    network,
    brokerUrl: brokerUrl.replace(/\/+$/, ""),
    address: wallet.address,
    privateKey: wallet.privateKey,
    agentId: keepAgent ? (previous?.agentId ?? null) : null,
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
          ["payout", `${config.address} ${ui.c.muted(`(Monad ${networkLabel(network)})`)}`],
          ["key", config.privateKey ? ui.c.muted("stored in the config (0600)") : ui.c.ok("none on this machine")],
          ["broker", config.brokerUrl],
          ["config", configPath()],
        ]),
        "",
        `${ui.c.muted("next:")}  ${ui.c.accent("xorv start")}   ${ui.c.muted("— go live and start taking jobs")}`,
        ...(config.privateKey && !config.agentId
          ? [`${ui.c.muted("then:")}  ${ui.c.accent("xorv identity register")}   ${ui.c.muted("— optional ERC-8004 identity")}`]
          : []),
      ],
      { title: "ready" },
    ),
  );
  ui.blank();
}

export interface WalletChoice {
  /** Checksummed payout address. */
  address: string;
  /** 0x key, or "" for an address-only node. */
  privateKey: string;
}

/**
 * Settle where this node gets paid.
 *
 * Pure over its prompts, so every path — reuse, generate, import (with a bad
 * key first), address-only (with a typo'd checksum first) — is tested without a
 * terminal.
 */
export async function setupWallet(previous: NodeConfig | null, prompt: Prompter): Promise<WalletChoice> {
  if (previous?.address) {
    const how = previous.privateKey ? "key on this machine" : "address only, no key here";
    const keep = await prompt.confirm(
      `reuse the existing payout address ${ui.c.bold(previous.address)} (${how})?`,
      true,
    );
    if (keep) return { address: normalizeAddress(previous.address), privateKey: previous.privateKey };
  }

  const choice = await prompt.select("how do you want to get paid?", [
    {
      label: "Generate a new key for me",
      hint: "quickest — the key is stored in the node config (0600)",
      mode: "generate" as const,
    },
    {
      label: "Use an address I already control",
      hint: "safest — e.g. your Privy wallet from the Xorv web app; no key is stored here",
      mode: "address" as const,
    },
    {
      label: "Import an existing private key",
      hint: "0x + 64 hex characters",
      mode: "import" as const,
    },
  ]);

  if (choice.mode === "address") {
    ui.muted("  A provider never signs anything to get paid, so this node needs no key at all.");
    ui.muted("  You give up `xorv run` and `xorv identity register` on this machine — both need a key.");
    while (true) {
      const raw = await prompt.ask("  payout address (0x…)");
      try {
        return { address: normalizeAddress(raw), privateKey: "" };
      } catch (err) {
        ui.bad(`  ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (choice.mode === "import") {
    while (true) {
      const raw = await prompt.ask("  private key (0x…)");
      try {
        const key = parsePrivateKey(raw);
        const address = privateKeyToAccount(key).address;
        ui.ok(`  that key controls ${ui.c.bold(address)}`);
        return { address, privateKey: key };
      } catch (err) {
        ui.bad(`  ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  ui.blank();
  console.log(
    ui.box(
      [
        ui.c.bold("a new payout key for this node"),
        "",
        ...ui.kv([
          ["address", ui.c.accent(address)],
          ["private key", ui.c.muted(`${key.slice(0, 10)}…  (saved to ${configPath()})`)],
        ]),
        "",
        "  Nothing to fund: any Monad address can receive USDC, and the",
        "  facilitator pays the gas on every payment you receive.",
      ],
      { title: "payout key", color: ui.BRAND.amber },
    ),
  );
  ui.blank();
  return { address, privateKey: key };
}

/** Show what the address holds — informational only; nothing here blocks setup. */
async function reportBalances(network: string, address: string): Promise<void> {
  const cfg = networkConfig(network);
  const spin = ui.spinner(`checking ${address} on ${cfg.name}…`);
  try {
    const balances = await fetchBalances(network, address);
    spin.stop();
    ui.ok(
      `  ${ui.c.money(formatUsdc(balances.usdcUnits))} USDC · ${formatMon(balances.monWei)} ` +
        ui.c.muted("(no MON needed to earn)"),
    );
    ui.muted(`  ${explorerAddress(network, address)}`);
    if (cfg.faucets.mon) {
      ui.muted(`  MON for an optional identity: ${cfg.faucets.mon} · test USDC: ${cfg.faucets.usdc}`);
    }
  } catch (err) {
    spin.stop();
    ui.warn(`  couldn't reach ${cfg.rpcUrl} to read the balance (${err instanceof Error ? err.message : String(err)})`);
    ui.muted("  continuing — `xorv doctor` will re-check this later");
  }
}
