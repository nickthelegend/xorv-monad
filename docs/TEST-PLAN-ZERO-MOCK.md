# Zero-mock test plan

MASTER PIPELINE step C, Phase 3 of `../METROPOLIS-ORCHESTRATION.md`. Each item is run against the
real local stack (`scripts/e2e-walk.sh` brings it up):
- a fresh anvil chain with Circle's FiatToken as USDC and Xorv's real contracts;
- the broker with SQLite persistence;
- a provider node selling **real** Codex and Claude Code;
- the Envio indexer with Hasura;
- a production build of the app.

On-chain means real signed transactions on that chain, or on an anvil fork of Monad testnet for
third-party contracts (AUSD, Cleanverse).

**PASS** means the observed result matches "correct" exactly and the browser console and network
tab show no errors. **UNTESTED** means a real dependency is missing; the dependency is named. Monad
testnet itself is on hold ("awaiting testnet go").

Status key: ⬜ not run · ✅ PASS · ❌ FAIL (then fixed and re-run) · ⏸ UNTESTED

## Pages (Claude in Chrome)

| # | Item | Correct means | Status |
|---|---|---|---|
| P1 | Board `/` | Heading, composer (prompt, model picker, max $), recent jobs list, live providers with price and on-chain score. No console or network errors | ⬜ |
| P2 | Board, broker down | "Can't reach the broker" in place of the lists; composer quote shows the reachability error; no uncaught errors | ⬜ |
| P3 | Composer: empty prompt | Quote button disabled; nothing sent | ⬜ |
| P4 | Composer: max $0 | "Set a maximum price above zero." with no request sent | ⬜ |
| P5 | Composer: max below every provider | The broker's 422 reason ("cheapest is …") shown; no quote card | ⬜ |
| P6 | Quote card | Provider, model, price, escrow address, deadline, "you need no MON", Run and Cancel | ⬜ |
| P7 | Pay from the demo account | Navigates to `/jobs/<id>`; status goes paid → running → Completed; result rendered as markdown; escrow "released" with its tx | ⬜ |
| P8 | Cancel a quote | Card closes; "nothing has been paid"; no request to pay | ⬜ |
| P9 | Job page, failed job | Error shown; escrow "refunded" with its tx; buyer balance restored on chain | ⬜ |
| P10 | Job page, unknown id | "Job not found" with the explanation | ⬜ |
| P11 | Chain viewer: tx | From the job page link: status success, block, from, to, decoded logs | ⬜ |
| P12 | Chain viewer: address and token | Balances read from the node; invalid input → "Not an address" | ⬜ |
| P13 | Chain viewer: bad and unknown hash | "Not a transaction hash" / "Transaction not found" | ⬜ |
| P14 | Providers `/providers` | The node, its capabilities, availability, the on-chain record | ⬜ |
| P15 | Network `/network` | Settlement, Contracts, Identity and signing, History (indexed), Audit log, Receipts: every value read live | ⬜ |
| P16 | Network: signer without Privy | "a local key · Privy not configured on this broker", no policy listed | ⬜ |
| P17 | Network: gate off locally | "off — anyone can fund and be paid" | ⬜ |
| P18 | 404 route | The not-found page with a way back | ⬜ |
| P19 | 375px | P1, P7, P14 and P15 fit with no horizontal scroll | ⬜ |
| P20 | Landing page | Hero, sections and links resolve; Monad copy only; 375px | ⬜ |
| P21 | Pay with the visitor's own wallet | The wallet signs the EIP-3009 authorization in the tab; job runs; escrow released | ⏸ needs a browser wallet funded on the local chain (Chrome profile wallet is the user's) |

## Broker API (curl, with real responses)

| # | Endpoint | Correct means | Status |
|---|---|---|---|
| A1 | `GET /health` | 200 `{ok:true}` | ⬜ |
| A2 | `GET /api/network` | network, facilitator, operator.signer (mode "key", policy null), stablecoins, escrow (identityGate null locally), registry, log, stats | ⬜ |
| A3 | `GET /api/providers` | The live node, capabilities, onchain record | ⬜ |
| A4 | `POST /api/quotes` invalid | 400 for no prompt, 400 for a bad max, 422 for below every price | ⬜ |
| A5 | `POST /api/jobs/:quoteId` unpaid | 402 with a PAYMENT-REQUIRED header offering escrow then exact | ⬜ |
| A6 | `POST /api/jobs/:quoteId` paid twice | 409 with the job id | ⬜ |
| A7 | `GET /api/jobs/:id`, `/stream` | Job record; SSE events through to completion | ⬜ |
| A8 | `POST /api/jobs/:id/cancel` | Before start: refunded with no reputation mark | ⬜ |
| A9 | `GET /api/receipts` | Receipts read back from XorvLog | ⬜ |
| A10 | `GET /metrics` | Prometheus text | ⬜ |

## On-chain (real signed transactions on the local chain)

| # | Interaction | Correct means | Status |
|---|---|---|---|
| C1 | Escrow fund | Buyer's EIP-3009 authorization pulled in; `JobFunded`; buyer spent 0 MON | ⬜ |
| C2 | Escrow release | Provider paid exactly the price; `JobReleased` with the result hash; registry completed +1 | ⬜ |
| C3 | Escrow refund | Buyer made whole; registry failed +1 when at fault | ⬜ |
| C4 | Registry sponsored registration | Provider registered by the operator; no MON needed by the provider | ⬜ |
| C5 | Audit log append | Receipt entry readable back | ⬜ |
| C6 | Cleanverse gate on the real A-Pass (Monad fork) | Unverified buyer refused before signing, nothing moved; verified buyer pays; freeze blocks payout | ⬜ |
| C7 | Real AUSD (Monad fork) | Fund and release in Agora's AUSD from Agora's faucet | ⬜ |
| C8 | Anything on Monad testnet | | ⏸ awaiting testnet go |

## External integrations

| # | Integration | Correct means | Status |
|---|---|---|---|
| X1 | Codex (provider) | A real job answered by Codex through the node's sandbox | ⬜ |
| X2 | Envio indexer | GraphQL totals equal the chain's; the app's History panel shows them | ⬜ |
| X3 | Kimi agent | A live run buys jobs through MCP within budget | ⏸ needs `MOONSHOT_API_KEY` |
| X4 | Qwen agent | Same | ⏸ needs `DASHSCOPE_API_KEY` + workspace URL |
| X5 | Privy server wallet | Broker signs through Privy under the policy, gas sponsored | ⏸ needs `PRIVY_APP_ID`, `PRIVY_APP_SECRET` |
| X6 | CRE simulate | `cre workflow simulate --broadcast` refunds an expired job | ⏸ needs `cre login` (and testnet go for `--broadcast`) |
| X7 | Cleanverse CVA (aUSDC) | aUSDC moves through a gated pool | ⏸ needs Cleanverse onboarding (pool registration, policy) |

## Fixes made during the run

_Filled in as items fail and are fixed._

## Zero-mock confirmation

_Filled in at the end._
