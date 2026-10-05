<div align="center">

<img src="brand/xorv-logo.svg" alt="Xorv" width="260" />

**A decentralized AI capacity network on Arbitrum.**
Rent out the Claude / Codex subscription you already pay for. Get paid per job in **Paxos USDG**, through an **on-chain escrow** that pays you when the work is delivered — and refunds the buyer when it isn't.

[![Arbitrum](https://img.shields.io/badge/Arbitrum-Sepolia%20%C2%B7%20Robinhood%20Chain-12AAFF?style=flat-square)](https://arbitrum.io)
[![Stylus](https://img.shields.io/badge/Stylus-Rust%20registry-E43E2B?style=flat-square)](https://docs.arbitrum.io/stylus)
[![USDG](https://img.shields.io/badge/settles%20in-USDG-00B67A?style=flat-square)](https://paxos.com/usdg/)
[![x402](https://img.shields.io/badge/x402-escrow%20scheme-7C5CFF?style=flat-square)](https://x402.org)
[![License](https://img.shields.io/badge/license-MIT-50F0C8?style=flat-square)](LICENSE)

**[Landing](https://xorv-arbitrum.vercel.app)** · **[App](https://xorv-arbitrum-app.vercel.app)** · **[Broker](https://broker-production-38c5.up.railway.app/api/network)** · **[Contracts](contracts/README.md)** · **[Architecture](ARCHITECTURE.md)**

</div>

---

## The problem

Millions of people pay $20–200 a month for an AI subscription and use a fraction of it. Anyone who
wants one coding task done has to buy their own plan or an API key. And every "pay a stranger for
compute" design so far has asked one side to trust the other: either the buyer pays up front and
hopes, or the provider works first and hopes.

## What Xorv does

You run one command and your machine joins the network. Jobs from strangers run on quota you were
already paying for, inside an OS sandbox that keeps your keys out of reach. Buyers — a person in the
browser, `xorv run` in a terminal, or an AI agent over MCP — pay per job with a single signature and
**no gas and no account**.

On Arbitrum the money never goes straight from buyer to provider. It goes into **XorvEscrow**:

- **Delivered →** the escrow pays the provider and records the SHA-256 of the result beside the payment.
- **Provider fails →** the job moves to another provider (the payee changes, the money doesn't) or the buyer is refunded.
- **Nobody settles by the deadline →** *anyone* can refund the buyer. The broker can stall; it can't keep the money.

Every settlement also writes the provider's outcome into **XorvRegistry**, a **Rust contract on
Arbitrum Stylus**, in the same transaction. Reputation can't be claimed, only earned — and the
matcher ranks providers on it.

---

## For judges — verify it yourself

Everything below runs offline except where noted.

```bash
git clone --recursive https://github.com/nickthelegend/xorv-arbitrum && cd xorv-arbitrum
pnpm install && pnpm build && pnpm test          # 411 TypeScript tests

cd contracts && forge test                       # 54 Solidity tests: unit, fuzz, 4 invariants, fork (FORK_TESTS=1)
FORK_TESTS=1 forge test --match-contract Fork    # vs the REAL USDG + USDC on Arbitrum Sepolia & Robinhood Chain (network)
cd stylus/registry && cargo test                 # 47 Rust tests for the Stylus registry
```

And the whole product, end to end, with real processes against real contracts:

```bash
MODE=fork  scripts/e2e-local.sh    # anvil forking Arbitrum Sepolia, settling in the real Paxos USDG contract
MODE=nitro scripts/e2e-local.sh    # a Nitro dev node: Solidity escrow → Rust/Stylus registry, through the broker
```

| Proof | Result |
|---|---|
| `MODE=fork` — broker + provider node + `xorv run`, real USDG contract | **9/9**: paid through escrow, released with the result hash, provider got exactly the price, **buyer spent 0 gas** |
| `MODE=nitro` — the same, plus the Stylus registry | **13/13**: + sponsored on-chain registration, `completed = 1`, `earned = price`, broker ranks on the record |
| `scripts/interop-nitro.sh` — Solidity ↔ Stylus on a real Arbitrum node | **8/8**: release → `completed`, refund → `failed`, score = 5000 |
| Fork tests — escrow vs the real tokens | fund → release on **USDG (Arbitrum Sepolia)**, **USDG (Robinhood Chain Testnet)**, **USDC (Arbitrum Sepolia)** |

### A bug the chain found

The Nitro interop run caught something no unit test had: the provider was paid, but the Stylus
registry recorded nothing. The escrow wraps its registry call in `try/catch` so the registry can never
block a payment — which means a transaction with enough gas for the payment but not the registry
still *succeeds*. And `eth_estimateGas`, which searches for the smallest succeeding limit, produced
exactly that transaction every time. The fix requires the registry's full gas budget up front
(EIP-150's 63/64 included); `test_underfundedGasNeverSkipsReputation` fails on the old guard and
passes on the new one. Details in [`contracts/README.md`](contracts/README.md).

### Status, stated plainly

| | |
|---|---|
| ✅ Contracts written, tested (unit, fuzz, invariant, fork, Rust), deploy + verification scripted | `scripts/deploy-testnet.sh <network>` |
| ✅ Escrow in every payment path — broker, `xorv run`, MCP, browser wallet, demo route | 407 TS tests |
| ✅ End to end on local Arbitrum chains, real USDG contract code | the table above |
| ✅ Broker, landing and app deployed | links at the top |
| ✅ **Contracts on Arbitrum Sepolia** | XorvEscrow [`0x383F5153…`](https://sepolia.arbiscan.io/address/0x383F5153db8Bb18c7c25157Fb3493645A465EeF3) · XorvRegistry (Stylus) [`0x38b65014…`](https://sepolia.arbiscan.io/address/0x38b65014fee7c87d5e13afbc555388f612a7a2a1) · XorvLog [`0x13573838…`](https://sepolia.arbiscan.io/address/0x135738387e4bEC5573914F1A2A812728b9b268C8) |
| ✅ **Paid jobs on Arbitrum Sepolia, in Paxos USDG** | [escrow funded](https://sepolia.arbiscan.io/tx/0x1f5c34362bade6680f18b8fa7418d5d46e445da072b4da67ba0e55766bc3de5f) → [released + Stylus reputation](https://sepolia.arbiscan.io/tx/0xd13b5f13cfd26cee4ef8abfbdc0c02389cc49c30027526cd9ecd5af4d9543393) → [receipt](https://sepolia.arbiscan.io/tx/0x36b38f505c151c7285249f4ff5511aad144263f3a879d5403d26f34314dbfb58); buyer spent 0 ETH |
| ⏳ Robinhood Chain Testnet | not deployed: its faucet needs a Google sign-in. Same command: `scripts/deploy-testnet.sh robinhood-testnet` |

---

## Why Arbitrum, Stylus and USDG

| | Why it matters here |
|---|---|
| **Fees are a rounding error** | A $0.001 job isn't eaten by gas; fund + release together cost a fraction of a cent. |
| **Sub-second blocks** | The buyer isn't waiting on confirmations before their job starts. |
| **Stylus** | The registry is written on *every* settled job, so it's the contract whose per-call cost matters most. Rust on Stylus, called from Solidity with a fixed gas budget. Worst case measured at 72k gas. |
| **Robinhood Chain** | An Arbitrum chain; the same contracts and code settle there. USDG exists on both. |
| **Paxos USDG** | A regulated dollar stablecoin with EIP-3009 — the buyer's side is one EIP-712 signature any wallet already produces. It keeps EIP-3009 in a facet and has **no `version()`**, which x402 can't auto-detect; Xorv configures and verifies each token's domain. USDC is accepted too. |

---

## How a job is paid for

```
  buyer                     broker                        provider node
    │  POST /api/quotes        │                                │
    ├─────────────────────────►│  match: price → on-chain score │
    │  ◄── quote (job id, deadline, provider)                   │
    │  POST /api/jobs/:quote   │                                │
    │  ◄── 402 accepts[]: escrow (USDG, USDC), exact (fallback) │
    │  PAYMENT-SIGNATURE ─────►│  verify → XorvEscrow.fund()    │
    │  (ReceiveWithAuthorization, nonce = job + deadline)       │
    │  ◄── 200 + jobId         ├──── job.dispatch (WebSocket) ─►│  sandboxed run
    │  ◄═══ SSE events ════════╪◄═══ tool calls, edits ═════════┤
    │  ◄── result              │◄─── answer ────────────────────┤
    │                          ├── XorvEscrow.release(sha256(result))
    │                          │       └─ XorvRegistry.recordOutcome   (Stylus)
```

The **x402 `escrow` scheme** ([`packages/protocol/src/escrow.ts`](packages/protocol/src/escrow.ts))
keeps the x402 shape — 402, sign, retry — and changes where the money waits. The buyer signs
`ReceiveWithAuthorization` (only the escrow can redeem it, so it can't be front-run) with a nonce
**derived from the job id and refund deadline**, recomputed by the client and by the contract — so a
signature can only ever fund this job. The broker still offers the stock `exact` scheme after it, so
any x402 client can pay.

---

## Quickstart

Needs Node ≥ 20.11, pnpm, and for the contracts Foundry and `cargo-stylus`.

```bash
cp .env.example .env                         # operator key (facilitator + escrow attester), demo payer
scripts/deploy-testnet.sh arbitrum-sepolia   # registry (Stylus) + escrow + log, wired, verified, written to .env
pnpm build
pnpm broker                                  # coordinator + facilitator on :8402
node packages/cli/dist/index.js init         # then: start — your provider node
pnpm app                                     # job board on :3002
```

Buy a job from the terminal, paying from an address with no ETH:

```bash
XORV_PAYER_KEY=0x… node packages/cli/dist/index.js run "Explain a Merkle tree, briefly." --max 0.05
```

### The CLI

| Command | What it does |
|---|---|
| `xorv init` / `start` | Set up and run a provider node: registers (sponsored on chain), holds the control channel, runs sandboxed jobs |
| `xorv run "…"` | Buy a job over x402 — escrowed when the broker offers it; `--token USDG\|USDC` |
| `xorv test` / `doctor` | Run each adapter locally for free; every reason the node might not be earning |
| `xorv earnings` / `wallet` / `status` | What this machine has made; payout address and balances; who's live |

Adapters: `claude-code` · `codex` · `grok` · `opencode` · `openai-compatible` · `echo`.

### For agents: the MCP server

```bash
claude mcp add xorv -- node /absolute/path/to/xorv-arbitrum/packages/mcp/dist/index.js
# XORV_PAYER_KEY=0x…   XORV_MAX_USD=0.05   (hard ceiling per call)
```

An agent discovers capacity, pays through the escrow, and gets the answer back with the escrow
deposit and release transactions — or the refund, if the job failed.

---

## Repo layout

| Path | What |
|---|---|
| [`contracts/`](contracts) | Foundry: `XorvEscrow`, `XorvLog`, tests, deploy script. [`contracts/stylus/registry`](contracts/stylus/registry): the Rust registry |
| [`packages/protocol`](packages/protocol) | Networks, stablecoins, the x402 escrow scheme, registry helpers |
| [`services/broker`](services/broker) | Matcher, x402 resource server, facilitator/attester, escrow settlement, reputation cache |
| [`packages/cli`](packages/cli) · [`packages/mcp`](packages/mcp) | Provider node + buyer CLI; MCP server for agents |
| [`apps/app`](apps/app) · [`apps/landing`](apps/landing) | Job board (escrow state, refund button); marketing site |
| [`scripts/`](scripts) | `deploy-testnet.sh`, `e2e-local.sh`, `interop-nitro.sh` |

## Security

Contracts: see the property table in [`contracts/README.md`](contracts/README.md) — each guarantee is
pinned by a named test. Provider nodes: every job runs under macOS seatbelt, Linux bubblewrap, or a
container; a job cannot read `~/.xorv` (your payout key), `~/.ssh`, cloud credentials or the keychain.
See [`SECURITY.md`](SECURITY.md).

**On terms of service:** most consumer AI subscriptions are licensed to an individual, and reselling
that capacity may breach them. Run Xorv against quota you're entitled to share, a plan that permits
it, or your own local models via the OpenAI-compatible adapter.

## Lineage

Xorv was first built on Hedera (x402 bounty, July 2026), then ported to Arc. This repository is the
Arbitrum version, and the first with escrow and on-chain reputation.

## License

MIT
