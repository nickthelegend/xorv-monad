# @xorv/broker — AI roles and Nansen trust

Three sponsor models take a turn on every Xorv job, and Nansen's wallet data
guards the reputation they feed ([Nansen trust signals](#nansen-trust-signals),
below). They are part of the broker's core loop, not optional adapters a buyer
has to go looking for:

```
POST /api/quotes ─► Hunyuan screens the prompt ─► Qwen routes "Auto" ─► matcher ─► frozen quote
job completed    ─► Kimi scores the result ─► ERC-8004 giveFeedback from the verifier EOA
```

| Role | Model | Runs | What it decides | Where you see it |
|---|---|---|---|---|
| Screener | Tencent Hunyuan `hy4-preview` (TokenHub) | every quote, before a provider can see the prompt | `allow` / `block` + category + reason. A block is **HTTP 422** and no quote is issued | quote `screening`, job page "Screened by", `/api/network` |
| Router | Alibaba Qwen 3.8 Max `qwen3.8-max` (Model Studio, thinking off) | quotes with no adapter or `"auto"`, when at least two adapters are live under the ceiling | which adapter runs the job, why, and how hard it is | quote `routing` ("Routed by Qwen 3.8 Max: …"), composer's **Auto** option, job page |
| Verifier | Moonshot Kimi K3 `kimi-k3` (`reasoning_effort: "low"`) | every completed job that isn't private | score 0–100, pass, rationale, flags | job `verification`, the provider's ERC-8004 reputation, `/verifications/<jobId>.json` |

## How each role is kept honest

- **Screener** (`src/ai/screener.ts`) protects provider machines: credential or key
  exfiltration, malware, destructive commands, sandbox escape, prompt injection
  against the node. The quote freezes the screened request and the paid route only
  runs the quoted request, so a prompt can't be swapped after screening. If Hunyuan
  can't answer, `XORV_SCREENER_FAIL=open` (default) quotes anyway and the record
  says *"not screened: … allowed because XORV_SCREENER_FAIL=open"*; `closed`
  refuses to quote (503) until the screen is back.
- **Router** (`src/ai/router.ts`) sees the prompt and a compact table of the live
  candidates under the buyer's ceiling — adapter, model, price, success rate,
  mean buyer rating, mean Kimi score, ERC-8004 identity — and answers
  `{adapter, reason, difficulty}`. The pick must be one of those candidates; the
  price matcher still picks the node for it, so the router can never steer a job
  to a particular provider or above the ceiling. Timeout, provider error, bad JSON
  or an off-table pick → the deterministic matcher, recorded as
  `routing.fallback` with the reason ("… matched on price instead").
- **Verifier** (`src/ai/verifier.ts`) runs after the buyer already has the result
  and never blocks the job. Private jobs (`request.encryptTo`) are skipped — the
  broker only holds their ciphertext. Prompt and result are fenced as untrusted
  data; a result the model flags as `prompt_injection` never passes.

All three share `src/ai/client.ts`: one call over the protocol's `chatJson`
(OpenAI-compatible, JSON mode), a hard per-role deadline (screen 5 s, route 6 s,
verify 20 s) raced against the request, strict validation, per-role latency and
failure counters, and key hygiene — keys go only to each preset's base URL and are
scrubbed from any error text before it is logged or served.

## The verifier's on-chain feedback (ERC-8004)

When the provider holds a verified ERC-8004 agent (and did the work it was paid
for) and the broker has a verifier key, the score is written to the Reputation
Registry from the verifier EOA (`src/ai/feedback.ts`, called from `src/app.ts`):

```
giveFeedback(agentId, score, 0, "xorv-verified", <adapter>, <XORV_PUBLIC_URL>/api/quotes,
             <XORV_PUBLIC_URL>/verifications/<jobId>.json, keccak256(file))
```

- The file at `GET /verifications/<jobId>.json` is canonical JSON with the model,
  score, rationale, flags, the job's request and result hashes and the x402
  `proofOfPayment`; its keccak256 is the committed `feedbackHash`. It is rebuilt
  from facts frozen when the job was scored, so it keeps hashing to what went
  on-chain. Its hash is stored on the job before the transaction is sent.
- Buyer ratings go through XorvLedger under tag `starred`; verifier scores come
  from a different client address under `xorv-verified`, so the two signals stay
  separable in the registry.
- Gas: ~280k per first feedback (~0.03 MON), billed on the gas *limit* on Monad, so
  the write carries `estimateGas` + 15% and goes through the protocol's
  per-address signer lock — the same queue as the ledger writer and facilitator.
  The estimate doubles as a free preflight for a feedback the registry would refuse.
- `XORV_VERIFIER_KEY` defaults to `XORV_OPERATOR_KEY`. It **must never own or
  operate a provider's agent NFT** (the registry rejects self-feedback). If it is
  a separate key, add its address to the indexer's `ENVIO_XORV_VERIFIER_ADDRESSES`
  so Envio classifies its feedback as `XORV_VERIFIED` (it trusts only the ledger's
  broker EOA by default).
- Best-effort: a failed write is stored on the job as `verification.feedbackError`
  and counted in `/api/network`; the job itself is never touched.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `XORV_SCREENER` / `XORV_ROUTER` / `XORV_VERIFIER` | `auto` | `auto` = on exactly when the key is set; the provider name = on, warn at boot if the key is missing; `off` |
| `XORV_SCREENER_FAIL` | `open` | what a quote does when the screen can't answer |
| `XORV_VERIFIER_KEY` | operator key | signs the verifier's `giveFeedback`; unset and no operator key = scores stay off-chain |
| `TOKENHUB_API_KEY` / `XORV_HUNYUAN_API_KEY` | — | Hunyuan (screener) |
| `DASHSCOPE_API_KEY` / `XORV_QWEN_API_KEY` | — | Qwen (router); keys are region-bound, default endpoint is the international one |
| `MOONSHOT_API_KEY` / `XORV_KIMI_API_KEY` | — | Kimi (verifier) |
| `XORV_{HUNYUAN,QWEN,KIMI}_BASE_URL`, `_MODEL` | preset defaults | endpoint and model overrides |

A missing key never stops the broker: the role is off and says why.
`pnpm --filter @xorv/broker setup` and the boot banner list each role;
`GET /api/network` reports enabled roles under `ai` (the protocol's `AiRoleInfo`,
`null` when off) and every role's full state under `aiRoles` — enabled, provider,
model, the reason it's off, latency, the screen's fail mode, and where verifier
feedback goes. Prometheus: `xorv_ai_screen_total`, `xorv_ai_route_total`,
`xorv_ai_verify_total`, `xorv_ai_feedback_total`, `xorv_ai_latency_ms{role}`.

What the models see: Hunyuan and Qwen read the buyer's prompt (Qwen at most its
first 6,000 characters); Kimi reads the prompt and the result of non-private jobs.
Nothing else leaves the broker.

## Nansen trust signals

The broker buys wallet intelligence from Nansen, per call, in USDC over x402 on
Monad **mainnet** (`eip155:143`, the only Monad row Nansen's 402s offer), and uses
it in three places (`src/trust/`, full design in [docs/NANSEN.md](../../docs/NANSEN.md)):

```
POST /api/providers/register ─► trust.watch(payout wallet)   (background; never delays registration)
  first-funder (chain "all") + related-wallets (monad) + transactions (monad, 90 d) ─► 0-100 score
  ─► /api/providers, /api/providers/:id, /api/leaderboard  (public view, "Powered by Nansen")
  ─► Registry.candidates: price, then reliability ± 0.1 × trust  (TRUST_TIEBREAK_WEIGHT)
POST /api/jobs/:id/rate ─► payer signature verified ─► trust.checkRelated(buyer, provider)
  same wallet · one funded the other · shared non-exchange first funder · related wallets
  ─► related: 403 {code: "related_wallets", trustCheck}; nothing relayed; check stored on the job
  ─► otherwise (or lookup failed/timed out, 12 s): relay as before, check stored on the job
```

| File | What it holds |
|---|---|
| `src/trust/nansen.ts` | `NansenClient`: the x402 client (only `eip155:143` registered, mainnet USDC hard-coded, payTo pin, spend controls, per-endpoint price table in `onBeforePaymentCreation`, daily `SpendBudget` with reservations released on signing/verify/settle failure), local request validation, TTL cache, de-duplication, 2 concurrent requests, 429 cool-down, settlement tx capture, `apikey` precedence |
| `src/trust/signal.ts` | `buildTrustSignal` (the scoring rules, `TRUST_RULES`), `publicTrustView` (strips smart-money data, related-wallet addresses and errors; adds attribution), `relatedParties` (the wash-rating verdict), `matchScore` |
| `src/trust/service.ts` | `NansenTrust`: signals per wallet, background refresh (6 h; a degraded signal retries after 10 min), `checkRelated` with a timeout, `status()` for `/api/network` |
| `src/trust/fixtures.ts` | `fixture` mode: deterministic, recorded-shape answers per address, plus an optional sybil cluster |
| `src/scripts/nansen-probe.ts` | `pnpm nansen:probe <address> [<other>]`: one lookup (and the related check) printed for a human, with the Monad payment links in live mode |

Rules that hold it together:

- **Missing data never costs a provider anything.** Testnet-only wallets have no
  Monad mainnet history; zero activity is not a penalty, a failed call leaves the
  score where it was, and when every call fails the score is exactly 50 and the
  matcher treats the provider as unknown.
- **Nothing blocks on Nansen.** Registration never waits for a lookup; a rating
  check that fails or times out is recorded as `degraded` and the rating is
  relayed. Only a proven link refuses a rating.
- **Only the buyer can trigger a paid lookup at rating time**: the check runs
  after the payer's EIP-712 signature has verified.
- **Validate before paying.** Nansen returns its 402 before it validates the body,
  so every request is checked locally first and an invalid one is never sent.
- **Internal stays internal.** Smart-money membership (a +5 matching nudge) and
  related-wallet addresses never appear in a response; everything shown carries
  "Powered by Nansen".

`GET /api/network` → `nansen`: `mode`, `auth` (`x402` | `api-key` | `fixture` |
`none`), `payer`, `callsToday`, `paidCallsToday`, `spentTodayUsdc`, `budgetUsdc`,
`perCallCapUsdc`, `lastPaidTx` and `recentPaidTx` (monadscan.com links),
`lastError`, `walletsScored`, `ratingGuard`, `ratingChecks`, `ratingsRefused`.
Prometheus: `xorv_rating_refusals_total{reason="related_wallets"}`.

| Variable | Default | Meaning |
|---|---|---|
| `XORV_NANSEN_MODE` | `off` | `off`, `fixture` (no network, no money) or `live` |
| `XORV_NANSEN_PAYER_KEY` | — | Monad **mainnet** key with a few USDC; required for `live` unless `NANSEN_API_KEY` is set |
| `NANSEN_API_KEY` | — | takes precedence over x402 (credits, no payments) |
| `XORV_NANSEN_PER_CALL_CAP` / `XORV_NANSEN_DAILY_CAP` | `50000` / `1000000` | USDC units ($0.05 / $1.00) |
| `XORV_NANSEN_PIN_PAYTO` | — | `observed` or an address: refuse any other payee |
| `XORV_NANSEN_SMART_MONEY` | `on` | fetch the daily smart-money list for the internal nudge |
| `XORV_NANSEN_RATING_GUARD` | `on` | refuse ratings between related wallets |
| `XORV_NANSEN_REFRESH_MINUTES` | `360` | provider signal refresh |
| `XORV_NANSEN_FIXTURE_CLUSTER` | — | fixture mode: addresses given one shared first funder (demo sybil ring) |

## Tests

`test/ai.test.ts` (each role against a stubbed provider: happy path, malformed
JSON, timeouts — including a `fetch` that ignores its abort signal — HTTP errors,
off-table router picks, out-of-range scores, key redaction, the feedback file and
its hash, and a real viem broadcast of `giveFeedback` against a stub RPC checking
the `estimateGas` + 15% limit and the calldata) and the "AI roles" block in
`test/integration.test.ts` (the real quote and completion paths).
`test/trust.test.ts` replays the 402s Nansen actually served (`test/fixtures/nansen/`,
all eight `accepts` rows) through a mock `fetch` with a throwaway signer: only the
Monad USDC row is paid, price rises, other tokens, swapped payees and mismatched
resources are refused before signing, the budget reserves and releases; plus
validation, cache, concurrency, scoring, the public view, the related-party
matrix, fixtures, the matching tie-breaker and the probe. The "Nansen trust"
block in `test/integration.test.ts` runs the real HTTP paths, including a
related-wallet rating refused with 403. No network, no keys:
`pnpm --filter @xorv/broker test`.
