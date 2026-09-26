# Nansen in Xorv: wallet trust, bought per call over x402

Xorv's reputation is only worth something if a provider can't manufacture it. A rating has to be
signed by the wallet that paid for the job, but nothing stops a provider from paying for its own jobs
from a second wallet and rating itself five stars. Telling those two wallets apart takes on-chain
intelligence the broker doesn't have: who funded each wallet, what it is linked to, how long it has
existed. Nansen has that data, and it sells it per call over x402. So the broker buys it the way any
agent buys from any other agent on Xorv: a cent of USDC per call, settled on Monad.

This page covers what the broker does with the data, how it pays, what it may and may not publish,
and how to demo it. The code is in [`services/broker/src/trust/`](../services/broker/src/trust).

---

## 1. Where it is load-bearing

| | What happens | Code |
|---|---|---|
| **Provider trust** | When a node registers, the broker looks up its payout wallet in the background (never on the registration's critical path) and keeps a 0–100 trust signal. The sweep refreshes it every 6 hours. The public view is on `/api/providers`, `/api/providers/:id` and `/api/leaderboard`, and in the app on every provider row and the provider page. | `service.ts` `watch`, `app.ts` register route and sweep |
| **Wash-rating guard** | Before relaying a buyer's rating into ERC-8004, the broker checks whether buyer and provider are the same party. If they are, it refuses with **403 `related_wallets`**, relays nothing, and records the check on the job. | `service.ts` `checkRelated`, `signal.ts` `relatedParties`, `app.ts` `POST /api/jobs/:id/rate` |
| **Matching** | Between equally priced providers, the matcher's reliability rank is nudged by wallet trust, by at most ±0.1 on the 0–1 success scale. | `registry.ts` `rankScore`, `TRUST_TIEBREAK_WEIGHT` |
| **Accounting** | `/api/network` reports today's calls, spend, budget, the last paid transaction and the guard's counts. The app's network page shows them. | `service.ts` `status` |

The bounty asks for "a product experience powered by Nansen data … that goes beyond exposing raw
data". Nansen's answers here are not displayed as rows: they turn into a decision the broker acts
on (refuse this rating, rank this node first) and one explained number per provider.

## 2. How the broker pays Nansen

```
broker (NansenClient)                                   api.nansen.ai                Monad mainnet
  │ validate the body locally ──────────── (a bad body would be charged: Nansen 402s before it validates)
  │ POST /api/v1/profiler/address/first-funder ──────────►
  │ ◄──────────── 402 PAYMENT-REQUIRED, 8 accepts rows (Base, X Layer, 4×BNB, Monad, Solana)
  │ x402 client: only exact on eip155:143 is registered → the Monad USDC row
  │   policy: Circle USDC 0x7547…b603, optional pinned payTo
  │   spend controls: ≤ per-call cap
  │   onBeforePaymentCreation: price ≤ the table for this path, reserve against the daily budget
  │ sign EIP-3009 TransferWithAuthorization (value 10000 = $0.01, to Nansen's payTo)
  │ POST … PAYMENT-SIGNATURE ─────────────────────────────►  facilitator ──► transferWithAuthorization
  │ ◄──────────── 200 data + PAYMENT-RESPONSE {success, transaction}
  │ keep the settlement tx with the cached answer → https://monadscan.com/tx/…
```

**Mainnet, on purpose.** Nansen's 402s offer Monad **mainnet** (`eip155:143`) and no testnet row, and
its Monad data is mainnet data. So the Nansen payer is a separate mainnet key holding a few dollars
of USDC (`XORV_NANSEN_PAYER_KEY`), whatever network the rest of the broker runs on. The client
hard-codes the mainnet USDC contract instead of calling `networkConfig()`: `XORV_STABLECOIN`
overrides the asset for both networks, and a testnet test-token override must never reach a real
payment.

What stands between a 402 and a signature (`nansen.ts`):

| Guard | Why |
|---|---|
| Local request validation (`validateNansenRequest`): address shape, chain enum, page sizes, the one-year date window, the timeframe enum | Nansen answers 402 before it validates the body, so an invalid request would be paid for and then refused |
| Only `ExactEvmScheme` on `eip155:143` is registered | The other seven `accepts` rows can never be selected |
| Policy: `exact`, `eip155:143`, Circle USDC, and `payTo` when pinned (`XORV_NANSEN_PIN_PAYTO=observed`) | A swapped token or payee is refused |
| Spend controls at the per-call cap (default 50000 = $0.05) | Replaces `@x402/evm`'s $1 default for mainnet USDC |
| Per-endpoint price table (`NANSEN_PRICE_UNITS`) in `onBeforePaymentCreation` | A price rise aborts before anything is signed; an unknown path is never paid |
| The 402 must name the resource that was requested, on `api.nansen.ai` | A redirected or confused 402 is not paid |
| Daily budget with reservations (default $1.00, UTC day) | Reserved before signing, so two concurrent payments can't both squeeze under the last cent. Released when signing fails, when the facilitator refuses the payment or when settlement fails. A paid call that fails in some other way keeps its reservation, because Nansen does not document whether it charges for it |
| TTL cache, request de-duplication, at most 2 requests at once, a cool-down after 429 | Concurrent lookups for one wallet pay once; a 402 plus its paid retry is two requests against a 5/s, 60/min per-wallet limit |
| `NANSEN_API_KEY`, when set, takes precedence | Nansen bills credits instead and no payment happens; it is also the only way to reach the label endpoints, which cannot be paid for |

**Cost.** Three $0.01 calls per provider wallet (first funder, related wallets, transactions), two per
buyer when a rating is checked, and one $0.05 smart-money list per day. Cache lifetimes: first funder
7 days, related wallets 24 hours, transactions 1 hour, smart-money list 24 hours. A refresh after
6 hours usually re-buys only the transactions ($0.01). The default $1.00 daily budget covers a few
dozen new wallets a day.

## 3. The trust signal

| Input (Nansen endpoint) | What is read |
|---|---|
| `profiler/address/first-funder` (`chain: "all"`) | Who first sent the wallet gas, on which chain, when: the wallet's age and funding origin. Cross-chain, so a key that has only been used on Monad testnet still has a history if it was funded elsewhere |
| `profiler/address/related-wallets` (`chain: "monad"`) | Structural links on Monad: first funder, signers, deployer. Used for the sybil check, not published |
| `profiler/address/transactions` (`chain: "monad"`, last 90 days, one page) | Activity on Monad mainnet, the wallet's own label where Nansen stamps it, and risky counterparties |
| `smart-money/pnl-leaderboard` (`chains: ["monad"]`, daily) | Membership only, for an internal matching nudge (+5). Never shown |

The score, as rules (`signal.ts` `TRUST_RULES`):

| Rule | Points |
|---|---:|
| Start | 50 |
| Wallet age from first funding: > 1 year / > 90 days / > 30 days / < 7 days | +20 / +10 / +5 / −10 |
| First funded by a labelled exchange (someone passed an on-ramp) | +5 |
| Monad mainnet activity: ≥ 50 txs / ≥ 10 txs | +10 / +5 |
| Each risky label on the funder, a related wallet or a counterparty (mixer, exploit, drainer, sanctioned …) | −20, at most −40 |
| Clamped to 0–100 | |

**Missing data never costs a provider anything.** Most provider wallets have no Monad mainnet
history at all (Xorv runs on testnet), and a wallet credited straight from an exchange has no first
funder on record. There is no penalty for zero activity. A call that fails leaves the score where it
was and marks the signal `degraded`. When every call fails the score is exactly 50, the badge says
"No wallet history" rather than showing a number, and the matcher treats the provider as unknown.

## 4. The wash-rating guard

`relatedParties(buyer, provider)` says two wallets are one party when any of these hold:

1. They are the same address (no lookup needed).
2. One first-funded the other.
3. They share a first funder that is **not a service**. An exchange hot wallet, a bridge relayer or a
   faucet funds thousands of strangers, so sharing one proves nothing (`isServiceLabel`).
4. Nansen lists either as a related wallet of the other, or both list the same non-service wallet as
   their first funder on Monad.

The check runs in `POST /api/jobs/:id/rate` only **after** the payer's EIP-712 signature has
verified, so nobody but the buyer can make the broker spend on a lookup. It is bounded (12 s). A
lookup that fails or times out is recorded as `degraded` and **does not block** the rating: an
unproven link is never a refusal. A refusal looks like this:

```json
HTTP 403
{
  "error": "Rating refused: the buyer and provider wallets are related (Nansen) — both wallets were first funded by 0x5e1f…c0de. Ratings between wallets controlled by the same party would let a provider buy its own reputation, so Xorv only relays ratings from independent buyers.",
  "code": "related_wallets",
  "trustCheck": { "related": true, "reasons": [{ "kind": "shared-funder", "message": "…" }], "mode": "live", "degraded": false,
                  "attribution": "Powered by Nansen", "attributionUrl": "https://nansen.ai" }
}
```

The check (passed or refused) is stored on the job as `trustCheck`, so the app shows the refusal
after a reload and a relayed rating carries "Buyer and provider checked as independent wallets".
Prometheus counts refusals as `xorv_rating_refusals_total{reason="related_wallets"}`.

## 5. What is published, and what is not

Nansen's redistribution guide allows transactions, counterparties and related-wallets data with
attribution, and keeps labels, smart-money data and leaderboards for internal use. `publicTrustView`
is the single place that decides what leaves the broker:

| Field | Public? |
|---|---|
| score, band, first seen, wallet age, Monad tx count | Yes, with "Powered by Nansen" |
| first funder address, chain and Nansen's name for it (e.g. "Binance 14") | Yes |
| risk flags, display-safe labels (smart-money wording stripped) | Yes |
| how many related wallets there are | Yes |
| related wallet **addresses** | No, internal (sybil check only) |
| smart-money membership | No, internal (matching nudge only), never in any response |
| per-call errors | No |
| the x402 payments that bought the data | Yes, as Monadscan links |

Every surface that shows Nansen data (API responses, provider rows, the provider page, the network
panel, the rating refusal) carries the attribution. Cache lifetimes are kept short because Nansen's
API terms forbid keeping copies longer than its documentation allows.

## 6. Modes and configuration

| Variable | Default | Meaning |
|---|---|---|
| `XORV_NANSEN_MODE` | `off` | `off`; `fixture` = deterministic recorded-shape data, no network, no money (dev, CI, a demo without funds); `live` = real calls |
| `XORV_NANSEN_PAYER_KEY` | — | Monad **mainnet** key with a few USDC; pays over x402. Keep it separate from every other key |
| `NANSEN_API_KEY` | — | Takes precedence over x402 when set (credits instead of payments) |
| `XORV_NANSEN_PER_CALL_CAP` | `50000` | Largest single payment, USDC units ($0.05) |
| `XORV_NANSEN_DAILY_CAP` | `1000000` | Daily budget, USDC units ($1.00) |
| `XORV_NANSEN_PIN_PAYTO` | — | `observed` pins Nansen's payee `0x9305…F13f`; or an address |
| `XORV_NANSEN_SMART_MONEY` | `on` | Fetch the daily smart-money list for the internal matching nudge |
| `XORV_NANSEN_RATING_GUARD` | `on` | Refuse ratings between related wallets |
| `XORV_NANSEN_REFRESH_MINUTES` | `360` | Rebuild provider signals this often |
| `XORV_NANSEN_FIXTURE_CLUSTER` | — | Fixture mode only: comma-separated addresses given one shared, unlabelled first funder (a deliberate sybil ring for the demo) |

`live` without a payer key or an API key fails at boot with a message naming both.

## 7. Seeing it

```bash
# One lookup, printed for a human; a second address also runs the related-wallet check.
pnpm nansen:probe 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045                 # fixture data by default
pnpm nansen:probe --mode live 0x<provider payout> 0x<buyer>                   # pays ≤ $0.05 on Monad mainnet
pnpm nansen:probe --json --mode fixture 0x<address>                            # the public view as JSON

curl -s $BROKER/api/network | jq .nansen                 # mode, calls, spend, budget, last paid tx
curl -s $BROKER/api/providers | jq '.providers[].trust'  # the public view per provider
```

In the app: the trust badge on each provider row (home and providers pages), the full panel on
`/providers/<id>` (the page every provider's ERC-8004 agent file links to), the *Wallet
intelligence* panel on the network page, and the rating widget's refusal.

**Staging a live refusal for the video.** The guard needs a real link Nansen can see. The cheapest:
from the provider's payout address, send a little MON on **Monad mainnet** to a fresh wallet. That
wallet's first funder is now the provider, on the chain Nansen indexes, so related-wallets on `monad`
should list the provider as its "First Funder" (check with `pnpm nansen:probe --mode live` first;
Nansen's indexing lag is not documented). Use the same key as the testnet buyer, pay for one job,
and rate it: the rating is refused because Nansen links the two wallets. Without mainnet funds, run the broker
with `XORV_NANSEN_MODE=fixture` and `XORV_NANSEN_FIXTURE_CLUSTER=<buyer>,<provider payout>`, and say
on camera that the refusal shot uses fixture data.

## 8. Tests

`services/broker/test/trust.test.ts` needs no network and no money. The payment tests replay the
402s Nansen actually served on 2026-09-26 (`test/fixtures/nansen/`, byte-for-byte, all eight rows)
through a mock `fetch` and sign with a throwaway key, so the real x402 client, spend controls, policy
and hooks decide. They cover: only the Monad USDC row is paid, to the captured payee, at the
captured price; a missing Monad row, a different token, a price rise, a swapped payee and a 402 for
another resource are refused before signing; budget reserve and release; local validation; cache,
de-duplication, concurrency and the 429 cool-down; the scoring rules and neutral degradation; the
public view; the related-party matrix; fixture determinism; the matching tie-breaker; and the probe.
The "Nansen trust" block in `test/integration.test.ts` runs the real HTTP paths: signals on
`/api/providers`, `/api/providers/:id` and the leaderboard, `/api/network`, a related-wallet rating
refused with 403 and nothing relayed, an unrelated one relayed, and an outage blocking neither
registration nor rating. `apps/app/test/trust.test.ts` covers the app's readers and wording.

## 9. Known limits

- **Not yet run against live Nansen.** Every payment path is tested against Nansen's real 402s, but
  no call has been paid for yet: that needs a mainnet key with USDC. Paid latency and whether a paid
  call that then fails is charged are unverified.
- Which chains `first-funder` covers (Monad included) is not documented. Related wallets are read on
  Monad only.
- Signals and today's spend live in memory: a restart re-buys what it needs, and the daily budget
  starts again (bounded by the per-call cap and the payer's balance).
- The score is a heuristic over three calls, not a verdict. It is used to break ties and to decorate
  a provider, never to exclude one.
- The composite score is shown with attribution under the redistribution guide's "allowed with
  attribution" categories; written approval from Nansen for the composite is still to be asked for.
