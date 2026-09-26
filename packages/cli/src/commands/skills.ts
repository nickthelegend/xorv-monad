/**
 * `xorv skills` — install Xorv as a slash command inside Claude Code.
 *
 * The pitch is small and specific: you are already sitting in an agent, and
 * some of the work in front of you does not need *this* agent. A second
 * opinion from a different model, a long mechanical refactor you would rather
 * not spend your own context on, a job at 2am when your own plan is rate
 * limited. `/xorv <task>` sends that work to somebody else's machine and pays
 * them for it — a real USDC transfer on Hedera, per job, no account, no key
 * exchange, no invoice.
 *
 * That is the part worth showing. Everything else in Xorv is a marketplace;
 * this is the marketplace being used by the thing that needed it, from inside
 * the editor, with the receipt printed next to the answer.
 *
 * The skill is a plain markdown file that shells out to `xorv run --json`, so
 * it inherits every guarantee the CLI already has — the quote is shown before
 * money moves, the price ceiling is enforced, and the settlement transaction
 * comes back with the result. There is no second implementation to keep in
 * sync, and nothing here talks to Hedera directly.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ui from "../ui.js";
import { loadConfig, resolveBrokerUrl } from "../config.js";

/** Where a skill lives, per Claude Code's own layout. */
export function skillDir(scope: "project" | "user", cwd = process.cwd()): string {
  const root = scope === "user" ? os.homedir() : cwd;
  return path.join(root, ".claude", "skills", "xorv");
}

/**
 * The skill body.
 *
 * Written as instructions to an agent, not documentation for a human — it is
 * read by Claude Code at invocation time. The two things it must get right:
 * never spend more than the user expects, and always surface the receipt, so
 * a paid job can be audited after the fact rather than taken on trust.
 */
export function skillMarkdown(brokerUrl: string): string {
  return `---
name: xorv
description: Run a task on someone else's AI subscription and pay for it per job in USDC over x402 on Hedera. Use when the user asks to offload, delegate, or outsource work to the Xorv network; when they want a second model's take on something; when a job would burn context or quota that is better spent locally; or when they explicitly say /xorv. Also use to check what this machine has earned as a provider.
---

# Xorv — buy compute from the network

Xorv is a marketplace for idle AI subscription quota. Someone else's machine
runs the job on the Claude / Codex / Grok plan they already pay for, and they
get paid per job — a real USDC transfer on Hedera, settled in about three
seconds, straight to them.

You are already inside an agent. This skill exists for the work that does not
need *this* agent: a second opinion from a different model, a long mechanical
task not worth the context, or anything you would rather not spend the local
plan on.

## Running a job

\`\`\`bash
xorv run --json --yes --max 0.30 "<the task, as a complete self-contained prompt>"
\`\`\`

The prompt goes to a stranger's machine with **no other context** — no repo, no
files, no conversation history. Write it so it stands alone. If the task needs
code, paste the code into the prompt.

\`--max\` is a hard ceiling in dollars. Never raise it above what the user
authorised. If no ceiling was given, use \`0.30\` and say so.

\`--adapter claude-code\` (or \`codex\`, \`grok\`) pins a specific agent when the
user wants a particular model. Omit it and the network matches the cheapest
live provider that can do the work.

## Reading the result

\`--json\` returns:

\`\`\`json
{
  "jobId": "job_…",
  "quote": { "provider": { "label": "…", "accountId": "0.0.…" }, "priceLabel": "$0.2500" },
  "settlementTransaction": "0.0.…@…",
  "hashscan": "https://hashscan.io/testnet/transaction/…",
  "status": "completed",
  "result": "…"
}
\`\`\`

Report three things back, always:

1. **The answer** — \`result\`.
2. **Who ran it and what it cost** — the provider label and \`priceLabel\`.
3. **The receipt** — the \`hashscan\` link.

The third one is not decoration. A payment happened on a public ledger; the
user should be able to check it. Never report a paid job without its link.

\`status\` other than \`completed\` means the job failed. Say so plainly and show
\`error\`. A failed job is reassigned by the network at no extra charge, so
offer to retry rather than treating it as final.

## Before spending anything

Money leaves the user's account when this runs. So:

- **Confirm the first job of a session** unless the user already said to go
  ahead. Show the task and the ceiling. After that, stay inside the ceiling
  they set without re-asking each time.
- **Never invent a higher ceiling** because a quote came back above it. Report
  the quote and let them decide.
- If \`xorv\` is not installed, say so and stop: \`npm i -g @xorv/cli\`.

## When payment fails

A \`"status": "failed"\` with \`"stage": "payment"\` is almost always one of three
things, and the \`hints\` array says which. The one people hit first: **you
cannot pay yourself.** If this machine is also running \`xorv start\`, its
config account is the provider, and buying from itself is rejected. Buy from a
separate account:

\`\`\`bash
export XORV_PAYER_ID=0.0.xxxxx
export XORV_PAYER_KEY=...
\`\`\`

Those are read by \`xorv run\` directly; nothing else needs changing.

## Other things worth knowing

\`xorv status\` — who is live on the network right now, and at what price.
\`xorv earnings\` — what this machine has earned as a provider, job by job,
plus its on-chain balance. Use this when the user asks what they have made.
\`xorv doctor\` — why a node is not earning; it names the sandbox tier, whether
each agent CLI is actually signed in, and whether the payout account can
receive USDC.

Broker for this install: \`${brokerUrl}\`

## What this is not

This does not give you access to the user's Xorv payout key, and it does not
run jobs *for* the network on this machine — that is \`xorv start\`, which is a
deliberate decision the user makes at a terminal, not something to do on their
behalf.
`;
}

export interface SkillsOptions {
  global?: boolean;
  force?: boolean;
  print?: boolean;
}

export async function skillsCommand(opts: SkillsOptions = {}): Promise<void> {
  const config = loadConfig();
  const brokerUrl = config ? resolveBrokerUrl(config) : "http://localhost:8402";
  const body = skillMarkdown(brokerUrl);

  if (opts.print) {
    console.log(body);
    return;
  }

  const scope = opts.global ? "user" : "project";
  const dir = skillDir(scope);
  const file = path.join(dir, "SKILL.md");

  if (fs.existsSync(file) && !opts.force) {
    console.log(ui.banner("claude code skill"));
    ui.blank();
    ui.warn(`already installed at ${file}`);
    ui.info("re-install with --force, or print it with --print");
    return;
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body, "utf8");

  console.log(ui.banner("claude code skill"));
  ui.blank();
  ui.ok(`installed → ${file}`);
  ui.blank();
  console.log(`  ${ui.c.muted("restart Claude Code, then:")}`);
  console.log(`     ${ui.c.accent("/xorv")} ${ui.c.muted("refactor this parser to use a state machine")}`);
  ui.blank();
  console.log(
    `  ${ui.c.muted("the job runs on someone else's machine, and the receipt comes back with the answer.")}`,
  );
  ui.blank();
  if (!config) {
    ui.warn("this machine is not configured yet — run `xorv init` before buying jobs");
  }
}
