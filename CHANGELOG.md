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
  **payer-signed ratings** (`rateJob`, EIP-712, EOA or ERC-1271 through `SignatureChecker`), forwarded
  to the ERC-8004 Reputation Registry.
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
- The broker serves ERC-8004 registration files (`/agents/<id>.json`) and reproducible feedback files
  (`/feedback/<jobId>.json`, `/verifications/<jobId>.json`) whose keccak256 is the on-chain
  `feedbackHash`.
- **Gasless ratings**: `GET /api/jobs/:id/rating` → the buyer signs → `POST /api/jobs/:id/rate` → the
  broker relays `rateJob`. One per job, from the wallet that paid.

### Indexer: Envio HyperIndex (new `services/indexer`)

- Indexes XorvLedger and the ERC-8004 Identity and Reputation registries over HyperSync, with
  testnet and mainnet configs.
- 15 entity types, including derived provider earnings, success rate and rating; agent reputation
  split by writer (buyer ratings, Xorv-verified, other); network, daily, per-provider and per-buyer
  series.
- Exported GraphQL queries, and 52 tests on Envio's test indexer. It lives outside the pnpm workspace
  because Envio ships no Windows binary.
- The broker reads `/api/ledger`, `/api/receipts` and `/api/leaderboard` from the indexer first and
  falls back to a bounded RPC scan in 100-block windows or to in-memory stats.

### AI roles in the broker (new `services/broker/src/ai`)

- **Hunyuan hy4 screens** every quote before any provider sees the prompt. A block is a 422. The
  fail mode is set by `XORV_SCREENER_FAIL=open|closed`.
- **Qwen 3.8 Max routes** "Auto" quotes among live adapters under the ceiling, with a deterministic
  fallback.
- **Kimi K3 verifies** completed public jobs and writes the score to ERC-8004 (`xorv-verified`) from
  the verifier EOA. It never blocks the job.
- Each role has a shared client, hard per-role deadlines, strict JSON validation, key redaction,
  metrics, and state reported on `/api/network`. A missing key turns a role off, never the broker.

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
- Provider ids changed on every broker restart. They now derive from the node id, because they are
  hashed on-chain and written into agent URIs.
- The sandbox's deny rules missed a relocated `XORV_HOME`.
- Receipts are now queued from every path that finishes a job (an old comment claimed the settle hook
  did it).

### Quality

- The root test count and a per-package breakdown are in the README ("For judges"). None of the
  tests need keys or a network.
- CI builds before typechecking and runs every suite on Node 22 and 24, plus the CLI's Node 20.11
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
