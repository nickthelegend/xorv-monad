---
name: xorv-metamask
description: Buy an AI job on the Xorv network (Claude Code, Codex, Grok, Qwen 3.8 Max, Kimi K3, Hunyuan hy4 running on someone else's machine) and pay the provider per job in USDC over x402 on Monad, signed by the user's MetaMask Agent Wallet under its policy. Use when the user has MetaMask Agent Wallet (`mm`) set up and asks to offload, delegate or outsource a task to Xorv, wants a second model's answer, or says "mm xorv". Also use to list Xorv providers and prices, or to rate a job they paid for.
---

# Xorv through MetaMask Agent Wallet

Xorv is a marketplace for idle AI capacity. A stranger's machine runs the job
on the plan or model they already have, and they are paid per job: a USDC
transfer on Monad, straight to them. The broker never holds the money.

The `@xorv/mm-plugin` adds `mm xorv …` commands to MetaMask Agent Wallet. The
payment is an EIP-3009 authorization that **MetaMask signs**, so the user's
wallet policy applies (Guard Mode allowlists, 2FA). You never touch a key, and
the wallet needs **USDC on Monad and no MON**: the network's facilitator pays
the gas.

## Before anything else

```bash
mm plugins inspect @xorv/mm-plugin   # is the plugin installed?
mm doctor                            # is the wallet signed in and initialised?
```

If the plugin is missing, say so and stop. It is not on npm yet, so do not
suggest installing it by package name: that fails with a 404. The user
installs it from a checkout of https://github.com/nickthelegend/xorv-monad:

```bash
pnpm install
pnpm --filter @xorv/protocol build
pnpm --filter @xorv/mm-plugin build
mm config set experimentalPlugins true
mm config set experimentalAllowUnverifiedInstalls true   # local installs are development-only
mm plugins install "file:<absolute path to the checkout>/packages/mm-plugin"
```

They review a consent screen; do not pass `--accept-permissions` for them.
On Windows the path needs a drive letter (`E:/…`), not `/e/…`.

`mm xorv` talks to the broker at `XORV_BROKER_URL` (default
`http://localhost:8402`). Pass `--broker <url>` if the user named one.

## See who is selling, and at what price

```bash
mm xorv providers --json
```

`data.providers[]` lists each live node: `label`, `capabilities[]` (adapter,
model, `price`), `agentId` (its ERC-8004 identity on Monad), `successRate` and
`reputation.stars`. No wallet access, no sign-in needed.

## Price a task without paying

```bash
mm xorv quote --json --max 0.30 "<the task, as a complete self-contained prompt>"
```

Shows the provider, `price`, the exact `usdcAmount` and `payTo` (always the
provider). A quote is valid for five minutes; `mm xorv run` requests its own.

## Run a job

```bash
mm xorv run --json --max 0.30 "<the task, as a complete self-contained prompt>"
```

- The prompt goes to a stranger's machine with **no other context**: no repo,
  no files, no conversation. Write it so it stands alone; paste any code in.
- `--max` is a hard ceiling in dollars, enforced before MetaMask is asked to
  sign and again as the payment's spend cap. Never raise it above what the user
  authorised. If they gave none, use `0.30` and say so.
- `--adapter <kind>` pins an agent: `claude-code`, `codex`, `grok`, `qwen`,
  `kimi`, `hunyuan`, `qwen-code`. Omit it to let the network choose.
- `--chain-id 10143` (testnet) or `143` (mainnet) refuses any other chain.

MetaMask may pause for approval (Guard Mode 2FA). In `--json` mode that shows
as a `{"_notice": {"kind": "AWAITING_MFA", …}}` line (text mode prints
`[AWAITING_MFA]`). Tell the user to approve in MetaMask Mobile or the email
link; the command keeps waiting. The authorization is valid for about five
minutes, so a slow approval can expire: then simply run it again.

### Reading the result

stdout ends with one JSON envelope:

```json
{
  "ok": true,
  "data": {
    "jobId": "job_…",
    "status": "completed",
    "result": "…",
    "price": "$0.0100",
    "provider": { "label": "…", "adapter": "claude-code", "agentId": "42", "agentUrl": "https://testnet.monadscan.com/nft/0x8004…/42" },
    "payment": { "txHash": "0x…", "explorerUrl": "https://testnet.monadscan.com/tx/0x…" },
    "receiptExplorerUrl": "https://testnet.monadscan.com/tx/0x…",
    "rate": "mm xorv rate job_… --stars 5"
  },
  "hint": "…"
}
```

Always report three things:

1. **The answer**: `data.result`.
2. **Who ran it and what it cost**: `data.provider.label`, its adapter, `data.price`.
3. **The receipt**: `data.payment.explorerUrl`, the USDC settlement on Monad.
   Never report a paid job without it. Add `data.receiptExplorerUrl` (the
   XorvLedger receipt, which commits to a hash of the result) when present.

### When it fails

Failures print `{"ok": false, "error": {"code", "message", "hint"}}` on stderr
and exit 1. Relay `message` and follow `hint`. The codes:

| code | meaning | what to do |
|---|---|---|
| `XORV_QUOTE_REFUSED` | over `--max`, or the quote is inconsistent | report the price; ask before raising `--max` |
| `XORV_NO_PROVIDERS` | nobody online under the ceiling | `mm xorv providers`; retry later or raise `--max` with consent |
| `XORV_INSUFFICIENT_USDC` | wallet short of USDC | testnet: https://faucet.circle.com (Monad Testnet) |
| `XORV_SIGNATURE_DENIED` | MetaMask or its policy refused | nothing was paid; the user checks the request or policy |
| `XORV_SIGNATURE_PENDING` | approval not given yet | approve (`mm wallet requests watch <id>`), then rerun |
| `XORV_PAYMENT_REFUSED` | the 402 did not match the quote, or settlement failed | nothing was paid; rerun |
| `XORV_JOB_FAILED` | paid, but the job failed after the network's free retries | show the error and payment link; offer to retry |
| `XORV_JOB_TIMEOUT` | still running when the wait ended | `mm xorv job <jobId>` later; it is paid for |
| `XORV_BROKER_UNREACHABLE` | no broker at that URL | check `--broker` / `XORV_BROKER_URL` |
| `AUTH_FAILED` (from `mm`) | not signed in | the user runs `mm login` |

## Rate the job

A rating is a gasless EIP-712 signature (no funds move) that becomes ERC-8004
reputation for the provider's agent. Offer it after a completed job and ask for
the stars; do not rate on the user's behalf without asking.

```bash
mm xorv rate <jobId> --stars 1-5 --json
```

Only the wallet that paid can rate, once per job. `data.explorerUrl` is the
on-chain rating transaction.

## Spending rules

- Confirm the first paid job of a session unless the user already said go.
  Show the task and the ceiling. After that, stay within the ceiling they set.
- Never invent a higher ceiling because a quote came back above it.
- Each `mm xorv run` is a new payment. Do not rerun a job that completed just
  because the answer was short; ask first.
