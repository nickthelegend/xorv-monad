#!/usr/bin/env node
/**
 * xorv — rent out idle AI capacity, get paid per job in USDC over x402 on Hedera.
 */

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { earningsCommand } from "./commands/earnings.js";
import { doctorCommand } from "./commands/doctor.js";
import { skillsCommand } from "./commands/skills.js";
import { runCommand } from "./commands/run.js";
import { walletAssociate, walletNew, walletShow } from "./commands/wallet.js";
import {
  cancelCommand,
  completionCommand,
  configCommand,
  jobsCommand,
  logsCommand,
  pauseCommand,
  priceCommand,
  resumeCommand,
  testCommand,
} from "./commands/manage.js";
import * as ui from "./ui.js";

const VERSION = "0.1.0";

ui.installCursorGuard();

const program = new Command();

program
  .name("xorv")
  .description(
    "Rent out your idle Claude / Codex / Grok subscription and get paid per job in USDC over x402 on Hedera.",
  )
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: false })
  .addHelpText(
    "beforeAll",
    ui.banner("decentralized AI capacity network · x402 on Hedera"),
  )
  .addHelpText(
    "afterAll",
    [
      "",
      `  ${ui.c.bold("provider — earn")}`,
      `    ${ui.c.accent("xorv init")}          set this machine up`,
      `    ${ui.c.accent("xorv start")}         go live and take jobs`,
      `    ${ui.c.accent("xorv earnings")}      what you've made`,
      "",
      `  ${ui.c.bold("buyer — spend")}`,
      `    ${ui.c.accent('xorv run "…"')}       post a job and pay for it`,
      "",
      `  ${ui.c.muted("docs: https://github.com/nickthelegend/xorv")}`,
      "",
    ].join("\n"),
  );

program
  .command("init")
  .description("set this machine up as a provider node")
  .option("--broker <url>", "broker URL to register with")
  .option("--force", "reconfigure without asking")
  .action(wrap(initCommand));

program
  .command("start")
  .description("go live: register, hold the control channel open, run jobs")
  .option("--broker <url>", "override the configured broker URL")
  .option("--tunnel", "expose this node publicly via a Cloudflare quick tunnel")
  .option("--port <port>", "port for the local status page (default: random)")
  .action(wrap(startCommand));

program
  .command("status")
  .description("who is live on the network right now")
  .option("--broker <url>", "broker to query")
  .option("--json", "machine-readable output")
  .action(wrap(statusCommand));

program
  .command("earnings")
  .description("what this machine has earned")
  .option("--json", "machine-readable output")
  .option("--limit <n>", "how many ledger rows to read", "500")
  .action(wrap(earningsCommand));

program
  .command("skills")
  .description("install Xorv as a /xorv slash command in Claude Code")
  .option("-g, --global", "install for every project (~/.claude), not just this one")
  .option("--force", "overwrite an existing install")
  .option("--print", "print the skill instead of writing it")
  .action(wrap(skillsCommand));

program
  .command("doctor")
  .description("check everything that could stop this node earning")
  .option("--json", "machine-readable results, for CI and scripts")
  .option("--fix", "repair what has exactly one safe repair; report the rest")
  .action(wrap(doctorCommand));

program
  .command("run <prompt>")
  .description("post a job to the network and pay for it over x402")
  .option("--broker <url>", "broker to post to")
  .option("--max <usd>", "most you'll pay for this job", "0.05")
  .option("--adapter <kind>", "require a specific adapter (claude-code, codex, grok, …)")
  .option("--account <id>", "Hedera account to pay from")
  .option("--key <key>", "private key for that account")
  .option("--hbar", "pay in HBAR instead of USDC")
  .option("-y, --yes", "skip the confirmation")
  .option("--json", "machine-readable output")
  .action(wrap(runCommand));

program
  .command("jobs")
  .description("jobs this node has run")
  .option("--all", "every job on the network, not just this node's")
  .option("--limit <n>", "how many to show", "20")
  .option("--json", "machine-readable output")
  .action(wrap(jobsCommand));

program
  .command("price [capability] [usd]")
  .description("show or change what this node charges")
  .option("--json", "machine-readable output")
  .action(wrap(priceCommand));

program
  .command("test")
  .description("run a real job through each adapter locally — free, and proves the node works")
  .option("--prompt <text>", "prompt to test with")
  .option("--adapter <kind>", "test only this adapter")
  .action(wrap(testCommand));

program
  .command("logs")
  .description("this machine's local job log")
  .option("--limit <n>", "how many rows to read", "50")
  .option("--json", "machine-readable output")
  .action(wrap(logsCommand));

program
  .command("config")
  .description("show this node's configuration")
  .option("--path", "print the config file path and exit")
  .option("--json", "machine-readable output (key redacted)")
  .action(wrap(configCommand));

program
  .command("pause")
  .description("stop taking new jobs, without going offline")
  .action(wrap(pauseCommand));

program
  .command("resume")
  .description("start taking jobs again")
  .action(wrap(resumeCommand));

program
  .command("cancel <jobId>")
  .description("stop a running job (does not refund)")
  .option("--broker <url>", "broker to call")
  .action(wrap(cancelCommand));

program
  .command("completion [shell]")
  .description("print shell completions (bash, zsh, fish)")
  .action(wrap(completionCommand));

const wallet = program.command("wallet").description("the payout account");
wallet
  .command("show", { isDefault: true })
  .description("balances and USDC association status")
  .action(wrap(walletShow));
wallet
  .command("associate")
  .description("opt this account into receiving USDC (required, one-time)")
  .action(wrap(walletAssociate));
wallet
  .command("new")
  .description("generate a fresh payout keypair")
  .action(wrap(walletNew));

/**
 * Turn a thrown error into one clear line instead of a stack trace.
 *
 * Everything this CLI throws is meant to be read by an operator, and a
 * 40-line Node stack buries the sentence that says what to do. `--debug`
 * brings the stack back for anyone actually debugging.
 */
function wrap<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      ui.blank();
      ui.bad(err instanceof Error ? err.message : String(err));
      if (process.env.XORV_DEBUG && err instanceof Error && err.stack) {
        console.error(ui.c.muted(err.stack));
      }
      ui.blank();
      process.exitCode = 1;
    }
  };
}

if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  await program.parseAsync(process.argv);
}
