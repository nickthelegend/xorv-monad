<div align="center">

<img src="brand/xorv-logo.svg" alt="Xorv" width="260" />

**A decentralized AI capacity network on Monad.**
Rent out the Claude / Codex / Kimi / Qwen capacity you already pay for. Get paid per job in **Agora AUSD**, through an **on-chain escrow** that pays you when the work is delivered — and refunds the buyer when it isn't.

[![Monad](https://img.shields.io/badge/Monad-testnet%2010143-836EF9?style=flat-square)](https://monad.xyz)
[![AUSD](https://img.shields.io/badge/settles%20in-AUSD-1F6BFF?style=flat-square)](https://www.agora.finance)
[![x402](https://img.shields.io/badge/x402-escrow%20scheme-7C5CFF?style=flat-square)](https://x402.org)
[![Envio](https://img.shields.io/badge/indexed%20by-Envio%20HyperIndex-FF5A1F?style=flat-square)](https://envio.dev)
[![Chainlink CRE](https://img.shields.io/badge/refunds%20by-Chainlink%20CRE-375BD2?style=flat-square)](https://docs.chain.link/cre)
[![License](https://img.shields.io/badge/license-MIT-50F0C8?style=flat-square)](LICENSE)

**Track 04 — Trust, Identity & AI Infrastructure** · Monad Metropolis

**[Contracts](contracts/README.md)** · **[Indexer](indexer/)** · **[CRE refund keeper](cre/README.md)** · **[Agent](packages/agent/)** · **[Architecture](ARCHITECTURE.md)**

</div>

---

## The problem

Millions of people pay $20–200 a month for an AI subscription and use a fraction of it. Anyone who
wants one task done has to buy their own plan or an API key. And every "pay a stranger for compute"
design so far has asked one side to trust the other: the buyer pays up front and hopes, or the
provider works first and hopes. AI agents make it worse: an agent that can pay is an agent that can
be cheated, or can overspend.

## What Xorv does

You run one command and your machine joins the network. Jobs from strangers run on capacity you were
already paying for, inside an OS sandbox that keeps your keys out of reach. Buyers — a person in the
browser, `xorv run` in a terminal, Claude Code over MCP, or an **autonomous Kimi/Qwen agent with a
budget** — pay per job with a single signature: **no gas, no account, no API key**.

On Monad the money never goes straight from buyer to provider. It goes into **XorvEscrow**:

- **Delivered →** the escrow pays the provider and records the SHA-256 of the result beside the payment.
- **Provider fails →** the job moves to another provider (the payee changes, the money doesn't) or the buyer is refunded.
- **Nobody settles by the deadline →** *anyone* can refund the buyer — and a **Chainlink CRE workflow** makes sure someone does, even if the broker is gone.

Every settlement also writes the provider's outcome into **XorvRegistry** in the same transaction.
Reputation can't be claimed, only earned, and the matcher ranks providers on it. **Envio HyperIndex**
turns all of it — jobs, receipts, reputation, daily totals — into the history the app shows, which
Monad's 100-block `eth_getLogs` cap would otherwise make unreachable.

---

## For judges — verify it yourself

Everything below runs offline unless noted.

```bash
git clone --recursive https://github.com/nickthelegend/xorv-monad && cd xorv-monad
pnpm install && pnpm build && pnpm test            # 418 TypeScript tests (protocol, broker, CLI, MCP, agent, app)

cd contracts && forge test                         # 125 Solidity tests: unit, fuzz, 4 invariants, registry, keeper, Cleanverse gate
FORK_TESTS=1 forge test --match-contract Fork      # vs the REAL AUSD, USDC and Cleanverse A-Pass on a Monad testnet fork (network)
cd ../cre/refund-keeper && bun test                # the CRE workflow under the SDK's own test runtime
cd ../indexer && pnpm install --ignore-workspace && pnpm codegen && pnpm test   # Envio: full job lifecycles
```

And the whole product, end to end, with real processes against real contracts:

```bash
MODE=anvil scripts/e2e-local.sh          # fresh chain: escrow → registry reputation, through the real broker
MODE=fork  scripts/e2e-local.sh          # Monad testnet fork, paying in the real Agora AUSD from Agora's faucet
AGENT=1    scripts/e2e-local.sh          # + xorv-agent (Kimi and Qwen, FIXTURE MODE) buying jobs through the MCP server
INDEXER=1  scripts/e2e-local.sh          # + the Envio indexer, checked against the chain
SIGNER=privy-mock scripts/e2e-local.sh   # the operator signs through Privy's policy (PRIVY MOCK MODE)
MODE=fork CLEANVERSE=1 scripts/e2e-local.sh   # escrow gated by Cleanverse's real A-Pass
```

| Proof | Result |
|---|---|
| `MODE=anvil` — broker + provider node + `xorv run` | **13/13**: paid through escrow, released with the result hash, provider got exactly the price, **buyer spent 0 MON**, registry `completed = 1`, `earned = price` |
| `MODE=fork` — the same against **real AUSD** on Monad testnet | **13/13** |
| `AGENT=1` — `xorv-agent` → MCP → broker → escrow, Kimi and Qwen | **6/6 each**: two jobs bought, spent exactly the prices, stayed in budget, on-chain proof attached |
| `INDEXER=1` — Envio over the same chain | **8/8**: jobs, releases, provider score and earnings in the index match the chain |
| `SIGNER=privy-mock` — every operator write through the Privy policy | **17/17**: fund, release, sponsored registration and audit log all allowed; nothing refused |
| `MODE=fork CLEANVERSE=1` — Cleanverse's real A-Pass gating the escrow | **18/18**: a buyer without an A-Pass is refused with nothing moved, then pays once issued one |
| Fork tests — escrow + registry vs the real tokens | fund → release → reputation on **AUSD** and **USDC** (Monad testnet) |

### Status, stated plainly

| | |
|---|---|
| ✅ Contracts written and tested; deploy + Sourcify verification scripted | `scripts/deploy-testnet.sh monad-testnet` |
| ✅ Escrow in every payment path — broker, `xorv run`, MCP, agent, browser wallet, demo route | 418 TS tests |
| ✅ End to end locally, including the real AUSD contract on a Monad fork | the table above |
| ✅ Envio indexer, CRE workflow (compiles to WASM, tested on the SDK runtime), Kimi/Qwen adapters and agent | `indexer/`, `cre/`, `packages/agent` |
| ✅ Cleanverse CVI gate on the escrow, proven against the real A-Pass on a fork | `contracts/src/CleanverseGate.sol` |
| ✅ Operator as a policy-locked, gas-sponsored Privy server wallet (mock mode until keys) | `packages/protocol/src/privy.ts` |
| ⏸ **Not deployed yet**, by choice: everything runs locally for now | `scripts/deploy-testnet.sh monad-testnet` when it's time |
| ⏳ Live runs that need a key or account: Kimi, Qwen, Privy, `cre login`, Envio Cloud, Cleanverse A-Passes | [docs/SPONSOR-GAP.md](docs/SPONSOR-GAP.md) |

---

## Monad, AUSD and the sponsor stack

| | What Xorv does with it |
|---|---|
| **Monad** | 0.4 s blocks and sub-cent fees make a $0.001 job viable and fund the escrow before the provider has read the prompt. Gas is charged on the gas *limit*, so the deploy pads estimates by 10%, not 30%. |
| **Agora AUSD** | The default settlement token. EIP-3009 means the buyer's side is one EIP-712 signature. Its domain name is **"Agora Dollar"**, not its `name()` ("AUSD") — Xorv configures each token's domain and checks it against `DOMAIN_SEPARATOR()` on chain. Circle's test USDC is accepted too. |
| **Envio HyperIndex** | [`indexer/`](indexer): jobs (full lifecycle, seconds to settle), providers (registry score, heartbeats, earnings), buyers, receipts linked to jobs, daily and network totals. The app's history comes from here. |
| **Chainlink CRE** | [`cre/refund-keeper`](cre): cron → Envio (DON consensus) → `isRefundable` on Monad → signed report → `XorvRefundKeeper` → refund. Refunds survive the broker. |
| **Kimi (Moonshot) · Qwen (Alibaba)** | Two ways: providers **sell** Kimi/Qwen capacity through first-class adapters, and **`xorv-agent`** uses Kimi or Qwen as an autonomous buyer with a budget enforced in code. |
| **x402** | A custom `escrow` scheme: the buyer signs `ReceiveWithAuthorization` with a nonce derived from the job id and refund deadline, so a signature can only ever fund that job. |

---

## How a job is paid for

```
  buyer                     broker                        provider node
    │  POST /api/quotes        │                                │
    ├─────────────────────────►│  match: price → on-chain score │
    │  ◄── quote (job id, deadline, provider)                   │
    │  POST /api/jobs/:quote   │                                │
    │  ◄── 402 accepts[]: escrow (AUSD, USDC), exact (fallback) │
    │  PAYMENT-SIGNATURE ─────►│  verify → XorvEscrow.fund()    │
    │  (ReceiveWithAuthorization, nonce = job + deadline)       │
    │  ◄── 200 + jobId         ├──── job.dispatch (WebSocket) ─►│  sandboxed run
    │  ◄═══ SSE events ════════╪◄═══ tool calls, edits ═════════┤
    │  ◄── result              │◄─── answer ────────────────────┤
    │                          ├── XorvEscrow.release(sha256(result))
    │                          │       └─ XorvRegistry.recordOutcome
    │                          │
    │       deadline passes, nobody settled ──► Chainlink CRE ──► XorvRefundKeeper ──► refund to buyer
```

---

## Quickstart

Needs Node ≥ 20.11, pnpm and Foundry. The indexer needs Node 22; the CRE workflow needs Bun.

```bash
cp .env.example .env                          # operator key (facilitator + escrow attester), demo payer
scripts/deploy-testnet.sh monad-testnet       # registry + escrow + log + refund keeper, wired, Sourcify-verified
scripts/faucet-ausd.sh                        # 10,000 test AUSD for the demo buyer, from Agora's faucet
pnpm build
pnpm broker                                   # coordinator + facilitator on :8402
node packages/cli/dist/index.js init          # then: start — your provider node
pnpm app                                      # job board on :3002
```

Or the whole thing offline on Anvil: `scripts/local-stack.sh`, then `scripts/local-stack-run.sh broker|provider|app|landing`.

Buy a job from the terminal, paying from an address with no MON:

```bash
XORV_PAYER_KEY=0x… node packages/cli/dist/index.js run "Explain a Merkle tree, briefly." --max 0.25
```

Give an agent a goal and a budget:

```bash
MOONSHOT_API_KEY=… XORV_PAYER_KEY=0x… node packages/agent/dist/index.js \
  "Write a Solidity function that checks an EIP-712 signature, and have a second model review it" --budget 0.30
```

### The CLI

| Command | What it does |
|---|---|
| `xorv init` / `start` | Set up and run a provider node: registers (sponsored on chain), holds the control channel, runs sandboxed jobs |
| `xorv run "…"` | Buy a job over x402 — escrowed when the broker offers it; `--token AUSD\|USDC` |
| `xorv test` / `doctor` | Run each adapter locally for free; every reason the node might not be earning |
| `xorv earnings` / `wallet` / `status` | What this machine has made; payout address and balances; who's live |

Adapters: `claude-code` · `codex` · `grok` · `opencode` · `kimi` · `qwen` · `openai-compatible` · `echo`.

### For agents: the MCP server

```bash
claude mcp add xorv -- node /absolute/path/to/xorv-monad/packages/mcp/dist/index.js
# XORV_PAYER_KEY=0x…   XORV_MAX_USD=0.05   (hard ceiling per call)
```

---

## Repo layout

| Path | What |
|---|---|
| [`contracts/`](contracts) | Foundry: `XorvEscrow`, `XorvRegistry`, `XorvLog`, `XorvRefundKeeper`, tests, deploy script |
| [`indexer/`](indexer) | Envio HyperIndex: `config.yaml`, `schema.graphql`, handlers, lifecycle tests |
| [`cre/`](cre) | Chainlink CRE workflow: the refund keeper |
| [`packages/protocol`](packages/protocol) | Networks, stablecoins, the x402 escrow scheme, registry helpers |
| [`services/broker`](services/broker) | Matcher, x402 resource server, facilitator/attester, escrow settlement, reputation cache |
| [`packages/cli`](packages/cli) · [`packages/mcp`](packages/mcp) · [`packages/agent`](packages/agent) | Provider node + buyer CLI; MCP server; the Kimi/Qwen agent |
| [`apps/app`](apps/app) · [`apps/landing`](apps/landing) | Job board (escrow state, refund button); marketing site |
| [`scripts/`](scripts) | `deploy-testnet.sh`, `local-stack.sh`, `e2e-local.sh`, `faucet-ausd.sh` |

## Security

Contracts: see the property table in [`contracts/README.md`](contracts/README.md) — each guarantee is
pinned by a named test. Provider nodes: every job runs under macOS seatbelt, Linux bubblewrap, or a
container; a job cannot read `~/.xorv` (your payout key), `~/.ssh`, cloud credentials or the keychain.
See [`SECURITY.md`](SECURITY.md).

**On terms of service:** most consumer AI subscriptions are licensed to an individual, and reselling
that capacity may breach them. Run Xorv against quota you're entitled to share, a plan or API that
permits it (Kimi and Qwen are sold through their APIs), or your own local models.

## Pre-existing work, attribution and AI tools

**Pre-existing (not built during Metropolis).** Xorv was first built on Hedera (July 2026) and ported
to Arc and then Arbitrum ([github.com/nickthelegend/xorv-arbitrum](https://github.com/nickthelegend/xorv-arbitrum), MIT).
This repository's first commit imports that code unchanged: the provider node and job sandbox, the AI
tool adapters (Claude Code, Codex, Grok, OpenCode, OpenAI-compatible), the broker, the web app and
landing page, the x402 escrow scheme, `XorvEscrow` and `XorvLog`.

**Built during Metropolis** (every commit after the first): the Monad port (networks, AUSD, MON gas,
Monadscan, Anvil local stack, Monad fork tests), `XorvRegistry` in Solidity (ported from Rust/Stylus,
which Monad doesn't have), `XorvRefundKeeper` and the Chainlink CRE workflow, the Envio indexer, the
Kimi and Qwen adapters, `xorv-agent`, and the deploy and test scripts.

**Third-party code.** OpenZeppelin Contracts 5.4 and forge-std (MIT), as git submodules. Circle's
`stablecoin-evm` (Apache-2.0) is fetched by `scripts/local-stack.sh` for local runs, not vendored.
The Envio and Chainlink CRE SDKs, x402, viem and the MCP SDK are npm dependencies under their own licences.

**AI coding tools.** This project was built with Claude Code (Anthropic's Claude) as a coding agent,
directed and reviewed by the author.

## License

MIT
