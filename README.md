<div align="center">

<img src="brand/xorv-logo.svg" alt="Xorv" width="260" />

**A decentralized marketplace for AI capacity, settled on Monad.**
Rent out the AI subscription or model key you already pay for. Get paid **per job, in USDC, over
[x402](https://x402.org)**, with every job receipted on-chain and every provider's reputation held in
Monad's **ERC-8004** registries.

[![Monad](https://img.shields.io/badge/Monad-testnet%2010143-836EF9?style=flat-square)](https://testnet.monadscan.com)
[![x402](https://img.shields.io/badge/x402-v2%20exact-7C5CFF?style=flat-square)](https://x402.org)
[![ERC-8004](https://img.shields.io/badge/ERC--8004-v2.0.0-3DDCFF?style=flat-square)](https://eips.ethereum.org/EIPS/eip-8004)
[![License](https://img.shields.io/badge/license-MIT-50F0C8?style=flat-square)](LICENSE)

**Demo video:** <!-- TODO(deploy): demo video link --> _TBD, fill in after recording_ ·
**App:** <!-- TODO(deploy): deployed app URL --> _TBD_ ·
**XorvLedger:** <!-- TODO(deploy): XorvLedger address --> _TBD_

</div>

---

Millions of people pay for Claude, Codex, Qwen or Kimi and use a fraction of it. Anyone who wants one
job done has to buy a whole plan or an API key. Xorv is the rail between them. A provider runs one
command and their machine joins the network. A buyer (a person in a browser, a script, or another
AI agent) asks for a quote, signs one USDC authorization, and the job runs on the provider's machine.
The USDC moves **straight from buyer to provider** in a single Monad transaction that the network's
facilitator submits and pays gas for. The broker only introduces the two parties and never holds the
money. Every paid job is written to the `XorvLedger` contract. The buyer rates it with a free EIP-712
signature, and that rating becomes ERC-8004 reputation which only a paying buyer can give. Three
sponsor models sit in the core loop: Hunyuan screens every prompt, Qwen routes "Auto" jobs, and Kimi
verifies results and writes its score on-chain.

## Track 04: Trust, Identity & AI Infrastructure

The track asks for "protocols, primitives, or infrastructure layers that other applications build
on" and names "agent identity and reputation under ERC-8004" as an example. Xorv is that kind of
layer, not a consumer app:

- **A payment primitive for agents.** Any HTTP client that speaks x402 can buy a job. The repo ships
  four buyers that all use the same protocol: a web app, a CLI, an MCP server for AI agents, and a
  MetaMask Agent Wallet plugin.
- **Identity that binds to payment.** A provider's ERC-8004 agent is only credited with a job when
  the x402 `payTo` equals the agent's registered wallet. `XorvLedger` enforces this on-chain
  (`PayToNotAgentWallet`), so the broker cannot simply assert it.
- **Reputation that costs something to fake.** Buyer ratings reach the ERC-8004 Reputation Registry
  only through `XorvLedger.rateJob`. There is one rating per recorded job, and it must be signed by
  the wallet that paid for that job. `getSummary(agentId, [ledger], "starred", "")` is therefore a
  score built from paid jobs only, and any other marketplace can read it.
- **AI trust services in the loop.** A safety screen protects provider machines, and a verifier
  publishes an independent quality score to the same registry under a separate tag.

## For judges: verify in three commands

```bash
pnpm install && pnpm build && pnpm test
```

**965 tests pass** (counted on 2026-09-26 by running every workspace suite once, one after another,
on Windows 11 with Node 22.21). A further 14 POSIX-only CLI cases (sandbox tiers and file modes) are
skipped on Windows. They need **no keys, no RPC and no testnet funds**: the x402 facilitator and the
XorvLedger writer are stubbed at the chain boundary, the contracts run on Hardhat's in-process chain
against the real ERC-8004 v2.0.0 registry code, and the hosted models are scripted `fetch` stubs.
You need Node 22.5+ (the broker uses `node:sqlite`) and pnpm 10. The first `pnpm build` downloads the
Solidity compiler through Hardhat. CI runs the same commands on Node 22 and 24
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

| Package | Tests | What they cover |
|---|---:|---|
| `packages/protocol` | 236 | Monad chain table, viem helpers and the signer lock, money math, the x402 facilitator and the quote-bound buyer client, the XorvLedger ABI and 100-block feed reader, ERC-8004 helpers, model presets and the SSE reader, private-job crypto (known-answer vectors, `node:crypto` cross-checks) |
| `packages/contracts` | 47 | `XorvLedger` against the real ERC-8004 v2.0.0 registries, the ABI pin, the gas report, the Monad testnet fork config |
| `packages/cli` | 240 | every adapter including `qwen`, `kimi`, `hunyuan` and `qwen-code`; the sandbox; `init`, `wallet` and `identity`; `xorv run`'s checks before signing; private-job sealing; `xorv start`'s log off a terminal |
| `packages/mcp` | 82 | the real server over stdio against a mock broker that verifies signatures, the Privy signer with a fake client, the session budget, the Privy policy |
| `packages/mm-plugin` | 71 | every `mm xorv` command on a mocked MetaMask context, the signer, the payment policy, the manifest |
| `services/broker` | 206 | the full HTTP lifecycle, receipt batching and retries, indexer-first feeds, the AI roles, private jobs and vaults |
| `apps/app` | 69 | the x402 payment helper, ratings, demo-payer guards, the Mera keyring with a synced authenticator |
| `apps/landing` | 14 | the broker feed parsers |
| **Total** | **965** | |

The Envio indexer (`services/indexer`) is outside the pnpm workspace because Envio ships no Windows
binary. Its 52 tests run in a Linux container with the one command in
[`services/indexer/README.md`](services/indexer/README.md#tests-in-a-throwaway-container-works-from-windows).

### What is proven, and what isn't yet

| | Status |
|---|---|
| Quote → 402 → EIP-3009 signature → upfront settlement → dispatch → result → receipt, through the real Hono app, the real x402 resource server and the real WebSocket hub | Integration test, `services/broker/test/integration.test.ts` |
| **The whole system on a fork of Monad testnet**: Circle's real USDC and the canonical ERC-8004 registries, XorvLedger deployed by its own script, the built broker, a real `xorv` provider node, `xorv run --json`, the MCP server over stdio and a private job; 174 checks read back off the chain (USDC transfers with the buyer holding no MON, `ProviderRegistered`/`JobRecorded`/`JobRated`, Kimi's and the buyers' `NewFeedback`, the sealed envelope's receipt hash) | `pnpm e2e` ([`e2e/README.md`](e2e/README.md)); last green run in [`e2e/last-run.md`](e2e/last-run.md). Needs the Monad testnet RPC, no keys or funds |
| `XorvLedger` receipts, `payTo == agentWallet`, one rating per job, EOA and ERC-1271 signatures, forwarding into the real ERC-8004 Reputation Registry | Contract tests, `packages/contracts/test/XorvLedger.test.ts` |
| Gas for every call the broker pays for, measured on **live Monad** with state overrides (nothing deployed) | `pnpm --filter @xorv/contracts gas:monad`, table in [`packages/contracts/README.md`](packages/contracts/README.md#gas) |
| MetaMask plugin manifest accepted by MetaMask's own `PluginManifestSchema`; `providers` and `quote` run inside Agent Wallet 7.0.0 | `packages/mm-plugin/test/manifest.test.ts`, example session in [`packages/mm-plugin/README.md`](packages/mm-plugin/README.md#example-session) |
| Private job keys reproduced on a second (simulated, synced) authenticator | `apps/app/test/private-keyring.test.ts` |
| **XorvLedger deployed on Monad testnet** | <!-- TODO(deploy): XorvLedger address + deploy tx --> **Not yet.** TBD, fill in after deploy |
| **A job paid, receipted, rated and verified on Monad testnet** | <!-- TODO(deploy): settlement / receipt / rating / feedback tx hashes --> **Not yet.** TBD, fill in after deploy |
| **Envio indexer live on Envio Cloud** | <!-- TODO(deploy): Envio GraphQL endpoint --> **Not yet.** Deploy between Oct 10 and 13 (see [SUBMISSION.md](SUBMISSION.md#before-you-submit)) |

Nothing in this README claims an on-chain transaction that isn't linked. Every "TBD" is filled in
after deployment.

---

## Prior work: what existed before Metropolis, and what is new

**Xorv began as a Hedera x402 prototype**, built earlier in 2026 for the Hedera x402 bounty:
<https://github.com/nickthelegend/xorv>. In this repository, commit
[`321b563`](https://github.com/nickthelegend/xorv-monad/commit/321b563) ("Import the Xorv codebase as
the starting point for the Monad port") imports that code unchanged. **Everything after `321b563` was
built during Monad Metropolis**, starting 2026-09-26, and the commit history shows each step. The
Hedera version settled HBAR and HTS token transfers and kept its audit trail on Hedera Consensus
Service topics. None of that code remains on the payment path.

**Carried over from the Hedera prototype** (redesigned where the chain required it):

- The marketplace design: a quote freezes the provider and the price, the 402 pays the provider
  directly, payment settles before the job runs, and failed jobs are reassigned at no extra charge.
- The broker's registry, heartbeat liveness and matcher (price, then success rate, then load), the
  job store, SSE streaming, the WebSocket hub that provider nodes dial out to, SQLite/Mongo
  persistence, rate limits and Prometheus metrics.
- The provider CLI's structure and commands, the `claude-code`, `codex`, `grok`, `opencode`,
  `openai-compatible` and `echo` adapters, and the OS-level job sandbox (seatbelt, bubblewrap,
  container) with keychain token injection.
- The MCP server's tool structure, the `/xorv` Claude Code skill, the job board and landing page
  designs, the Dockerfile, and the 60-second trailer in `videos/xorv-launch/`, which **shows the
  Hedera prototype** (see [its README](videos/xorv-launch/README.md)).

**New during Metropolis:**

| Area | What was built | Where |
|---|---|---|
| Monad/EVM payment rail | x402 v2 `exact` (EIP-3009) with Circle USDC on Monad. Upfront settlement. An in-process viem facilitator or Monad's hosted one. A buyer client bound to the frozen quote. Gas limits set to estimate + 15%. A per-address signer lock. | `packages/protocol/src/{chains,evm,x402,x402-client,money}.ts`, `services/broker/src/{app,facilitator}.ts` |
| `XorvLedger` contract | Batched receipts, provider registrations and sampled heartbeats, gasless payer-signed ratings forwarded to ERC-8004. Hardhat 3 tests against the vendored registries. Live-Monad gas measurement. Deploy and verify scripts. | `packages/contracts/` |
| ERC-8004 identity and payment-backed reputation | `xorv identity register/show`. The broker checks a claimed agent against the Identity Registry. Registration and feedback files are served by the broker. EIP-712 rating relay. | `packages/cli/src/commands/identity.ts`, `packages/protocol/src/erc8004.ts`, `services/broker/src/{app,ratings}.ts` |
| Envio indexer | HyperIndex v3 over XorvLedger and the ERC-8004 Identity and Reputation registries, with 15 entity types including derived aggregates. The broker reads it first and falls back to RPC. | `services/indexer/`, `services/broker/src/{indexer,ledger-reader}.ts` |
| Privy | Embedded wallet created at login pays per job and signs gasless ratings. MCP agent buyer on a Privy server wallet bound to a signing policy. | `apps/app/components/{providers,wallet-provider}.tsx`, `packages/mcp/src/{signer,privy-policy}.ts` |
| MetaMask Agent Wallet | `@xorv/mm-plugin`: `mm xorv providers/quote/run/job/rate`, signing only through `ctx.walletExecutor`, plus a companion agent skill. | `packages/mm-plugin/` |
| Qwen 3.8 Max, Kimi K3, Hunyuan hy4 | Provider adapters (`qwen`, `kimi`, `hunyuan`, `qwen-code`) and the broker's core-loop roles: Hunyuan screens, Qwen routes, Kimi verifies and writes ERC-8004 feedback. | `packages/cli/src/adapters/{hosted,qwen-code}.ts`, `services/broker/src/ai/`, `packages/protocol/src/llm.ts` |
| Mera private jobs | Passkey-PRF keys in three namespaces. Results sealed on the provider to the buyer's inbox key. An encrypted history vault that decrypts on a second device. | `packages/protocol/src/{sealed,vault}.ts`, `apps/app/lib/private/`, [`docs/PRIVATE_JOBS.md`](docs/PRIVATE_JOBS.md) |
| Bug fixes found during the port | Settlement used to run *after* dispatch, so a provider could work on a payment that never settled. A settlement was matched to "the latest unpaid job for this payee" and could swap two buyers' records; it is now matched by quote id. Reassignment kept stale timestamps, credited the wrong provider, and could resurrect a finished job. A double-click could settle one quote twice. Anyone who knew a public job id could cancel it; cancelling now needs a one-time token. Provider ids changed on every broker restart. The sandbox's deny rules missed a relocated `XORV_HOME`. | commits `fb7f041`, `b6e8ba6`, `2b3bdeb` |

## AI tools disclosure

The Monad port was built with **Claude Code** (Anthropic), with Claude agents working in parallel git
worktrees under the author's direction: planning, research, implementation, tests and documentation.
Commits written this way carry a `Co-Authored-By: Claude …` trailer. The author chose the design,
the bounties and the scope, and reviewed and merged the work.

## Attribution of external code

| What | Where | Licence / source |
|---|---|---|
| ERC-8004 v2.0.0 `IdentityRegistryUpgradeable`, `ReputationRegistryUpgradeable`, `HardhatMinimalUUPS`, `ERC1967Proxy` re-export. **Vendored verbatim, test-only, never deployed by this repo.** | `packages/contracts/contracts/vendor/erc8004/` | MIT (SPDX headers), © the ERC-8004 authors, from [erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts) at `b9e466c`. See [its README](packages/contracts/contracts/vendor/erc8004/README.md). |
| OpenZeppelin Contracts (`EIP712`, `SignatureChecker`) and Contracts Upgradeable (for the vendored registries) | npm deps of `packages/contracts` | MIT |
| x402 (`@x402/core`, `@x402/evm`, `@x402/hono`, `@x402/fetch`, `@x402/extensions`) | npm deps (broker, protocol, app, buyers) | Apache-2.0, [x402](https://github.com/coinbase/x402) |
| Privy SDKs (`@privy-io/react-auth`, `@privy-io/node`) | npm deps of `apps/app` and `packages/mcp` | Apache-2.0 |
| Mera (`@category-labs/mera`) | npm dep of `apps/app` | MIT OR Apache-2.0, [Category Labs](https://github.com/category-labs/mera) |
| MetaMask Agent Wallet (`@metamask/agent-wallet`) and its plugin template | `packages/mm-plugin/` was scaffolded from [agent-wallet-plugin-template](https://github.com/MetaMask/agent-wallet-plugin-template). `@metamask/agent-wallet` is a peer and dev dependency and is not redistributed. | MetaMask's own licence (see its `LICENSE`) |
| Envio HyperIndex (`envio`) | `services/indexer/` | [Envio](https://envio.dev), see the package's licence |
| viem, Hono, noble crypto (`@noble/curves`, `@noble/hashes`, `@noble/ciphers`), `@modelcontextprotocol/sdk`, Next.js, Hardhat | npm deps | MIT |

Everything else in the repository is original to Xorv and MIT-licensed ([LICENSE](LICENSE)).

---

## Why Monad

Xorv sells jobs that cost between a tenth of a cent and a few dollars. The chain has to settle a
payment faster than the job starts, and it has to be cheap enough to write a receipt for *every*
job. Monad does both, and it is EVM, so the standards already exist.

| Property | What it does for Xorv |
|---|---|
| **300 ms blocks, finality in about 600 ms** | Settlement lands before dispatch, so the provider knows it has been paid before it starts working. The buyer waits well under a second for the payment step. |
| **Cheap enough to receipt every job** | A receipt costs about 41k gas inside a batch of 20 (`recordJobs`, measured on live Monad). Each paid job gets a public receipt, and ratings become on-chain reputation rather than a database row. |
| **EVM, so x402 `exact` works with Circle USDC** | EIP-3009 `transferWithAuthorization`: the buyer signs, the facilitator submits and pays gas, and **a buyer needs no MON at all**. The USDC contract's own nonce check prevents replay. |
| **ERC-8004 registries are live on Monad** | The canonical v2.0.0 Identity and Reputation registries are deployed at the `0x8004…` addresses on both chains. Xorv binds to them and does not deploy its own. |
| **Monad's billing model is handled** | Monad charges for the gas **limit**, not the gas used. Every write carries `eth_estimateGas` × 1.15, never a padded constant (`withGasHeadroom`, `packages/protocol/src/evm.ts`). Receipts are batched and heartbeats sampled (1 in 20), because the fixed cost dominates small transactions. `XorvLedger` stores one packed slot per job and puts everything else in events. |
| **Public RPC log limits are handled** | `eth_getLogs` is capped at 100 blocks on the public RPC. Reads go to the Envio indexer first and fall back to a bounded backward scan in 100-block windows. |

## How it works

```
 buyer: web app + Privy · xorv run · MCP + Privy server wallet · mm xorv (MetaMask)
   │
   │ 1  POST /api/quotes ───────────► broker: Hunyuan screens the prompt (422 on block)
   │                                          Qwen routes "Auto" among live adapters under the ceiling
   │                                          matcher picks the node → frozen quote:
   │ ◄── quote {provider 0x…, agentId, usdcAmount, accepts[]}, single-use, 5-min TTL
   │
   │ 2  POST /api/jobs/:quoteId ────► 402 PAYMENT-REQUIRED
   │ ◄── {exact, eip155:10143, USDC, amount, payTo: PROVIDER, extra:{name:"USDC",version:"2"}}
   │
   │    buyer checks the 402 equals the quote, signs EIP-3009 TransferWithAuthorization
   │ 3  PAYMENT-SIGNATURE ──────────► facilitator settles FIRST (upfront flow):
   │                                  transferWithAuthorization buyer → provider on Monad
   │ ◄── 200 {jobId, payment.txHash, cancelToken}
   │                                         │ 4  job.dispatch over the node's own WebSocket
   │                                         ▼
   │                                  provider node (xorv start): sandboxed adapter
   │ ◄══ SSE live events ═══════════ claude-code · codex · qwen · kimi · hunyuan · qwen-code · …
   │ ◄── result                        (private job: sealed to the buyer's passkey inbox key)
   │
   │ 5  broker: Kimi scores the result → ERC-8004 giveFeedback (tag "xorv-verified", verifier EOA)
   │            XorvLedger.recordJobs (batched receipt: payment tx, request/result hashes, ok)
   │
   │ 6  buyer signs an EIP-712 Rating (free) ─► broker relays XorvLedger.rateJob
   │                                            └─► ERC-8004 ReputationRegistry.giveFeedback ("starred")
   ▼
 Envio HyperIndex follows XorvLedger + ERC-8004 → GraphQL → broker /api/leaderboard, /api/ledger
   → app network and providers pages, landing ledger
```

Three rules hold the design together. They are explained in [ARCHITECTURE.md](ARCHITECTURE.md):

1. **The broker is never the payee.** The 402's `payTo` is the matched provider's own address, so the
   USDC moves buyer → provider in one transfer. The protocol fee is 0%.
2. **A quote is a price commitment.** x402 asks for the payment requirements twice, and both answers
   are read from the frozen quote. Buyers refuse any 402 that differs from it (`quoteMatchPolicy`).
3. **Pay first, then work, with free reassignment.** Settlement lands before dispatch. If the
   provider fails, the job goes to another provider at no extra charge (up to three providers in
   total), and the failure counts against the original provider's success rate.

---

## Sponsor integrations

Each subsection says what the integration does in the product, which bounty requirement it answers,
where the code is, and where it appears in the demo ([RECORDING.md](RECORDING.md)).

### Privy: the account that pays, rates, and runs agents

- **What it does.** Visitors log in with email, Google, a passkey or a wallet. Anyone without a
  wallet gets an **embedded EVM wallet**, created on login and pinned to Monad. That wallet
  **pays for each job**: x402 `exact` asks for one EIP-712 signature (EIP-3009 over USDC), which the
  wallet produces through Privy's `toViemAccount` and `@x402/fetch` v2. It also **signs each job
  rating** (EIP-712 `Rating`), which the broker relays into ERC-8004 so the buyer pays no gas. An
  embedded wallet can export its key. Separately, the **MCP agent buyer runs on a Privy server
  wallet bound to a signing policy**. `pnpm privy:setup` writes a policy that allows only
  `eth_signTypedData_v4` for USDC `TransferWithAuthorization` on this chain up to a cap, plus
  XorvLedger ratings, and optionally a payee allowlist. Privy refuses to sign anything else, even if
  the MCP host is compromised. With `--owner-key`, a P-256 owner key is also required, so the app
  secret alone can neither sign nor loosen the policy. A provider can also run address-only with
  its Privy wallet as the payout address (`xorv init`), so no key sits on the provider machine.
- **Bounty fit ("beyond authentication", "multiple Privy features").** Embedded wallet creation,
  typed-data signing for payments, typed-data signing for ratings, key export, server wallets, and
  wallet policies. Login is the least of it.
- **Why not `useX402Fetch`.** Privy's hook speaks x402 v1 through the legacy `x402` package, which has
  no Monad network or Monad USDC. Xorv wraps the Privy wallet as a viem account and uses x402 v2
  instead (explained in `apps/app/lib/x402-pay.ts`).
- **Code.** `apps/app/components/providers.tsx` (Privy config), `apps/app/components/wallet-provider.tsx`
  (embedded wallet → signer, export), `apps/app/lib/x402-pay.ts` and `apps/app/components/composer.tsx`
  (pay), `apps/app/lib/rating.ts` and `apps/app/components/rate-job.tsx` (rate),
  `packages/mcp/src/signer.ts` (server wallet via `@privy-io/node/viem` `createViemAccount`),
  `packages/mcp/src/privy-policy.ts`, `packages/mcp/src/scripts/privy-setup.ts`.
- **In the demo.** Log in, see the wallet appear in the header, pay from it, then rate with a free
  signature. The Privy agent wallet (`xorv_wallet` in Claude Code) is an optional cutaway.

### Envio: the network's memory

- **What it does.** A HyperIndex v3 indexer follows **three contracts**: `XorvLedger` (6 events) and
  the ERC-8004 Identity (4) and Reputation (3) registries. It uses HyperSync, with configs for
  testnet (`config.yaml`) and mainnet (`config.mainnet.yaml`). It derives **15 entity types**. These
  include per-provider earnings, success rate, average duration and average rating; each agent's
  reputation split by who wrote it (`BUYER_RATING` from the ledger, `XORV_VERIFIED` from the broker's
  verifier, `OTHER`); buyers; a global `NetworkStats`; and daily series (`DailyStats`,
  `ProviderDay`, `BuyerDay`) with exact distinct counts. A receipt that arrives before its provider's
  registration is claimed by that provider later, and a revoked feedback entry takes back exactly
  what it added.
- **What it powers.** The broker's `/api/leaderboard`, `/api/ledger` and `/api/receipts` read the
  indexer first (`services/broker/src/indexer.ts`, `services/broker/src/ledger-reader.ts`). Those
  endpoints feed the app's **network page** ("indexed by Envio"), the **providers page** leaderboard
  join, and the **landing page ledger**. Without the indexer, the broker falls back to memory and a
  bounded RPC scan and says so (`source: "memory" | "rpc"`).
- **Bounty fit ("actually driving a feature", depth).** Multiple contracts, a non-trivial schema,
  derived and aggregated entities, and a trust classification. The repo includes `config.yaml`,
  `schema.graphql`, the handlers, and 52 handler/ABI/query tests.
- **Code.** `services/indexer/` ([README](services/indexer/README.md)): `config.yaml`,
  `schema.graphql`, `src/handlers/*.ts`, `src/lib/{aggregates,trust,entities}.ts`, `src/queries.ts`.
- **Deployment.** <!-- TODO(deploy): Envio Cloud GraphQL endpoint --> TBD. Envio Cloud's free plan
  keeps a deployment for 30 days, so it is deployed between Oct 10 and 13.
- **In the demo.** The network page and leaderboard, with the "indexed by Envio" label, and one live
  GraphQL query against the deployed indexer.

### MetaMask Agent Wallet: `mm xorv run`

- **What it does.** `@xorv/mm-plugin` adds native `mm xorv providers | quote | run | job | rate`
  commands to MetaMask's Agent Wallet CLI. `mm xorv run "<task>" --max 0.05` quotes the job and vets
  the quote: Monad only, at or under the ceiling, the amount equals the price, the payee is the
  quoted provider, and the buyer is not paying itself. It checks the USDC balance, then has
  **MetaMask sign the EIP-3009 authorization through `ctx.walletExecutor`**, so MetaMask policy,
  Guard Mode and 2FA apply. It recovers the signer before sending and returns the answer, the Monad
  settlement link and the XorvLedger receipt. `mm xorv rate` signs the gasless ERC-8004 rating the
  same way, after rebuilding the typed data locally and checking it field by field.
- **Bounty fit.** A real plugin built on the official template. The `package.json#mm` manifest
  declares per-command capabilities (`wallet-read`, `wallet-submit` only where needed) and
  `targetChains: [10143, 143]`. It uses typed-data signing only and never submits a transaction.
  A companion skill (`skills/xorv-metamask/SKILL.md`) teaches agents to use it.
- **Code.** `packages/mm-plugin/` ([README](packages/mm-plugin/README.md)): `src/commands/xorv/*.ts`,
  `src/lib/{executor,pay,vet,rate}.ts`.
- **In the demo.** `mm xorv providers`, then `mm xorv run …` with the MetaMask approval, the
  settlement link, and a rating.

### Mera: one passkey, many keys (private jobs)

- **What it does.** A **private job** keeps the answer for the buyer alone. Mera evaluates the
  WebAuthn PRF extension on a passkey in **three namespaced salts**. `xorv:inbox:v1` becomes an
  X25519 keypair, and its public key is the job's `encryptTo`: the provider seals the result on
  its own machine before sending it. `xorv:vault:v1` becomes an AES-256-GCM key that encrypts the
  buyer's private-job history. `xorv:vault-auth:v1` becomes an Ed25519 key held in a Mera signing
  session: its hash is the vault's id and its signatures authorize vault writes. **None of it signs
  a blockchain transaction.** Privy still pays. Nothing is persisted in the browser.
- **Bounty fit ("non-wallet use of PRF-derived key material", "live cross-device test").** The keys
  do encryption, identity and authorization, not account signing. The salts are namespaced and
  versioned. On a second device or a fresh profile with the same synced passkey, the same keys
  appear, the history decrypts and every result opens. The flow is tested with a fake *synced*
  authenticator.
- **Code.** `packages/protocol/src/{sealed,vault}.ts`, `apps/app/lib/private/{passkey,keyring,vault-client,result}.ts`,
  `apps/app/components/{private-keys,passkey-panel,private-result,private-history}.tsx`,
  `apps/app/app/private/page.tsx`, `packages/cli/src/node.ts` (sealing),
  `services/broker/src/vaults.ts`. Full design and threat model: [docs/PRIVATE_JOBS.md](docs/PRIVATE_JOBS.md).
- **In the demo.** The private toggle, the passkey prompts, the sealed result decrypting in the tab,
  then the same fingerprints and history on a second device.

### Qwen 3.8 Max: the job router, and two adapters

- **What it does.** When a buyer picks **Auto** and at least two adapters are live under the ceiling,
  the broker asks `qwen3.8-max` (thinking off, JSON mode) to choose the adapter. It sees the prompt
  and a table of live candidates: price, success rate, mean rating, mean Kimi score, ERC-8004
  identity. The pick must be one of those candidates, and the price matcher still chooses the node,
  so the router cannot steer a job to a particular provider or above the ceiling. If Qwen times out,
  errors, returns bad JSON or picks something off the table, the deterministic matcher takes over
  and the job records `routing.fallback`. Providers can also **sell** Qwen through the `qwen`
  adapter (streams reasoning and token cost) or the `qwen-code` adapter (drives the Qwen Code CLI
  with tools).
- **Code.** `services/broker/src/ai/router.ts`, `packages/protocol/src/llm.ts` (`LLM_PRESETS.qwen`),
  `packages/cli/src/adapters/hosted.ts`, `packages/cli/src/adapters/qwen-code.ts`.
- **In the demo.** The quote card reads "Routed by Qwen 3.8 Max to kimi (easy): …", and the job page's
  *Network checks* panel repeats it.

### Kimi K3: the result verifier that writes reputation

- **What it does.** After every completed, non-private job, `kimi-k3` scores the result 0–100 with a
  pass/fail, a rationale and flags. The prompt and result are fenced as untrusted data, and a result
  flagged as prompt injection never passes. When the provider has a verified ERC-8004 agent, the
  score is written to the **Reputation Registry** from the verifier EOA as
  `giveFeedback(agentId, score, 0, "xorv-verified", …)`. The feedback file is served at
  `/verifications/<jobId>.json`, and its keccak256 is the on-chain `feedbackHash`. Verification runs
  after the buyer has the result and never blocks the job. Providers can also sell Kimi through the
  `kimi` adapter.
- **Code.** `services/broker/src/ai/verifier.ts`, `services/broker/src/ai/feedback.ts`,
  `packages/cli/src/adapters/hosted.ts`.
- **In the demo.** The *Verified* row on the job page (for example "92/100 · pass" with Kimi's
  rationale) and its "ERC-8004 feedback" explorer link.

### Hunyuan hy4: the safety screen

- **What it does.** Every quote request is screened by `hy4-preview` (Tencent TokenHub) **before any
  provider can see the prompt and before anyone pays**. The screen looks for credential or key
  exfiltration, malware, destructive commands, sandbox escape, and prompt injection against the
  node. A block returns **HTTP 422** and no quote is issued. The quote freezes the screened request,
  so a prompt cannot be swapped after screening. The fail mode is explicit: with
  `XORV_SCREENER_FAIL=open` (the default), an unscreened quote is recorded as "not screened"; with
  `closed`, the broker returns 503 until the screen is back. Providers can also sell Hunyuan through
  the `hunyuan` adapter.
- **Code.** `services/broker/src/ai/screener.ts`, `services/broker/src/ai/client.ts` (shared deadline,
  validation, key redaction), `packages/cli/src/adapters/hosted.ts`.
- **In the demo.** "Screened by Hunyuan hy4: allowed — …" on the quote card and the *Screened* row on
  the job page. A hostile prompt is refused with a 422 before any quote exists.

All three roles are documented in [services/broker/README.md](services/broker/README.md). A missing
key turns a role off and never stops the broker. `GET /api/network` reports each role's state.

### ERC-8004 on Monad: identity and payment-backed reputation

- **Identity.** `xorv identity register` calls `IdentityRegistry.register(agentURI)` from the payout
  key. This makes that address both the owner and the agent wallet. `agentURI` is
  `<broker>/agents/<nodeId>.json`, the registration file the broker serves (`x402Support: true`).
  On registration, the broker checks that the claimed agent's `getAgentWallet` equals the node's
  payout address. `XorvLedger` enforces the same rule on every receipt.
- **Reputation.** Buyer ratings arrive under tag `starred` with `clientAddress == XorvLedger`, one
  per paid job, signed by the payer. Kimi scores arrive under `xorv-verified` from the verifier EOA.
  The two signals stay separable, and the indexer classifies them.
- **Code.** `packages/protocol/src/erc8004.ts`, `packages/cli/src/commands/identity.ts`,
  `packages/contracts/contracts/XorvLedger.sol`, `services/broker/src/app.ts` (`/agents`,
  `/feedback`, `/verifications`, `verifyAgent`).
- **Registries** (canonical v2.0.0): testnet Identity `0x8004A818BFB912233c491871b3d84c89A494BD9e`,
  Reputation `0x8004B663056A597Dffe9eCcC1965A193B7388713`; mainnet Identity
  `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Reputation `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`.

---

## Deployments

<!-- TODO(deploy): fill every TBD row after deploying; do not remove the rows. -->

| | Monad testnet (`eip155:10143`) |
|---|---|
| XorvLedger | TBD, fill in after deploy (`packages/contracts/deployments/monadTestnet.json`) |
| XorvLedger deploy tx | TBD |
| Broker operator EOA (ledger writes, rating relay, verifier) | TBD |
| Facilitator | TBD: self-hosted EOA address, or `https://x402-facilitator.molandak.org` |
| Example x402 settlement (buyer → provider USDC) | TBD |
| Example `recordJobs` receipt | TBD |
| Example `rateJob` → ERC-8004 feedback | TBD |
| Example Kimi `giveFeedback` (`xorv-verified`) | TBD |
| Demo provider's ERC-8004 agent | TBD (`https://testnet.monadscan.com/nft/0x8004A818BFB912233c491871b3d84c89A494BD9e/<agentId>`) |
| Envio GraphQL endpoint | TBD |
| Broker URL | TBD |
| App URL | TBD |
| Landing URL | TBD |
| USDC (Circle) | [`0x534b2f3A21130d7a60830c2Df862319e593943A3`](https://testnet.monadscan.com/token/0x534b2f3A21130d7a60830c2Df862319e593943A3) |
| ERC-8004 Identity / Reputation | `0x8004A818BFB912233c491871b3d84c89A494BD9e` / `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

The npm packages `@xorv/cli`, `@xorv/protocol` and `@xorv/mcp` at version 0.1.x are the **Hedera
prototype**. Until 0.2.0 is published, install from source (below).

---

## Quickstart

Needs Node 22.5+ and pnpm 10. Test USDC comes from <https://faucet.circle.com> (pick Monad Testnet) and
test MON from <https://faucet.monad.xyz>. **Buyers need USDC only.**

```bash
git clone https://github.com/nickthelegend/xorv-monad.git
cd xorv-monad
pnpm install && pnpm build
cp .env.example .env                   # every key is optional; see the comments in the file
pnpm setup:monad                       # read-only report: keys, balances, AI roles, what's missing
```

With **no keys at all**, the broker boots on Monad testnet. It matches and dispatches jobs, settles
payments through Monad's hosted facilitator, and serves the ledger read-only. Each key adds a
capability: `XORV_OPERATOR_KEY` enables ledger writes, rating relays and verifier feedback;
`XORV_FACILITATOR_KEY` self-hosts settlement; `DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY` and
`TOKENHUB_API_KEY` turn on the AI roles.

Then in three terminals:

```bash
pnpm broker                                    # coordinator + x402 resource server on :8402
node packages/cli/dist/index.js init           # once: pick adapters, prices, payout address
node packages/cli/dist/index.js start          # your provider node (or `pnpm link --global` for `xorv`)
pnpm app                                       # job board on :3002 (set NEXT_PUBLIC_PRIVY_APP_ID in apps/app/.env.local)
```

Buy a job from the terminal with a key that holds test USDC. It must be a different wallet from the
provider's payout address, because a provider cannot pay itself:

```bash
XORV_PAYER_KEY=0x… node packages/cli/dist/index.js run "Explain what a Merkle tree is, briefly." --max 0.02
```

Other buyers: the MCP server ([`packages/mcp/README.md`](packages/mcp/README.md)), the MetaMask plugin
([`packages/mm-plugin/README.md`](packages/mm-plugin/README.md)), and `xorv skills`, which installs
`/xorv` as a Claude Code slash command.

### Deploying

The full order of operations, with faucets, env lines and the Oct 10–13 indexer redeploy, is in [DEPLOY.md](DEPLOY.md). In short:

1. **Ledger.** `XORV_BROKER_ADDRESS=<operator address> pnpm deploy:ledger` deploys `XorvLedger` to
   Monad testnet (about 0.2 MON plus Monad's 10 MON account reserve). It checks that the registries
   report v2.0.0, writes `packages/contracts/deployments/monadTestnet.json`, and prints the
   `XORV_LEDGER_*` and `ENVIO_XORV_LEDGER_*` lines. Verify it with
   `pnpm --filter @xorv/contracts verify:testnet`. See [packages/contracts/README.md](packages/contracts/README.md#deploy-and-verify).
2. **Indexer.** Deploy `services/indexer` to Envio Cloud with the printed `ENVIO_*` variables, then
   set `XORV_INDEXER_URL` on the broker. See [services/indexer/README.md](services/indexer/README.md#deploying-to-envio-cloud).
3. **Broker.** `docker compose up -d` (SQLite in a volume; `--profile mongo` adds MongoDB). Set
   `XORV_PUBLIC_URL` to the broker's public https URL: it is written into on-chain agent and
   feedback URIs. Set `XORV_TRUST_PROXY=1` behind a proxy. `/metrics` speaks Prometheus.
4. **App and landing.** Deploy `apps/app` and `apps/landing` (Next.js) with `NEXT_PUBLIC_XORV_BROKER_URL`,
   `NEXT_PUBLIC_XORV_NETWORK` and `NEXT_PUBLIC_PRIVY_APP_ID`. Private jobs need an https domain,
   because passkeys are scoped to it.

---

## Repository map

```
xorv-monad/
├── packages/
│   ├── protocol/     @xorv/protocol: types, Monad chain table, viem helpers, x402 facilitator and
│   │                 buyer client, XorvLedger ABI + feed reader, ERC-8004 helpers, LLM presets,
│   │                 private-job crypto (sealed.ts, vault.ts); browser-safe entry at ./web
│   ├── contracts/    @xorv/contracts: XorvLedger.sol, Hardhat 3 tests, vendored ERC-8004 (test-only),
│   │                 deploy / verify / live-gas scripts
│   ├── cli/          @xorv/cli: the provider node and `xorv run`; adapters incl. qwen, kimi,
│   │                 hunyuan, qwen-code; `xorv identity`; OS sandbox
│   ├── mcp/          @xorv/mcp: MCP server; buyer on a local key or a Privy server wallet + policy
│   └── mm-plugin/    @xorv/mm-plugin: MetaMask Agent Wallet plugin, `mm xorv …`, companion skill
├── services/
│   ├── broker/       @xorv/broker: registry, matcher, x402 (upfront), facilitator, XorvLedger writer,
│   │                 rating relay, AI roles (src/ai), private-job vaults, SQLite/Mongo, metrics
│   └── indexer/      Envio HyperIndex v3 (own lockfile, outside the pnpm workspace)
├── apps/
│   ├── app/          xorv-app: job board; Privy wallet pays and rates; network, providers and
│   │                 private-jobs pages
│   └── landing/      xorv-landing: marketing site with the live XorvLedger receipts feed
├── e2e/                   `pnpm e2e`: the whole system on a Monad testnet fork, checked on-chain
├── docs/PRIVATE_JOBS.md   private jobs: derivations, envelope, vault, threat model, demo script
├── videos/xorv-launch/    HyperFrames trailer from the Hedera prototype (pre-existing)
└── brand/                 logo + mark
```

## Security notes

A provider runs prompts written by strangers, on their own machine, against their own paid account.
Every job runs in the strongest sandbox the host offers: seatbelt on macOS, bubblewrap on Linux, or a
container anywhere. On every host the environment is an allowlist, and under seatbelt and bubblewrap
the Xorv home (where a payout key would live), SSH keys and cloud credentials are unreadable.
`xorv doctor` names the tier. Windows gets the environment tier only. Providers can run **address-only**, with no key on the machine at
all. Buyers check every 402 against the frozen quote before signing, because a signed EIP-3009
authorization can be spent by whoever holds it. The Privy agent wallet and MetaMask each add their
own signing policy on top. The full threat model, including what is *not* protected, is in
[SECURITY.md](SECURITY.md), and the private-job limits are in [docs/PRIVATE_JOBS.md](docs/PRIVATE_JOBS.md#5-threat-model).

On terms of service: most consumer AI subscriptions are licensed to an individual, and reselling
that capacity may breach them. The `qwen`, `kimi` and `hunyuan` adapters use pay-as-you-go API
keys. Xorv is infrastructure and does not decide this for you.

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How it fits together on Monad, and why the awkward parts are the way they are |
| [SUBMISSION.md](SUBMISSION.md) | The Metropolis submission: track, bounties, requirement checklists, what's left |
| [RECORDING.md](RECORDING.md) | The 3-minute demo script and the 2-minute founder pitch |
| [SECURITY.md](SECURITY.md) | Threat model, key handling, payment safety, known limits |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup on Monad testnet, tests, the indexer, commit style |
| [CHANGELOG.md](CHANGELOG.md) | 0.2.0, the Monad port |
| [docs/PRIVATE_JOBS.md](docs/PRIVATE_JOBS.md) | Mera private jobs |
| [services/broker/README.md](services/broker/README.md) | The AI roles |
| [services/indexer/README.md](services/indexer/README.md) | The Envio indexer |
| [packages/contracts/README.md](packages/contracts/README.md) | XorvLedger, gas, deploy |
| [packages/cli/README.md](packages/cli/README.md) · [packages/mcp/README.md](packages/mcp/README.md) · [packages/mm-plugin/README.md](packages/mm-plugin/README.md) | The three non-browser buyers and the provider node |

## Licence

MIT, see [LICENSE](LICENSE). Vendored and third-party code keeps its own licence (see
[Attribution](#attribution-of-external-code)).
