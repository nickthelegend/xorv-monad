# Changelog

All notable changes to this project.

## [0.2.0] — Monad port (Monad Metropolis, unreleased)

Xorv moves from Hedera to **Monad**. Commit `321b563` imports the 0.1.0 Hedera prototype unchanged,
and everything below was built after it, during Monad Metropolis (from 2026-09-26). The npm
packages are not published at 0.2.0 yet. The deployed addresses are listed in the README once they
exist.

### Payments: x402 on Monad

- x402 v2 **`exact` scheme on EVM**: the buyer signs an EIP-3009 `TransferWithAuthorization` over
  **Circle USDC** (EIP-712 domain `"USDC"`/`"2"` in the 402's `extra`), and the facilitator submits
  it and pays the MON gas. Buyers need USDC only.
- The paid route uses x402's **upfront** payment flow: the payment settles before the job is created
  or dispatched.
- The facilitator is **in-process** (a viem EOA, `XORV_FACILITATOR=self`), **Monad's hosted
  facilitator** (`hosted`), or any URL. The broker boots with no key at all and settles through the
  hosted facilitator. An explicit `self` without a key answers 503 and is never silently downgraded.
- **Quote-bound buyer client** (`buyerX402Client` + `quoteMatchPolicy`): every Xorv buyer refuses a
  402 whose payee, amount, asset or network differs from the frozen quote, and caps each payment.
- Payment rejections are logged at the point of decision, including `onAfterVerify` invalid results
  from a hosted facilitator.
- **Removed:** HBAR payments (x402 `exact` on EVM moves ERC-20s only), Mirror Node exchange rates,
  token association, the 180-second validity workaround, HashPack/WalletConnect.

### On-chain record: `XorvLedger` (new `packages/contracts`)

- `XorvLedger` replaces the three HCS topics. It handles provider registrations, sampled heartbeats,
  **batched job receipts** (`recordJobs`: one packed slot per job, everything else in events) and
  **payer-signed ratings** (`rateJob`, EIP-712: ECDSA against the buyer first, then ERC-1271, so
  EIP-7702 accounts and smart accounts both work), forwarded to the ERC-8004 Reputation Registry.
- The ledger refuses self-dealing itself (`SelfDealing`): a receipt whose buyer is its `payTo`, and a
  rating from the agent's current wallet, owner or an approved operator, on the direct and the
  relayed path alike.
- The owner is a constructor argument, named at deploy time (`XORV_LEDGER_OWNER`). The deploy script
  refuses, on Monad testnet and mainnet, an owner that is the broker or the operator key.
- Receipts bind the settlement tx to `keccak256(prompt)`, `keccak256(result)`, the duration, the
  outcome, the buyer, the payee and the agent.
- Tests on Hardhat 3 against the **vendored ERC-8004 v2.0.0 registries** (test-only), with gas
  reports, an ABI pinned to the spec, and `gas:monad`, which measures every call on live Monad with
  state overrides and deploys nothing.
- Deploy and verify scripts for Monad testnet and mainnet (Sourcify, plus Monadscan with a key). They
  refuse to overwrite a recorded deployment.
- The broker's writer sets every gas limit to `estimateGas` × 1.15 (Monad bills the limit), batches
  receipts (4 s or 20), samples heartbeats (1 in 20), splits a reverted batch to isolate bad
  receipts, and serializes broadcasts per signer.

### Identity and reputation: ERC-8004

- `xorv identity register | show`: one `register(agentURI)` transaction from the payout key, then a
  check that the registry's agent wallet is still the payout address.
- Nodes register by payout address plus an optional agent id. The broker verifies
  `getAgentWallet(agentId) == address`, and `XorvLedger` enforces `payTo == agentWallet` on every
  receipt.
- The broker serves ERC-8004 registration files (`/agents/<providerId>.json`; node ids never appear
  on-chain) and reproducible feedback files (`/feedback/<jobId>.json`, `/verifications/<jobId>.json`)
  whose keccak256 is the on-chain `feedbackHash`.
- **Gasless ratings**: `GET /api/jobs/:id/rating` → the buyer signs → `POST /api/jobs/:id/rate` → the
  broker relays `rateJob`. One per job, from the wallet that paid.

### Indexer: Envio HyperIndex (new `services/indexer`)

- Indexes XorvLedger and the ERC-8004 Identity and Reputation registries over HyperSync, with
  testnet and mainnet configs.
- 14 entity types, including derived provider earnings, success rate and rating; agent reputation
  split by writer (buyer ratings, Xorv-verified, other); network, daily, per-provider and per-buyer
  series.
- Exported GraphQL queries, and 52 tests on Envio's test indexer. It lives outside the pnpm workspace
  because Envio ships no Windows binary.
- The broker reads `/api/ledger`, `/api/receipts` and `/api/leaderboard` from the indexer first and
  falls back to a bounded RPC scan in 100-block windows or to in-memory stats.

### AI roles in the broker (new `services/broker/src/ai`)

- **Hunyuan hy4 screens** every quote before any provider sees the prompt. A block is a 422. The
  fail mode is set by `XORV_SCREENER_FAIL=open|closed`.
- **Qwen 3.8 Max is a tool-using routing agent.** For "Auto" quotes it runs a bounded loop (≤4
  turns, ≤6 reads, 15 s, thinking on) over `list_candidates`, `erc8004_reputation` (ERC-8004
  Reputation and Identity registries on Monad), `recent_receipts` (XorvLedger events),
  `indexer_provider_stats` (Envio aggregates) and `nansen_trust`, then `select_provider`. It
  chooses the provider, not only the adapter. The pick is checked against the live candidates and
  the ceiling, with one retry, then a deterministic fallback. Every call is recorded in
  `routing.steps` and rendered as an agent trace on the quote card and job page. The protocol LLM
  client gained a tool-calling chat turn for it.
- **The matcher ranks on indexed reputation.** When no router runs, price ties break on buyer
  ratings and Kimi scores from the Envio indexer (shrunk toward a neutral prior, refreshed at most
  once a minute), or on the broker's own jobs without an indexer.
- The screen's deadline is `XORV_SCREENER_TIMEOUT_MS` (default 8 s), and `XORV_SCREENER_REASONING`
  sets TokenHub's reasoning effort.
- **Kimi K3 verifies** completed public jobs and writes the score to ERC-8004 (`xorv-verified`) from
  the verifier EOA. It never blocks the job.
- Each role has a shared client, hard per-role deadlines, strict JSON validation, key redaction,
  metrics, and state reported on `/api/network`. A missing key turns a role off, never the broker.

### Wallet trust with Nansen (new `services/broker/src/trust`)

- The broker **pays Nansen per call** in USDC over x402 on Monad mainnet (`eip155:143`, the only
  Monad row Nansen offers): only that network registered, mainnet USDC hard-coded, local request
  validation before any paid call, a per-endpoint price table, a per-call cap, an optional pinned
  payee and a daily budget with reservations released on failure. The settlement tx is kept with
  each cached answer. `NANSEN_API_KEY` takes precedence when set.
- A **0–100 trust score** per provider payout wallet (first funder, related wallets, Monad activity)
  with written rules that never penalise missing data, on `/api/providers`, the new
  `/api/providers/:id` and `/api/leaderboard`, and a tie-breaker in matching.
- A **wash-rating guard**: a rating between related wallets (same wallet, one funded the other, a
  shared non-exchange first funder, related wallets) is refused with 403 `related_wallets` before it
  reaches ERC-8004, and the check is stored on the job.
- `/api/network` reports Nansen's mode, calls, spend, budget and the last paid tx;
  `pnpm nansen:probe` prints one lookup; `XORV_NANSEN_MODE=fixture` runs it all without network or
  money. The app shows the trust badge, a provider page with the full panel and its Monad payment
  links, the network page's *Wallet intelligence* panel, and the rating refusal.

### Provider CLI

- viem and `@x402/evm` replace the Hiero SDK. The payout **address** is stored and the key is
  optional: `init` can generate a key, import one, or take an address only.
- New adapters: `qwen`, `kimi`, `hunyuan` (in-process, OpenAI-compatible streaming with reasoning and
  token cost) and `qwen-code` (the Qwen Code CLI).
- `xorv run` pays over x402 on Monad, pinned to the frozen quote, and refuses to pay your own payout
  address.
- `doctor` checks the RPC, the chain id, balances and identity. `status`, `earnings` and `jobs` show
  explorer links and XorvLedger feeds.
- `/xorv` Claude Code skill rewritten for USDC on Monad.
- A Hedera-era config is recognised and upgraded, keeping the name, capabilities and prices.

### MCP server

- Buys from a **local key or a Privy server wallet bound to a signing policy**. `pnpm privy:setup`
  creates the wallet and a policy allowing only USDC `TransferWithAuthorization` on this chain up to
  a cap, plus XorvLedger ratings. It can also restrict payees and add a P-256 owner key.
- A per-job ceiling (`XORV_MAX_PRICE`), a session budget reserved before signing
  (`XORV_SESSION_BUDGET_USD`), and new `xorv_wallet` and `xorv_rate_job` tools.

### MetaMask Agent Wallet plugin (new `packages/mm-plugin`)

- `mm xorv providers | quote | run | job | rate`. Payment and rating signatures go only through
  `ctx.walletExecutor` under MetaMask policy. The quote is vetted and the signer recovered before
  sending.
- A manifest with per-command capabilities and `targetChains: [10143, 143]`, validated against
  MetaMask's own schema, plus a companion agent skill.

### Web app

- **Privy** login (email, Google, passkey, wallet). An embedded EVM wallet is created at login and
  pinned to Monad. It pays for jobs over x402 and signs gasless ratings, and its key can be exported.
  An injected wallet is the fallback when there is no Privy app id.
- A testnet-only demo payer with a per-job cap, for visitors with no wallet.
- The job page shows the settlement, the XorvLedger receipt, the AI checks (screened, routed,
  verified, with the ERC-8004 feedback link) and the rating widget.
- The network and providers pages are rebuilt on XorvLedger, ERC-8004 and the Envio leaderboard.

### Private jobs with Mera (new)

- Passkey-PRF keys via `@category-labs/mera` in three namespaces: an X25519 inbox, an AES-256-GCM
  history vault, and an Ed25519 vault-auth key in a Mera signing session.
- Results are sealed on the provider's machine before they leave it. The broker stores only the
  envelope, redacts public views, and discards a plaintext result. The on-chain receipt commits to
  the ciphertext.
- A signed, versioned history vault on the broker, a "Private jobs" page, per-result share links,
  and a cross-device test against a fake synced authenticator.
- Design and threat model: `docs/PRIVATE_JOBS.md`.

### Landing page

- The ledger section reads XorvLedger receipts from the broker. The hero, the payment loop, the FAQ
  and the adapter list are rewritten for Monad, and a "Built with" section says where each sponsor
  sits in the loop.

### Fixed

- **Settlement ran after dispatch**, so a provider could work on a payment that then failed to
  settle. It is now upfront.
- A settlement was attached to "the latest unpaid job for this payee" and could swap two concurrent
  buyers' records. It is now matched by quote id.
- Reassignment kept the first assignment's timestamps, so jobs bounced A → B → A. It also credited
  earnings to whoever finished rather than whoever was paid, and let a late result resurrect a
  finished job.
- One quote could be settled twice by a double-click (there is now a `paying` guard).
- Anyone who knew a public job id could cancel the job. Cancelling now needs a one-time token from
  the payment response.
- Provider ids changed on every broker restart. They now derive from the node id
  (`providerIdFor`, a one-way hash), because they are hashed on-chain and written into agent URIs.
- The sandbox's deny rules missed a relocated `XORV_HOME`.
- Receipts are now queued from every path that finishes a job (an old comment claimed the settle hook
  did it).
- The provider node credited itself the quoted price for every job, with no settlement transaction,
  including a job reassigned to it after the paid provider failed it. Dispatches now carry the job's
  settlement, and the node credits the settled amount (with its transaction) only when it was the
  payee. Found by the e2e harness.
- `xorv start` off a terminal (systemd, Docker, output to a file) printed its status footer once a
  second and nothing about jobs. It now prints each node event once. Found by the e2e harness.

### Fixed after an adversarial review (52 confirmed findings)

- **Registration.** Re-registering a node id whose session is still live needs that session's
  bearer token (409 `node_live` otherwise), and an existing token is never handed to a caller who
  did not present it. Node ids stay off-chain: `agentURI` is `<broker>/agents/<providerId>.json`,
  built by the CLI, and `/agents/:file` no longer resolves node ids.
- **Self-dealing.** The broker refuses a payment whose payer is the quoted provider's `payTo`
  (403 `self_payment`, before anything settles) and never offers such a job for rating. `XorvLedger`
  refuses the same receipt and ratings from the agent's own wallet, owner or operators (see above).
- **Ledger owner.** Named at deploy time and never defaulted to the broker's hot key, so a leaked
  broker key can be rotated out with `setBroker`.
- **Ratings.** Relayed ratings are checked with ECDSA before ERC-1271, so EIP-7702 buyers can rate.
  An agent that made the ledger (or the verifier) its operator is detected and answered with 409
  `ledger_authorized` instead of an opaque revert. Receipts the ledger holds without an agent are
  no longer offered for rating.
- **Nansen budget.** Provider signals are bought when a node opens its control socket, not on the
  free registration. 30% of the daily budget is reserved for the wash-rating guard, and a guard
  check that can't run for lack of budget defers the rating (503 `trust_budget_spent`) instead of
  relaying it unchecked.
- **Matching and payment.** Only providers holding an open control socket are quoted or paid; a
  paid dispatch the socket can't take counts as a failure against the quoted provider; a provider
  failing more than it completes recently is left out of matching. Fractional prices (which froze
  quotes at 0 USDC) are refused. A settlement still confirming after the facilitator's wait keeps its
  quote locked and runs the job when it lands (`GET /api/quotes/:id`).
- **Receipts.** A receipt that reverts `DuplicateJob` because it already landed counts as recorded,
  and an unconfirmed batch is checked before anything is resent.
- **Broker limits.** Expired quotes are pruned and open quotes capped at 10,000; the 256 KB body
  limit counts streamed bytes; every WebSocket frame from a node is validated (8 MiB cap) so a
  malformed one can't exit the broker; the rate limiter reads `X-Forwarded-For` from the right
  (`XORV_TRUSTED_HOPS`).
- **Persistence and vaults.** Vault ciphertext stays on disk, not in the heap, with a total cap
  (1 GiB on disk, 128 MiB in memory mode) and 10 new vaults per client per hour. Boot merges Mongo
  and SQLite record by record so an older copy never wins.
- **Private jobs.** The router's and screener's free-text reasons are withheld from public views of
  a private job. The job page checks a sealed result against the `resultHash` in the job's
  XorvLedger receipt on Monad, not against the broker's own hash. The history vault trims its oldest
  entries to fit the broker's 176 KiB cap instead of failing every write; unsaved private prompts are
  dropped on Lock.
- **Web app.** Privy's sign modal gets JSON-safe typed data (bigints as decimal strings), which fixed
  a crash on the first payment or rating. The demo routes (`/api/pay`, `/api/rate`) are rate-limited
  per IP and per deployment, capped per rolling 24 h (`XORV_DEMO_DAILY_USDC_UNITS`, default $5), allow
  one payment attempt per quote, and sign a rating only for the browser that paid (an HttpOnly demo
  receipt, 30 minutes, once per job).

### Quality

- The root test count and a per-package breakdown are in the README ("For judges"). None of the
  tests need keys or a network.
- **`pnpm e2e`** (new `e2e/`) runs the whole system against real contract code: a local fork of
  Monad testnet (Hardhat 3 EDR) with Circle's real USDC and the canonical ERC-8004 registries,
  XorvLedger deployed by its own script, the built broker, a real provider node, `xorv run --json`,
  the MCP server and a private job, with every claim read back off the fork. The last green report is
  committed as `e2e/last-run.md`.
- CI builds before typechecking and runs every suite on Node 22 and 24, plus the CLI's Node 20.19
  floor and the committed-secret scan.

---

## [0.1.0] — 2026-07-31 (Hedera prototype, pre-existing work)

The first release, built for the [Hedera x402 bounty](https://hedera.com/x402-bounty/) at
<https://github.com/nickthelegend/xorv>. It is imported into this repository unchanged by `321b563`
and listed here as prior work.

- **Provider CLI** (`xorv`): `init`, `start`, `run`, `status`, `earnings`, `doctor`, `wallet`,
  `jobs`, `price`, `test`, `logs`, `config`, `pause`, `resume`, `cancel`, `completion`.
- **Six adapters**: `claude-code`, `codex`, `grok`, `opencode`, `openai-compatible` and `echo`.
- **Broker**: provider registry, heartbeat liveness, price × reputation matching, x402 gating, a
  self-hosted facilitator, an HCS audit trail, SQLite persistence, Prometheus metrics, per-IP rate
  limits.
- **MCP server** with five tools, the **job board** and the **landing site**.
- x402 `exact` on Hedera via partially signed `TransferTransaction`, in USDC or HBAR, with the
  facilitator as fee payer and the provider as payee.
- 220 tests at release. CI on Node 22 and 24. A Dockerfile and compose file.

The imported snapshot also contains Hedera-era work that this entry does not list: the OS-level job
sandbox (seatbelt, bubblewrap, container) with keychain token injection, MongoDB persistence, the
`/xorv` Claude Code skill and the HyperFrames trailer in `videos/xorv-launch/`.
