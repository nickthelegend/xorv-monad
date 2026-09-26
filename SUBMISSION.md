# Monad Metropolis: submission

Everything the submission form asks for, in the order it asks. Fields marked **TBD** only exist after
deployment or recording. Fill them in from the checklist at the end, and never with invented values.

---

## Project

| Field | Value |
|---|---|
| **Project name** | Xorv |
| **One-liner** | A decentralized marketplace for AI capacity: pay per job in USDC over x402 on Monad, with every job receipted on-chain and provider reputation held in ERC-8004. |
| **Track** | **04: Trust, Identity & AI Infrastructure** |
| **Repository** | <https://github.com/nickthelegend/xorv-monad> (MIT) |
| **Demo video (~3 min)** | <!-- TODO(deploy): demo video link --> TBD, fill in after recording |
| **Founder pitch (≤2 min)** | <!-- TODO(deploy): pitch video link --> TBD, fill in after recording |
| **Project graphic (≤3 MB)** | <!-- TODO(deploy): graphic --> TBD. Suggested source: `brand/xorv-logo.svg` on the app's dark background |
| **Working Monad link** | <!-- TODO(deploy): deployed app URL --> TBD, the deployed app on Monad testnet |
| **Judge access** | Open the app, log in with any email (Privy creates a wallet), get test USDC from <https://faucet.circle.com> (Monad Testnet), post a job and pay. No MON is needed. Or run `pnpm install && pnpm build && pnpm test` from the repo. |

### Why Track 04

The track is for "protocols, primitives, or infrastructure layers that other applications build on"
and lists "agent identity and reputation under ERC-8004". Xorv is:

- **a payment primitive for AI work**: any x402 client can buy a job, and the repo ships four buyers
  (web app, CLI, MCP server, MetaMask plugin);
- **identity bound to payment**: `XorvLedger` credits an ERC-8004 agent only when `payTo` equals
  the agent's registered wallet;
- **reputation that costs something to fake**: one rating per paid job, signed by the wallet that
  paid, refused when Nansen links the buyer's wallet to the provider's, delivered to the ERC-8004
  Reputation Registry through the ledger, and readable by any other marketplace;
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
2. A buyer asks for a quote. Hunyuan screens the prompt, Qwen picks the adapter when the buyer chose
   "Auto", and the matcher freezes a provider, a price and a USDC amount.
3. The buyer signs **one EIP-3009 USDC authorization** to the provider's own address. The x402
   facilitator settles it on Monad **before** the job runs and pays the gas. The broker is never the
   payee.
4. The job runs in the provider's sandbox and streams back live. A failed job moves to another
   provider at no extra charge.
5. The job is receipted on `XorvLedger`, Kimi scores the result and writes the score to ERC-8004, and
   the buyer rates it with a free EIP-712 signature that the broker relays into ERC-8004, unless
   Nansen shows the buyer's and the provider's wallets are one party.
6. The broker pays Nansen per call (USDC over x402 on Monad) to score every provider's payout
   wallet; the score is shown on each provider and breaks ties in matching.
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

<!-- TODO(deploy): replace every TBD below with the real value; keep the explorer links. -->

| | Monad testnet (`eip155:10143`) |
|---|---|
| `XorvLedger` | TBD, fill in after deploy (`https://testnet.monadscan.com/address/<address>`) |
| Deploy transaction | TBD |
| x402 settlement (buyer → provider USDC) | TBD |
| `recordJobs` receipt | TBD |
| `rateJob` → ERC-8004 `giveFeedback` (`starred`) | TBD |
| Kimi verifier `giveFeedback` (`xorv-verified`) | TBD |
| Demo provider's ERC-8004 agent | TBD |
| Envio GraphQL endpoint | TBD |
| Nansen x402 payment, broker → Nansen (Monad **mainnet**) | TBD (`https://monadscan.com/tx/<hash>`) |
| ERC-8004 Identity / Reputation (canonical, not ours) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` / `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| USDC (Circle) | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |

## Pre-existing work and AI tools

Xorv began as a Hedera x402 prototype (<https://github.com/nickthelegend/xorv>). Commit `321b563`
imports it unchanged, and **everything after it was built during Metropolis** (from 2026-09-26). The
[README](README.md#prior-work-what-existed-before-metropolis-and-what-is-new) lists what was carried
over and what is new. The port was built with **Claude Code** and Claude agents under the author's
direction, as disclosed in the [README](README.md#ai-tools-disclosure). External code is attributed
[there too](README.md#attribution-of-external-code).

---

## Bounties entered

Each checklist maps one published requirement to the evidence. "Code" means it is in the repo and
tested. "Live" means it still needs the deployment or the recording. Requirement wording marked
*(captured)* was copied from the bounty card by another team, and *(unverified)* means the card
text was not found. **Read every card in the portal before submitting**: requirement adherence is
40% of each bounty score.

### Privy: "Privy!" ($5,000)

*(captured)* "Integrate Privy beyond authentication — login-only integrations will not qualify." The
demo must clearly show Privy-powered functionality, with bonus points for multiple Privy features.

| Requirement | Evidence | Status |
|---|---|---|
| Beyond login: the embedded wallet **pays** for jobs | x402 `exact` EIP-3009 signed by the Privy wallet via `toViemAccount`, `@x402/fetch` v2 (`apps/app/components/wallet-provider.tsx`, `apps/app/lib/x402-pay.ts`, `apps/app/components/composer.tsx`) | Code |
| Beyond login: the embedded wallet **signs ratings**, gaslessly | EIP-712 `Rating`, relayed to `XorvLedger.rateJob` → ERC-8004 (`apps/app/lib/rating.ts`, `apps/app/components/rate-job.tsx`) | Code |
| Multiple features: embedded wallet created at login, pinned to Monad | `createOnLogin: "users-without-wallets"`, `defaultChain`/`supportedChains` (`apps/app/components/providers.tsx`) | Code |
| Multiple features: key export | `useExportWallet` (`wallet-provider.tsx`) | Code |
| Multiple features: **server wallet + policy** for an AI agent | MCP buyer on `@privy-io/node/viem` `createViemAccount`; `pnpm privy:setup` writes a policy (USDC `TransferWithAuthorization` on this chain ≤ cap, XorvLedger ratings, optional payee allowlist, optional P-256 owner key) (`packages/mcp/src/signer.ts`, `packages/mcp/src/privy-policy.ts`, `packages/mcp/src/scripts/privy-setup.ts`) | Code |
| Provider payout to a Privy wallet (no key on the node) | `xorv init` → "Use an address I already control" (`packages/cli/src/commands/init.ts`) | Code |
| Demo clearly shows it | RECORDING.md 0:08–0:48 (login, quote, pay from the embedded wallet), 1:18–1:28 (gasless rating), 2:25–2:55 (Privy pays for the private job); the MCP agent wallet is an optional cutaway | Live: TBD |

### Envio: "Best Use of Envio" ($1,000)

*(captured)* "meaningfully use Envio's HyperIndex, HyperSync or HyperRPC to power real on-chain data…
not just installed, but actually driving a feature." Judged on depth (multichain, non-trivial schema,
derived or aggregated entities), live and correct data, originality and craft. Deliverables: an
indexer with a public `config.yaml`, `schema.graphql` and handlers; a consumer; a short demo.

| Requirement | Evidence | Status |
|---|---|---|
| HyperIndex indexer, public config, schema and handlers | `services/indexer/config.yaml`, `config.mainnet.yaml`, `schema.graphql`, `src/handlers/{XorvLedger,IdentityRegistry,ReputationRegistry}.ts` | Code |
| Depth: more than a single-event indexer | 3 contracts, 13 events, 15 entity types; derived `Provider` earnings, success rate and rating; `Agent` reputation split by writer; `NetworkStats`, `DailyStats`, `ProviderDay`, `BuyerDay` | Code |
| Non-trivial logic | Feedback classified by client address (ledger = buyer rating, broker = verified, else other); revocations undo exactly; receipts that arrive before their registration are claimed later; broker rotation respected (`src/lib/trust.ts`, `src/lib/aggregates.ts`) | Code |
| Actually driving a feature | Broker `/api/leaderboard`, `/api/ledger`, `/api/receipts` read Envio first (`services/broker/src/indexer.ts`, `ledger-reader.ts`) → app network page ("indexed by Envio"), providers leaderboard, landing ledger | Code |
| HyperSync | Both configs read `monad-testnet.hypersync.xyz` / `monad.hypersync.xyz` | Code |
| Tests | 52 handler, ABI, config and query tests (`services/indexer/test`) | Code (run in Docker/WSL) |
| Hosted indexer with live data | Envio Cloud, deployed between Oct 10 and 13 so the 30-day free deployment outlives judging | Live: TBD |
| Short end-to-end demo | RECORDING.md 1:28–1:45 (network page, leaderboard, a live GraphQL query) | Live: TBD |

### MetaMask: "Best Agent Wallet Plugin" ($2,500)

*(unverified: card text not found.)* Built to the Agent Wallet plugin documentation.

| Expected requirement | Evidence | Status |
|---|---|---|
| A real Agent Wallet plugin (npm package adding `mm` commands) | `@xorv/mm-plugin`: `mm xorv providers`, `quote`, `run`, `job`, `rate`, on the official template (`packages/mm-plugin/`) | Code |
| Valid manifest with scoped capabilities | `package.json#mm`: `schemaVersion: 1`, `minCliVersion: ^7.0.0`, per-command `capabilities` and `dataAccess`, `targetChains: [10143, 143]`; validated with MetaMask's own `PluginManifestSchema` (`test/manifest.test.ts`) | Code |
| Uses the wallet under MetaMask policy | EIP-3009 and rating signatures only through `ctx.walletExecutor` typed-data; readable intent text; signer recovered before sending (`src/lib/executor.ts`) | Code |
| Safety before asking MetaMask | quote vetting, 402 = quote, spend cap, not paying yourself, balance check (`src/lib/vet.ts`, `src/lib/pay.ts`) | Code |
| Runs in Agent Wallet | `providers` and `quote` ran in Agent Wallet 7.0.0 from a local install (packages/mm-plugin/README.md, "Example session") | Partly verified |
| A paid `mm xorv run` on Monad | needs a signed-in Agent Wallet with test USDC | Live: TBD |
| Companion agent skill | `packages/mm-plugin/skills/xorv-metamask/SKILL.md` | Code |
| Published to npm | `pnpm --filter @xorv/protocol publish` then `pnpm --filter @xorv/mm-plugin publish` | TBD |
| Demo | RECORDING.md 2:10–2:25 | Live: TBD |

### Monad Foundation: "Mera: One Passkey, Many Keys" ($2,500)

*(captured)* The "most creative non-wallet use of Mera's PRF-derived key material… for anything that
is NOT signing blockchain transactions from a wallet account." Judged on novelty, correct use of the
primitives (salts genuinely namespaced, nothing sensitive persisted), and **a live cross-device test**:
a second device or fresh profile must reproduce the same keys and decrypt the same state.

| Requirement | Evidence | Status |
|---|---|---|
| Non-wallet use of PRF key material | E2E-encrypted AI job results (X25519 inbox), an encrypted job-history vault (AES-256-GCM), a self-certifying vault identity and write authorization (Ed25519 in a Mera signing session). None of it signs a transaction; Privy pays. | Code |
| At least one PRF namespace doing non-account work | Three: `xorv:inbox:v1`, `xorv:vault:v1`, `xorv:vault-auth:v1` (`packages/protocol/src/sealed.ts`, `vault.ts`) | Code |
| Salts genuinely namespaced | One PRF salt per namespace (`sha256(label)`), bound again in the HKDF salt and info; ceremonies pinned to one credential; known-answer vectors and `node:crypto` cross-checks (`packages/protocol/test/{sealed,vault}.test.ts`) | Code |
| Nothing sensitive persisted | Keys only in memory, zeroed on lock, 30-min auto-lock; a test scans the private-job code for storage APIs (`apps/app/test/private-keyring.test.ts`) | Code |
| Cross-device test | Real Mera against a fake *synced* authenticator reproduces keys, history and results on "device B" (`apps/app/test/private-keyring.test.ts`, `test/support/fake-authenticator.ts`) | Code |
| **Live** cross-device test | Second device or fresh profile, same synced passkey, on the deployed https app: RECORDING.md 2:25–2:55, and a standalone 75-second cut scripted in [docs/PRIVATE_JOBS.md §6](docs/PRIVATE_JOBS.md#6-cross-device-demo-script-for-the-video-about-75-s) | Live: TBD |

### Nansen AI: "Best use of Nansen" ($5,000)

*(captured)* "Build a product experience powered by Nansen data/API/MCP/CLI that goes beyond exposing
raw data." All tracks. Nansen's CEO also judges the main track.

| Requirement | Evidence | Status |
|---|---|---|
| Powered by Nansen's API | Four endpoints: `profiler/address/first-funder`, `related-wallets`, `transactions`, `smart-money/pnl-leaderboard` (`services/broker/src/trust/nansen.ts`) | Code |
| Beyond raw data: a decision the product acts on | **Wash-rating guard**: `POST /api/jobs/:id/rate` refuses with 403 `related_wallets` when buyer and provider are one party (same wallet, one funded the other, a shared non-exchange first funder, related wallets), before anything reaches ERC-8004; the check is stored on the job (`services/broker/src/trust/signal.ts` `relatedParties`, `service.ts` `checkRelated`, `app.ts`) | Code |
| Beyond raw data: one explained number per provider | A 0–100 trust score with written rules that never penalise missing data (`signal.ts` `TRUST_RULES`), on `/api/providers`, `/api/providers/:id`, `/api/leaderboard`; a tie-breaker in matching (`registry.ts` `TRUST_TIEBREAK_WEIGHT`) | Code |
| Visible in the product | Trust badge on every provider row, the full panel on `/providers/<id>` with "Xorv paid Nansen $0.03 over x402 on Monad" and Monadscan links, the network page's *Wallet intelligence* panel, the rating widget's refusal (`apps/app/components/{trust,provider-view,rate-job}.tsx`); Nansen on the landing page's Built-with and FAQ | Code |
| Agent-to-agent payments on Monad | The broker pays each call in USDC over x402 on Monad mainnet: only `eip155:143` registered, mainnet USDC hard-coded, local validation before paying, per-endpoint price table, per-call cap, daily budget with reservations, optional pinned payee (`nansen.ts`); tested against Nansen's real captured 402s (`services/broker/test/trust.test.ts`) | Code |
| Respects Nansen's redistribution rules | Smart-money data and related-wallet addresses stay internal; every surface says "Powered by Nansen"; short cache lifetimes (`publicTrustView`, [docs/NANSEN.md §5](docs/NANSEN.md#5-what-is-published-and-what-is-not)) | Code |
| Works without funds for judges and CI | `XORV_NANSEN_MODE=fixture`: deterministic recorded-shape data, no network, no payments, never claims a paid tx | Code |
| A paid call on Monad mainnet | `XORV_NANSEN_PAYER_KEY` with ~$2 of mainnet USDC, `XORV_NANSEN_MODE=live`, then `pnpm nansen:probe --mode live <address>` or register the demo provider | Live: TBD |
| Demo | RECORDING.md 1:45–2:00 (trust panel with its Monad payment links, then a refused wash rating) | Live: TBD |

### Alibaba Cloud: "Best Builds with Qwen 3.8 Max" (credits)

*(unverified: card text not found.)*

| What Qwen does | Evidence | Status |
|---|---|---|
| **Load-bearing core-loop role: the job router** for every "Auto" quote; constrained to live candidates under the ceiling; deterministic fallback | `services/broker/src/ai/router.ts`, integration tests "routes an Auto request with Qwen…" and "falls back to the price matcher…" | Code |
| Visible in the product | Quote card "Routed by Qwen 3.8 Max to …", the job page's *Network checks*, `/api/network` `aiRoles`; RECORDING.md 0:18–0:35 | Code |
| Provider backend: `qwen` adapter (`qwen3.8-max`, streamed reasoning, token cost) | `packages/cli/src/adapters/hosted.ts` | Code |
| Provider backend: `qwen-code` adapter (Qwen Code CLI with tools, on Qwen 3.8 Max) | `packages/cli/src/adapters/qwen-code.ts` | Code |
| Live calls with a Model Studio key | `DASHSCOPE_API_KEY` on the demo broker and provider | Live: TBD |

### Kimi: "Best Builds Powered by KIMI" (credits)

*(unverified: card text not found.)*

| What Kimi does | Evidence | Status |
|---|---|---|
| **Load-bearing core-loop role: the result verifier**, scoring every completed public job | `services/broker/src/ai/verifier.ts` | Code |
| Its score becomes **on-chain ERC-8004 reputation** (`xorv-verified`), with a hash-committed feedback file | `services/broker/src/ai/feedback.ts`, `GET /verifications/<jobId>.json` | Code |
| Visible in the product | The job page's *Verified* row with the "ERC-8004 feedback" link; the indexer's `XORV_VERIFIED` reputation; RECORDING.md 1:05–1:18 | Code |
| Provider backend: `kimi` adapter (`kimi-k3`) | `packages/cli/src/adapters/hosted.ts` | Code |
| Live calls with a Moonshot key | `MOONSHOT_API_KEY` on the demo broker | Live: TBD |

### Tencent Kepler Plan: "Build with Hunyuan" (credits)

*(unverified: card text not found.)*

| What Hunyuan does | Evidence | Status |
|---|---|---|
| **Load-bearing core-loop role: the safety screen** on every quote, before any provider sees the prompt; a block is a 422 | `services/broker/src/ai/screener.ts`, integration test "refuses to quote a prompt the Hunyuan screen blocks…" | Code |
| Explicit failure policy | `XORV_SCREENER_FAIL=open|closed` | Code |
| Visible in the product | Quote card "Screened by Hunyuan hy4: …", the job page's *Screened* row; RECORDING.md 0:18–0:35 (and the optional blocked-prompt cutaway) | Code |
| Provider backend: `hunyuan` adapter (`hy4-preview` via TokenHub) | `packages/cli/src/adapters/hosted.ts` | Code |
| Live calls with a TokenHub key (activate `hy4-preview` in the Model Gallery first) | `TOKENHUB_API_KEY` on the demo broker | Live: TBD |

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
- **Reputation that resists self-dealing, further.** The Nansen guard already refuses ratings
  between wallets it links; a provider could still rate itself from a wallet with no on-chain tie to
  it. The indexer already has every receipt's buyer, so the next step is weighting scores by distinct
  paying buyers and by each buyer's own Nansen trust.
- **A protocol fee without custody.** It would need a payment splitter contract as the `payTo`. The
  broker must never become the payee.
- **Publish 0.2.0** of `@xorv/protocol`, `@xorv/cli`, `@xorv/mcp` and `@xorv/mm-plugin` to npm.

---

## Before you submit

Deadline: **Oct 13 2026, 11:59 PM ET** (Oct 14 03:59 UTC). The version saved at the deadline is
the one judged.

**Deploy**
- [ ] Fund the operator EOA with MON (above the 10 MON reserve) and deploy the ledger:
      `XORV_BROKER_ADDRESS=<operator address> pnpm deploy:ledger`, then
      `pnpm --filter @xorv/contracts verify:testnet`. Commit `packages/contracts/deployments/monadTestnet.json`.
- [ ] Run the broker on a public https URL with `XORV_PUBLIC_URL` set to it (it goes into on-chain
      agent and feedback URIs), `XORV_LEDGER_ADDRESS`, `XORV_LEDGER_FROM_BLOCK`, and the three model
      keys. Check with `pnpm setup:monad` and `GET /api/network`.
- [ ] Register the demo provider's ERC-8004 identity (`xorv identity register`) and start it with the
      `qwen`, `kimi` or `hunyuan` adapter and one CLI adapter.
- [ ] **Deploy the Envio indexer between Oct 10 and Oct 13** (the free plan keeps a deployment for 30
      days; judging runs to Oct 27 and winners are announced Nov 3). Set `ENVIO_XORV_LEDGER_ADDRESS`,
      `ENVIO_XORV_LEDGER_START_BLOCK`, and `ENVIO_XORV_VERIFIER_ADDRESSES` if the verifier has its own
      key. Then set `XORV_INDEXER_URL` on the broker.
- [ ] Deploy `apps/app` and `apps/landing` on https with `NEXT_PUBLIC_XORV_BROKER_URL`,
      `NEXT_PUBLIC_XORV_NETWORK=eip155:10143` and `NEXT_PUBLIC_PRIVY_APP_ID`. Add the domain to the
      Privy app's allowed origins and to `XORV_CORS_ORIGINS`.
- [ ] Pay one job end to end in the deployed app, rate it, and let Kimi verify it. Copy the
      settlement, receipt, rating and feedback transaction hashes.
- [ ] Nansen: fund a **separate** Monad **mainnet** key with ~$2 USDC, set `XORV_NANSEN_MODE=live`
      and `XORV_NANSEN_PAYER_KEY` on the broker, register the demo provider, and check
      `GET /api/network` → `nansen.lastPaidTx`. Copy one paid tx. Stage the refused rating as in
      [docs/NANSEN.md §7](docs/NANSEN.md#7-seeing-it).
- [ ] Optional: publish `@xorv/protocol` and `@xorv/mm-plugin` to npm (`pnpm publish`, not
      `npm publish`) so judges can `mm plugins install @xorv/mm-plugin`.

**Fill placeholders**
- [ ] `grep -rn "TODO(deploy)" README.md SUBMISSION.md` and replace every TBD in README.md
      (header links, "What is proven", Deployments) and in this file.
- [ ] Update the XorvLedger row in `packages/contracts/README.md` ("not deployed yet").

**Record**
- [ ] The ~3-minute demo ([RECORDING.md](RECORDING.md)), showing the Monad integration and each
      sponsor, including the live cross-device Mera decrypt.
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
- [ ] Track 04. Every bounty above, with its conditional questions answered from the checklists in
      this file.
- [ ] Set the Metropolis community group in the team's portal profile if a member is eligible (for
      the Community Team Project prize).
