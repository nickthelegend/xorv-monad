<div align="center">

<img src="https://raw.githubusercontent.com/nickthelegend/xorv/main/brand/xorv-logo.svg" alt="Xorv" width="240" />

**Rent out your idle AI subscription. Get paid per job in USDC.**

</div>

```bash
npm i -g @xorv/cli
xorv init
xorv start
```

That's it. Your machine joins the [Xorv](https://github.com/nickthelegend/xorv) network, takes jobs
from anyone, runs them on the Claude / Codex / Grok plan you already pay for, and gets paid **per
job in USDC over [x402](https://x402.org) on [Hedera](https://hedera.com)** — straight to your
wallet, with no platform in the middle.

---

## Why you'd run this

- **You keep 100%.** The protocol fee is zero, and payment goes buyer → you in a single on-chain
  transfer. Xorv is never the payee, so there's nothing to withhold.
- **You never need HBAR.** The network's facilitator is the fee payer on every settlement. Your
  account can hold nothing but earnings and still get paid.
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
checks), lets you pick what to sell and at what price, and gets you a Hedera payout account either
by importing one or generating a keypair and walking you through funding it.

### `xorv start`

Go live. Registers with the broker, publishes the registration to a Hedera Consensus Service topic,
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
xorv run "Summarise this paper" --adapter claude-code --hbar
```

| Flag | |
|---|---|
| `--max <usd>` | Most you'll pay (default `0.05`) |
| `--adapter <kind>` | Require a specific adapter |
| `--hbar` | Pay in HBAR instead of USDC |
| `--account` / `--key` | Payer credentials (or `XORV_PAYER_ID` / `XORV_PAYER_KEY`) |
| `--json` | Machine-readable output |

### `xorv status` · `xorv earnings` · `xorv doctor` · `xorv wallet`

`status` shows who's live on the network and what they charge. `earnings` reads a local append-only
ledger (works offline) and shows daily sparklines plus your on-chain balance. `doctor` checks every
reason this node might not be earning and prints the fix for each. `wallet` handles balances, USDC
association (`xorv wallet associate` — required once) and key rotation.

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

It is **not a sandbox**. These CLIs can run shell commands, and a shell command can leave a
directory. For a real boundary, run the node in a container or a VM.

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

MIT · [github.com/nickthelegend/xorv](https://github.com/nickthelegend/xorv)
