# Judge review: Xorv (Track 04: Trust, Identity & AI Infrastructure)

Written 13 Oct 2026 as an unbiased Metropolis judge would read it. I used the live app, the repo and the chain, not the pitch. Scores are out of 10 unless marked otherwise.

## Scores

| Criterion | Score | Why |
|---|---:|---|
| Product quality | 7.5 | The hosted app works end to end: quote, escrow payment, job, release, receipt, verification and rating, each linked to its Monad tx. The UI is calm, readable and fits 1440 and 390 px. Two things hold it back: a person can only buy after logging in and getting faucet USDC, and there is one live seller. |
| Technical excellence | 8.5 | x402 `exact` plus a custom `escrow` scheme with its own facilitator; XorvEscrow with refunds that no one can block; a CRE keeper; ERC-8004 identity and reputation; Envio; and passkey-sealed private jobs. About 1,400 tests across the packages, plus fork e2e runs (31/31), with CI green on every push. Bugs found in live runs were fixed at the root, each with a regression test. |
| Monad integration | 9 | `eth_sendRawTransactionSync`, with "executed X ms · final Y ms" measured on real txs (about 0.3 s / 1.1 s); a live `monadNewHeads` / `monadLogs` commit-state pipeline; `txpool_statusByHash`; fees as limit × price; a 10 MON reserve check on gas payers; a staking-precompile read of the validator set; P256 precompile checks for passkeys; and the 100-block `eth_getLogs` cap respected. |
| Track fit (Trust, Identity, AI infra) | 8.5 | The track's core: AI agents paying for AI work, with escrowed trust, on-chain identity (ERC-8004 agent #2252), verifier and buyer reputation, Nansen wallet trust and a Cleanverse identity gate. |
| Innovation | 7 | x402-paid jobs with on-chain escrow, plus a verifiable speed receipt, are new. "Marketplace for AI capacity" is a crowded idea, and the differentiation lives in the trust layer rather than the market itself. |
| **Overall** | **8.1** | |

**Bounty rubric (requirements 40 / technical 30 / Monad 20 / innovation 10):**

| Bounty | Requirements /40 | Technical /30 | Monad /20 | Innovation /10 | Total |
|---|---:|---:|---:|---:|---:|
| Privy | 33: server wallet with a policy paying live, embedded wallet and gasless ratings in code; the human login path is not in the recorded cut | 26 | 18 | 7 | 84 |
| Chainlink CRE | 34: a real broadcast refund through the forwarder and keeper; no DON deploy (needs CRE deploy access) | 26 | 17 | 8 | 85 |
| Kimi | 36: verifier on every job, written to ERC-8004, plus a hosted Kimi provider under a spend cap | 25 | 16 | 7 | 84 |
| Envio | 26: indexer tested and run live against testnet, but **not hosted** (Envio Cloud needs the user's login) | 25 | 17 | 6 | 74 |
| Nansen | 28: live API calls with caching and a wash-rating guard; no x402-paid call on mainnet | 24 | 15 | 7 | 74 |

## Product-market fit

- **The need is real.** Agents increasingly call other models and tools, and paying per call with refund protection beats subscriptions and prepaid API credit for one-off work. The escrow plus verifier plus reputation loop is the part buyers can't get from a raw API.
- **The weak side is supply.** The "rent out your subscription" story runs into consumer terms of service; the README says so. Sustainable supply is API-key and self-hosted-model providers, which the product already supports (hosted Kimi node, OpenAI-compatible adapter). The headline now names what is actually on sale.

## Hackathon fit

- It is built for Metropolis rather than ported: the escrow, CRE keeper, Data Feeds guard, AUSD settlement, Monad speed receipts and commit-state pipeline are all Monad-specific and new in this window.
- Every claim in README and SUBMISSION links a transaction, or says what it waits on. There is a recorded 2-minute walkthrough of the live stack.

## Top 5 weaknesses

1. **One live seller.** A marketplace with a single hosted Kimi node, run by the team, is a demo of the rails rather than proof of a market.
2. **A person paying from their own wallet is unproven live.** *Narrowed during judge mode:* the hosted app's "Pay from demo account" is now configured (at most $0.03 a job, $0.60 a day, rate-limited). A browser purchase with no login ran end to end on 13 Oct: `job_qYHL9A_f9aGZ`, payment [`0x8922a3…28dd`](https://testnet.monadvision.com/tx/0x8922a3a27429753fc04634bbbbed437ec7711f4a3fef6af9dde16c798a9628dd), Kimi 95/100, released. The Privy-login path still needs a person.
3. **The escrow trusts the broker's attester.** Release is still signed by Xorv's facilitator. *Narrowed during judge mode:* with `XORV_RELEASE_ON_VERDICT=on` (live on the hosted broker), a delivered job is released only after Kimi passes it, and refunded at the provider's fault if Kimi fails it. Refunds stay trustless after the deadline (CRE, or anyone). What remains is trust in the attester and the verifier, not a contract-enforced proof.
4. **Envio is not hosted.** The leaderboard and the CRE keeper's index run locally, and the hosted broker reads its feeds from RPC.
5. **Breadth over depth in the sponsor list.** Qwen and Hunyuan show "not configured" in the UI, and the MetaMask plugin and Mera's cross-device flow are tested but not shown live.

## What would make a judge say no

- "I couldn't buy a job": *fixed.* "Pay from demo account" buys without a login or faucet USDC. *Mitigated:* the provider runs on Railway with a persisted daily cap and now survives broker restarts, and the README walks a judge through the faucet step.
- "It says Claude, but it's an API key resold under someone else's terms": *fixed*, since the hero names the live model.
- "Release is centralized": narrowed, since release now needs the verifier's pass, but still signed by the broker's attester.

## Fixed during judge mode

- The hero said "someone else's Claude" while only Kimi was on sale, and the model picker offered adapters no one sells. Both now follow the live provider list. (`91b3cc1`)
- README's judge section led with a local `pnpm demo`; it now starts with the live app, step by step.
- The hosted provider had no ERC-8004 identity, so reputation never reached the chain. It is now agent #2252, with live Kimi feedback and an agent rating on chain.
- The provider showed "online" but matched no jobs after broker redeploys (zombie reconnect loops); it is fixed with a regression test.
- The job page overflowed at 390 px; fixed.
- The escrow release now follows Kimi's verdict: release on a pass, refund on a fail, and release after a 2-minute grace period if no verdict comes. Three integration tests cover it, and the job page says when it is waiting.
