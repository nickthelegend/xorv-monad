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
