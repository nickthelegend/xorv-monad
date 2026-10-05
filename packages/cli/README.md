<div align="center">

<img src="https://raw.githubusercontent.com/nickthelegend/xorv-monad/main/brand/xorv-logo.svg" alt="Xorv" width="240" />

**Rent out your idle AI subscription. Get paid per job in USDC.**

</div>

```bash
git clone https://github.com/nickthelegend/xorv-monad && cd xorv-monad
pnpm install && pnpm build
alias xorv="node $PWD/packages/cli/dist/index.js"
xorv init
xorv start
```

> Not on npm yet: the `@xorv/cli` package published there is the earlier Hedera version
> and talks to a different network. Install from this repo as above.

That's it. Your machine joins the [Xorv](https://github.com/nickthelegend/xorv-monad) network, takes jobs
from anyone, runs them on the Claude / Codex / Grok plan you already pay for, and gets paid **per
job in USDC over [x402](https://x402.org) on [Arc](https://www.circle.com/arc)** — straight to your
wallet, with no platform in the middle.

---

## Why you'd run this

- **You keep 100%.** The protocol fee is zero, and payment goes buyer → you in a single on-chain
  transfer. Xorv is never the payee, so there's nothing to withhold.
- **You never need a gas token.** On Arc, USDC *is* the gas, and the network's facilitator pays the
  fee on every settlement. A fresh address can receive earnings the moment it exists.
- **You set the price.** Per capability, per job, down to a tenth of a cent. The cheapest matching
  provider wins the job.
- **You stay behind NAT.** The node dials out to the broker. No port forwarding, no inbound surface.
  A Cloudflare tunnel is optional.
- **No API keys.** Xorv drives the CLI you already have installed and signed in. It never calls an
  AI API on your behalf.

---

## Commands

### `xorv init`

Interactive setup. Probes which agent CLIs actually work on this machine (it doesn't ask — it
checks), lets you pick what to sell and at what price, and gets you an Arc payout address either
by importing a key or generating one. Nothing to fund, nothing to associate.

### `xorv start`

Go live. Registers with the broker, appends the registration to the XorvLog contract on Arc,
opens the control channel, and hands the terminal to a live dashboard.

```
● LIVE  │ nivesh-macbook │ beat 3s ago │ up 2h 14m
◈ earned $0.0420  │ 42 done  │ 0 failed  │ 1 running
─────────────────────────────────────────────────────
  selling
  · Claude Code                   $0.0100  1 running
  · Codex                         $0.0080  idle

  in flight
  ⚡ job_gBc-RIOAyq claude-code $0.0100 8.4s
      Write: src/parser.ts
```

| Flag | |
|---|---|
| `--tunnel` | Raise a Cloudflare quick tunnel and expose a public status page |
| `--broker <url>` | Point at a different broker |
| `--port <port>` | Port for the local status page |

### `xorv run "<prompt>"`

The buyer side — post a job to the network and pay for it. The whole protocol in one command.

```bash
xorv run "Write a Python function that parses ISO-8601 durations, with tests." --max 0.02
xorv run "Summarise this paper" --adapter claude-code --yes
```

| Flag | |
|---|---|
| `--max <usd>` | Most you'll pay (default `0.05`) |
| `--adapter <kind>` | Require a specific adapter |
| `--key` | Payer key, its address is derived (or `XORV_PAYER_KEY`) |
| `--broker <url>` | Broker to post to |
| `-y, --yes` | Skip the confirmation |
| `--token <symbol>` | Pay in `AUSD` or `USDC` (default: the first one the payer holds) |
| `--json` | Machine-readable output |

When the broker runs with XorvEscrow, the payment waits in escrow until the job delivers: the receipt
box shows the release transaction, and a failed job shows its refund instead.

### `xorv status` · `xorv earnings` · `xorv doctor` · `xorv wallet`

`status` shows who's live on the network and what they charge. `earnings` reads a local append-only
ledger (works offline) and shows daily sparklines plus your on-chain balance. `doctor` checks every
reason this node might not be earning and prints the fix for each. `wallet` shows the payout address and its
USDC balance, and `wallet new` rotates the key. There is no association step on Arc.

---

## Adapters

| Adapter | Drives | Streams |
|---|---|---|
| `claude-code` | `claude` | tool calls, file edits, extended thinking |
| `codex` | `codex` (PATH or Codex.app) | shell commands, file changes |
| `grok` | `grok` | answer + reasoning |
| `opencode` | `opencode` | answer |
| `openai-compatible` | any `/v1/chat/completions` endpoint | answer |
| `echo` | built in | always available, for testing the payment path |

`openai-compatible` is the open end: Ollama, LM Studio, vLLM, OpenRouter, or an internal gateway —
so a local GPU is sellable too. Configure with `XORV_OPENAI_BASE_URL`, `XORV_OPENAI_MODEL` and
optionally `XORV_OPENAI_API_KEY`.

Writing a new adapter is one class with two methods: `available()` and `run()`.

---

## Security

**Read this before running a node.** You will be executing prompts written by strangers on your own
machine, against your own paid account.

Every job runs in a **fresh empty directory** under `~/.xorv/jobs/`, which is the agent's working
directory and is deleted when the job ends. That bounds the blast radius of a hostile prompt to a
scratch directory rather than your source tree.

On top of that, every job is spawned through the strongest sandbox the host provides — macOS
seatbelt, Linux bubblewrap, or `XORV_SANDBOX=container`. A job cannot read `~/.xorv` (your payout
key), `~/.ssh`, cloud credentials or the keychain, and its environment is an allowlist. `xorv doctor`
names the active tier.

`XORV_SAFE_MODE=1` disables tools entirely and leaves pure text generation — worth less per job, but
it cannot touch a disk.

Also check your AI provider's terms: most consumer subscriptions are licensed to an individual, and
reselling that capacity may breach them.

---

## Configuration

Config lives at `~/.xorv/config.json`, mode `0600`. The payout key is stored in plaintext — a
deliberate, stated trade-off, since it's a hot key that must sign with no human present. Set
`XORV_PRIVATE_KEY` to override it from a real secret manager.

| Env | |
|---|---|
| `XORV_BROKER_URL` | Broker to register with |
| `XORV_PRIVATE_KEY` | Payout key, overriding the config file |
| `XORV_SAFE_MODE` | `1` disables all tools |
| `XORV_HOME` | Config directory (default `~/.xorv`) |
| `XORV_CLAUDE_BIN` etc. | Override a CLI's path |
| `XORV_DEBUG` | Print stack traces |

---

MIT · [github.com/nickthelegend/xorv-monad](https://github.com/nickthelegend/xorv-monad)
