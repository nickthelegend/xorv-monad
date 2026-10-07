# Xorv — Monad Metropolis submission

**Track:** 04 — Trust, Identity & AI Infrastructure
**One line:** a marketplace where people sell idle AI capacity and humans *and agents* buy it per job, paid in AUSD into an on-chain escrow on Monad, with reputation written by the settlement itself.
**Repo:** https://github.com/nickthelegend/xorv-monad (MIT)

## Why Track 4

Paying a stranger, or a stranger's machine, for AI work is a trust problem on both sides. Xorv removes the trust:

- **The buyer's money is never at the provider's mercy, or the broker's.** It waits in XorvEscrow. It is released only when a result is delivered, with the result's hash recorded beside the payment. Anyone can refund the buyer after the deadline, and a Chainlink CRE workflow makes sure someone does.
- **A provider's identity is its track record.** XorvRegistry is written by the escrow in the settling transaction (completed, failed, earned, a Laplace-smoothed score). It can't be claimed or padded, only earned. The matcher ranks on it.
- **Only verified identities can move money through it.** With Cleanverse CVI on, the escrow funds a job only between A-Pass holders and pays out only to a provider whose A-Pass is still active. A freeze by Cleanverse stops the payout in the same block.
- **The broker's own key can't go rogue.** Its operator wallet is a Privy server wallet whose policy allows exactly the eight calls the broker makes, on this chain, at zero value, with gas sponsored by Privy.
- **Agents can spend without being able to overspend.** `xorv-agent` (Kimi or Qwen) hires other models within a budget its runtime enforces, not one it promises to respect.

## Portal fields

| Field | Value |
|---|---|
| Project name | Xorv |
| Track (one per project) | 04 — Trust, Identity & AI Infrastructure |
| One-liner | Sell idle AI capacity per job; humans and agents buy it in AUSD through an on-chain escrow on Monad, gated by Cleanverse identity, with reputation written by the settlement itself. |
| Repo (OSI licence) | https://github.com/nickthelegend/xorv-monad (MIT), branch [`metropolis-escrow`](https://github.com/nickthelegend/xorv-monad/tree/metropolis-escrow). The repo's `main` is the 26–28 Sep ERC-8004 build with its live testnet deployment. |
| Live app | _after go: the Vercel URL_ |
| Demo video (≤ 3 min) | _after go_ (script below) |
| Pitch video (≤ 2 min) | _after go_ (script below) |
| Judge logins | None needed: the app's demo account pays from a funded test wallet |
| Pre-existing code and AI tools | README → "Pre-existing work, attribution and AI tools" |
| Contracts | Below, after deploy |

## Deployed on Monad testnet (chain 10143)

| Contract | Address |
|---|---|
| XorvEscrow | _after deploy — `deployments/monad-testnet.json`_ |
| XorvRegistry | _after deploy_ |
| XorvLog | _after deploy_ |
| XorvRefundKeeper (CRE receiver) | _after deploy_ |
| Settlement token | Agora AUSD `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` |

## Bounties claimed

| Bounty | Requirement | How Xorv meets it |
|---|---|---|
| **Cleanverse CVI/CVA** (T4) | "Gate CVA asset movement behind on-chain CVI identity verification" | `CleanverseGate` + `XorvEscrow.setIdentityGate`: `fund` requires both parties' A-Pass; `release`/`reassign` require the payee's. It reads Cleanverse's own A-Pass validity (frozen, revoked or expired → no), plus the compliance validator once a pool is registered. Tested against the **real** A-Pass and validator on a Monad testnet fork. **Blocked for CVA itself:** aUSDC transfers revert until Cleanverse onboards the app (pool registration, policy). See [SPONSOR-GAP](docs/SPONSOR-GAP.md). |
| **Privy** (All) | "Beyond authentication"; multiple features | The broker's operator is a Privy **server wallet** under a **policy** that allows only its eight calls, with **native gas sponsorship** on Monad testnet. `privy:setup` creates both. |
| **Alibaba Qwen** (T4) | "Push Qwen into genuinely agentic territory on Monad" | `xorv-agent --brain qwen`. Qwen 3.8 Max with thinking and tool calling is an autonomous buyer: it reads the live market, prices subtasks, picks which model to hire and whether a second opinion is worth paying for. It pays each job in AUSD on Monad via x402 into XorvEscrow, and stays inside a budget enforced in code. Providers can also **sell** Qwen capacity through the `qwen` adapter. |
| **Kimi** (All) | "Genuinely powered by Kimi, not bolted on" | Kimi k2.6 is the agent's default brain: the same autonomous buyer as above, threading `reasoning_content` between turns. Providers can sell Kimi capacity through the `kimi` adapter. |
| **Chainlink CRE** (All) | "A CRE workflow as an orchestration layer"; simulation accepted | `cre/refund-keeper`: cron → HTTP with DON consensus (the Envio index) → EVM read on Monad (`isRefundable`) → DON-signed report → KeystoneForwarder → `XorvRefundKeeper.onReport` → `XorvEscrow.refund`. It orchestrates the refund guarantee off the broker. The receiver is a real contract with 6 tests. |
| **Envio** (All) | HyperIndex/HyperSync powering a core feature; derived/aggregated entities | `indexer/`: Job (full lifecycle, seconds to settle), Provider (registry score, heartbeats, earnings), Buyer, Receipt (linked to its job), DailyStat and Network aggregates across three contracts. It is load-bearing because Monad's public RPC serves only 100 blocks per `eth_getLogs`, and the CRE workflow reads its expired-jobs query. |

**Not claimed:** Agora (T1/T2 only, needs Mera), Mera, Dynamic, Nansen, MetaMask, Kuru, Perpl, Aurora (not this product), Alchemy (overlaps Privy sponsorship).

**Status:** every bounty above is built and tested **locally** with real contracts and real signed transactions. The running product contains no mocks: without a key, a feature says "not configured". Nothing is deployed yet. [docs/SPONSOR-GAP.md](docs/SPONSOR-GAP.md) lists each one's evidence and the one key or account its live run needs; [docs/TEST-PLAN-ZERO-MOCK.md](docs/TEST-PLAN-ZERO-MOCK.md) lists every flow checked in the browser.

### Evidence, per bounty

| Bounty | Code | Tests | End to end |
|---|---|---|---|
| Cleanverse | `contracts/src/CleanverseGate.sol`, `XorvEscrow.setIdentityGate`, `services/broker/src/identity.ts` | `forge test --match-contract CleanverseGate` (13); `FORK_TESTS=1 … CleanverseGateFork` (3, real A-Pass) | `MODE=fork CLEANVERSE=1 scripts/e2e-local.sh` (19/19) |
| Privy | `packages/protocol/src/privy.ts`, `services/broker/src/scripts/privy-setup.ts` | `packages/protocol/test/privy*.test.ts` (14, including anvil) | live: after keys |
| Qwen / Kimi | `packages/agent`, `packages/cli/src/adapters/openai-compatible.ts` | `packages/agent/test` (9) | `AGENT=1 scripts/e2e-local.sh` (6/6 each; live with keys) |
| CRE | `cre/refund-keeper`, `contracts/src/XorvRefundKeeper.sol` | `bun test` (4), `forge test --match-contract RefundKeeper` (6) | `cre workflow simulate` after `cre login` |
| Envio | `indexer/` | `indexer/test` (4) | `INDEXER=1 scripts/e2e-local.sh` (8/8); the app's History panel |
| Tx hashes | — | — | _after go_ |

## Demo script (≤ 3 minutes)

| Time | Shot | Say |
|---|---|---|
| 0:00 | Landing page | "Your AI subscription is idle most of the day. Xorv lets you sell that capacity per job, and lets humans and agents buy it, settled in AUSD on Monad." |
| 0:15 | `xorv start` in a terminal | "One command: the node checks what's installed, sandboxes every job, and registers in XorvRegistry on Monad." |
| 0:35 | App: prompt → quote | "A buyer asks for a quote. The broker answers with HTTP 402 and the terms: the price, the provider, and that the AUSD goes into XorvEscrow, refundable if the job fails." |
| 0:55 | Pay → job streams → released | "One signature, no MON. The escrow is funded, the provider's machine runs the job, and the release pays them and writes their reputation in the same transaction." |
| 1:25 | Monadscan: fund and release txs | "Every step is on chain." |
| 1:25 | App → Network: Identity and signing | "Two more locks. Only Cleanverse A-Pass holders can fund or be paid by this escrow. And the broker's own wallet is a Privy server wallet whose policy allows eight calls and nothing else, with Privy paying the gas." |
| 1:35 | Cleanverse freezes the provider → release reverts | "If Cleanverse freezes a provider mid-job, the payout stops at the escrow. Unfreeze it, and it goes through." |
| 1:40 | `xorv-agent --brain qwen` | "Now an agent. Qwen gets a goal and a 30-cent budget. It reads the market, hires Codex to write the code and Kimi to review it, and pays each one through the escrow. The budget is enforced by its runtime, not by trusting the model." |
| 2:20 | Envio GraphQL / app history | "Monad's RPC gives 100 blocks per log query, so history comes from Envio HyperIndex: every job, every provider's score, daily totals." |
| 2:35 | CRE simulate → refund tx | "And if the broker vanishes, a Chainlink CRE workflow finds expired jobs and refunds the buyers on chain." |
| 2:50 | End card | "Xorv. Trustless AI capacity, on Monad." |

## Pitch video (≤ 2 minutes)

| Time | Say |
|---|---|
| 0:00 | "Paying a stranger's machine for AI work is a trust problem. Xorv removes the trust." |
| 0:15 | "Money waits in an escrow on Monad. It's released only when the result is delivered, with the result's hash on chain, and refunded if not. A Chainlink CRE workflow makes sure the refund happens even if we disappear." |
| 0:40 | "Identity is enforced where value moves: only Cleanverse A-Pass holders can fund or be paid, and a freeze stops a payout in the same block." |
| 1:00 | "Reputation can't be claimed, only earned: the escrow writes it into the registry in the settling transaction." |
| 1:15 | "Even our own key is fenced: the broker's wallet is a Privy server wallet that can make eight calls and nothing else." |
| 1:30 | "And agents can buy too. Qwen or Kimi gets a goal and a budget it cannot exceed." |
| 1:45 | "Xorv: trustless AI capacity, on Monad." |

## Judge logins

None needed. The app's demo account pays from a funded test wallet. For your own wallet: add Monad testnet and take AUSD from Agora's faucet (`scripts/faucet-ausd.sh <address>`).
