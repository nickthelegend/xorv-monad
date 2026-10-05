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
| P1 | Board `/` | Heading, composer (prompt, model picker, max $), recent jobs list, live providers with price and on-chain score. No console or network errors | ✅ |
| P2 | Board, broker down | "Can't reach the broker" in place of the lists; composer quote shows the reachability error; no uncaught errors | ✅ |
| P3 | Composer: empty prompt | Quote button disabled; nothing sent | ✅ |
| P4 | Composer: max $0 | "Set a maximum price above zero." with no request sent | ✅ |
| P5 | Composer: max below every provider | The broker's 422 reason ("cheapest is …") shown; no quote card | ✅ |
| P6 | Quote card | Provider, model, price, escrow address, deadline, "you need no MON", Run and Cancel | ✅ |
| P7 | Pay from the demo account | Navigates to `/jobs/<id>`; status goes paid → running → Completed; result rendered as markdown; escrow "released" with its tx | ✅ |
| P8 | Cancel a quote | Card closes; "nothing has been paid"; no request to pay | ✅ |
| P9 | Job page, failed job | Error shown; escrow "refunded" with its tx; buyer balance restored on chain | ✅ |
| P10 | Job page, unknown id | "Job not found" with the explanation | ✅ |
| P11 | Chain viewer: tx | From the job page link: status success, block, from, to, decoded logs | ✅ |
| P12 | Chain viewer: address and token | Balances read from the node; invalid input → "Not an address" | ✅ |
| P13 | Chain viewer: bad and unknown hash | "Not a transaction hash" / "Transaction not found" | ✅ |
| P14 | Providers `/providers` | The node, its capabilities, availability, the on-chain record | ✅ |
| P15 | Network `/network` | Settlement, Contracts, Identity and signing, History (indexed), Audit log, Receipts: every value read live | ❌→✅ |
| P16 | Network: signer without Privy | "a local key · Privy not configured on this broker", no policy listed | ✅ |
| P17 | Network: gate off locally | "off — anyone can fund and be paid" | ✅ |
| P18 | 404 route | The not-found page with a way back | ✅ |
| P19 | 375px | P1, P7, P14 and P15 fit with no horizontal scroll | ✅ |
| P20 | Landing page | Hero, sections and links resolve; Monad copy only; 375px | ❌→✅ |
| P21 | Pay with the visitor's own wallet | The wallet signs the EIP-3009 authorization in the tab; job runs; escrow released | ⏸ needs `NEXT_PUBLIC_PRIVY_APP_ID` (the app's wallet login is Privy), or a browser wallet funded on the local chain. The Chrome profile's wallet is the user's own and was not touched |

## Broker API (curl, with real responses)

| # | Endpoint | Correct means | Status |
|---|---|---|---|
| A1 | `GET /health` | 200 `{ok:true}` | ✅ |
| A2 | `GET /api/network` | network, facilitator, operator.signer (mode "key", policy null), stablecoins, escrow (identityGate null locally), registry, log, stats | ✅ |
| A3 | `GET /api/providers` | The live node, capabilities, onchain record | ✅ |
| A4 | `POST /api/quotes` invalid | 400 for no prompt, 400 for a bad max, 422 for below every price | ✅ |
| A5 | `POST /api/jobs/:quoteId` unpaid | 402 with a PAYMENT-REQUIRED header offering escrow then exact | ✅ |
| A6 | `POST /api/jobs/:quoteId` paid twice | 409 with the job id | ✅ |
| A7 | `GET /api/jobs/:id`, `/stream` | Job record; SSE events through to completion | ✅ |
| A8 | `POST /api/jobs/:id/cancel` | Before start: refunded with no reputation mark | ✅ |
| A9 | `GET /api/receipts` | Receipts read back from XorvLog | ✅ |
| A10 | `GET /metrics` | Prometheus text | ✅ |

## On-chain (real signed transactions on the local chain)

| # | Interaction | Correct means | Status |
|---|---|---|---|
| C1 | Escrow fund | Buyer's EIP-3009 authorization pulled in; `JobFunded`; buyer spent 0 MON | ✅ |
| C2 | Escrow release | Provider paid exactly the price; `JobReleased` with the result hash; registry completed +1 | ✅ |
| C3 | Escrow refund | Buyer made whole; registry failed +1 when at fault | ✅ |
| C4 | Registry sponsored registration | Provider registered by the operator; no MON needed by the provider | ✅ |
| C5 | Audit log append | Receipt entry readable back | ✅ |
| C6 | Cleanverse gate on the real A-Pass (Monad fork) | Unverified buyer refused before signing, nothing moved; verified buyer pays; freeze blocks payout | ✅ |
| C7 | Real AUSD (Monad fork) | Fund and release in Agora's AUSD from Agora's faucet | ✅ |
| C8 | Anything on Monad testnet | | ⏸ awaiting testnet go |

## External integrations

| # | Integration | Correct means | Status |
|---|---|---|---|
| X1 | Codex (provider) | A real job answered by Codex through the node's sandbox | ✅ |
| X2 | Envio indexer | GraphQL totals equal the chain's; the app's History panel shows them | ✅ |
| X3 | Kimi agent | A live run buys jobs through MCP within budget | ⏸ needs `MOONSHOT_API_KEY` |
| X4 | Qwen agent | Same | ⏸ needs `DASHSCOPE_API_KEY` + workspace URL |
| X5 | Privy server wallet | Broker signs through Privy under the policy, gas sponsored | ⏸ needs `PRIVY_APP_ID`, `PRIVY_APP_SECRET` |
| X6 | CRE simulate | `cre workflow simulate --broadcast` refunds an expired job | ⏸ needs `cre login` (and testnet go for `--broadcast`) |
| X7 | Cleanverse CVA (aUSDC) | aUSDC moves through a gated pool | ⏸ needs Cleanverse onboarding (pool registration, policy) |

## How each item was run

- **Browser items (P):**
  - the built-in browser pane, with each item's console and network read in a fresh tab;
  - the Playwright walk in Google Chrome (`apps/app/e2e/walk.spec.ts`, via `scripts/e2e-walk.sh`), which fails on any console error, page error, failed request or unexpected HTTP status.

  The Claude in Chrome extension was not connected during this run (`tabs_context` reported it unreachable twice); the Chrome pass is the Playwright one.
- **API items (A):** `curl` against the running broker.
- **On-chain items (C):** read back with `cast` from the local chain after each browser flow. C6 and C7 ran with `MODE=fork CLEANVERSE=1 scripts/e2e-local.sh` against Monad testnet code on an anvil fork (19/19).
- **X1:** a real Codex answer in each paid job. **X2:** the History panel's totals equal the chain (3 funded, 2 released, 1 refunded, $0.40 paid, score 75%).

Notable observations:
- P2: with the broker stopped, the console shows the browser's own `ERR_CONNECTION_REFUSED` for the stopped service. That is the scenario under test, and the page handles it ("Can't reach the broker", retries on its own, nothing paid).
- P9: stopping a running escrowed job refunded the buyer in full (100 USDC back on chain) with **no** mark on the provider (failed = 0), as a cancel should.
- Persistence: jobs survived a broker restart (SQLite).

## Fixes made during the run

| Item | Failure | Root cause and fix |
|---|---|---|
| P11 | The job page's "View escrow deposit" opened a new tab on the local chain | Local explorer links point at the app's own `/chain` viewer. `inAppChainPath` (`apps/app/lib/chains.ts`) now makes them same-tab relative links, decided from the configured chain so server and client agree. |
| P15 | The Identity and signing intro claimed "Privy's policy engine checks every transaction" on a broker with no Privy configured | The intro now states only what this deployment enforces: gate and/or Privy, or neither. The network page names the configured chain instead of always saying "Monad". |
| P20 | The landing footer's explorer link went to `/chain`, a 404 on the local stack | Added the `/chain` front page: chain id, latest block, the deployment's contracts, and a lookup that routes a hash or address to its page and explains anything else. Covered by the walk. |

## Result

**40 PASS · 0 FAIL · 8 UNTESTED.** Three items failed on their first run and passed after a root-cause fix (above).

UNTESTED, each blocked by a real dependency:
- P21: Privy app id or a funded browser wallet.
- C8: testnet go.
- X3: `MOONSHOT_API_KEY`.
- X4: `DASHSCOPE_API_KEY` and the workspace URL.
- X5: Privy app id and secret.
- X6: `cre login`, and testnet go for `--broadcast`.
- X7: Cleanverse onboarding.

## Zero-mock confirmation

- **No mocks, stubs or fixture modes remain in the running product.** `git grep` over the product path (excluding tests) finds no mock, stub, fake or fixture mode. Without a key, a feature says "not configured" (the operator signer, the agent).
- **Test doubles exist only in test files:** `packages/*/test`, `services/broker/test`, `contracts/test`, and `packages/agent/test/model-server.ts`, which the `AGENT=1` e2e uses only when no model key is set and says so.
- **Every on-chain step in the tested surface is a real signed transaction** against real contracts: a local anvil chain, or an anvil fork of Monad testnet for AUSD and Cleanverse.
- **Data persists in SQLite** and survived a broker restart.
- **No console or network errors in the tested surface,** except the browser's own connection-refused logs in P2, where the broker is stopped on purpose.
