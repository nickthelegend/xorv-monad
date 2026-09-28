# Monad Metropolis: submission

Everything the submission form asks for, in the order it asks. Fields marked **TODO(deploy)** only
exist after deployment or recording. Each one says the command or file that produces it. Fill them in
from the checklist at the end (`grep -n "TODO(deploy)" SUBMISSION.md` lists them), and never with
invented values.

---

## Project

| Field | Value |
|---|---|
| **Project name** | Xorv |
| **One-liner** | A decentralized marketplace for AI capacity: pay per job in USDC over x402 on Monad, with every job receipted on-chain and provider reputation held in ERC-8004. |
| **Track** | **04: Trust, Identity & AI Infrastructure** |
| **Repository** | <https://github.com/nickthelegend/xorv-monad> (MIT) |
| **Demo video (~3 min)** | **TODO(deploy)**: record [RECORDING.md](RECORDING.md), upload, paste the link |
| **Founder pitch (≤2 min)** | **TODO(deploy)**: record the pitch in [RECORDING.md](RECORDING.md#the-founder-pitch-200-or-less), paste the link |
| **Project graphic (≤3 MB)** | **TODO(deploy)**: export one. Suggested source: `brand/xorv-logo.svg` on the app's dark background |
| **Working Monad link** | **TODO(deploy)**: the deployed app's https URL (Vercel project for `apps/app`, [DEPLOY.md §5](DEPLOY.md#5-deploy-the-app-and-the-landing-to-vercel)) |
| **Judge access** | Open the app, log in with any email (Privy creates a wallet), get test USDC from <https://faucet.circle.com> (Monad Testnet), post a job and pay. No MON is needed. Or run `pnpm install && pnpm build && pnpm test` from the repo. |

### Why Track 04

The track is for "protocols, primitives, or infrastructure layers that other applications build on"
and lists "agent identity and reputation under ERC-8004". Xorv is:

- **a payment primitive for AI work**: any x402 client can buy a job, and the repo ships four buyers
  (web app, CLI, MCP server, MetaMask plugin);
- **identity bound to payment**: `XorvLedger` credits an ERC-8004 agent only when `payTo` equals
  the agent's registered wallet;
- **reputation that costs something to fake**: one rating per paid job, signed by the wallet that
  paid, never from the agent's own wallet, owner or operators (`XorvLedger` refuses it on-chain),
  refused by the broker when Nansen links the buyer's wallet to the provider's, delivered to the
  ERC-8004 Reputation Registry through the ledger, and readable by any other marketplace;
- **AI trust services**: a safety screen protecting provider machines, and a verifier publishing an
  independent score on-chain.

It is not a consumer app. It is the rail that consumer apps and agents buy AI work through.

---

## Problem

People pay $20–200 a month for AI subscriptions and model credits and use a fraction of them. Anyone
who needs one job done, or an agent that needs a second model's opinion, has to buy a whole plan or
an API key. Nobody has a way to sell the unused part per job: there is no trustworthy way to find a
provider, pay them a fraction of a cent to a few dollars without an account, know the work was done,
or tell good providers from bad ones.

## Solution

Xorv connects the two sides with an open protocol:

1. A provider runs `xorv init && xorv start`. Their machine dials out to the broker and offers the
   CLIs and model keys it has (Claude Code, Codex, Qwen, Kimi, Hunyuan, Qwen Code, local models),
   each at a price they set.
2. A buyer asks for a quote. Hunyuan screens the prompt; when the buyer chose "Auto", Qwen 3.8 Max
   runs a tool loop that reads ERC-8004 reputation, XorvLedger receipts, Envio aggregates and Nansen
   trust on Monad and picks the provider; the quote freezes that provider, a price and a USDC amount.
3. The buyer signs **one EIP-3009 USDC authorization** to the provider's own address. The x402
   facilitator settles it on Monad **before** the job runs and pays the gas. The broker is never the
   payee.
4. The job runs in the provider's sandbox and streams back live. A failed job moves to another
   provider at no extra charge.
5. The job is receipted on `XorvLedger`, Kimi scores the result and writes the score to ERC-8004, and
   the buyer rates it with a free EIP-712 signature that the broker relays into ERC-8004, unless
   Nansen shows the buyer's and the provider's wallets are one party.
6. The broker pays Nansen per call (USDC over x402 on Monad) to score each connected provider's
   payout wallet; the score is shown on each provider and breaks ties in matching.
7. An Envio indexer turns all of it into the network page and the provider leaderboard.

Private jobs add end-to-end encryption: the answer is sealed on the provider's machine to a key
derived from the buyer's passkey (Mera), and it decrypts on any device that has that passkey.

## Monad integration

| What runs on Monad | Where |
|---|---|
| Every job payment: x402 `exact`, EIP-3009 `transferWithAuthorization` on Circle USDC (`0x534b…43A3` testnet), buyer → provider, gas paid by the facilitator | `packages/protocol/src/x402.ts`, `services/broker/src/app.ts` |
| `XorvLedger`: provider registrations, sampled heartbeats, batched job receipts, payer-signed ratings | `packages/contracts/contracts/XorvLedger.sol` |
| ERC-8004 identity (canonical v2.0.0 registries): `xorv identity register`, `payTo == agentWallet` enforced on every receipt | `packages/cli/src/commands/identity.ts`, `XorvLedger._checkAgentWallet` |
| ERC-8004 reputation: buyer ratings through the ledger (`starred`), Kimi verifications from the verifier EOA (`xorv-verified`) | `XorvLedger.rateJob`, `services/broker/src/ai/feedback.ts` |
| Envio HyperIndex over XorvLedger and both ERC-8004 registries, via HyperSync | `services/indexer/` |
| The broker buying Nansen wallet data: x402 `exact` USDC on Monad **mainnet** (`eip155:143`), one EIP-3009 authorization per $0.01 call, settlement tx kept with each answer | `services/broker/src/trust/nansen.ts` |

**Why Monad.** 300 ms blocks and about 600 ms finality mean a payment settles before the job
starts, so providers work on money that has already landed. Batched receipts cost about 41k gas each
(measured on live Monad), cheap enough to receipt every job and keep reputation on-chain. It is EVM,
so x402 `exact` works with EIP-3009 and Circle USDC, and buyers need no MON. The ERC-8004 registries
are already live on Monad. The Monad-specific costs are handled: every write sets its gas limit to
`estimateGas` × 1.15 because Monad bills the limit; receipts are batched and heartbeats sampled; the
ledger stores one slot per job; reads go through Envio because the public RPC caps `eth_getLogs` at
100 blocks. More detail in [README → Why Monad](README.md#why-monad) and
[ARCHITECTURE.md](ARCHITECTURE.md#xorvledger-the-public-record).

## Deployed contracts and transactions

XorvLedger is deployed and verified. Replace each remaining **TODO(deploy)** with the real value, as an explorer link,
from the command next to it. `<broker>` is the broker's public URL and `<job>` a job id from the
deployed app.

| | Monad testnet (`eip155:10143`) | Where the value comes from |
|---|---|---|
| `XorvLedger` | [`0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD`](https://testnet.monadscan.com/address/0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD) — source verified on [Sourcify](https://sourcify-api-monad.blockvision.org/repo-ui/10143/0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD) | `packages/contracts/deployments/monadTestnet.json` |
| Deploy transaction | [`0xb342175f22adb752d95400eb16288425c403c3f44427735f8439a234453dacc3`](https://testnet.monadscan.com/tx/0xb342175f22adb752d95400eb16288425c403c3f44427735f8439a234453dacc3) (block 66379818) | same file |
| x402 settlement (buyer → provider USDC) | **TODO(deploy)** | `curl -s <broker>/api/jobs/<job> \| jq -r .job.payment.txHash` (or the `Paid:` line of `xorv run`) |
| `recordJobs` receipt | **TODO(deploy)** | `… \| jq -r .job.receiptTxHash`, a few seconds after the job finishes |
| `rateJob` → ERC-8004 `giveFeedback` (`starred`) | **TODO(deploy)** | `… \| jq -r .job.rating.txHash`, after rating the job in the app |
| Kimi verifier `giveFeedback` (`xorv-verified`) | **TODO(deploy)** | `… \| jq -r .job.verification.feedbackTxHash` (needs `MOONSHOT_API_KEY` on the broker) |
| Privy server-wallet payment (MCP agent) | **TODO(deploy)** | the `Payment:` link `xorv_run_job` prints ([packages/mcp/README.md](packages/mcp/README.md)) |
| Demo provider's ERC-8004 agent | **TODO(deploy)** | the agent id from `xorv identity show`; link as `https://testnet.monadscan.com/nft/0x8004A818BFB912233c491871b3d84c89A494BD9e/<agentId>` |
| Envio GraphQL endpoint | **TODO(deploy)** | the Envio Cloud dashboard, or `envio-cloud deployment endpoint <indexer> <commit>` |
| Nansen x402 payment, broker → Nansen (Monad **mainnet**) | **TODO(deploy)** | `curl -s <broker>/api/network \| jq -r .nansen.lastPaidTx.url` with `XORV_NANSEN_MODE=live` |
| ERC-8004 Identity / Reputation (canonical, not ours) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` / `0x8004B663056A597Dffe9eCcC1965A193B7388713` | |
| USDC (Circle) | `0x534b2f3A21130d7a60830c2Df862319e593943A3` | |

## Pre-existing work and AI tools

Xorv began as a Hedera x402 prototype (<https://github.com/nickthelegend/xorv>). Commit `321b563`
imports it unchanged, and **everything after it was built during Metropolis** (from 2026-09-26). The
[README](README.md#prior-work-what-existed-before-metropolis-and-what-is-new) lists what was carried
over and what is new. The port was built with **Claude Code** and Claude agents under the author's
direction, as disclosed in the [README](README.md#ai-tools-disclosure). External code is attributed
[there too](README.md#attribution-of-external-code).

---

## Bounties entered

Xorv is entered in **Track 04: Trust, Identity & AI Infrastructure**. The portal's Tracks & Bounties
page says each sponsor bounty names its track, and only the ones marked **All tracks** pair with any
primary track. So a Track 04 project can enter the All-tracks bounties and the Track 04 ones, and
nothing locked to another track. Every card below is quoted verbatim from that page, with its track
and prize.

Each checklist maps a requirement to its evidence. **Code** means it is in the repo and tested.
**Live** means it still needs the deployment or the recording. Each card's own submission fields
appear in the portal when the bounty is added: re-read them before submitting, because requirement
adherence is 40% of each bounty score.

| Bounty | Sponsor | Track on the card | Prize |
|---|---|---|---|
| Privy! | Privy | All tracks | $5,000 USD |
| Best Use of Envio | Envio | All tracks | $1,000 USD |
| Best use of Nansen | Nansen AI | All tracks | $5,000 USD total prize pool |
| Best Builds Powered by KIMI | Kimi | All tracks | $3,000 in credits |
| Mera: One Passkey, Many Keys | Monad Foundation | All tracks | $2,500 USD |
| Best Builds with Qwen 3.8 Max | Alibaba Cloud | Trust, Identity & AI Infrastructure | $5,000 in credits |

### Privy: "Privy!"

> **Card** (Privy · All tracks · $5,000 USD): "Integrate Privy beyond authentication — login-only
> integrations will not qualify."

The sponsor's brief adds that the demo must clearly show the functionality powered by Privy, with
bonus points for meaningfully integrating multiple Privy features. Xorv uses three on camera.

| Requirement | Evidence | Status |
|---|---|---|
| Beyond login: the embedded wallet **pays** for jobs | x402 `exact` EIP-3009 signed by the Privy wallet via `toViemAccount`, `@x402/fetch` v2 (`apps/app/components/wallet-provider.tsx`, `apps/app/lib/x402-pay.ts`, `apps/app/components/composer.tsx`). Privy's sign modal gets JSON-safe typed data (`apps/app/lib/typed-data.ts`, byte-for-byte digest test in `apps/app/test/typed-data.test.ts`) | Code |
| Beyond login: the embedded wallet **signs ratings**, gaslessly | EIP-712 `Rating`, relayed to `XorvLedger.rateJob` → ERC-8004 (`apps/app/lib/rating.ts`, `apps/app/components/rate-job.tsx`) | Code |
| Multiple features: **server wallet + policy** for an AI agent | MCP buyer on `@privy-io/node/viem` `createViemAccount`; `pnpm privy:setup` writes a policy (USDC `TransferWithAuthorization` on this chain ≤ cap, XorvLedger ratings, optional payee allowlist, optional P-256 owner key); `xorv_wallet` shows the wallet id and its policy id (`packages/mcp/src/signer.ts`, `packages/mcp/src/privy-policy.ts`, `packages/mcp/src/scripts/privy-setup.ts`) | Code |
| Multiple features: embedded wallet created at login, pinned to Monad | `createOnLogin: "users-without-wallets"`, `defaultChain`/`supportedChains` (`apps/app/components/providers.tsx`) | Code |
| Multiple features: key export | `useExportWallet` (`wallet-provider.tsx`) | Code |
| Provider payout to a Privy wallet (no key on the node) | `xorv init` → "Use an address I already control" (`packages/cli/src/commands/init.ts`) | Code |
| Demo clearly shows it | [RECORDING.md](RECORDING.md): 0:08–0:16 login creates the embedded wallet; 0:30–0:42 it signs the x402 payment; 1:06–1:16 it signs the gasless rating; 1:16–1:40 an MCP agent pays from the policy-bounded server wallet, with the policy on screen; 2:20–2:52 it pays for the private job | Live: TODO(deploy) |

### Envio: "Best Use of Envio"

> **Card** (Envio · All tracks · $1,000 USD): "Meaningfully use Envio's HyperIndex, HyperSync, or
> HyperRPC to power real on-chain data driving a core feature in your app."

The sponsor's brief adds that entries are judged on depth (multichain, a non-trivial schema, derived
or aggregated entities), live and correct data, originality and craft, and asks for an indexer with a
public `config.yaml`, `schema.graphql` and handlers, a consumer, and a short demo.

| Requirement | Evidence | Status |
|---|---|---|
| HyperIndex indexer, public config, schema and handlers | `services/indexer/config.yaml`, `config.mainnet.yaml`, `schema.graphql`, `src/handlers/{XorvLedger,IdentityRegistry,ReputationRegistry}.ts` | Code |
| Depth: more than a single-event indexer | 3 contracts, 13 events, 14 entity types; derived `Provider` earnings, success rate and rating; `Agent` reputation split by writer; `NetworkStats`, `DailyStats`, `ProviderDay`, `BuyerDay` | Code |
| Non-trivial logic | Feedback classified by client address (ledger = buyer rating, broker = verified, else other); revocations undo exactly; receipts that arrive before their registration are claimed later; broker rotation respected (`src/lib/trust.ts`, `src/lib/aggregates.ts`) | Code |
| Real on-chain data driving a feature | Broker `/api/leaderboard`, `/api/ledger`, `/api/receipts` read Envio first (`services/broker/src/indexer.ts`, `ledger-reader.ts`) → app network page ("indexed by Envio"), providers leaderboard, landing ledger | Code |
| Envio in the core loop (matching, routing) | The Qwen router's `indexer_provider_stats` and `recent_receipts` tools read the indexer while choosing a provider; when no router runs, the deterministic matcher breaks price ties on indexed reputation (buyer ratings + Kimi scores, shrunk toward a neutral prior; one batched GraphQL query a minute at most) — `services/broker/src/ai/router-tools.ts`, `router-data.ts`, `reputation-book.ts` | Code |
| HyperSync | Both configs read `monad-testnet.hypersync.xyz` / `monad.hypersync.xyz` | Code |
| Tests | 52 handler, ABI, config and query tests (`services/indexer/test`) | Code (run in Docker/WSL, and in CI) |
| Hosted indexer with live data | Envio Cloud, deployed between Oct 10 and 13 so the 30-day free deployment outlives judging | Live: TODO(deploy) |
| Short end-to-end demo | RECORDING.md 1:40–1:55 (network page, leaderboard, a live GraphQL query) | Live: TODO(deploy) |

### Nansen AI: "Best use of Nansen"

> **Card** (Nansen AI · All tracks · $5,000 USD total prize pool): "Build a product experience powered
> by Nansen data/API/MCP/CLI that goes beyond exposing raw data."

The broker is itself a paying agent: it buys Nansen profiler data per call, in USDC over x402 on
Monad **mainnet**, and turns it into three decisions the product acts on. Nansen's CEO also judges
the main track. Full design: [docs/NANSEN.md](docs/NANSEN.md).

| Requirement | Evidence | Status |
|---|---|---|
| Powered by Nansen's API | Four endpoints: `profiler/address/first-funder`, `related-wallets`, `transactions`, `smart-money/pnl-leaderboard` (`services/broker/src/trust/nansen.ts`) | Code |
| Paid per call over x402 on Monad | Only `exact` on `eip155:143` registered, mainnet USDC hard-coded (never read from a stablecoin override); every request validated locally first, because Nansen charges before it validates; a per-endpoint price table ($0.01 profiler, $0.05 smart money); a per-call cap (`XORV_NANSEN_PER_CALL_CAP`, $0.05) and a daily budget (`XORV_NANSEN_DAILY_CAP`, $1) with reservations released when signing or settlement fails; an optional pinned payee (`XORV_NANSEN_PIN_PAYTO=observed`); the settlement tx kept with each cached answer. `NANSEN_API_KEY` takes precedence (credits, no payment). Tested against Nansen's real captured 402s (`services/broker/test/trust.test.ts`) | Code |
| Beyond raw data 1: **a provider trust score** | One 0–100 number per payout wallet from written rules that never penalise missing data (`services/broker/src/trust/signal.ts` `TRUST_RULES`: wallet age, exchange funding, activity, risky counterparties), on `/api/providers`, `/api/providers/:id` and `/api/leaderboard`. Bought when a provider's node opens its control socket (not at registration, which is free), refreshed every 6 h (`services/broker/src/trust/service.ts`) | Code |
| Beyond raw data 2: **a wash-rating guard** | `POST /api/jobs/:id/rate` refuses with 403 `related_wallets` when buyer and provider are one party (same wallet, one funded the other, a shared non-exchange first funder, related wallets), before anything reaches ERC-8004, and stores the check on the job (`signal.ts` `relatedParties`, `service.ts` `checkRelated`, `services/broker/src/app.ts`). 30% of the daily budget is reserved for it; when a check can't run for lack of budget the rating is deferred (503 `trust_budget_spent`), never relayed unchecked | Code |
| Beyond raw data 3: **a matching tie-breaker** | The score nudges reliability by at most ±0.1 after price (`services/broker/src/registry.ts` `TRUST_TIEBREAK_WEIGHT`), so it breaks ties and never beats a cheaper node or a real track record; smart-money membership adds an internal nudge that is never shown | Code |
| Visible in the product | Trust badge on every provider row (`apps/app/components/live-lists.tsx`); the *Wallet trust* panel on `/providers/<id>` with wallet age, first funder, activity, risk flags and "Xorv paid Nansen $0.03 over x402 on Monad" with each settlement linked on Monadscan (`provider-view.tsx`); the network page's *Wallet intelligence* spend panel: mode, payer, calls and spend against the budget, last payment, ratings checked and refused (`network-view.tsx`); the rating widget's *Rating refused* (`rate-job.tsx`). All in `apps/app/components/trust.tsx` and `apps/app/lib/trust.ts`. Nansen also appears on the landing page's Built-with and FAQ | Code |
| Respects Nansen's redistribution rules | Smart-money data and related-wallet addresses stay in the broker; the public view is built in one function (`publicTrustView`); every surface says "Powered by Nansen", linked to nansen.ai; answers are cached briefly (7 days for a first funder, 1 day for related wallets, 1 hour for activity) ([docs/NANSEN.md §5](docs/NANSEN.md#5-what-is-published-and-what-is-not)) | Code |
| Modes: off, fixture, live | `XORV_NANSEN_MODE=off` (default), `fixture` (deterministic recorded-shape data, no network, no payments, never claims a paid tx; `XORV_NANSEN_FIXTURE_CLUSTER` stages a related-wallet ring for the demo), `live` (`XORV_NANSEN_PAYER_KEY`, a mainnet key with a few USDC, or `NANSEN_API_KEY`) | Code |
| A paid call on Monad mainnet | `XORV_NANSEN_MODE=live` with `XORV_NANSEN_PAYER_KEY` (~$2 of mainnet USDC), then `pnpm nansen:probe --mode live <address>` or connect the demo provider | Live: TODO(deploy) |
| Demo | RECORDING.md 1:55–2:10 (trust panel with its Monad payment links, then a refused wash rating) | Live: TODO(deploy) |

### Kimi: "Best Builds Powered by KIMI"

> **Card** (Kimi · All tracks · $3,000 in credits): "Build a project genuinely powered by KIMI
> (Moonshot AI) — open scope, no category restrictions."

| What Kimi does | Evidence | Status |
|---|---|---|
| **Load-bearing core-loop role: the result verifier**, scoring every completed public job | `services/broker/src/ai/verifier.ts` | Code |
| Its score becomes **on-chain ERC-8004 reputation** (`xorv-verified`), with a hash-committed feedback file | `services/broker/src/ai/feedback.ts`, `GET /verifications/<jobId>.json` | Code |
| Visible in the product | The job page's *Verified* row with the "ERC-8004 feedback" link; the indexer's `XORV_VERIFIED` reputation; RECORDING.md 0:56–1:06 | Code |
| Provider backend: `kimi` adapter (`kimi-k3`) | `packages/cli/src/adapters/hosted.ts` | Code |
| Live calls with a Moonshot key | `MOONSHOT_API_KEY` on the demo broker | Live: TODO(deploy) |

### Monad Foundation: "Mera: One Passkey, Many Keys"

> **Card** (Monad Foundation · All tracks · $2,500 USD): "Most creative non-wallet use of Mera's
> PRF-derived key material."

The sponsor's brief adds that it is for anything that is not signing blockchain transactions from a
wallet account, judged on novelty, correct use of the primitives (salts genuinely namespaced, nothing
sensitive persisted), and **a live cross-device test**: a second device or fresh profile must
reproduce the same keys and decrypt the same state.

| Requirement | Evidence | Status |
|---|---|---|
| Non-wallet use of PRF key material | E2E-encrypted AI job results (X25519 inbox), an encrypted job-history vault (AES-256-GCM), a self-certifying vault identity and write authorization (Ed25519 in a Mera signing session). None of it signs a transaction; Privy pays. | Code |
| At least one PRF namespace doing non-account work | Three: `xorv:inbox:v1`, `xorv:vault:v1`, `xorv:vault-auth:v1` (`packages/protocol/src/sealed.ts`, `vault.ts`) | Code |
| Salts genuinely namespaced | One PRF salt per namespace (`sha256(label)`), bound again in the HKDF salt and info; ceremonies pinned to one credential; known-answer vectors and `node:crypto` cross-checks (`packages/protocol/test/{sealed,vault}.test.ts`) | Code |
| Nothing sensitive persisted | Keys only in memory, zeroed on lock, 30-min auto-lock; unsaved prompts dropped on lock; a test scans the private-job code for storage APIs (`apps/app/test/private-keyring.test.ts`, `private-pending.test.ts`) | Code |
| The result is bound to the chain | The job page checks the envelope against the `resultHash` in the job's XorvLedger receipt on Monad, read over the browser's own RPC (`apps/app/lib/private/receipt-check.ts`) | Code |
| Cross-device test | Real Mera against a fake *synced* authenticator reproduces keys, history and results on "device B" (`apps/app/test/private-keyring.test.ts`, `test/support/fake-authenticator.ts`) | Code |
| **Live** cross-device test | Second device or fresh profile, same synced passkey, on the deployed https app: RECORDING.md 2:20–2:52, and a standalone 75-second cut scripted in [docs/PRIVATE_JOBS.md §6](docs/PRIVATE_JOBS.md#6-cross-device-demo-script-for-the-video-about-75-s) | Live: TODO(deploy) |

### Alibaba Cloud: "Best Builds with Qwen 3.8 Max"

> **Card** (Alibaba Cloud · Trust, Identity & AI Infrastructure · $5,000 in credits): "Push Qwen 3.8
> Max into genuinely agentic territory on Monad."

Qwen 3.8 Max is a bounded, tool-using agent on the quote path. For every "Auto" quote with more than one
live option under the ceiling, it reads Monad state and then picks the provider that runs the job.

| What Qwen does | Evidence | Status |
|---|---|---|
| **Agentic, on Monad:** a tool loop (≤4 turns, ≤6 reads, 15 s budget, thinking on with a 256-token budget) over `list_candidates`, `erc8004_reputation` (ERC-8004 Reputation `getSummary` for the XorvLedger and verifier clients + Identity agent-wallet check), `recent_receipts` (XorvLedger `JobRecorded`/`JobRated`, indexer first, RPC fallback), `indexer_provider_stats` (Envio aggregates), `nansen_trust` (public trust view), then `select_provider` | `services/broker/src/ai/router.ts`, `router-tools.ts`, `router-data.ts`; `packages/protocol/src/llm.ts` (tool-calling chat turn) | Code |
| **Load-bearing:** it chooses the provider (not just the adapter); the pick is checked against live candidates and the ceiling, gets one retry, else the deterministic matcher takes over and `routing.fallback` is recorded | `services/broker/test/ai.test.ts` (multi-turn loop, each tool's mapping, invalid pick, timeout, turn caps), integration tests | Code |
| **Visible:** `routing.steps` — every tool call with validated ids, a templated summary and explorer links — rendered as an agent trace on the quote card and the job page; private jobs withhold the model's reason | `apps/app/components/routing-trace.tsx`, `apps/app/lib/ai.ts`, `apps/app/test/ai.test.ts`; RECORDING.md quote beat | Code |
| Exercised end to end against a Monad testnet fork (mock Qwen driving the real tool loop over the fork's ERC-8004 registries and XorvLedger) | `e2e/src` mock LLM, `e2e/README.md` | Code |
| Provider backend: `qwen` adapter (`qwen3.8-max`, streamed reasoning, token cost) | `packages/cli/src/adapters/hosted.ts` | Code |
| Provider backend: `qwen-code` adapter (Qwen Code CLI with tools, on Qwen 3.8 Max) | `packages/cli/src/adapters/qwen-code.ts` | Code |
| Live calls with a Model Studio key | `DASHSCOPE_API_KEY` on the demo broker and provider | Live: TODO(deploy) |

### Also built (not entered: track-locked to other tracks)

These stay in the product and in the repo's tests. Their bounties name a different track on the card,
so a Track 04 project cannot enter them, and they are not in the main demo.

**MetaMask: "Best Agent Wallet Plugin".**

> **Card** (Metamask · Onchain Finance & Trading · $2,500 USD): "Build a plugin that gives the
> MetaMask Agent Wallet a new trading superpower via its plugin architecture."

Xorv's plugin buys AI jobs rather than trading, and the card is locked to Onchain Finance & Trading.
What it is, as a buyer client:

| Feature | Evidence | Status |
|---|---|---|
| A real Agent Wallet plugin (npm package adding `mm` commands) | `@xorv/mm-plugin`: `mm xorv providers`, `quote`, `run`, `job`, `rate`, on the official template (`packages/mm-plugin/`) | Code |
| Valid manifest with scoped capabilities | `package.json#mm`: `schemaVersion: 1`, `minCliVersion: ^7.0.0`, per-command `capabilities` and `dataAccess`, `targetChains: [10143, 143]`; validated with MetaMask's own `PluginManifestSchema` (`test/manifest.test.ts`) | Code |
| Signs only through MetaMask, after checking the quote | EIP-3009 and rating signatures only through `ctx.walletExecutor` typed-data, readable intent, signer recovered before sending; quote vetting, spend cap, not paying yourself, balance check (`src/lib/{executor,vet,pay}.ts`) | Code |
| Runs in Agent Wallet | `providers` and `quote` ran in Agent Wallet 7.0.0 from a local install ([packages/mm-plugin/README.md](packages/mm-plugin/README.md#example-session)) | Partly verified |
| Published to npm | `pnpm --filter @xorv/protocol publish --access public`, then `pnpm --filter @xorv/mm-plugin publish --access public` | Not yet |

**Tencent Kepler Plan: "Build with Hunyuan: Multimodal & Interactive Experiences".**

> **Card** (Kepler Plan by Tencent · Social, Attention & Culture · $2,000 in Tencent Cloud vouchers):
> "Build a multimodal or interactive experience genuinely powered by Tencent's Hunyuan model."

Xorv's Hunyuan role is a text safety screen, and the card is locked to Social, Attention & Culture.
What it is, as a product feature:

| Feature | Evidence | Status |
|---|---|---|
| The safety screen on every quote, before any provider sees the prompt; a block is a 422 | `services/broker/src/ai/screener.ts`, integration test "refuses to quote a prompt the Hunyuan screen blocks…" | Code |
| Explicit failure policy | `XORV_SCREENER_FAIL=open\|closed` | Code |
| Visible in the product | Quote card "Screened by Hunyuan hy4: …", the job page's *Screened* row (reasons withheld on private jobs); the blocked-prompt shot is an optional cutaway in RECORDING.md | Code |
| Provider backend: `hunyuan` adapter (`hy4-preview` via TokenHub) | `packages/cli/src/adapters/hosted.ts` | Code |

**Monad Foundation: "Best Community Team Project"** (All tracks, $5,000 USD) is for teams from
Metropolis community supporters. It is not a separate entry: see the last item of
[Before you submit](#before-you-submit).

---

## Team

| | |
|---|---|
| Nivesh Gajengi ([@nickthelegend](https://github.com/nickthelegend)) | Design, product, and direction of the Claude Code agents that built the port <!-- TODO: add teammates, if any --> |

## What's next

- **Mainnet.** `config.mainnet.yaml`, `deploy:mainnet` and the mainnet chain table are ready. It needs
  a funded deploy and a mainnet broker.
- **Private jobs outside the browser.** Today only browser buyers hold a passkey, so CLI, MCP and
  MetaMask-plugin buyers post public jobs.
- **Reputation that resists self-dealing, further.** `XorvLedger` already refuses a provider paying
  itself and ratings from the agent's own wallet, owner or operators, and the broker refuses to relay
  ratings between wallets Nansen links. A provider could still rate itself from a wallet with no
  traceable tie to it. The indexer already has every receipt's buyer, so the next step is weighting
  scores by distinct paying buyers and by each buyer's own Nansen trust.
- **A protocol fee without custody.** It would need a payment splitter contract as the `payTo`. The
  broker must never become the payee.
- **Publish 0.2.0** of `@xorv/protocol`, `@xorv/cli`, `@xorv/mcp` and `@xorv/mm-plugin` to npm.

---

## Before you submit

Deadline: **Oct 13 2026, 11:59 PM ET** (Oct 14 03:59 UTC). The version saved at the deadline is
the one judged.

**Deploy** (the full order, with env lines, is [DEPLOY.md](DEPLOY.md))
- [ ] Fund the deployer (or operator) EOA with MON, above the 10 MON reserve, and deploy the ledger
      with a **cold owner**: `XORV_BROKER_ADDRESS=<operator address> XORV_LEDGER_OWNER=<address the
      broker's host doesn't hold> pnpm deploy:ledger`. The script refuses an owner that is the broker
      or the operator key on testnet. Then `pnpm --filter @xorv/contracts verify:testnet`, and commit
      `packages/contracts/deployments/monadTestnet.json`.
- [ ] Run the broker on a public https URL with `XORV_PUBLIC_URL` set to it (it goes into on-chain
      agent and feedback URIs), `XORV_LEDGER_ADDRESS`, `XORV_LEDGER_FROM_BLOCK`, `XORV_TRUST_PROXY=1`
      and `XORV_TRUSTED_HOPS` behind a proxy, and the three model keys. Check with
      `pnpm setup:monad` and `GET /api/network`.
- [ ] Register the demo provider's ERC-8004 identity (`xorv identity register`) and start it with the
      `qwen`, `kimi` or `hunyuan` adapter and one CLI adapter.
- [ ] **Deploy the Envio indexer between Oct 10 and Oct 13** (the free plan keeps a deployment for 30
      days; judging runs to Oct 27 and winners are announced Nov 3). Set `ENVIO_XORV_LEDGER_ADDRESS`,
      `ENVIO_XORV_LEDGER_START_BLOCK`, and `ENVIO_XORV_VERIFIER_ADDRESSES` if the verifier has its own
      key. Then set `XORV_INDEXER_URL` on the broker.
- [ ] Deploy the two sites on https ([DEPLOY.md §5](DEPLOY.md#5-deploy-the-app-and-the-landing-to-vercel)):
  - `apps/app`: `NEXT_PUBLIC_XORV_BROKER_URL`, `NEXT_PUBLIC_XORV_NETWORK=eip155:10143`,
    `NEXT_PUBLIC_PRIVY_APP_ID`, and optionally the server-only `XORV_DEMO_PAYER_KEY`;
  - `apps/landing`: `NEXT_PUBLIC_XORV_BROKER_URL`, `NEXT_PUBLIC_XORV_APP_URL` (the app's https URL:
    without it every "Open app" and "Post a job" button points to `http://localhost:3002`),
    `NEXT_PUBLIC_XORV_LEDGER_ADDRESS` and `NEXT_PUBLIC_XORV_NETWORK`.

  Add the app's domain to the Privy app's allowed origins, both domains to `XORV_CORS_ORIGINS`, and
  the app's to `XORV_APP_URL`.
- [ ] Pay one job end to end in the deployed app, rate it, and let Kimi verify it. Copy the
      settlement, receipt, rating and feedback transaction hashes.
- [ ] Privy server wallet: `pnpm privy:setup --cap-usdc 0.05 --broker <broker URL>`, fund the printed
      address with test USDC, configure the MCP server built from source, and pay one job with
      `xorv_run_job`. Copy its payment link.
- [ ] Nansen: fund a **separate** Monad **mainnet** key with ~$2 USDC, set `XORV_NANSEN_MODE=live`
      and `XORV_NANSEN_PAYER_KEY` on the broker, start the demo provider (its signal is bought when
      its node connects), and check `GET /api/network` → `nansen.lastPaidTx`. Copy one paid tx.
      Stage the refused rating as in [docs/NANSEN.md §7](docs/NANSEN.md#7-seeing-it).
- [ ] Optional: publish to npm with pnpm, not npm (it rewrites the `workspace:*` range), and with
      `--access public`, because a scoped package is private on its first publish and neither
      `@xorv/protocol` nor `@xorv/mm-plugin` sets `publishConfig`:
      `pnpm --filter @xorv/protocol publish --access public`, then
      `pnpm --filter @xorv/mm-plugin publish --access public`.

**Fill placeholders**
- [ ] `grep -rn "TODO(deploy)" README.md SUBMISSION.md packages/contracts/README.md` and replace each
      one (README header links, "What is proven" and Deployments; this file's Project and Deployed
      contracts tables and bounty statuses; the XorvLedger row in `packages/contracts/README.md`)
      with the value from the command named next to it.

**Record**
- [ ] The ~3-minute demo ([RECORDING.md](RECORDING.md)), showing the Monad integration and each
      entered bounty: three Privy features, Envio, Nansen, Kimi, Qwen and the live cross-device Mera
      decrypt.
- [ ] The ≤2-minute founder pitch (same file).
- [ ] The project graphic (≤3 MB).

**Hygiene**
- [ ] **Rotate every credential that was ever pasted anywhere**: in a chat, a terminal recording,
      a screenshot, an issue, or a `.env` shared for debugging. That covers operator, facilitator,
      verifier, deployer, demo and Nansen payer keys, the Privy app secret, the DashScope, Moonshot,
      TokenHub and Nansen API keys, the Envio API token and the Monadscan key. Then re-run `pnpm setup:monad`.
- [ ] Confirm that no `.env` or key is tracked (CI's "No keys in the tree" job) and that the repo is
      public.

**Submission form**
- [ ] Primary track: **Trust, Identity & AI Infrastructure** (Track 04).
- [ ] Add the six bounties entered, and answer each one's fields from its checklist above: *Privy!*,
      *Best Use of Envio*, *Best use of Nansen*, *Best Builds Powered by KIMI*, *Mera: One Passkey,
      Many Keys*, *Best Builds with Qwen 3.8 Max*.
- [ ] Do not add *Best Agent Wallet Plugin* (MetaMask) or *Build with Hunyuan* (Tencent): their cards
      name other tracks.
- [ ] *Best Community Team Project* (All tracks): select your community group in the portal profile
      if eligible.
