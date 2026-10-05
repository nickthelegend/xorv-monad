---
name: xorv
description: Run a task on someone else's AI subscription and pay for it per job in USDG (or USDC) over x402 on Arbitrum. Use when the user asks to offload, delegate, or outsource work to the Xorv network; when they want a second model's take on something; when a job would burn context or quota that is better spent locally; or when they explicitly say /xorv. Also use to check what this machine has earned as a provider.
---

# Xorv — buy compute from the network

Xorv is a marketplace for idle AI subscription quota. Someone else's machine
runs the job on the Claude / Codex / Grok plan they already pay for, and they
get paid per job — a real USDG (or USDC) transfer on Arbitrum, settled in
about a second, straight to them.

You are already inside an agent. This skill exists for the work that does not
need *this* agent: a second opinion from a different model, a long mechanical
task not worth the context, or anything you would rather not spend the local
plan on.

## Running a job

```bash
xorv run --json --yes --max 0.30 "<the task, as a complete self-contained prompt>"
```

The prompt goes to a stranger's machine with **no other context** — no repo, no
files, no conversation history. Write it so it stands alone. If the task needs
code, paste the code into the prompt.

`--max` is a hard ceiling in dollars. Never raise it above what the user
authorised. If no ceiling was given, use `0.30` and say so.

`--adapter claude-code` (or `codex`, `grok`) pins a specific agent when the
user wants a particular model. Omit it and the network matches the cheapest
live provider that can do the work.

`--token USDG` or `--token USDC` picks the stablecoin to pay with. Omit it
and `xorv run` pays with the first one the payer holds enough of (USDG first).

## Reading the result

`--json` returns:

```json
{
  "jobId": "job_…",
  "quote": { "provider": { "label": "…", "address": "0x…" }, "priceLabel": "$0.2500" },
  "paidWith": "USDG",
  "settlementTransaction": "0x…",
  "explorerUrl": "https://sepolia.arbiscan.io/tx/0x…",
  "status": "completed",
  "result": "…"
}
```

Report three things back, always:

1. **The answer** — `result`.
2. **Who ran it and what it cost** — the provider label and `priceLabel`.
3. **The receipt** — the `explorerUrl` link (Arbiscan).

The third one is not decoration. A payment happened on a public ledger; the
user should be able to check it. Never report a paid job without its link.

`status` other than `completed` means the job failed. Say so plainly and show
`error`. A failed job is reassigned by the network at no extra charge, so
offer to retry rather than treating it as final.

## Before spending anything

Money leaves the user's account when this runs. So:

- **Confirm the first job of a session** unless the user already said to go
  ahead. Show the task and the ceiling. After that, stay inside the ceiling
  they set without re-asking each time.
- **Never invent a higher ceiling** because a quote came back above it. Report
  the quote and let them decide.
- If `xorv` is not installed, say so and stop: it installs from source —
  `git clone https://github.com/nickthelegend/xorv-arbitrum && cd xorv-arbitrum && pnpm install && pnpm build`,
  then `node packages/cli/dist/index.js`. (The `@xorv/cli` on npm is the older Hedera version.)

## When payment fails

A `"status": "failed"` with `"stage": "payment"` is almost always one of three
things, and the `hints` array says which. The one people hit first: **you
cannot pay yourself.** If this machine is also running `xorv start`, its
config account is the provider, and buying from itself is rejected. Buy from a
separate account:

```bash
export XORV_PAYER_KEY=0x...   # an EVM key holding USDG or USDC — it needs no ETH
```

That is read by `xorv run` directly; nothing else needs changing.

## Other things worth knowing

`xorv status` — who is live on the network right now, and at what price.
`xorv earnings` — what this machine has earned as a provider, job by job,
plus its on-chain balance. Use this when the user asks what they have made.
`xorv doctor` — why a node is not earning; it names the sandbox tier, whether
each agent CLI is actually signed in, and whether each stablecoin's EIP-712
domain matches its contract.

Broker for this install: `http://localhost:8402`

## What this is not

This does not give you access to the user's Xorv payout key, and it does not
run jobs *for* the network on this machine — that is `xorv start`, which is a
deliberate decision the user makes at a terminal, not something to do on their
behalf.
