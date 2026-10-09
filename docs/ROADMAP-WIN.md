# Roadmap to win: a judge's-eye review

Written 7 Oct 2026 for the development wave. I used the product the way a judge with five minutes
and no context would, on a local fork of Monad testnet with real contracts and real paid jobs:
- the board;
- a quote paid from the demo account;
- the job page;
- the providers list and a provider's page;
- the network page.

The "before" screenshots are in [`screens/wave/`](screens/wave/) (`before-*.png`, desktop and 390px).

How Track 04 is judged:
- **Main track:** product quality, technical excellence, Monad integration, track fit and innovation,
  20% each.
- **Bounties:** meeting the stated requirement is 40% of each score.

## The 10 biggest weaknesses, ranked by what they cost with judges

| # | Weakness | What a judge sees | Costs |
|---|---|---|---|
| 1 | **Monad's advantage is said, never shown.** | The hero says "settled on Monad in about a second". Neither the quote card nor the job page shows how long settlement took, which block it landed in, the gas, or who paid that gas. The network page has no speed figure at all. | Monad integration, innovation |
| 2 | **The escrow, the core trust primitive, is invisible when the buyer pays.** | The quote card says "pays → 0x17C3… · the provider, never the broker" even though the money goes into XorvEscrow. The job page lists the escrow as plain table rows ("state: released to the provider"), with no sense of a lifecycle. | Track fit (trust), product quality |
| 3 | **A refunded job looks like a failure.** | A cancel shows a red **Failed** badge and an error box, although the buyer was refunded in full. The network page's "paid to providers" counts the refunded $0.0010 as paid ($0.0060 against $0.0050 actually earned). | Product quality, credibility |
| 4 | **Nothing is hosted, and the README's "verify in three commands" only runs tests.** | Without a deployment, a judge has no way to *use* the product. The local route needs a chain, contracts, a broker, a provider and the app wired by hand. | Every criterion: an unseen product scores low |
| 5 | **The provider side is a single number.** | A provider's page shows "earned $0.0050" and nothing else: no payouts, no history, no money waiting in escrow, no refunds. The supply side of a two-sided market isn't shown. | Product quality, track fit |
| 6 | **There's no way to browse the market.** | The board shows the last few jobs and nothing else. There is no list of every job, no filter by outcome or provider, and no search. | Product quality |
| 7 | **The reputation story can't be tried locally.** | Demo providers have no ERC-8004 identity, so the job page says "no on-chain reputation to rate", and the "only paying buyers can rate" loop never appears. | Track fit (ERC-8004), the demo |
| 8 | **Copy contradicts the escrow.** | The hero and the network page say the money goes "straight to the provider"; with the escrow, it waits first. | Credibility |
| 9 | **Explorer links are dead on a local fork.** | ↗ links go to testnet.monadscan.com, which has never seen a fork transaction. | Local demo only; fine once deployed |
| 10 | **No "wow" moment for the video.** | Payment is a button that says "Settling on Monad…" and then a page appears. Nothing shows the money arriving, waiting and being released inside a second. | Demo, memorability |

AI roles show "off" locally, and Nansen and Privy show "not configured". That is honest and needs keys,
so it's out of scope for this wave.

## Plan: the top 5 by impact × effort (no MON, no keys)

| Rank | Improvement | Fixes | Impact | Effort |
|---|---|---|---|---|
| 1 | **`pnpm demo`: the whole product in one command**, with demo providers holding ERC-8004 identities | 4, 7, and the wave's own need for real data | High | Low (reuses the e2e harness) |
| 2 | **Escrow timeline**: a live lifecycle on the job page, an escrow-aware quote card, and refunds shown as refunds | 2, 3, 8, 10 | High | Medium |
| 3 | **Monad speed receipt**: measured settlement and release times, block, gas and gas payer on every job; the median on the network page | 1, 10 | High | Medium |
| 4 | **Provider earnings dashboard**: earned, held in escrow, refunded, payouts with release txs, earnings by day | 5 | Medium-high | Medium |
| 5 | **Job marketplace browse page**: `/jobs` with outcome and provider filters and search, linked from the board | 6 | Medium | Low-medium |

Considered and not picked for this wave:
- **Live job progress on the board.** The job page already streams over SSE; the timeline (2) makes the
  payment stages live, which is the part that was missing.
- **An in-app chain viewer for the local fork** (9). It only matters locally, and testnet links work once deployed.

## Acceptance criteria

**1. `pnpm demo`**
- One command, after `pnpm build` and `forge build`, starts:
  - an anvil fork of Monad testnet (0.3 s blocks, `--prune-history 300`);
  - XorvLedger and XorvEscrow;
  - the broker (self-hosted facilitator as the escrow's attester);
  - two provider nodes;
  - the app with a funded demo account.
- It seeds real paid jobs: escrowed and released, plus one cancelled and refunded.
- Demo providers are registered in the canonical ERC-8004 Identity Registry, so a judge can rate a
  job and see it land as ERC-8004 feedback.
- Keys are generated per run and exist only on the fork; Ctrl-C stops every process it started.
- The README leads its judge section with it.

**2. Escrow timeline**
- The job page shows a vertical timeline. Each step has its time and a link to its transaction:
  - quoted;
  - funded (buyer → XorvEscrow);
  - running;
  - delivered;
  - released (escrow → provider, with the result hash), or refunded (escrow → buyer, with the reason).
- It updates live while the job runs.
- The quote card says the money waits in XorvEscrow and is refunded if the job fails, and shows the
  refund deadline.
- A cancelled or failed job whose escrow refunded shows **Refunded**, not Failed.
- The network page's "paid to providers" excludes refunded money.
- Tested: unit tests for the timeline's derivation; app and broker suites green; the e2e still green.

**3. Monad speed receipt**
- The broker measures each settlement, from submission to the confirmed receipt, in ms. It reads
  the receipt's block, gas used and effective gas price, and records who paid that gas. It does the
  same for the escrow release.
- The job page shows:
  - "final on Monad in N ms";
  - the block number;
  - gas paid by the facilitator, in MON;
  - "you paid 0 MON";
  - the release time;
  - a one-line comparison with Ethereum's 12 s slot, labelled as a protocol constant.
- The network page shows the median settlement time over recent jobs.
- Measured on whatever chain the broker talks to; nothing is hard-coded.
- Tested: broker tests for the timing record, plus app tests for the formatting.

**4. Provider earnings dashboard**
- A provider's page shows:
  - total earned (released only);
  - held in escrow now;
  - refunded;
  - earnings by day, as a bar chart;
  - a payouts table: job, time, amount, release tx, outcome.
- Every number comes from the broker's job records, which hold the on-chain tx hashes.
- Empty and loading states; 390px layout.
- Tested: unit tests for the aggregation.

**5. Job marketplace browse page**
- `/jobs` lists every job, newest first.
- Filters: outcome (all, completed, refunded, running, failed) and provider; search over title and prompt.
- Each row shows the price, provider, outcome and age.
- A "Browse all jobs" link from the board, and a Jobs link in the navigation.
- Private jobs stay redacted.
- Tested: unit tests for filtering.

## Status

| Rank | Feature | Commit | Screens |
|---|---|---|---|
| 1 | `pnpm demo` | 3ea6e93 | `f1-demo-*.png` |
| 2 | Escrow timeline | 94abd85 | `f2-escrow-*.png` |
| 3 | Monad speed receipt | db47247 | `f3-speed-*.png` |
| 4 | Provider earnings dashboard | 7679a53 | `f4-earnings-*.png` |
| 5 | Job browse page | this commit | `f5-browse-*.png` |

## The next 5 (after this wave)

1. Deploy, once the user says go ([DEPLOY-LATER.md](DEPLOY-LATER.md)): the hosted app is worth more than any feature.
2. An in-app chain viewer for local and fork runs, so every ↗ link resolves.
3. A CRE refund replay: show a job refunded by the Chainlink keeper after its deadline, from the job page.
4. Agent buyer view: an MCP agent's session, its budget and every job it bought, on one page.
5. A Cleanverse "verified" badge on providers and buyers, read from the gate.

## Monad-native coverage

The user asked for all eight Monad-native items (`../../METROPOLIS-ORCHESTRATION.md`, "MONAD TECH";
research in `MONAD-TECH.md`). One line per item. Each item says where it runs: **live-read** (real
Monad testnet, read-only), **fork** (the local anvil fork), **built** (code and tests, runs wherever
the deployment runs), or **awaiting testnet go** (needs MON).

| # | Item | Status | Where in the code | Screens |
|---|---|---|---|---|
| 1 | Live commit-state strip (`monadNewHeads`, `monadLogs`) | **live-read**: every Monad testnet block goes Proposed → Voted → Finalized → Verified with measured ms, and XorvLedger and ERC-8004 events stream with their commit state. Works while payments run on a fork, and is labelled as the real network | `apps/app/lib/{commit-states,use-monad-live}.ts`, `components/monad-live.tsx` | `m1-commit-*.png` |
| 2 | Two-timer receipts (executed, final) | **built; fork-timed now, Monad-timed at testnet go**. Escrow writes (fund, release, refund, cancel) go out with `eth_sendRawTransactionSync`: the receipt comes back in the send itself, with a plain send if the node lacks the method. The broker times executed (submit → receipt) and final (submit → the `finalized` head holds the block, hash checked). On a local chain finality is n/a and every figure is labelled "local fork, not Monad's timing" | `packages/protocol/src/sync-send.ts`, `services/broker/src/app.ts` (`chainTiming`), `apps/app/components/speed-receipt.tsx` | `m2-timers-*.png` |
| 3 | Transaction status (`txpool_statusByHash`) | **built + live-read**. `readTxStatus` asks Monad's txpool about a transaction not yet in a block (pending / dropped / unknown), and places a mined one in consensus from the `latest` / `safe` / `finalized` heads (Proposed / Voted / Finalized). The broker serves it at `GET /api/tx/:hash`, cached per hash, and every transaction in a job's timeline carries a live badge that polls until final. Checked read-only against Monad testnet: Xorv's live settlement `0x5792…02d7` reads `finalized`. On a fork it reads "mined · local fork" | `packages/protocol/src/tx-status.ts`, `services/broker/src/app.ts` (`/api/tx/:hash`), `apps/app/components/tx-badge.tsx` | `m3-txstatus-*.png` |
| 4 | Passkeys on chain (P256 `0x0100`) | **built + live-read, wired into the app (wave 2)**. `verifyPasskeyAssertion` checks a WebAuthn assertion on P256VERIFY; tested on anvil's precompile and on testnet's. The app runs Mera's ceremonies through its own WebAuthn client, which keeps the passkey's public key (from creation, or recovered from two unlock signatures) and each unlock's assertion, in tab memory only. *Verify my last unlock on Monad* asks testnet's `0x0100` with a read-only eth_call. Checked in Chrome with a PRF virtual authenticator: verified at testnet block #69,069,105 | `packages/protocol/src/p256.ts`, `apps/app/lib/private/passkey-onchain.ts`, `components/passkey-onchain.tsx` | `wave2/w2-passkey-*.png` |
| 5 | Native staking (`0x1000`) | **live-read**. The Network page reads Monad's staking precompile on the real network every 30 s: epoch and delay period, the validator proposing now (auth address, stake, commission), and the consensus set size (paginated). Checked against testnet: epoch 1381, proposer #172 with about 11M MON at 10%, 199 validators. ABI from Monad's `@monad-crypto/viem`. Delegate/undelegate: **not applicable**. Xorv holds no MON to stake (buyers pay USDC, and the gas payers keep a working balance) | `packages/protocol/src/staking.ts`, `apps/app/components/staking-panel.tsx` | `m5-m6-network-*.png` |
| 6 | Monad gas correctness (limit billing, reserve balance, 128 KB, MIP-8) | **built**. Explicit limits (estimate × 1.15; a reverting estimate is never sent). The broker checks its gas payers (facilitator/attester, operator) against the 10 MON reserve, logs when one drops below, and shows it on the Network page; `keepsReserve` encodes the rule. The escrow guard moved to transient storage (EIP-1153), so no global slot is written per call; each job is one struct under one key (one MIP-8 page). Contracts are 1–10 KB, far under 128 KB. `0x1001` is not applicable (the contracts move USDC, never MON). Documented in `docs/MONAD-GAS.md` | `packages/protocol/src/reserve.ts`, `services/broker/src/app.ts` (`refreshGasPayers`), `contracts/src/XorvEscrow.sol`, `docs/MONAD-GAS.md` | `m5-m6-network-*.png` (gas payer rows) |
| 7 | Monad-native payments (x402 facilitator, MPP) | **built + live on testnet since 28 Sep**. With no facilitator key, the broker settles `exact` payments through Monad's own hosted x402 facilitator (`x402-facilitator.molandak.org`, the default); a live testnet job settled through it (`0x5792…02d7`, gas paid by the facilitator). Its `/supported` lists `exact`, `upto` and `batch-settlement` on 10143 and 143 (checked 7 Oct). Escrowed jobs use Xorv's own `escrow` x402 scheme on a self-hosted facilitator, because the escrow's attester must sign them. MPP (`@monad-crypto/mpp`): **not applicable for now**. All of Xorv's buyers (web, CLI, MCP, MetaMask) speak x402, and a second payment protocol would split the quote-binding checks that protect buyers | `packages/protocol/src/{x402,chains}.ts`, `services/broker/src/facilitator.ts` | — |
| 8 | Canonical contracts, Sourcify, linked hashes | **built + live**. Every hash and address links to MonadVision (Sourcify-verified XorvLedger shows its source there). On a local fork, links to fork state render as plain text instead of dead links, while the live pipeline still links real testnet blocks. Multicall3 (`0xcA11…CA11`, viem's stale pre-reset creation block dropped) batches the escrow verify's 4 reads and the gate's identity reads into one `eth_call`. Canonical ERC-8004 registries, Circle USDC and Monad's x402 facilitator were already in use | `packages/protocol/src/{chains,evm,escrow}.ts`, `apps/app/lib/network.ts` (`explorerHref`), `components/ui.tsx` | `m3-txstatus-*.png` (fork hashes as plain text; checked: 0 dead links, 12 plain hashes on a job page) |

## Wave 2 (8 Oct): the next 5

The previous wave's "next 5", minus #1 (deploy, which waits for the testnet go), plus one next-best
item that needs no keys or MON. Before running it, `pnpm e2e:escrow` was re-run after the sync-send
and transient-guard changes: 31/31.

| # | Feature | Status | Commit | Screens |
|---|---|---|---|---|
| 1 | ~~Deploy~~ | skipped: needs the testnet go and MON | | |
| 2 | Passkeys verified on Monad's P256 precompile, from the app | done | 42695b7 | `wave2/w2-passkey-*.png` |
| 3 | In-app viewer for fork transactions | done: `/chain`, `/chain/tx/:hash`, `/chain/address/:address`, `/chain/block/:n` read the app's own RPC and decode USDC, XorvEscrow, XorvLedger and ERC-8004 events with named addresses. On a fork every explorer link opens here instead of turning into text (11 viewer links, 0 dead ones on a job page). The fee row says what anvil charged and what Monad would charge (the limit) | 0621846 | `wave2/w2-chain-*.png` |
| 4 | CRE refund replay on the job page | done. `pnpm demo` deploys XorvRefundKeeper and runs a provider whose model stalls. Two minutes in (the escrow deadline), it replays the CRE workflow: isRefundable, then the report `abi.encode(bytes32[] jobIds)` delivered to `XorvRefundKeeper.onReport` by a local key standing in for the KeystoneForwarder. The broker now watches running escrowed jobs on chain, notices the refund, stops the job and names the keeper (`settledVia`). The job page shows the keeper's five steps with the real refund tx, and for a job still held, the keeper as the buyer's backstop with the deadline | fe15a51 | `wave2/w2-cre-*.png` |
| 5 | Agent-buyer session page | done. The MCP server tags its quotes with a per-process session (random id, `XORV_AGENT_NAME`, its session budget). The broker groups those jobs (`GET /api/agents`, `/api/agents/:session`). `/agents` shows each agent's spend, escrow held and refunds against its budget, who paid and what it bought; job pages link to their agent. `pnpm demo` runs a real MCP agent over stdio with a $0.003 budget: three jobs bought, the fourth refused by its own budget check before signing | this commit | `wave2/w2-agents-*.png` |
| + | Next-best: | | | |


## Codex continuation · 8 Oct: Cleanverse badges

The remaining next-five identity badge is built for provider detail pages and
buyers on job receipts. `GET /api/identity/:address` reads the configured gate
and its current A-Pass standing without submitting a transaction. The badge
links to the gate and distinguishes verified, no active pass, no configured
gate, checking, stale and unavailable. It describes identity **now**, not at
the historical payment. Failed or absent gate reads never create a verified
claim.

Validation: two broker HTTP integration regressions and two badge-state tests
pass; broker and app typechecks pass. Single-worker production app build passes. Production browser/live gate verification
is UNTESTED pending a configured real Cleanverse gate, registered validator pool
and A-Passes. Existing deployment/testnet holds remain in effect. No new chain
transaction or hosting action was performed.

## Wave 3 (9 Oct): build-out

| # | Item | Status |
|---|---|---|
| 1 | Settlement evidence: trust a facilitator's tx hash only once its receipt proves this authorization paid this job | parked in a git stash. The draft also requires durable payment persistence: without a durable store it answers 503, and 36 broker tests time out. It needs a design pass, not a patch |
| 2 | First visit to /private: the vault lookup answers 200 `{exists: false}` instead of a 404, so the console stays clean (older brokers' 404 is still handled) | done |
| 3 | Demo with the Cleanverse gate on and real A-Passes, so the badges show verified and unverified side by side | next |
