# Architecture

How Xorv is put together on Monad, and why the awkward parts are the way they are.

The Hedera prototype this grew out of (see [README → Prior work](README.md#prior-work-what-existed-before-metropolis-and-what-is-new))
had its own awkward parts: a 180-second transaction validity window, token association, a fresh SDK
client per settlement, and HCS message chunking. None of them survived the port. What follows is
the set of awkward parts that EVM and Monad bring instead.

---

## The shape

```
 buyers                         broker (services/broker)                 provider node (xorv start)
 app+Privy · xorv run ·            │                                        dials OUT over WebSocket
 MCP+Privy · mm xorv               │                                                  │
   │ 1 POST /api/quotes ─────────► │ Hunyuan screen → Qwen route → matcher             │
   │ ◄── frozen quote ──────────── │ (provider 0x…, agentId, usdcAmount, accepts[])    │
   │ 2 POST /api/jobs/:quoteId ──► │ 402: exact · USDC · payTo = PROVIDER              │
   │ 3 PAYMENT-SIGNATURE ────────► │ facilitator: transferWithAuthorization ─────► Monad
   │ ◄── 200 jobId, payment tx ─── │ (settled BEFORE the handler runs)                 │
   │                               ├─── job.dispatch ─────────────────────────────────►│
   │ ◄══ SSE ══════════════════════╪◄══ job.event (tool calls, reasoning, steps) ══════┤
   │ ◄── result ───────────────────┤◄── job.result (sealed if private) ────────────────┤
   │                               ├─ Kimi verify ─► ERC-8004 giveFeedback ────────► Monad
   │                               ├─ XorvLedger.recordJobs (batched) ─────────────► Monad
   │ 6 EIP-712 Rating (free) ─────►├─ XorvLedger.rateJob ─► ERC-8004 giveFeedback ─► Monad
   │                               │
   │                               ◄── Envio HyperIndex (services/indexer) GraphQL ◄─ Monad logs
```

The broker is the only process that has to run for the network to exist. The indexer, the app and
the landing page are all optional. Provider nodes run anywhere.

## Packages

| Package | What it is |
|---|---|
| `packages/protocol` | The shared vocabulary: domain and wire types, the Monad chain table (`chains.ts`), viem helpers (`evm.ts`), the x402 facilitator (`x402.ts`, Node only) and buyer client (`x402-client.ts`), the XorvLedger ABI and feed reader (`ledger.ts`), ERC-8004 helpers (`erc8004.ts`), the OpenAI-compatible model presets (`llm.ts`), private-job crypto (`sealed.ts`, `vault.ts`). `@xorv/protocol/web` is the browser-safe subset. |
| `packages/contracts` | `XorvLedger.sol`, its Hardhat 3 tests against the vendored ERC-8004 registries, and the deploy, verify and live-gas scripts. |
| `packages/cli` | `xorv`: the provider node, `xorv run` (a buyer), `xorv identity`, and the adapters and sandbox. |
| `packages/mcp` | `@xorv/mcp`: an MCP server that lets an agent buy jobs, from a local key or a Privy server wallet. |
| `packages/mm-plugin` | `@xorv/mm-plugin`: `mm xorv …` for MetaMask Agent Wallet. |
| `services/broker` | Registry, matcher, x402 resource server, facilitator selection, XorvLedger writer, rating relay, AI roles, private-job vaults, SQLite/Mongo, metrics. |
| `services/indexer` | Envio HyperIndex over XorvLedger and ERC-8004. It has its own lockfile, outside the workspace. |
| `apps/app` | The job board: Privy wallet, pay, rate, private jobs, and the network and providers pages. |
| `apps/landing` | The marketing site, with a live receipts feed. |

---

## Decisions worth explaining

### The broker is never the payee

The 402 names the **matched provider's own address** as `payTo`. The buyer signs an EIP-3009
`TransferWithAuthorization` for exactly that amount to exactly that address, and the facilitator
submits it. The USDC moves buyer → provider in one transfer, and the broker's key never touches it.
That is why the `payTo` in the route config (`services/broker/src/app.ts`) is a resolver over the
quote rather than a constant.

The protocol fee is 0% (`XORV_FEE_BPS` is display-only). A non-zero fee would need a splitter
contract as the payee, because EIP-3009 moves one amount to one address. It must never become "pay
the broker and trust it to forward".

### A quote is a price commitment

x402 asks the server for payment requirements **twice**: once to answer 402, and once to check the
payment that comes back. Both answers must name the same provider and the same amount. If the
matcher ran twice, a buyer could be quoted one node and pay another.

So `POST /api/quotes` freezes the provider, its checksummed payout address, its verified ERC-8004
agent id, the price and the USDC amount (`jobs.createQuote`), and both resolvers read from the
quote. A quote is single-use and expires in 5 minutes (`QUOTE_TTL_SECONDS`). The same 300 seconds
become the x402 `maxTimeoutSeconds` and so the EIP-3009 `validBefore`: client, server and token
contract all agree on one window.

The quote response also carries `accepts[]`, exactly the row the 402 will contain. Every Xorv buyer
checks the 402 against it before signing (`buyerX402Client` with `expect`, `quoteMatchPolicy` in
`packages/protocol/src/x402-client.ts`). On EVM, whoever holds a signed authorization can spend it,
so "the broker swapped the payee" has to be caught before signing, not after.

A quote also carries a `paying` flag. Two signed payments for one quote (a double-click, or two
tabs) cannot both settle: the second gets 409. The flag also keeps a quote resolvable if its TTL
runs out between settlement landing and the job being created.

### Payment settles before the job runs

The paid route uses x402's **upfront** payment flow (`extra: { paymentFlow: "upfront" }`, supported
by `@x402/core` 2.27). The facilitator settles the authorization *before* the handler runs, so the
handler only ever sees a payment that has already landed on Monad, and only then creates and
dispatches the job.

The default flow settles after the handler returns. The first port used it, and it was a real bug:
the job was dispatched from the handler, so a provider could start working on a payment that then
failed to settle (the buyer spent the USDC in between, or signed two quotes against one balance),
and it would never be paid. Settling first also means a five-minute authorization can never lapse
under a ten-minute job.

The other risk, a provider that takes the money and fails, is covered by the network rather than by
each transaction. A failed job is **reassigned to another provider at no extra charge**, up to three
providers in total (`MAX_PROVIDERS_PER_JOB`). A reassignment is a fresh assignment with fresh
timestamps, and it never returns to a provider that already had the job. The failure counts against
the original provider's success rate, which is the matcher's second sort key after price.

### A settlement is matched to its job by quote id

The settle hook (`onAfterSettle`) takes the quote id from the paid URL. Under the upfront flow the
job does not exist yet, so the payment record waits in a map keyed by quote id until the handler
picks it up. The Hedera prototype matched a settlement to "the most recent unpaid job for this
payTo", which could swap the records of two buyers who paid the same provider at the same moment.

### Pay first means cancel is not a refund

`POST /api/jobs/:id/cancel` stops the work and frees the provider's slot. It does not refund,
because the money has already moved and the provider may already have used real quota. Only the
buyer who paid can cancel: the payment response carries a one-time `cancelToken`, and the broker
stores only its hash. Job ids are listed publicly on `/api/jobs`, so knowing one proves nothing.

### Provider nodes dial out

The node opens a WebSocket **to** the broker, and the broker never calls in. Someone sharing a
laptop is behind NAT, on hotel wifi, on a machine that sleeps. Outbound works from all of those with
no port forwarding and no inbound attack surface. Results and events also have authenticated HTTP
fallbacks (`POST /api/jobs/:id/result`, `/events`), because the work is already paid for and a
dropped socket must not be the reason a buyer never gets an answer. If a node's socket drops between
quote and payment, the paid job is reassigned instead of failed.

### Liveness is not a database row

The registry is in memory on purpose: a provider is only real while heartbeats keep arriving (every
15 s, offline after 45 s, reaped after 10 minutes). `registry.get()` re-derives status on every call,
because status is a function of the clock and the guard that decides whether a quoted provider is
still alive enough to be paid reads it.

Provider ids are derived from the node's stable id, not minted per broker process. They are hashed
into XorvLedger events (`providerId = keccak256(id)`) and written into ERC-8004 agent URIs, so a new
id per restart would split one node into many on-chain.

What does survive a restart goes to SQLite or MongoDB (jobs, payments, earnings, vaults) and to
Monad (registrations, sampled heartbeats, receipts, ratings). The chain is the part nobody has to
take on trust.

---

## XorvLedger: the public record

`packages/contracts/contracts/XorvLedger.sol` replaces the prototype's three HCS topics. Its
interface is fixed, because the protocol ABI and the indexer depend on it
(`packages/contracts/abi/XorvLedger.json`, pinned by `test/abi.test.ts`).

**Monad bills the gas limit, not the gas used.** That one fact shapes every write:

- **Every transaction sets its limit to `eth_estimateGas` × 1.15** (`withGasHeadroom`,
  `packages/protocol/src/evm.ts`). A padded constant overpays on every transaction, and a bare
  estimate can run short if state moves between the estimate and inclusion. The estimate also works
  as a free preflight for a write that would revert.
- **Receipts are batched.** The broker queues receipts and sends one `recordJobs` call after
  `XORV_RECEIPT_BATCH_MS` (4 s) or as soon as `XORV_RECEIPT_BATCH_MAX` (20) are waiting. The fixed
  cost of a transaction (21k intrinsic gas, cold account accesses at 10,100 each on Monad, one
  signature, one round trip) is paid once. Measured on live Monad: 105,967 gas for one receipt
  alone, 40,952 per receipt in a batch of 20. Within a batch, the contract checks each
  (agent, payTo) pair against the Identity Registry only once.
- **One storage slot per job.** A new slot costs about 27.9k gas on Monad, and log data is cheap. So
  a job stores exactly what `rateJob` has to check, packed into one slot (`buyer`, `agentId`,
  `rated`), and everything else is in the `JobRecorded` event. Registrations and heartbeats store
  nothing and only emit events.
- **Heartbeats are sampled.** One beat in twenty is published (`XORV_HEARTBEAT_PUBLISH_EVERY`).
  Publishing every beat would be thousands of transactions a day per node: noise rather than
  evidence, and every one pays for its full gas limit.

**`recordJobs` is all-or-nothing, so a bad receipt must not sink good ones.** On a revert, the
broker splits the batch in half and retries each half, down to single receipts
(`services/broker/src/chain.ts`, `sendBatch`). Other failures, such as a dead RPC or no gas money,
fail the batch as a whole, because splitting would only repeat the same error. If a single receipt
reverts with `PayToNotAgentWallet` (the agent NFT moved or its wallet was re-pointed after the
quote), it is recorded once more under `NO_AGENT`. The payment still happened; it just can no longer
be attributed to that identity.

**A receipt is written only when there is something to attest to**: the job is terminal *and* its
payment is recorded. A fast job often finishes before its settlement is attached, and a receipt
without a settlement transaction proves nothing. Receipts are queued from a job-store subscription,
so every path that finishes a job (result, failure, timeout, cancel) triggers one without having to
remember to. A failed write is retried by the 15-second sweep up to three times. Each receipt binds
the settlement tx to `requestHash = keccak256(prompt)`, `resultHash = keccak256(result)`, the
duration, the outcome, the buyer, the payee and the agent. The payload stays off-chain, and the
record stays checkable.

**Audit writes never block the request path.** Registration waits at most 2.5 s for its ledger write
and then answers without it. An unchanged re-registration (a reconnect) writes nothing. A failed
write lands in `lastPublishError` on `/api/network`. The one exception is the rating relay: the
buyer is waiting to hear whether it landed, so it reports failure.

### ERC-8004 identity binding: `payTo == agentWallet`

A provider may claim an ERC-8004 agent id when it registers (`xorv identity register` creates one
from the payout key: `register(agentURI)` makes the caller both owner and agent wallet in one
transaction). The claim is worth recording only if the agent's wallet **is** the payout address.
The broker checks `getAgentWallet(agentId)` with a 4-second timeout. If the lookup fails or the
wallet differs, the node registers without an identity and is told why; it still earns.
`XorvLedger` enforces the same rule on-chain for every receipt and registration
(`PayToNotAgentWallet`), so "this agent was paid for this job" is a contract invariant, not a claim
made by the broker.

A reassigned job's receipt is recorded **without an agent**. The ledger requires the agent's wallet
to be the address that was paid, and the address that was paid (the quoted provider) did not do the
work. Crediting either identity with the outcome would misattribute it.

The broker serves the agent's registration file at `GET /agents/<id>.json` (`x402Support: true`,
`supportedTrust: ["reputation"]`, the jobs endpoint and the web app). The URI stays stable, so it
never needs a follow-up `setAgentURI` write.

### Ratings: EIP-712, gasless, one per job

```
GET  /api/jobs/:id/rating?value=87 → EIP-712 typed data + the feedback file's hash
buyer signs it (Privy embedded wallet, MetaMask, a CLI or MCP key); no gas
POST /api/jobs/:id/rate {value, deadline, signature}
     → broker verifies the signer is the job's payer (ECDSA, then ERC-1271/6492 over RPC)
     → waits up to 15 s for the job's receipt to land (the ledger rates only recorded jobs)
     → XorvLedger.rateJob(rating, sig) → ReputationRegistry.giveFeedback(agentId, value, 0, "starred", …)
```

- **The domain is `{name: "XorvLedger", version: "1", chainId, verifyingContract: ledger}`.** The
  signature check happens in the broker *and* in the contract (OpenZeppelin `SignatureChecker`, so
  smart accounts work). The broker checks first so it never spends gas relaying a rating the
  contract would refuse.
- **One rating per job** is enforced on-chain (`AlreadyRated`). An in-flight set in the broker stops
  a double-submit from burning a second transaction.
- **Buyers never sign what they are handed verbatim.** The app, the MCP server and the MetaMask
  plugin each rebuild the typed data locally with `ratingTypedData` and compare the job, the value,
  the deadline and the ledger before signing.
- **The feedback file is reproducible.** Its keccak256 is inside the signed message and ends up
  on-chain, and it is served later from `/feedback/<jobId>.json`. So it is built only from facts that
  are frozen once the job is terminal, plus the value and deadline that travel with the signature.
  Its `createdAt` is derived from the deadline for the same reason.
- **Every rating reaches ERC-8004 with `clientAddress == XorvLedger`.** Filtering a summary by that
  client gives a provider score made only of paid jobs, each rated by the wallet that paid.

The ledger must never own or operate a provider's agent NFT, and neither may the verifier EOA:
ERC-8004 rejects feedback from an agent's owner and operators. A contract test demonstrates the
ledger case, and the broker skips verifier feedback when the verifier EOA is the provider's own
wallet.

---

## AI roles, and how each one fails

Three sponsor models sit in the core loop (`services/broker/src/ai/`,
[services/broker/README.md](services/broker/README.md)). They share one client (`ai/client.ts`) with
a hard per-role deadline raced against the request, strict validation of the JSON the model
returns, per-role counters, and key hygiene: a key goes only to its preset's base URL and is
scrubbed from any error text.

| Role | Runs | Deadline | When it fails |
|---|---|---|---|
| **Screener**, Hunyuan hy4 | every quote, before any provider sees the prompt | 5 s | `XORV_SCREENER_FAIL=open` (default): quote anyway, recorded as "not screened: …". `closed`: 503 until the screen is back. A **block** is a 422 and no quote exists. |
| **Router**, Qwen 3.8 Max | quotes with no adapter (or "auto") when two or more adapters are live under the ceiling | 6 s | Timeout, HTTP error, bad JSON or a pick that is not a live candidate → the deterministic matcher, recorded as `routing.fallback` with the reason. |
| **Verifier**, Kimi K3 | every completed, non-private job | 20 s | Never blocks: it runs after the buyer has the result. No score means no feedback. A failed `giveFeedback` is stored as `verification.feedbackError`. |

Why they are shaped this way:

- **What was screened is what runs.** The quote freezes the screened request, and the paid route
  runs only the quoted request, so a prompt cannot be swapped after screening.
- **The router picks an adapter, never a node.** It sees a table of live candidates under the
  buyer's ceiling (price, success rate, mean rating, mean Kimi score, ERC-8004 identity). The price
  matcher still chooses the node for the adapter it picked, so the model cannot steer a job to a
  particular provider or above the ceiling.
- **The verifier's score is a separate signal.** It is written from the verifier EOA under tag
  `xorv-verified`, never mixed with buyer `starred` ratings. The feedback file at
  `/verifications/<jobId>.json` hashes to the committed `feedbackHash`, and its hash is stored on the
  job before the transaction is sent. Private jobs are skipped, because the broker holds only
  ciphertext.
- **A missing key turns a role off, never the broker.** `GET /api/network` reports each role's
  state (`ai`, `aiRoles`) and why a role is off.

## Private jobs

A private job's answer is sealed on the provider's machine to an X25519 key derived from the buyer's
passkey (through Mera's PRF evaluation), stored by the broker as an envelope it cannot open, and
committed on-chain as the envelope's hash. The design, the three key namespaces, the vault and the
threat model are in [docs/PRIVATE_JOBS.md](docs/PRIVATE_JOBS.md). Architecturally, it changes four
things:

- `encryptTo` is validated at quote time, before anyone is reserved or paid.
- A plaintext result for a private job is discarded unstored and the job fails over, the same way as
  any other provider failure.
- Public views redact the prompt and title, and the event stream carries only status lines.
- The verifier is skipped.

---

## Reading the record back: indexer first, RPC second

The public Monad RPC caps `eth_getLogs` at **100 blocks** (about 30 seconds at 300 ms blocks).
Answering "the last 50 receipts" or "the best provider" by walking logs is slow and burns the RPC's
rate limit. So reads have two sources (`services/broker/src/ledger-reader.ts`):

1. **The Envio indexer** (`XORV_INDEXER_URL`), which has the whole history and the derived
   aggregates and answers in one GraphQL request. It serves receipts, ratings, registrations and the
   leaderboard.
2. **A bounded backward RPC scan** (`readLedgerEvents` in `packages/protocol/src/ledger.ts`). It
   works in ≤100-block windows from the latest block, 20,000 blocks by default (about 100 minutes),
   and never before `XORV_LEDGER_FROM_BLOCK`. It needs nothing but the contract address. Heartbeats
   are always read this way.

The indexer is an accelerator, never a dependency. If it is unset, slow or erroring, the broker
falls back and says so in the response (`source: "indexer" | "rpc" | "memory"`, plus
`indexerError`). The leaderboard falls back to in-memory stats. Results are cached for 5 seconds,
because the landing page and the network page poll, and without a cache every visitor would cost the
RPC hundreds of `eth_getLogs` calls per refresh.

The indexer itself uses HyperSync, so it never touches the 100-block cap. It classifies each
ERC-8004 feedback entry once, by the client address that wrote it: `BUYER_RATING` from the ledger,
`XORV_VERIFIED` from the ledger's active broker or listed verifier addresses, and `OTHER` for
everything else. Anyone can call `giveFeedback`, so the writer decides what an entry is worth. See
[services/indexer/README.md](services/indexer/README.md).

## Nonces: one queue per signer

The broker can have three EOAs: the facilitator (settlement gas), the operator (ledger writes and
rating relays) and the verifier (Kimi feedback). By default they are all the same key, and several
of them can fire in the same millisecond, which is how two transactions end up racing for one
nonce. Every broadcast therefore goes through `withSignerLock` (`packages/protocol/src/evm.ts`), a
per-address queue shared across the process, and every account carries viem's `nonceManager`. A
settlement and a receipt batch from the same key get consecutive nonces instead of one failing.

A separate `XORV_FACILITATOR_KEY` is still recommended, so a buyer's settlement never queues behind
a receipt batch. Each EOA must also stay above Monad's ~10 MON per-account reserve for in-flight gas.
`pnpm setup:monad` checks the balances.

## Addresses and ids

- Addresses are normalized with viem's `getAddress` at every boundary (registration, settle hook,
  receipts, the agent-wallet check) and compared case-insensitively (`sameAddress`). The indexer
  stores lowercase.
- On-chain ids are hashes of the broker's ids: `jobId = keccak256(utf8(brokerJobId))`,
  `providerId = keccak256(utf8(brokerProviderId))`. The broker keeps a map back, so ledger feeds link
  to job pages.
- `capabilities` on-chain is the compact string `"claude-code:10000,qwen:5000"` (adapter:price in
  micro-USD). The indexer parses it into `ProviderCapability` rows.

---

## Data flow, precisely

**Registration.** Node → `POST /api/providers/register {address, agentId?, capabilities}` → the
address is checksummed and a claimed agent is verified → registry keyed on the stable node id → a
bearer token comes back → `registerProvider` on XorvLedger in the background. The node opens
`wss://…/ws/provider?token=…`.

**Heartbeat.** Every 15 s, `POST /api/providers/:id/heartbeat` with the node's bearer token, carrying
load and per-capability availability. One in twenty is published as `ProviderHeartbeat`.

**Quote.** Screen → candidates (live providers × capabilities, filtered on adapter, price ceiling,
per-capability availability and free concurrency; sorted by price, then success rate, then load) →
route when the buyer left the adapter open → freeze.

**Payment.** `@x402/hono` middleware on `POST /api/jobs/:quoteId`, behind a guard that turns an
expired quote into a clean 404 and a paid or offline one into a 409. The facilitator is in-process
(`XORV_FACILITATOR=self`, a viem EOA), Monad's hosted one (`hosted`, `https://x402-facilitator.molandak.org`)
or any URL. With nothing configured, the broker uses self-hosted when a key exists and hosted
otherwise, and says so at boot. An explicit `self` without a key is never silently downgraded: the
paid route answers 503 with the fix.

**Dispatch.** `job.dispatch` down the socket. The node runs the adapter in a fresh directory under
the Xorv home, inside the sandbox, streams `job.event` and returns `job.result`, sealed first if the
job is private.

**Completion.** The success counts for the provider that did the work. The earnings are credited to
the provider that was **paid** (the quoted one), because that is where the USDC went, even when a
reassignment means someone else finished the job. The verifier runs, and the receipt is queued.

---

## Testing

The root `pnpm test` runs every workspace suite: **970 tests**, counted on 2026-09-26 by running
each suite once, one after another, on Windows. A further 14 POSIX-only CLI cases are skipped there.
None of them needs a key, an RPC or testnet funds.

| Suite | Files | Tests | What it leans on |
|---|---:|---:|---|
| `packages/protocol` | 11 | 236 | viem over a fake JSON-RPC, a real x402 facilitator over a stub transport, known-answer crypto vectors |
| `packages/contracts` | 4 | 47 | Hardhat's in-process chain (EDR), the vendored ERC-8004 registries, `node:test` |
| `packages/cli` | 16 | 245 (+14 skipped on Windows) | fake agent binaries, a fake RPC, scripted model endpoints |
| `packages/mcp` | 7 | 82 | the real server over stdio, a mock broker that verifies signatures, a fake Privy client |
| `packages/mm-plugin` | 7 | 71 | the real `PluginCommand` base, a fake executor that signs the way MetaMask's JSON-RPC signer does |
| `services/broker` | 10 | 206 | the real Hono app, x402 resource server and WebSocket hub, with the chain stubbed |
| `apps/app` | 6 | 69 | real Mera against a fake synced authenticator, a mocked broker `fetch` |
| `apps/landing` | 1 | 14 | hand-built broker payloads, including malformed ones |
| **Total** | **62** | **970** | |

What makes that possible:

- **The chain is behind interfaces.** The broker takes a `ChainLike` and an injectable
  `FacilitatorClient`, so the integration suite (`services/broker/test/integration.test.ts`) boots a
  real HTTP server, the real Hono app, the real x402 resource server with `ExactEvmScheme` and the
  real WebSocket hub. A real viem account signs a real EIP-3009 authorization, and only the
  facilitator's broadcast and the ledger writer are stubbed. It covers upfront settlement,
  settlement-to-job matching for simultaneous buyers, replay refusal, reassignment and timeouts,
  cancel tokens, SSE, receipts and their retries, ratings, the no-key boot and the AI roles.
  `services/broker/test/private-jobs.test.ts` does the same for private jobs.
- **Contracts run against the real registry code.** `packages/contracts` deploys the vendored
  ERC-8004 v2.0.0 registries behind ERC1967 proxies the way upstream's own tests do, so behaviour
  like "`giveFeedback` rejects the agent's owner" is the real code, not a mock's approximation. Gas
  tests report every call the broker pays for, and `pnpm gas:monad` re-measures them on live Monad
  with state overrides.
- **Viem runs over stub transports.** Protocol and CLI tests drive viem through a fake JSON-RPC
  (`test/support/fake-rpc.ts`), so the gas headroom, the signer lock and the calldata are asserted
  on real encodings.
- **Sponsor models are scripted `fetch`es.** This includes one that ignores its abort signal, to
  prove the deadline holds.
- **Signers are checked the way the real counterparties check them.** The MCP mock broker verifies
  payment and rating signatures, the MetaMask fake executor hashes `EIP712Domain` literally the way
  MetaMask's JSON-RPC signer does, and the plugin manifest is validated with MetaMask's own schema.
- **Passkeys are simulated faithfully.** The app's private-job tests run real Mera against a fake
  authenticator that computes PRF the way WebAuthn does and syncs between two "devices".

The Envio indexer's 52 tests (`services/indexer/test`) drive the real handlers through Envio's
`createTestIndexer` with simulated events. They run in Linux or WSL, or in a throwaway container from
Windows, because Envio ships no Windows binary.

**End to end, on a fork of Monad testnet.** `pnpm e2e` ([e2e/README.md](e2e/README.md)) removes the
stubs at the chain boundary. It forks Monad testnet with Hardhat 3's EDR, so Circle's real USDC
(FiatToken v2.2, EIP-3009) and the canonical ERC-8004 v2.0.0 registries are the contracts in play,
mints the buyer's USDC through the token's own masterMinter, deploys XorvLedger with its deploy
script, and runs the built broker (self-hosted facilitator, ledger writer, rating relay), a real
`xorv` provider node that registers its identity with `xorv identity register`, `xorv run --json`,
the MCP server over stdio and a private job. Only the three models are stand-ins: a local
OpenAI-compatible server behind each preset's base URL, so the roles' real request, parsing and
feedback code runs. Every claim is then read back off the fork: 189 checks, last green run in
[e2e/last-run.md](e2e/last-run.md). It found three bugs the unit suites could not: Hardhat dropped
the fork's hardfork history (a chain-type mismatch); `xorv start` off a terminal printed its status
footer once a second instead of its jobs; and a provider's earnings ledger carried no settlement
transaction, and credited a node for a reassigned job it was never paid for.

What the tests do not prove: that the public Monad RPC under load, the hosted facilitator, Privy,
MetaMask or the three model APIs behave on the day as their documentation and our stubs say. That is
what the testnet deployment and the demo are for (see [SUBMISSION.md](SUBMISSION.md#before-you-submit)).
