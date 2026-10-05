# Arbitrum Open House Singapore — Online Buildathon · Xorv

Ready-to-paste answers for the HackQuest submission form, and the evidence behind each claim.

---

## Project name

**Xorv**

## One-liner

Rent out your idle Claude / Codex subscription and get paid per job in USDG — through an on-chain escrow that pays you when the work is delivered and refunds the buyer when it isn't.

## Tracks / prize categories

Overall Prize (Arbitrum) · Promising Products · deployed on **Arbitrum Sepolia and Robinhood Chain Testnet** · integrates **Paxos USDG** · uses **Stylus**.

## Description

Millions of people pay $20–200 a month for an AI subscription and use a fraction of it; anyone who wants one coding task done has to buy their own. Xorv connects the two. A provider runs one command and their machine takes jobs from strangers on quota they already pay for, inside an OS sandbox that keeps their keys out of reach. A buyer — a person in the browser, a terminal, or an AI agent over MCP — pays per job with one EIP-712 signature: no gas, no account, no API key.

Every "pay a stranger for compute" design asks one side to trust the other. On Arbitrum, Xorv removes that. The buyer's signature funds **XorvEscrow**, not the provider. When the result arrives the escrow pays the provider and records the result's SHA-256 beside the payment; if the provider fails the job is reassigned (the payee changes, the money doesn't) or refunded; and if nobody settles it by the deadline, **anyone** can refund the buyer. The broker can stall — it can't keep the money.

Every settlement also writes the provider's outcome into **XorvRegistry**, a Rust contract on **Arbitrum Stylus**, inside the same transaction. A provider's track record can't be claimed, only earned, and the matcher ranks on it.

Payments use x402 (HTTP 402 as a payment rail). Xorv adds an **`escrow` scheme** to it: the buyer signs `ReceiveWithAuthorization` — which only the escrow can redeem, so it can't be front-run — with a nonce **derived from the job id and refund deadline**, recomputed by the client and by the contract. One signature commits to the amount, the token, the payee, the job and its deadline.

Settlement is in **Paxos USDG** by default (USDC accepted). USDG keeps EIP-3009 in a facet behind its proxy and exposes no `version()`, which x402 can't auto-detect; Xorv configures each token's EIP-712 domain and verifies it against the contract's `DOMAIN_SEPARATOR` at boot and in every fork-test run.

## How it's built

- **Contracts** — `XorvEscrow` (Solidity 0.8.28, OpenZeppelin 5.4: SafeERC20, ReentrancyGuard, Pausable, Ownable2Step), `XorvRegistry` (Rust, stylus-sdk 0.10.9), `XorvLog` (Solidity audit trail). Foundry + cargo-stylus.
- **x402** — `@x402/core` 2.21 with a custom `escrow` scheme (client, resource server, facilitator) alongside the stock `exact` scheme.
- **Broker** — Hono, self-hosted facilitator that is also the escrow attester, WebSocket hub to provider nodes, SSE to buyers, SQLite. Deployed on Railway.
- **Clients** — `xorv` CLI (provider node + buyer), `@xorv/mcp` (agents), Next.js job board and landing (Vercel). viem throughout.

## Smart contract quality — what to look at

[`contracts/README.md`](contracts/README.md) lists every security property and the test that pins it. Highlights:

| Property | Enforced by |
|---|---|
| Buyer never needs gas | EIP-3009, relayed by the attester |
| A signature can't be redirected to another job or deadline | nonce derived on chain from `(chainId, escrow, jobId, deadline)` |
| Authorization can't be front-run | `receiveWithAuthorization` requires `msg.sender == escrow` |
| Owner can never touch escrowed funds | no withdrawal; `sweep` reaches only `balance − totalEscrowed`; invariant-tested |
| A stalled broker can't keep the money | permissionless refund after the deadline, works while paused |
| Fee can't be raised on paid work | snapshotted per job, capped at 5% in code |
| A broken registry can't block payment — and can't be starved to skip a bad mark | try/catch with a fixed budget; full budget required up front (EIP-150) |

Tests: **54** Solidity (unit, fuzz, 4 invariants over random fund/release/refund/reassign sequences), fork tests against the **real** USDG (Arbitrum Sepolia, Robinhood Chain Testnet) and USDC, **47** Rust tests for the Stylus registry, **400** TypeScript tests.

**Found on a real Arbitrum node:** the Nitro interop run showed a provider paid while the Stylus registry recorded nothing — `eth_estimateGas` picked a limit that covered the payment but starved the try/catch-wrapped registry call. Fixed by requiring the registry's full gas budget before the call; a regression test sweeps gas limits and fails on the old guard.

## Proof

| | |
|---|---|
| End to end on a fork of Arbitrum Sepolia, settling in the **real Paxos USDG contract** | `MODE=fork scripts/e2e-local.sh` — 9/9 checks; buyer spent 0 gas |
| End to end on a Nitro dev node with the **Stylus registry** | `MODE=nitro scripts/e2e-local.sh` — 13/13 checks |
| Solidity → Stylus interop | `scripts/interop-nitro.sh` — 8/8 |
| Deployed broker | https://broker-production-38c5.up.railway.app/api/network |
| Landing / app | https://xorv-arbitrum.vercel.app · https://xorv-arbitrum-app.vercel.app |
| XorvEscrow on Arbitrum Sepolia | [0x383F5153db8Bb18c7c25157Fb3493645A465EeF3](https://sepolia.arbiscan.io/address/0x383F5153db8Bb18c7c25157Fb3493645A465EeF3) |
| XorvRegistry (Rust / Stylus) on Arbitrum Sepolia | [0x38b65014fee7c87d5e13afbc555388f612a7a2a1](https://sepolia.arbiscan.io/address/0x38b65014fee7c87d5e13afbc555388f612a7a2a1) |
| XorvLog on Arbitrum Sepolia | [0x135738387e4bEC5573914F1A2A812728b9b268C8](https://sepolia.arbiscan.io/address/0x135738387e4bEC5573914F1A2A812728b9b268C8) |
| A paid job, on chain | Codex job paid in **Paxos USDG**: [escrow funded](https://sepolia.arbiscan.io/tx/0x1f5c34362bade6680f18b8fa7418d5d46e445da072b4da67ba0e55766bc3de5f) → [released to the provider, outcome written to the Stylus registry](https://sepolia.arbiscan.io/tx/0xd13b5f13cfd26cee4ef8abfbdc0c02389cc49c30027526cd9ecd5af4d9543393) → [receipt in XorvLog](https://sepolia.arbiscan.io/tx/0x36b38f505c151c7285249f4ff5511aad144263f3a879d5403d26f34314dbfb58). The buyer held 0 ETH throughout; the operator's gas per job is about 0.00002 ETH. |
| Contracts on Robinhood Chain Testnet | not deployed — its faucet requires a Google sign-in. Same code, one command: `scripts/deploy-testnet.sh robinhood-testnet` |

## Links

- Repo: https://github.com/nickthelegend/xorv-arbitrum
- Architecture (with diagram): [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Contracts: [`contracts/README.md`](contracts/README.md) · Stylus registry: [`contracts/stylus/registry`](contracts/stylus/registry)

## What's next (milestones)

1. Mainnet: Arbitrum One and Robinhood Chain, USDG — the token addresses and domains are already verified in `packages/protocol/src/constants.ts`.
2. Buyer-side disputes: a challenge window between delivery and release, with the result hash already on chain as evidence.
3. Provider staking in the registry, slashable by escrow outcomes.
4. A hosted facilitator so any x402 server can sell with Xorv's escrow scheme.
