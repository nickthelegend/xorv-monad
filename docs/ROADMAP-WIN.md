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
  - an anvil fork of Monad testnet (0.4 s blocks, `--prune-history 300`);
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
| 1 | `pnpm demo` | this commit | `f1-demo-*.png` |
| 2 | Escrow timeline | | |
| 3 | Monad speed receipt | | |
| 4 | Provider earnings dashboard | | |
| 5 | Job browse page | | |

## The next 5 (after this wave)

1. Deploy, once the user says go ([DEPLOY-LATER.md](DEPLOY-LATER.md)): the hosted app is worth more than any feature.
2. An in-app chain viewer for local and fork runs, so every ↗ link resolves.
3. A CRE refund replay: show a job refunded by the Chainlink keeper after its deadline, from the job page.
4. Agent buyer view: an MCP agent's session, its budget and every job it bought, on one page.
5. A Cleanverse "verified" badge on providers and buyers, read from the gate.
