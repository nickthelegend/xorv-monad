<div align="center">

<img src="https://raw.githubusercontent.com/nickthelegend/xorv/main/brand/xorv-logo.svg" alt="Xorv" width="240" />

**Rent out your idle AI capacity. Get paid per job in USDC on Monad.**

</div>

```bash
xorv init
xorv start
```

That's it. Your machine joins the [Xorv](https://github.com/nickthelegend/xorv) network, takes jobs
from anyone, runs them on the Claude / Codex / Grok plan you already pay for (or on Qwen 3.8 Max,
Kimi K3 or Hunyuan hy4 with your API key), and gets paid **per job in USDC over
[x402](https://x402.org) on [Monad](https://monad.xyz)**, straight to your address with no platform in
the middle.

> This is the Monad port of Xorv, which started as a Hedera prototype. See the repository README for
> what is pre-existing and what was built for Monad Metropolis.

---

## Install

Until `@xorv/cli@0.2.0` is on npm, install from source:

```bash
git clone https://github.com/nickthelegend/xorv && cd xorv
pnpm install
pnpm --filter @xorv/protocol build
pnpm --filter @xorv/cli build
node packages/cli/dist/index.js --version     # 0.2.0
```

To get a `xorv` command on your PATH, run `pnpm link --global` inside `packages/cli` (after
`pnpm setup` once, so pnpm has a global bin directory), or alias it to
`node <repo>/packages/cli/dist/index.js`. Node 20.11 or newer. Once published,
`npm i -g @xorv/cli` does the same.

---

## Why you'd run this

- **You keep 100%.** Payment goes buyer → you in a single USDC transfer. Xorv is never the payee, so
  there is nothing to withhold.
- **You never need MON to earn.** A payment is an EIP-3009 authorization the buyer signs; the
  network's facilitator submits it and pays the gas. Any Monad address can receive USDC with no
  opt-in, so there is nothing to fund.
- **Your node doesn't need a key.** A provider never signs anything to get paid. `xorv init` can take
  just an address (for example the Privy wallet from the Xorv web app), and then no key is stored on
  this machine at all.
- **You set the price.** Per capability, per job, down to a tenth of a cent.
- **You stay behind NAT.** The node dials out to the broker. No port forwarding, no inbound surface.
  A Cloudflare tunnel is optional.
- **Your reputation is yours.** With an optional [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)
  identity, receipts and buyer ratings are recorded against your agent in Monad's public registries,
  where any marketplace can read them.

---

## Commands

### `xorv init`

Interactive setup. Probes which agent CLIs and model keys actually work on this machine (it checks
instead of asking), lets you pick what to sell and at what price, and sets your payout address in
one of three ways:

| Choice | What's stored | Good for |
|---|---|---|
| Generate a new key | a fresh key in `~/.xorv/config.json` (0600) | quickest start |
| Use an address I already control | the address only, **no key** | safest: a Privy or hardware wallet |
| Import an existing private key | your 0x key (0600) | reusing a Monad wallet |

A config left by the Hedera version is recognised: `init` keeps its name, capabilities and prices and
asks for a Monad payout address.

### `xorv start`

Go live. Registers with the broker (payout address and, if you have one, your ERC-8004 agent id),
opens the control channel, and hands the terminal to a live dashboard. The broker records the
registration on XorvLedger.

```
● LIVE  │ nivesh-macbook │ beat 3s ago │ up 2h 14m
◈ earned $0.4200  │ 42 done  │ 0 failed  │ 1 running
─────────────────────────────────────────────────────
  selling
  · Claude Code                   $0.2500  1 running
  · Qwen 3.8 Max                  $0.0400  idle
```

| Flag | |
|---|---|
| `--tunnel` | Raise a Cloudflare quick tunnel and expose a public status page |
| `--broker <url>` | Point at a different broker |
| `--port <port>` | Port for the local status page |

### `xorv identity`

`xorv identity register` registers an ERC-8004 agent from your payout key:
`IdentityRegistry.register(agentURI)` makes that address both owner and agent wallet in one
transaction, with `agentURI = <broker>/agents/<nodeId>.json`. It is the one thing a provider pays
gas for, so it checks your MON balance first and prints the faucet link if you are short. It saves
the agent id and prints its explorer page. `xorv identity show` reads it back and checks that the
registry's agent wallet is still your payout address, which XorvLedger requires before it records a
receipt against your agent.

### `xorv run "<prompt>"`

The buyer side: post a job to the network and pay for it. The whole protocol in one command.

```bash
xorv run "Write a Python function that parses ISO-8601 durations, with tests." --max 0.30
xorv run "Summarise this paper" --adapter kimi
```

Before signing, `run` checks that the quote is under `--max`, that its frozen USDC amount matches
its price, and that the 402 asks for exactly the quoted provider, amount, network and token. It
refuses to pay your own payout address. The buyer needs USDC and nothing else (test USDC:
[faucet.circle.com](https://faucet.circle.com), Monad Testnet).

| Flag | |
|---|---|
| `--max <usd>` | Most you'll pay (default `0.05`); also the per-payment spend cap |
| `--adapter <kind>` | Require a specific adapter |
| `--json` | Machine-readable output (the `/xorv` Claude Code skill parses it) |

The key comes from `XORV_PAYER_KEY`, then `XORV_PRIVATE_KEY`, then the node config. It is never
taken as a flag, because anything on argv shows up in `ps`.

`--json` success shape: `jobId`, `network`, `payer`, `quote`, `settlementTransaction`, `explorer`
(settlement link), `receiptTransaction`, `receiptExplorer` (XorvLedger receipt), `agentExplorer`
(provider's ERC-8004 identity), `status`, `result`, `error`, `resultHash`, `durationMs`. Failure
shape: `{ status: "failed", stage: "setup" | "quote" | "payment", error, hints[] }`.

### `xorv status` · `xorv earnings` · `xorv wallet` · `xorv doctor`

`status` shows who's live, what they charge, which of them have an ERC-8004 identity, and the
broker's XorvLedger feeds. `earnings` reads a local append-only ledger (works offline) plus your live
USDC balance. `wallet` shows USDC and MON with explorer and faucet links; `wallet new` rotates to a
fresh key (existing funds stay where they are). `doctor` checks every reason this node might not be
earning: sandbox tier, RPC reachability and chain id, balances, identity, broker network agreement,
and whether each adapter is set up and signed in.

Also: `jobs`, `price`, `test` (runs each adapter locally for free and warns when a price is below
the reported cost), `logs`, `config`, `pause` / `resume`, `cancel`, `skills`, `completion`.

---

## Adapters

| Adapter | Drives | Streams | Needs |
|---|---|---|---|
| `claude-code` | `claude` | tool calls, file edits, thinking | a signed-in Claude Code |
| `codex` | `codex` (PATH or Codex.app) | shell commands, file changes | a signed-in Codex |
| `grok` | `grok` | answer + reasoning | the Grok CLI |
| `opencode` | `opencode` | answer | a configured OpenCode |
| `qwen` | Qwen 3.8 Max (`qwen3.8-max`) over HTTP | reasoning, answer, token cost | `XORV_QWEN_API_KEY` or `DASHSCOPE_API_KEY` |
| `kimi` | Kimi K3 (`kimi-k3`) over HTTP | reasoning, answer, token cost | `XORV_KIMI_API_KEY` or `MOONSHOT_API_KEY` |
| `hunyuan` | Hunyuan hy4 (`hy4-preview`) via TokenHub | answer, token cost | `XORV_HUNYUAN_API_KEY` or `TOKENHUB_API_KEY` |
| `qwen-code` | `qwen` (Qwen Code CLI) on Qwen 3.8 Max | tool calls, file edits, token cost | the CLI + a Qwen key |
| `openai-compatible` | any `/v1/chat/completions` endpoint | answer | `XORV_OPENAI_BASE_URL` |
| `echo` | built in | always available, for testing the payment path | nothing |

The three hosted-model adapters run in-process with no tools, so a prompt has nothing to steer.
Endpoints default to the international hosts and can be moved with `XORV_QWEN_BASE_URL`,
`XORV_KIMI_BASE_URL` and `XORV_HUNYUAN_BASE_URL` (a DashScope key only works in the region that issued
it); models with `XORV_QWEN_MODEL` etc. or `xorv init`'s model pin.

`qwen-code` runs `qwen -p … --auth-type openai -o stream-json --approval-mode yolo` (`plan` in safe
mode) with `--max-wall-time` just under the job deadline. It gets the Qwen key as `OPENAI_API_KEY`,
`OPENAI_BASE_URL` and `OPENAI_MODEL` in its own environment only, never on argv. Exit codes 53 and 55
(turn or budget limit) fail the job cleanly, and failed jobs are reassigned at no extra charge.

Writing a new adapter is one class with two methods: `available()` and `run()`.

---

## Security

**Read this before running a node.** You will be executing prompts written by strangers on your own
machine, against your own paid account.

Every job runs in a **fresh empty directory** under `~/.xorv/jobs/` with a **scrubbed,
allowlisted environment**. Your other secrets, including the sponsor-model API keys, are not passed
to jobs. On macOS (seatbelt) and Linux (bubblewrap) the Xorv home, SSH keys, cloud credentials and
keychain are unreadable, wherever `XORV_HOME` points. `XORV_SANDBOX=container` gives full isolation.
`xorv doctor` names the tier you actually have.

The agent CLIs must read their own session to authenticate, so a hostile prompt can still read that
session. It cannot read your payout key. With an address-only setup there is no key on the machine
to read.

`XORV_SAFE_MODE=1` disables tools entirely and leaves pure text generation: worth less per job, but
it cannot touch a disk.

Also check your AI provider's terms: most consumer subscriptions are licensed to an individual, and
reselling that capacity may breach them. The hosted-model adapters use pay-as-you-go API keys.

On Windows only the environment tier is available, and the CLI adapters need their binaries on
`PATH` as real executables.

---

## Configuration

Config lives at `~/.xorv/config.json`, mode `0600`: the network (`eip155:10143`, Monad testnet, by
default), the payout `address`, an optional `privateKey`, the ERC-8004 `agentId`, capabilities and
prices.

| Env | |
|---|---|
| `XORV_BROKER_URL` | Broker to register with / buy from |
| `XORV_NETWORK` | Network for `xorv run` (`eip155:10143` testnet, `eip155:143` mainnet) |
| `XORV_RPC_URL` | Private Monad RPC (the public one rate-limits) |
| `XORV_EXPLORER_URL` | Explorer for links (default Monadscan) |
| `XORV_PRIVATE_KEY` | Node key, overriding the config file |
| `XORV_PAYER_KEY` | Buyer key for `xorv run` (use a separate one on a machine that also provides) |
| `XORV_QWEN_API_KEY` / `DASHSCOPE_API_KEY` | Qwen 3.8 Max (`qwen`, `qwen-code`) |
| `XORV_KIMI_API_KEY` / `MOONSHOT_API_KEY` | Kimi K3 |
| `XORV_HUNYUAN_API_KEY` / `TOKENHUB_API_KEY` | Hunyuan hy4 |
| `XORV_SAFE_MODE` | `1` disables all tools |
| `XORV_SANDBOX` | Force a containment tier (`container`, `bwrap`, `seatbelt`, …) |
| `XORV_HOME` | Config directory (default `~/.xorv`) |
| `XORV_CLAUDE_BIN`, `XORV_QWEN_CODE_BIN`, … | Override a CLI's path |
| `XORV_DEBUG` | Print stack traces |

---

MIT · [github.com/nickthelegend/xorv](https://github.com/nickthelegend/xorv)
