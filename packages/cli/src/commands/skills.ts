/**
 * `xorv skills` — install Xorv as a slash command inside Claude Code.
 *
 * The pitch is small and specific: you are already sitting in an agent, and
 * some of the work in front of you does not need *this* agent. A second
 * opinion from a different model, a long mechanical refactor you would rather
 * not spend your own context on, a job at 2am when your own plan is rate
 * limited. `/xorv <task>` sends that work to somebody else's machine and pays
 * them for it — a real USDC transfer on Monad, per job, no account, no key
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
 * sync, and nothing here talks to the chain directly. The `--json` shape it
 * documents is `RunJsonResult` in run.ts; change one, change the other (and the
 * committed copy in .claude/skills/xorv/SKILL.md).
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
description: Run a task on someone else's AI capacity (Claude Code, Codex, Grok, Qwen 3.8 Max, Kimi K3, Hunyuan hy4) and pay for it per job in USDC over x402 on Monad. Use when the user asks to offload, delegate, or outsource work to the Xorv network; when they want a second model's take on something; when a job would burn context or quota that is better spent locally; or when they explicitly say /xorv. Also use to check what this machine has earned as a provider.
---

# Xorv — buy compute from the network

Xorv is a marketplace for idle AI capacity. Someone else's machine runs the
job — on the Claude / Codex / Grok plan they already pay for, or on a hosted
model (Qwen 3.8 Max, Kimi K3, Hunyuan hy4) — and they get paid per job: a real
USDC transfer on Monad, settled in about a second, straight to them. The broker
never holds the money.

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

\`--adapter <kind>\` pins a specific agent or model when the user wants one:
\`claude-code\`, \`codex\`, \`grok\`, \`qwen\` (qwen3.8-max), \`kimi\` (kimi-k3),
\`hunyuan\` (hy4-preview) or \`qwen-code\` (the agentic Qwen CLI). Omit it and the
network matches the best live provider under the ceiling.

## Reading the result

\`--json\` returns:

\`\`\`json
{
  "jobId": "job_…",
  "network": "eip155:10143",
  "payer": "0x…",
  "quote": {
    "provider": { "label": "…", "address": "0x…", "agentId": "42", "model": "qwen3.8-max" },
    "priceLabel": "$0.0400",
    "usdcAmount": "40000"
  },
  "settlementTransaction": "0x…",
  "explorer": "https://testnet.monadscan.com/tx/0x…",
  "receiptExplorer": "https://testnet.monadscan.com/tx/0x…",
  "agentExplorer": "https://testnet.monadscan.com/nft/0x8004…/42",
  "status": "completed",
  "result": "…"
}
\`\`\`

Report three things back, always:

1. **The answer** — \`result\`.
2. **Who ran it and what it cost** — the provider label, its model if the quote
   names one, and \`priceLabel\`.
3. **The receipt** — the \`explorer\` link: the USDC settlement on Monad.

The third one is not decoration. A payment happened on a public chain; the
user should be able to check it. Never report a paid job without its link.
When present, also give \`receiptExplorer\` (the job's receipt on XorvLedger,
which commits to a hash of the result) and \`agentExplorer\` (the provider's
ERC-8004 identity, where its reputation lives).

\`status\` other than \`completed\` means the job failed. Say so plainly and show
\`error\`. A failed job is reassigned by the network at no extra charge, so
offer to retry rather than treating it as final.

## Before spending anything

Money leaves the user's wallet when this runs. So:

- **Confirm the first job of a session** unless the user already said to go
  ahead. Show the task and the ceiling. After that, stay inside the ceiling
  they set without re-asking each time.
- **Never invent a higher ceiling** because a quote came back above it. Report
  the quote and let them decide.
- If \`xorv\` is not installed, say so and stop. It installs from source for
  now: clone https://github.com/nickthelegend/xorv-monad, run \`pnpm install\`,
  \`pnpm --filter @xorv/protocol build\` and \`pnpm --filter @xorv/cli build\`,
  then \`pnpm link --global\` inside \`packages/cli\`. Do not suggest installing
  it from npm: until 0.2.0 is published there, npm serves the pre-port
  prototype, which cannot pay or be paid on Monad.

The buyer's wallet needs **USDC on Monad and nothing else** — no MON: the
payment is a signed authorization, and the network's facilitator pays the gas.
Test USDC comes from https://faucet.circle.com (pick Monad Testnet).

## When payment fails

A \`"status": "failed"\` with \`"stage": "payment"\` (or \`"setup"\`) comes with a
\`hints\` array that says what to fix. The one people hit first:
**you cannot pay yourself.** If this machine is also running \`xorv start\`, its
node key is the provider's payout address, and buying from it is refused
before anything is signed. Buy with a separate key:

\`\`\`bash
export XORV_PAYER_KEY=0x…   # a Monad key holding USDC
\`\`\`

That is read by \`xorv run\` directly (ahead of \`XORV_PRIVATE_KEY\` and the node
config); nothing else needs changing. The other usual causes: the wallet holds
less USDC than the price, or the quote expired (quotes last five minutes).

## Other things worth knowing

\`xorv status\` — who is live on the network right now, at what price, and
which of them carry an ERC-8004 identity.
\`xorv earnings\` — what this machine has earned as a provider, job by job,
plus its live USDC balance on Monad. Use this when the user asks what they
have made.
\`xorv doctor\` — why a node is not earning; it names the sandbox tier, whether
each agent CLI or model key actually works, whether the RPC is on the right
chain, and whether the payout address and its ERC-8004 identity line up.
\`xorv identity show\` — the node's ERC-8004 agent, read back from the registry.

Broker for this install: \`${brokerUrl}\`

## What this is not

This does not give you access to the user's Xorv payout key, and it does not
run jobs *for* the network on this machine — that is \`xorv start\`, which is a
deliberate decision the user makes at a terminal, not something to do on their
behalf. The same goes for \`xorv identity register\`, which spends MON.
`;
}

export interface SkillsOptions {
  global?: boolean;
  force?: boolean;
  print?: boolean;
}

export async function skillsCommand(opts: SkillsOptions = {}): Promise<void> {
  let config: ReturnType<typeof loadConfig> = null;
  try {
    config = loadConfig();
  } catch {
    // A stale config only changes which broker URL is baked in.
    config = null;
  }
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
