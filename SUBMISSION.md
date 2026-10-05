# Xorv — Monad Metropolis submission

**Track:** 04 — Trust, Identity & AI Infrastructure
**One line:** a marketplace where people sell idle AI capacity and humans *and agents* buy it per job, paid in AUSD into an on-chain escrow on Monad, with reputation written by the settlement itself.
**Repo:** https://github.com/nickthelegend/xorv-monad (MIT)

## Why Track 4

Paying a stranger, or a stranger's machine, for AI work is a trust problem on both sides. Xorv removes the trust:

- **The buyer's money is never at the provider's mercy, or the broker's.** It waits in XorvEscrow. It is released only when a result is delivered, with the result's hash recorded beside the payment. Anyone can refund the buyer after the deadline, and a Chainlink CRE workflow makes sure someone does.
- **A provider's identity is its track record.** XorvRegistry is written by the escrow in the settling transaction (completed, failed, earned, a Laplace-smoothed score). It can't be claimed or padded, only earned. The matcher ranks on it.
- **Agents can spend without being able to overspend.** `xorv-agent` (Kimi or Qwen) hires other models within a budget its runtime enforces, not one it promises to respect.

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
| **Alibaba Qwen** (T4) | "Push Qwen into genuinely agentic territory on Monad" | `xorv-agent --brain qwen`. Qwen 3.8 Max with thinking and tool calling is an autonomous buyer: it reads the live market, prices subtasks, picks which model to hire and whether a second opinion is worth paying for. It pays each job in AUSD on Monad via x402 into XorvEscrow, and stays inside a budget enforced in code. Providers can also **sell** Qwen capacity through the `qwen` adapter. |
| **Kimi** (All) | "Genuinely powered by Kimi, not bolted on" | Kimi k2.6 is the agent's default brain: the same autonomous buyer as above, threading `reasoning_content` between turns. Providers can sell Kimi capacity through the `kimi` adapter. |
| **Chainlink CRE** (All) | "A CRE workflow as an orchestration layer"; simulation accepted | `cre/refund-keeper`: cron → HTTP with DON consensus (the Envio index) → EVM read on Monad (`isRefundable`) → DON-signed report → KeystoneForwarder → `XorvRefundKeeper.onReport` → `XorvEscrow.refund`. It orchestrates the refund guarantee off the broker. The receiver is a real contract with 6 tests. |
| **Envio** (All) | HyperIndex/HyperSync powering a core feature; derived/aggregated entities | `indexer/`: Job (full lifecycle, seconds to settle), Provider (registry score, heartbeats, earnings), Buyer, Receipt (linked to its job), DailyStat and Network aggregates across three contracts. It is load-bearing because Monad's public RPC serves only 100 blocks per `eth_getLogs`, and the CRE workflow reads its expired-jobs query. |

**Considered and not claimed** (they don't truly fit, or need access we don't have yet):
- Cleanverse CVI/CVA: docs access pending.
- Privy beyond login, Alchemy Gas Manager: possible later.
- Mera, Nansen, MetaMask (T1), Kuru and Perpl (T1): not this product.

## Demo script (≤ 3 minutes)

| Time | Shot | Say |
|---|---|---|
| 0:00 | Landing page | "Your AI subscription is idle most of the day. Xorv lets you sell that capacity per job, and lets humans and agents buy it, settled in AUSD on Monad." |
| 0:15 | `xorv start` in a terminal | "One command: the node checks what's installed, sandboxes every job, and registers in XorvRegistry on Monad." |
| 0:35 | App: prompt → quote | "A buyer asks for a quote. The broker answers with HTTP 402 and the terms: the price, the provider, and that the AUSD goes into XorvEscrow, refundable if the job fails." |
| 0:55 | Pay → job streams → released | "One signature, no MON. The escrow is funded, the provider's machine runs the job, and the release pays them and writes their reputation in the same transaction." |
| 1:25 | Monadscan: fund and release txs | "Every step is on chain." |
| 1:40 | `xorv-agent --brain qwen` | "Now an agent. Qwen gets a goal and a 30-cent budget. It reads the market, hires Codex to write the code and Kimi to review it, and pays each one through the escrow. The budget is enforced by its runtime, not by trusting the model." |
| 2:20 | Envio GraphQL / app history | "Monad's RPC gives 100 blocks per log query, so history comes from Envio HyperIndex: every job, every provider's score, daily totals." |
| 2:35 | CRE simulate → refund tx | "And if the broker vanishes, a Chainlink CRE workflow finds expired jobs and refunds the buyers on chain." |
| 2:50 | End card | "Xorv. Trustless AI capacity, on Monad." |

## Judge logins

None needed. The app's demo account pays from a funded test wallet. For your own wallet: add Monad testnet and take AUSD from Agora's faucet (`scripts/faucet-ausd.sh <address>`).
