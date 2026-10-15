# Judge round 2: an independent judge

On 13 Oct 2026, 20:00 IST, a fresh agent judged Xorv. It had not seen the code or the team's chat. It was given only:
- the live app;
- the public repo;
- `docs/PORTAL-COPY.md`;
- the official rubric.

Its verdict follows verbatim. The fixes and the re-judge come after it.

---

## Round 1 verdict (verbatim)

# Xorv: judge's verdict (Monad Metropolis, Track 04)

The core flow works. With no login, I paid $0.02 into escrow on the phone layout. The payment was final in 994 ms, Kimi scored the answer 92/100, and the escrow released it at +12 s. The ledger receipt and the reputation write followed, and I checked all four transactions over JSON-RPC (all succeeded). The weak spots are sponsor claims that the live system does not back up.

## Scores

**Main track**

| Criterion | Score | Reason |
|---|---|---|
| Product quality | 7 | Clean, fast flow from quote to paid result. Phone home page scrolls sideways, and some live panels fail when the public RPC rate-limits. |
| Technical excellence | 8 | Escrow, ledger receipt, reputation write and in-house payment server all work live. CI shows 8 checks passing. |
| Monad integration | 8 | Uses Monad's fast-receipt call and live block-stage stream, reads validators on chain, and shows a real speed receipt per job. |
| Track fit | 7 | Uses ERC-8004 identity and reputation (agent #2252 is owned by the payout wallet). But releasing money is decided by one server-held account, not by a trustless rule. |
| Innovation | 6 | Escrow plus an AI verifier plus x402 is a solid combination, not a new idea. |
| **Weighted total** | **7.2 / 10** | |

**Bounties marked "Submit"**

| Bounty | Requirement /40 | Technical /30 | Monad /20 | Innovation /10 | Total | Reason |
|---|---|---|---|---|---|---|
| Privy | 24 | 21 | 15 | 6 | **66** | The transactions exist, but nothing public proves the payer was a Privy server wallet or that the $0.05 policy exists. |
| Chainlink CRE | 26 | 23 | 15 | 7 | **71** | One refund ran through a CRE simulation and a mock forwarder. There is no deployed workflow, yet the app says it runs on Chainlink's network. |
| Kimi | 34 | 24 | 16 | 7 | **81** | Verified live on my own job: Kimi's 92/100 was written on chain, then the escrow released. |
| Nansen | 10 | 16 | 6 | 5 | **37** | Turned off on the live system: no wallets scored, no wash-rating guard, no Nansen panel on the provider page. |

## Claims I could not verify

- **"All Sourcify-verified":** sourcify.dev returns `match: null` for all three contracts. They are verified only on BlockVision's Sourcify mirror (sourcify-api-monad.blockvision.org): exact match for all three, though the escrow and keeper have no creation-code match. The portal copy should name that mirror.
- **"Chainlink CRE refunded an expired job, with no human involved"** (tx `0xa85c2f…`): the transaction is real. But the README admits it came from a manual `cre workflow simulate --broadcast`, sent through Chainlink's *Mock* KeystoneForwarder `0xB9F7…D192`. Someone ran a command, so "no human involved" is false. The job page also says "The workflow runs every 30 seconds on Chainlink's DON", and nothing shows it is deployed.
- **"Escrow releases only on Kimi's pass":** this is the server's rule, not the contract's. `attester()` on XorvEscrow is the payment server's own wallet `0xf4c4…2F79`.
- **Privy server wallet and policy:** the escrow payment `0x9d3ab6…` was authorised by `0x6613…40fb`. Nothing on chain ties that address to Privy or to a spending policy.
- **Nansen "run live with the API key on 13 Oct":** the live API (`/api/network`) shows `nansen.mode: "off"`, `walletsScored: 0`, `ratingGuard: false`. The provider page shows no "Powered by Nansen".
- **README: "Hunyuan screens every prompt, Qwen picks the provider for Auto":** both are reported `enabled: false` ("no API key"). The "Auto" picker is effectively decorative.
- **README intro: "USDC moves straight from buyer to provider… the broker never holds the money":** this contradicts the escrow path that the app actually uses.
- **"About 1,400 tests":** CI passes, but I could not count the tests.
- **Envio** is not deployed anywhere (`indexer: null` in the live API). The CRE refund depended on a local copy of the indexer.

## Broken or confusing

- **Home, phone 390px:** the page is 427px wide, so it scrolls sideways. "Browse all jobs" and the prices in the job list are cut off.
- **Home hero:** the large ✕ logo in a circle reads as a "close" or error button.
- **Quote card, phone:** "agent…" and "XorvEscrow … holds i…" are truncated. "Pay from demo account" sits below the fold under a big "Log in to pay" button, so the no-login path is easy to miss.
- **Network, phone:** the public RPC answered with 429 errors, both over HTTP and on the live connection. The key Monad panel then showed "unavailable" with dashes. This may be partly my test traffic, but connecting from the browser straight to the public RPC is fragile.
- **Providers:** "★★★★★ 92/100 from 0 ratings": five stars from zero ratings.
- **Jobs filter:** a leftover "smoke-echo" test provider is listed. The Agents page shows only "demo-agent" and "live-smoke-agent" sessions.
- **Job page after reload:** "Only the browser that paid… can rate". A judge who reopens the job cannot try the rating feature.
- **Running job page:** words like "Released on delivery" appear before anything has been released.

## Dense or ugly screens

- **Job detail, phone:** about 6 screens of scrolling (2,057px for a provider page, more for a job). The CRE explainer, execution log and speed receipt are all expanded. This is good evidence but too much for a first visit.
- **Network, desktop:** the block chips use tiny monospace text in low-contrast green.
- **Quote card fine print, desktop:** 11–12px grey text on black.

## The reason I'd vote no

The trust story is weaker than the pitch. Releasing money is decided by one wallet the payment server holds. The "no human involved" CRE refund was a manual simulation through a mock forwarder. Two of the four bounty integrations (Nansen, Qwen/Hunyuan) are off on the live system. For a "Trust & Identity" track, the trust guarantees are mostly off-chain and mostly asserted.

## What would most raise the score

1. Deploy the CRE workflow, or at least relabel it everywhere, including the job-page "runs every 30 s on Chainlink's DON" text, as a simulation through a mock forwarder.
2. Turn Nansen on live (score the one provider wallet, show "Powered by Nansen" on the provider page), or drop the Nansen bounty.
3. Make the verifier's role checkable on chain: Kimi's verdict signature, or a validation-registry entry checked by the escrow, rather than a payment-server wallet deciding.
4. Fix the 37px phone overflow and move "Pay from demo account" up to be the primary button. Use your own RPC endpoint so the Network page doesn't hit rate limits.
5. Fix the inaccurate wording: say "Verified on Monad Sourcify (BlockVision)", remove the "buyer to provider directly" line and the Hunyuan/Qwen claims, and fix "5 stars from 0 ratings".

The judge's one paid job: `job_4bqsF7v5GZI-`, payment `0x7cd2a01897f99f395449da7a5b14d5e26f5625d4dd6dd60290ee37168b7fb90f`.

---

## Fixes after round 1 (13 Oct, 20:10–20:30 IST)

**Claims:**
- Sourcify wording: the contracts are verified on Monad's instance, run by BlockVision.
- CRE: labelled as a simulation through the MockKeystoneForwarder, both in the app and in the portal copy.
- The release rule is the broker attester's.
- README: escrow is the default path; Hunyuan and Qwen act only with keys.
- Nansen is conditional on the recording.
- Privy policy evidence: `docs/evidence/`.

**UI:**
- 427 px home overflow fixed.
- "Pay from demo account (no login)" is the primary button.
- Quote card wraps.
- "5 stars from 0 ratings" fixed.
- "To be released on delivery".
- Hero mark in brand colors.
- Larger chips and fine print.
- A finished job's log starts folded.
- The browser falls back across public RPCs.

**Trust:** release now waits for the verdict's on-chain ERC-8004 feedback transaction (`b1888e4`).

## Round 2 verdict (verbatim, fresh judge, no payment)

**Weighted total: 6.6 / 10.**

| Criterion | Score | Reason |
|---|---|---|
| Product quality | 7 | Clean, fast UI that you understand in 30 seconds. Getting a quote takes one keystroke and the quote card is clear. Job pages are excellent. No overflow at 1440 or 390. |
| Technical excellence | 6 | A real escrow, an x402 facilitator, three contracts fully verified on Sourcify, CI green. But the escrow's verifier gate, which the whole pitch rests on, doesn't hold in the team's own data. |
| Monad integration | 8 | `eth_sendRawTransactionSync` speed receipts, `monadNewHeads` pipeline, validator set from the staking precompile, reserve-aware gas payers, measured finality around 1 s. Genuinely Monad-specific. |
| Track fit | 6 | ERC-8004 identity and reputation plus escrow fits "trust infra". But on-chain verdicts exist for only 4 of 12 jobs, and the Network page shows 0 receipts and 0 ratings published. |
| Innovation | 6 | Per-job AI marketplace with a verifier-gated escrow is a good combination, though each piece (x402, 8004, escrow) is known. |

| Bounty | Total | Reason |
|---|---|---|
| Privy | 77 | Fund tx and rating are real; that the payer is a policy-bound Privy *server* wallet is asserted only in docs. |
| CRE | 73 | 0xa85c2f does refund through the keeper and forwarder; it is a `simulate --broadcast` with a mock forwarder, not a DON deploy. |
| Kimi | 62 | Kimi verdicts are real, but "release only on Kimi's pass" is false on their own records. |
| Nansen (with recording) | 52 | Off live; makes sense only if judges watch the recording. |
| Envio (if deployed) | 48 | `indexer: null`; don't submit until deployed. |
| CVI (fork evidence) | 50 | Fork-only; the live escrow has no identity gate. |

**Claims it could not verify:**
- The flagship "verdict tx, then release tx": release 0x8ab899 is in block 70661072, and its feedback 0x7a0677 is in 70661073.
- Verdict-before-release holds for only the 2 newest of 12 jobs.
- `job_5lI4IqeDWek9` scored 25/100 (pass: false) and was released.
- The README said verification "never blocks the job".
- The Privy ids can't be checked on chain.

**Broken or confusing:**
- A 429 from the public RPC on the phone.
- The Network counters read "0 receipts / 0 ratings" beside 12 completed jobs.
- Screener, router and wallet intelligence show "off".
- The quote card's "You sign once" sits under the demo button.
- Repetitive recent jobs.
- The README cites the old ledger on monadscan.

**Dense:**
- Network page at 390 px is 4,145 px tall, with truncated hashes.
- The speed-receipt row truncates.

**The reason it would vote no:** "the central trust promise … is falsified by the team's own public data … For a Trust-track entry, that's disqualifying-level overclaim."

**What would most raise the score:**
1. Enforce verdict-before-release and cite a correct pair.
2. Show a fail → refund transaction.
3. Make the Network counters cumulative.
4. Cut or switch on the "off" features.
5. Unify the README with the portal.

## Fixes after round 2 (20:35–20:50 IST)

1. **The gate's history.** The portal, README and SUBMISSION now cite `job_qYHL9A_f9aGZ`: ERC-8004 feedback `0x09cee4…`, then release `0x158573…`, in block 70663304, feedback first. They state when each gate applied:
   - none before 16:15 IST 13 Oct, which explains `job_5lI4IqeDWek9`;
   - the verdict from 16:15;
   - the on-chain verdict from 20:25 (`b1888e4`).

   The README's Kimi section and its proven table are corrected.
2. **Counters.** They are labelled "written since the broker's last restart". An empty ratings feed explains the recent-block RPC window.
3. **Wrapping.** `Row` values wrap instead of truncating, which fixes the speed receipt and the settlement table.
4. **Quote fine print.** It names "the payer" on the demo path.

**Not fixable without the user, MON or keys:**
- A live fail → refund transaction: about 0.15 MON. It is added to the recording runbook as a shot.
- A CRE DON deploy (needs CRE deploy access).
- Envio Cloud.
- Nansen live (shared credits; recording only).
- The Qwen and Hunyuan keys.

## Round 3 verdict (fresh judge, no payment, 20:50 IST): **7.4 / 10**

| Criterion | Round 1 | Round 2 | Round 3 |
|---|---:|---:|---:|
| Product quality | 7 | 7 | 7 |
| Technical excellence | 8 | 6 | 8 |
| Monad integration | 8 | 8 | 8 |
| Track fit | 7 | 6 | 8 |
| Innovation | 6 | 6 | 6 |
| **Weighted** | **7.2** | **6.6** | **7.4** |

**Bounties in round 3:** Privy 78, CRE 67, Kimi 67, Nansen (conditional) 55, Cleanverse (fork evidence) 50, Envio: don't enter until deployed.

**Its strongest objection:** the final rule (release only after the on-chain verdict, from 20:25) has no live job yet. The Kimi row still cited the pre-gate pair. Every buyer and provider is the team's own.

**Fixed after round 3:**
- The Kimi row cites the `job_qYHL9A_f9aGZ` pair (feedback, then release, tx index 1 then 2), and says on-chain feedback started with the provider's identity.
- The README's bounty list matches the portal's submit, conditional and held decisions.
- The CRE row names the simulator's broadcasting key and the MockKeystoneForwarder. XorvRefundKeeper's `onReport` reverts for any other sender.
- The job page no longer claims a release followed the on-chain verdict; it states the verdict's feedback tx.

**Needs MON or the user:**
- **Post-gate live jobs.** 3–5 jobs, including a fail → refund, would show the final rule live. That is about 0.15 MON each from the facilitator and operator, plus 0.02 USDC per job. It is held under the no-testnet-spend rule; the runbook's shot 9b does it at recording time.
- **Outside buyers and providers.** An independent buyer and provider.
- **A CRE DON deploy.**
- **Envio Cloud.**
- **Nansen** on during judging.
