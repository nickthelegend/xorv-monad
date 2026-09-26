<div align="center">

<img src="brand/xorv-logo.svg" alt="Xorv" width="260" />

**A decentralized AI capacity network.**
Rent out the Claude / Codex / Grok subscription you already pay for, and get paid **per job in USDC over [x402](https://x402.org) on [Hedera](https://hedera.com)**.

[![x402](https://img.shields.io/badge/x402-v2-7C5CFF?style=flat-square)](https://x402.org)
[![Hedera](https://img.shields.io/badge/Hedera-testnet-3DDCFF?style=flat-square)](https://hashscan.io/testnet)
[![License](https://img.shields.io/badge/license-MIT-50F0C8?style=flat-square)](LICENSE)

</div>

<div align="center">

**[Landing](https://xorv.vercel.app)** · **[App](https://xorv-app.vercel.app)** · **[`npm i -g @xorv/cli`](https://www.npmjs.com/package/@xorv/cli)**

**▶ [Watch the trailer](videos/xorv-launch/renders/video.mp4)** — 60 seconds

</div>

---

## For judges — verify in three commands

```bash
pnpm install && pnpm build && pnpm test
```

312 tests, **no credentials and no network required** — the two pieces that
touch Hedera (the facilitator and the HCS writer) are stubbed, so everything
from a buyer's first request to a published receipt runs as production code.

Then the live proof, all on Hedera testnet and all openly readable:

| What | Where |
|---|---|
| A job paid for **through the deployed app** | [`0.0.9842030@1785526598.292531686`](https://hashscan.io/testnet/transaction/0.0.9842030-1785526598-292531686) — Vercel → broker → settlement → Claude Code → result |
| A real Claude Code job settled in **Circle USDC** | [`0.0.9842030@1785516412.478664506`](https://hashscan.io/testnet/transaction/0.0.9842030-1785516412-478664506) — buyer −0.2500 USDC, provider +0.2500, **buyer paid zero gas** |
| A real Claude Code job, paid | [`0.0.9842030@1785475549.131327424`](https://hashscan.io/testnet/transaction/0.0.9842030-1785475549-131327424) |
| Receipts topic | [`0.0.9848247`](https://hashscan.io/testnet/topic/0.0.9848247) |

### What is proven, and what isn't

| | |
|---|---|
| ✅ x402 payments settling on Hedera | Many, on-chain, links above |
| ✅ HTS token settlement (USDC's exact shape) | Six jobs — token `0.0.9858754`, 6dp fungible |
| ✅ Real Claude Code jobs, paid per job | Prompt in, working code out |
| ✅ HCS audit trail | Registry, heartbeat and receipt topics |
| ✅ MCP: an agent buying capacity | Verified over stdio |
| ✅ Survives a broker restart | SQLite + MongoDB |
| ✅ **Circle USDC** (`0.0.429274`) | A real Claude Code job settled in it — [`0.0.9842030@1785516412.478664506`](https://hashscan.io/testnet/transaction/0.0.9842030-1785516412-478664506) |
| ✅ Browser wallet paying directly | HashPack over WalletConnect signs the **native** transfer the facilitator verifies. Proven from a real extension: [`0.0.9842030@1785583332.923427914`](https://hashscan.io/testnet/transaction/0.0.9842030-1785583332-923427914) — wallet `0.0.9862584` paid 0.2500 USDC, and its HBAR moved by exactly zero |
| ✅ **Deployed and public** | [landing](https://xorv.vercel.app) · [app](https://xorv-app.vercel.app) — a job paid for through the deployed app, above |
| ✅ **Published to npm** | [`@xorv/cli`](https://www.npmjs.com/package/@xorv/cli) · [`@xorv/protocol`](https://www.npmjs.com/package/@xorv/protocol) · [`@xorv/mcp`](https://www.npmjs.com/package/@xorv/mcp) |
| ✅ OS-level job sandbox | Seatbelt / bubblewrap / container — a hostile prompt cannot read the payout key |
| ✅ Docker | Image built and run; a containerised broker settled a real job — [`0.0.9842030@1785993131.634335318`](https://hashscan.io/testnet/transaction/0.0.9842030-1785993131-634335318) |

---

## The trailer

**[videos/xorv-launch/renders/video.mp4](videos/xorv-launch/renders/video.mp4)** — 62s, 1080p.

Built with HyperFrames from this repo's own design tokens, and every value on
screen is real and checkable: the transaction id, the account pair, the USDC
token, the HCS topic. The whole project is in `videos/xorv-launch/` — storyboard,
script, and the eight frame compositions — so it re-renders with
`npx hyperframes render`.

---

## `/xorv` — buy compute from inside Claude Code

```bash
xorv skills
```

That installs Xorv as a slash command. Then, in any project:

```
/xorv Write a Postgres query that finds duplicate rows by email, keeping the newest
```

Claude Code hands the task to a *different* machine — someone else's Claude or
Codex subscription — pays for it in USDC over x402, and returns the answer with
the settlement transaction beside it.

An agent paying another agent for compute, per request. No account, no API key,
no invoice. It shells out to `xorv run --json`, so the price ceiling, the quote,
and the receipt are the same ones the CLI already enforces.

Add `--global` to install it for every project.

---

## The idea

Millions of people pay ~$20–200/month for an AI subscription and use a fraction of it. Meanwhile
anyone who wants a one-off coding task done has to buy their own plan or an API key.

Xorv connects the two. You run one command, your machine joins the network, and jobs from strangers
run on the quota you were already paying for. Each job settles as a **real on-chain transfer,
directly from the buyer to you** — no invoices, no platform float, no payout schedule.

```bash
npm i -g @xorv/cli
xorv init
xorv start
```

> Published as `@xorv/cli` rather than `xorv` — npm rejects the bare name as too
> close to existing packages. The binary is still `xorv`.

---

## What makes it work

**HTTP 402 finally means something.** x402 turns "Payment Required" into a working rail: the server
answers 402 with machine-readable payment terms, the client signs, and the same request succeeds a
round-trip later. No checkout, no accounts, no API keys.

**Hedera makes sub-cent pricing real.** Three properties this specifically needs:

| Property | Why it matters here |
|---|---|
| Fixed fees (~$0.0001) | A $0.001 job isn't eaten by gas |
| ~3s finality | The buyer isn't waiting on confirmations |
| Native fee-payer model | **Buyers never need HBAR** — Xorv's facilitator pays the gas |
| Consensus Service | A public, ordered audit log without deploying a contract |

**The broker never touches the money.** The 402 response names the *matched provider's own Hedera
account* as `payTo`. Funds move buyer → provider in one transfer. Protocol fee is 0%.

---

## The flow

```
  buyer                     broker                    provider node
    │                          │                            │
    │  POST /api/quotes        │                            │
    ├─────────────────────────►│  match on price + liveness │
    │  ◄─── quote (provider,   │                            │
    │        price, expiry)    │                            │
    │                          │                            │
    │  POST /api/jobs/:quote   │                            │
    ├─────────────────────────►│                            │
    │  ◄─── 402 + accepts[]    │  USDC · HBAR               │
    │                          │                            │
    │  signs a Hedera transfer │                            │
    │  X-PAYMENT ─────────────►│  facilitator co-signs,     │
    │                          │  pays gas, submits ──────► Hedera
    │  ◄─── 200 + job id       │  ~3s, settled              │
    │       X-PAYMENT-RESPONSE │                            │
    │                          ├──── job.dispatch ─────────►│
    │  ◄═══ SSE: live events ══╪◄═══ tool calls, edits ═════┤
    │  ◄─── result             │◄──── answer ───────────────┤
    │                          ├──── receipt ─────────────► HCS topic
```

Payment settles **before** the job runs. That isn't laziness: a signed Hedera transaction is only
valid for 180 seconds, so waiting for a five-minute coding job would leave the provider unpaid for
work already done. The other risk is covered at the network level — a failed job is **reassigned to
another provider at no extra charge**, and the failure counts against the original provider's
success rate, which is what the matcher sorts on.

---

## Repo layout

```
xorv/
├── packages/
│   ├── cli/          @xorv/cli — the provider node; the binary is `xorv`
│   ├── mcp/          @xorv/mcp — Xorv as an MCP server, so agents can buy capacity
│   └── protocol/     @xorv/protocol — shared types, money math, Hedera + x402 wiring
├── services/
│   └── broker/       @xorv/broker — registry, matching, x402 gating, self-hosted
│                     facilitator, HCS audit trail, SQLite, metrics
├── apps/
│   ├── app/          xorv-app — the job board (Next.js)
│   └── landing/      xorv-landing — marketing site (Next.js + GSAP)
└── brand/            logo + mark
```

---

## Quickstart

Needs Node ≥ 20.11 and pnpm. A funded Hedera **testnet** account takes ~60s at
[portal.hedera.com](https://portal.hedera.com).

```bash
git clone https://github.com/nickthelegend/xorv.git
cd xorv && pnpm install
cp .env.example .env          # paste your operator id + key
pnpm --filter @xorv/broker setup   # creates the 3 HCS topics + demo accounts
pnpm build
```

Then, in three terminals:

```bash
pnpm broker      # coordinator + facilitator on :8402
xorv start       # your provider node
pnpm app         # job board on :3002
```

Post a job from the terminal, end to end:

```bash
xorv run "Explain what a Merkle tree is, briefly." --max 0.02
```

<details>
<summary><b>What that prints</b></summary>

```
✔ matched nivesh-macbook
╭─ quote ──────────────────────────────────────────────────╮
│ provider   nivesh-macbook · 12 jobs done                 │
│ price      $0.0010                                       │
│ goes to    0.0.9848438 — straight to the provider        │
╰──────────────────────────────────────────────────────────╯
✔ paid $0.0010 — job job_TwzS96BhAx81
✔ ⛓ settled on testnet
  https://hashscan.io/testnet/transaction/0.0.9842030-1785475156-150213566
```

</details>

---

## The CLI

The provider node. Full docs in [`packages/cli/README.md`](packages/cli/README.md).

| Command | What it does |
|---|---|
| `xorv init` | Interactive setup — probes your agent CLIs, generates or imports a payout account |
| `xorv start` | Go live: register, hold the control channel, run jobs, live earnings dashboard |
| `xorv run "…"` | The buyer side — post a job and pay for it over x402 |
| `xorv test` | Run a real job through each adapter **locally and free** — proves the node will actually earn |
| `xorv doctor` | Every reason this node might not be earning, each with the fix |
| `xorv earnings` | What this machine has made, with sparklines and on-chain balance |
| `xorv jobs` | Jobs this node has run |
| `xorv price` | Show or change what this node charges |
| `xorv status` | Who's live on the network, and what they charge |
| `xorv pause` / `resume` | Stop taking new jobs without going offline |
| `xorv cancel <job>` | Stop a running job |
| `xorv wallet` | Balances, USDC association, key rotation |
| `xorv logs` / `config` | Local job log; current configuration (key redacted) |
| `xorv completion` | Shell completions for bash, zsh, fish |

### Adapters

An adapter drives a CLI you already have installed and signed in. Xorv never asks for an API key,
because it never calls an API on your behalf.

`claude-code` · `codex` · `grok` · `opencode` · `openai-compatible` (Ollama, LM Studio, vLLM,
OpenRouter…) · `echo` (built in, always works — exercises the whole payment path with nothing
installed)

---

## For agents: the MCP server

This is the part x402 was actually invented for. An agent that needs work done
finds capacity, pays for it, and gets the result — no human, no account, no card.

```bash
# @xorv/mcp is not published to npm yet — point at the built file in your clone:
claude mcp add xorv -- node /absolute/path/to/xorv/packages/mcp/dist/index.js
```

```bash
XORV_PAYER_ID=0.0.xxxxx    # the account the agent spends from
XORV_PAYER_KEY=...
XORV_MAX_USD=0.05          # hard ceiling per call, enforced client-side too
```

Five tools: `xorv_list_providers`, `xorv_network_status`, `xorv_quote`,
`xorv_run_job`, `xorv_get_job`. Only `run_job` spends, and it refuses anything
over the ceiling — a model that can spend without a bound is a model that can
empty an account through a loop it didn't mean to write.

A real call returns the answer plus its proof:

```
Reply with a haiku about paying for compute.
> …

---
Paid $0.0010 to nivesh-macbook (0.0.9848438)
Transaction: https://hashscan.io/testnet/transaction/0.0.9842030-1785476993-771264136
HCS receipt: https://hashscan.io/testnet/transaction/0.0.9842030-1785477001-566190167
```

---

## Tests

```bash
pnpm test    # 220 tests, no credentials, no network
```

Unit tests for money math, key parsing, the matcher and the terminal layout —
plus a **full-lifecycle integration suite** that boots a real HTTP server, the
real Hono app, the real x402 resource server and the real WebSocket hub, and
drives a fake provider through quote → pay → dispatch → stream → result →
receipt. Only the two pieces that touch Hedera are stubbed.

They earn their keep: writing them turned up five real bugs, including a stale
provider status being read by the guard that decides whether a quoted node is
still alive enough to be paid.

---

## Deploying the broker

```bash
docker compose up -d
```

Persists to a volume, health-checks itself, and runs as a non-root user. Set
`XORV_TRUST_PROXY=1` behind a reverse proxy so rate limiting sees real client
IPs. `/metrics` speaks Prometheus.

> The Dockerfile and compose file are written and reviewed but **have not been
> built on this machine** — Docker wasn't available. Treat them as unverified
> until you run them.

---

## Live on Hedera testnet

Everything below is real and checkable.

| | |
|---|---|
| Network | `hedera:testnet` |
| USDC | [`0.0.429274`](https://hashscan.io/testnet/token/0.0.429274) |
| Registry topic | [`0.0.9848245`](https://hashscan.io/testnet/topic/0.0.9848245) |
| Heartbeat topic | [`0.0.9848246`](https://hashscan.io/testnet/topic/0.0.9848246) |
| Receipts topic | [`0.0.9848247`](https://hashscan.io/testnet/topic/0.0.9848247) |

**Circle USDC settlement, verified on-chain.** Ten jobs across the CLI, the web app and the MCP
server — and the buyer's HBAR balance unchanged through every one of them, because the facilitator
paid every fee:

| | |
|---|---|
| Token | [`0.0.429274`](https://hashscan.io/testnet/token/0.0.429274) — Circle's USDC on Hedera testnet |
| A Claude Code job | [`0.0.9842030@1785516412.478664506`](https://hashscan.io/testnet/transaction/0.0.9842030-1785516412-478664506) — buyer `0.0.9848440` −0.2500 USDC, provider `0.0.9848438` +0.2500 |
| Its HCS receipt | [`https://hashscan.io/testnet/transaction/0.0.9842030-1785516420-464719452`](https://hashscan.io/testnet/transaction/0.0.9842030-1785516420-464719452) |
| Buyer's gas | **zero.** Every HBAR fee was debited from the facilitator |

**A real Claude Code job, paid for over x402.** Prompt in, working Python out, $0.0100 moved from
buyer to provider on-chain:

| | |
|---|---|
| Job | `job_2eHjgDqDuMyv` · adapter `claude-code` · $0.0100 |
| Payment | [`0.0.9842030@1785475549.131327424`](https://hashscan.io/testnet/transaction/0.0.9842030-1785475549-131327424) — buyer `0.0.9848440` → provider `0.0.9848438` |
| HCS receipt | [`0.0.9842030@1785475558.951801626`](https://hashscan.io/testnet/transaction/0.0.9842030-1785475558-951801626) |

Earlier echo-adapter settlements on the same topics:
[transfer](https://hashscan.io/testnet/transaction/0.0.9842030-1785475156-150213566)
· [receipt](https://hashscan.io/testnet/transaction/0.0.9842030-1785475156-278830202)

Each receipt carries the job id, both accounts, the amount, the settlement transaction id and a
**SHA-256 of the result** — so the payload stays private while the record stays verifiable.

---

## Security — read this before running a node

A Xorv provider runs prompts written by people they have never met, on their own machine, against
their own paid account. That is the product, and it is also the risk.

**What Xorv does:** every job is spawned through a sandbox that applies the strongest containment the
host provides — macOS seatbelt, Linux bubblewrap, or an opt-in container. On macOS and Linux a job
cannot read `~/.xorv` (**your payout private key**), `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.npmrc`,
the keychain, or your browser profile, and cannot write outside its own job directory. On every host
the environment is an allowlist — a job never sees `AWS_SECRET_ACCESS_KEY` or `GITHUB_TOKEN` — and
CPU, file size and process count are capped.

Claude Code authenticates from the keychain, so the node reads its token once at startup, outside the
sandbox, and injects only that token into the job. The keychain itself stays denied; otherwise any
prompt could run `security find-internet-password -w` and take your GitHub token.

`xorv doctor` names the active tier. Take it seriously if it says `env` or `limits` — those hosts
have no filesystem boundary.

**What Xorv does not do:** hide the agent session being rented. The agent's own token is in the job's
environment because the agent needs it to run.

**For full isolation on any host:** `XORV_SANDBOX=container xorv start`. Or `XORV_SAFE_MODE=1`, which
disables tools entirely and leaves a pure text-generation service — worth less per job, but it cannot
touch a disk.

**On terms of service:** most consumer AI subscriptions are licensed to an individual and reselling
that capacity may breach them. Xorv is infrastructure and doesn't decide this for you — run it
against quota you're entitled to share, a plan that permits it, or your own local models via the
OpenAI-compatible adapter.

---

## Design notes

A few decisions that aren't obvious:

- **Provider nodes dial out.** The node opens a WebSocket *to* the broker rather than the broker
  calling in. Someone sharing a laptop is behind NAT, on hotel wifi, on a machine that sleeps —
  outbound works from all of those with no port forwarding and no inbound attack surface. A
  Cloudflare tunnel is supported and useful (public status page, second delivery path) but earnings
  never depend on it.
- **The broker's state is deliberately in memory.** Membership *is* liveness — a provider is only
  real while heartbeats keep arriving. The durable half goes to HCS, where it's public and
  append-only rather than trapped in our database.
- **A quote is a first-class object.** x402 asks the server for payment requirements twice (once to
  answer 402, once to check the payment). Both answers must name the same provider at the same
  price, so the amounts are frozen at quote time — including the HBAR figure, which derives from a
  live exchange rate read from the Mirror Node.
- **Settlement gets its own SDK client, built fresh per payment.** The payload is a transaction
  frozen by the *payer's* client; submitting one mutates the submitting client's internal state, and
  reusing it makes every payment after the first fail deep inside the SDK. This one cost real
  debugging time.

---

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How it's put together, and why the awkward parts are that way |
| [SECURITY.md](SECURITY.md) | The provider risk stated plainly, key handling, and known limitations |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, and how to write an adapter |
| [CHANGELOG.md](CHANGELOG.md) | What shipped |
| [packages/cli/README.md](packages/cli/README.md) | Full CLI reference |

---

## License

MIT — see [LICENSE](LICENSE).

Built for the [Hedera x402 bounty](https://hedera.com/x402-bounty/).
Part of the [Loompad](https://loompad.tech) ecosystem.
