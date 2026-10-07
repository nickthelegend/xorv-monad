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

**Demo video:** **TODO(deploy)** <!-- record RECORDING.md, paste the link --> ·
**App:** **TODO(deploy)** <!-- the apps/app Vercel URL, DEPLOY.md §5 --> ·
**XorvLedger:** [`0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD`](https://testnet.monadscan.com/address/0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD) (Monad testnet, [verified on Sourcify](https://sourcify-api-monad.blockvision.org/repo-ui/10143/0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD))

</div>

---

Millions of people pay for Claude, Codex, Qwen or Kimi and use a fraction of it. Anyone who wants one
job done has to buy a whole plan or an API key. Xorv is the rail between them. A provider runs one
command and their machine joins the network. A buyer (a person in a browser, a script, or another
AI agent) asks for a quote, signs one USDC authorization, and the job runs on the provider's machine.
The USDC moves **straight from buyer to provider** in a single Monad transaction that the network's
facilitator submits and pays gas for. The broker only introduces the two parties and never holds the
money. Every paid job is written to the `XorvLedger` contract. The buyer rates it with a free EIP-712
signature, and that rating becomes ERC-8004 reputation which only a paying buyer can give (and which
the broker refuses to relay when Nansen links the buyer's wallet to the provider's). Three sponsor
models sit in the core loop: Hunyuan screens every prompt, Qwen runs a tool-using agent that
reads ERC-8004 reputation, XorvLedger receipts and Envio aggregates on Monad before it picks the
provider for an "Auto" job, and Kimi verifies results and writes its score on-chain. The broker
itself is a paying agent too: it buys Nansen wallet data per call, over x402 on Monad, to score
every provider's payout wallet.

When the broker runs its own facilitator, the buyer can pay into **XorvEscrow** instead: the USDC
waits in the contract until the job delivers, is released to the provider with the result's hash,
and is refunded in full if the job fails, is cancelled or misses its deadline. A **Chainlink CRE**
workflow refunds expired jobs even if the broker is gone, and an optional **Cleanverse** gate lets
only parties holding a valid A-Pass fund or be paid.

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
  the wallet that paid for that job. The ledger itself refuses a receipt the provider paid for and a
  rating from the agent's own wallet, owner or operators (`SelfDealing`), and the broker refuses to
  relay a rating when Nansen links the buyer's wallet to the provider's (one funded the other, a
  shared non-exchange funder, related wallets). `getSummary(agentId, [ledger], "starred", "")` is
  therefore a score built from paid jobs by independent buyers, and any other marketplace can read it.
- **Money that waits for the work.** `XorvEscrow` holds an escrowed job's USDC until delivery. The
  release carries the result's hash, and a refund needs no one's permission once the deadline has
  passed: the Chainlink CRE refund keeper sends it with no broker involved. `XorvLedger`'s receipt
  points at the release, so ERC-8004 reputation is still credited only for delivered, paid work.
- **Identity-gated value (Cleanverse CVI).** With `CleanverseGate` set on the escrow, funding needs
  a valid Cleanverse A-Pass on both buyer and provider, and payouts need one on the payee. A frozen,
  revoked or expired credential stops the money, but refunds are never gated.
- **AI trust services in the loop.** A safety screen protects provider machines, and a verifier
  publishes an independent quality score to the same registry under a separate tag.
- **Wallet trust, bought agent to agent.** The broker pays Nansen a cent per call in USDC over x402
  on Monad for each provider's payout-wallet history, and turns it into a trust score that breaks
  matching ties and is shown, with attribution, on every provider.

## For judges: use it in one command

```bash
pnpm install && pnpm build && (cd contracts && forge build) && pnpm demo
```

`pnpm demo` runs the whole product on your machine against **real contract code**, with no keys
and no testnet funds:
- a local fork of Monad testnet (anvil, 300 ms blocks like Monad's) with Circle's real USDC and the canonical
  ERC-8004 registries;
- XorvLedger and XorvEscrow;
- the broker, with its self-hosted facilitator;
- two provider nodes, each registered as an ERC-8004 agent;
- seeded paid jobs: escrowed and released, one cancelled and refunded, two rated into ERC-8004;
- the web app at <http://localhost:8652>, with a funded demo account so you can post a job and pay.

Every transaction is real and signed on the fork, and the keys it generates exist only there.
Ctrl-C stops everything. It needs Node 22.18+, pnpm 10 and Foundry (`anvil`, `forge`).

### Verify: every test suite

```bash
pnpm install && pnpm build && pnpm test
```

**1,234 tests pass** (counted on 2026-10-07 by running every workspace suite once, one after another,
on macOS with Node 26). On Windows, 14 POSIX-only CLI cases (sandbox tiers and file modes) are
skipped. The Foundry contracts, the indexer and the CRE workflow add 146 more (below the table). They need **no keys, no RPC and no testnet funds**: the x402 facilitator and the
XorvLedger writer are stubbed at the chain boundary, the contracts run on Hardhat's in-process chain
against the real ERC-8004 v2.0.0 registry code, and the hosted models are scripted `fetch` stubs.
You need Node 22.18+ (the workspace floor, set by `package.json` engines; the broker alone needs 22.13+
for `node:sqlite`, and the CLI and MCP server run on 20.19+) and pnpm 10. The first `pnpm build`
downloads the Solidity compiler through Hardhat. CI runs the same commands on Node 22 and 24
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

| Package | Tests | What they cover |
|---|---:|---|
| `packages/protocol` | 267 | Monad chain table, viem helpers and the signer lock, money math, the x402 facilitator and the quote-bound buyer client, the x402 `escrow` scheme (server, client, facilitator; two runs against a real escrow on anvil when `forge` is installed), the XorvLedger ABI and 100-block feed reader, ERC-8004 helpers, model presets and the SSE reader, private-job crypto (known-answer vectors, `node:crypto` cross-checks), the tool-calling chat turn |
| `packages/contracts` | 59 | `XorvLedger` against the real ERC-8004 v2.0.0 registries, self-dealing refusals, EIP-7702 and ERC-1271 rating signatures, the ABI pin, the gas report, the Monad testnet fork config |
| `packages/cli` | 267 | every adapter including `qwen`, `kimi`, `hunyuan` and `qwen-code`; the sandbox; `init`, `wallet` and `identity`; `xorv run`'s checks before signing; private-job sealing; `xorv start`'s log off a terminal; the earnings ledger |
| `packages/mcp` | 83 | the real server over stdio against a mock broker that verifies signatures, the Privy signer with a fake client, the session budget, the Privy policy |
| `packages/mm-plugin` | 74 | every `mm xorv` command on a mocked MetaMask context, the signer, the payment policy, the manifest |
| `services/broker` | 353 | the full HTTP lifecycle, receipt batching and retries, indexer-first feeds, the AI roles including the agentic Qwen router's tool loop, private jobs and vaults, Nansen trust signals over x402 and the wash-rating guard, the review's security fixes (session-token re-registration, frame validation, streamed body limits, self-payment refusal), the escrow lifecycle (release with the result hash, refund on failure and cancel, on-chain re-pointing, unverified providers never quoted) |
| `apps/app` | 116 | the x402 payment helper, JSON-safe typed data for Privy, ratings, bounded demo routes, the Mera keyring with a synced authenticator, the Nansen trust panels, the router trace |
| `apps/landing` | 15 | the broker feed parsers |
| **Total** | **1,234** | |

Outside the pnpm workspace:
- **`contracts/`** (Foundry): 76 tests for `XorvEscrow`, `XorvRefundKeeper` and `CleanverseGate`,
  including invariants, via `forge test`. Fork tests against Monad testnet are opt-in.
- **`services/indexer`**: Envio ships no Windows binary. Its 66 tests run with `pnpm test` there on
  macOS or Linux, or in a Linux container with the one command in
  [`services/indexer/README.md`](services/indexer/README.md#tests-in-a-throwaway-container-works-from-windows).
- **`cre/refund-keeper`**: 4 tests with `bun test`.

### What is proven, and what isn't yet

| | Status |
|---|---|
| Quote → 402 → EIP-3009 signature → upfront settlement → dispatch → result → receipt, through the real Hono app, the real x402 resource server and the real WebSocket hub | Integration test, `services/broker/test/integration.test.ts` |
| **The whole system on a fork of Monad testnet**: Circle's real USDC and the canonical ERC-8004 registries, XorvLedger deployed by its own script, the built broker, a real `xorv` provider node, `xorv run --json`, the MCP server over stdio and a private job; 189 checks read back off the chain (USDC transfers with the buyer holding no MON, `ProviderRegistered`/`JobRecorded`/`JobRated`, Kimi's and the buyers' `NewFeedback`, the sealed envelope's receipt hash) | `pnpm e2e` ([`e2e/README.md`](e2e/README.md)); last green run in [`e2e/last-run.md`](e2e/last-run.md). Needs the Monad testnet RPC, no keys or funds |
| **The escrow on a fork of Monad testnet**: `XorvEscrow` deployed beside XorvLedger; `xorv run` funds it (buyer → escrow, buyer holds no MON), the release pays the provider with the result's hash, `JobRecorded.paymentTx` is the release, a cancel refunds in full with no fault, and a `CleanverseGate` over Cleanverse's **real A-Pass** refuses an unverified buyer with nothing moved, then lets them pay once issued one; 31 checks | `pnpm e2e:escrow`; last green run in [`e2e/last-run-escrow.md`](e2e/last-run-escrow.md) |
| `XorvEscrow`, `XorvRefundKeeper`, `CleanverseGate`: fund, release, refund, reassign, cancel, deadlines, the attester, the CRE report path, the gate on every payout; invariants (the escrow always holds what it owes); fork tests against Monad testnet's real A-Pass, validator, USDC and AUSD | `cd contracts && forge test` (76 tests), `forge test --match-path 'test/*.fork.t.sol' --fork-url https://testnet-rpc.monad.xyz` |
| The CRE refund keeper: only refundable jobs reach the report, DON time sets the cut-off, empty, ahead-of-chain and unreachable index | `cd cre/refund-keeper && bun test` on the CRE SDK's test runtime; compiles to WASM |
| `XorvLedger` receipts, `payTo == agentWallet`, one rating per job, EOA, EIP-7702 and ERC-1271 signatures, `SelfDealing` refusals (self-paid receipts, ratings from the agent's own wallet, owner or operators), the owner named at deploy, forwarding into the real ERC-8004 Reputation Registry | Contract tests, `packages/contracts/test/{XorvLedger,owner}.test.ts`; the `SelfDealing` revert also confirmed against the live registries by `gas:monad` |
| Gas for every call the broker pays for, measured on **live Monad** with state overrides (nothing deployed) | `pnpm --filter @xorv/contracts gas:monad`, table in [`packages/contracts/README.md`](packages/contracts/README.md#gas) |
| MetaMask plugin manifest accepted by MetaMask's own `PluginManifestSchema`; `providers` and `quote` run inside Agent Wallet 7.0.0 | `packages/mm-plugin/test/manifest.test.ts`, example session in [`packages/mm-plugin/README.md`](packages/mm-plugin/README.md#example-session) |
| Private job keys reproduced on a second (simulated, synced) authenticator | `apps/app/test/private-keyring.test.ts` |
| Nansen x402 payments: only the Monad mainnet USDC row of Nansen's real 402s is paid, at the captured price, under a per-call cap and a daily budget; a related-wallet rating refused with 403 and nothing relayed | `services/broker/test/trust.test.ts` (replays the captured 402s), "Nansen trust" in `services/broker/test/integration.test.ts` |
| **XorvLedger deployed on Monad testnet** | ✅ [`0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD`](https://testnet.monadscan.com/address/0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD), deploy tx [`0xb342175f…`](https://testnet.monadscan.com/tx/0xb342175f22adb752d95400eb16288425c403c3f44427735f8439a234453dacc3) in block 66379818, source verified on [Sourcify](https://sourcify-api-monad.blockvision.org/repo-ui/10143/0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD); wired to the canonical ERC-8004 registries (`packages/contracts/deployments/monadTestnet.json`) |
| **A job paid and receipted on Monad testnet** | ✅ A live `xorv run` job: x402 settlement [`0x579205fe…`](https://testnet.monadscan.com/tx/0x579205fe205b8069682f147377efd6d9a6ca404e2c1c6ea95312853a921202d7), where Monad's public facilitator paid the gas and 0.01 USDC moved buyer → provider (the buyer holds no MON); then `JobRecorded` on XorvLedger [`0xbddafbf6…`](https://testnet.monadscan.com/tx/0xbddafbf69499df11f5c0289b4cefb6491cd0b168fd799bae2c77145dd855c6c7), carrying that payment tx and the result hash |
| **XorvEscrow, the refund keeper and the Cleanverse gate on Monad testnet** | **Not yet. TODO(deploy)**: testnet deploys are on hold; the runbook is [docs/DEPLOY-LATER.md](docs/DEPLOY-LATER.md) |
| **A CRE simulation broadcasting a refund** | **Not yet. TODO(deploy)**: `cre workflow simulate refund-keeper --target staging-settings --broadcast` after `cre login` and the escrow deploy |
| **Rated and verified on Monad testnet** | **Not yet. TODO(deploy)**: `rating.txHash` and `verification.feedbackTxHash` from `curl -s <broker>/api/jobs/<job>` (needs the provider's ERC-8004 identity and `MOONSHOT_API_KEY`) |
| **An MCP agent paying from a policy-bounded Privy server wallet on Monad testnet** | **Not yet. TODO(deploy)**: the `Payment:` link `xorv_run_job` prints |
| **Envio indexer live on Envio Cloud** | **Not yet. TODO(deploy)**: the endpoint from `envio-cloud deployment endpoint <indexer> <commit>`, deployed between Oct 10 and 13 (see [SUBMISSION.md](SUBMISSION.md#before-you-submit)) |
| **A Nansen call paid over x402 on Monad mainnet** | **Not yet. TODO(deploy)**: `curl -s <broker>/api/network \| jq -r .nansen.lastPaidTx.url`, with a mainnet key holding a few USDC (or one lookup with `pnpm nansen:probe --mode live <address>`) |

Nothing in this README claims an on-chain transaction that isn't linked. Every **TODO(deploy)** names
the command or file its value comes from, and is filled in after deployment.

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
| Envio indexer | HyperIndex v3 over XorvLedger, XorvEscrow and the ERC-8004 Identity and Reputation registries, with 15 entity types including derived aggregates. The broker reads it first and falls back to RPC. | `services/indexer/`, `services/broker/src/{indexer,ledger-reader}.ts` |
| Privy | Embedded wallet created at login pays per job and signs gasless ratings. MCP agent buyer on a Privy server wallet bound to a signing policy. | `apps/app/components/{providers,wallet-provider}.tsx`, `packages/mcp/src/{signer,privy-policy}.ts` |
| Nansen wallet trust | The broker pays Nansen per call over x402 on Monad mainnet; provider trust score, wash-rating guard, matching tie-breaker. | `services/broker/src/trust/`, `apps/app/components/trust.tsx`, [`docs/NANSEN.md`](docs/NANSEN.md) |
| MetaMask Agent Wallet | `@xorv/mm-plugin`: `mm xorv providers/quote/run/job/rate`, signing only through `ctx.walletExecutor`, plus a companion agent skill. | `packages/mm-plugin/` |
| Qwen 3.8 Max, Kimi K3, Hunyuan hy4 | Provider adapters (`qwen`, `kimi`, `hunyuan`, `qwen-code`) and the broker's core-loop roles: Hunyuan screens, Qwen runs a tool loop over Monad data and picks the provider, Kimi verifies and writes ERC-8004 feedback. | `packages/cli/src/adapters/{hosted,qwen-code}.ts`, `services/broker/src/ai/`, `packages/protocol/src/llm.ts` |
| `XorvEscrow` and the x402 `escrow` scheme | Buyer signs EIP-3009 `ReceiveWithAuthorization` into the escrow. Release with the result hash, refund (anyone, after the deadline), on-chain re-pointing on reassignment, cancel. Facilitator, broker, CLI, MCP, app and e2e support. Foundry tests, invariants and fork tests. | `contracts/`, `packages/protocol/src/escrow.ts`, `services/broker/src/escrow.ts`, `e2e/src/escrow.ts` |
| Chainlink CRE refund keeper | A CRE workflow: cron → Envio query (DON consensus) → `isRefundable` reads on Monad → one signed report → `XorvRefundKeeper.onReport` → refunds. | `cre/refund-keeper/`, `contracts/src/XorvRefundKeeper.sol` |
| Cleanverse CVI gate | `CleanverseGate` reads Cleanverse's A-Pass validity and validator. It gates escrow funding and payouts (never refunds); the facilitator refuses an unverified party before signing, and the broker never quotes an unverified provider. | `contracts/src/CleanverseGate.sol`, `services/broker/src/identity.ts` |
| Mera private jobs | Passkey-PRF keys in three namespaces. Results sealed on the provider to the buyer's inbox key. An encrypted history vault that decrypts on a second device. | `packages/protocol/src/{sealed,vault}.ts`, `apps/app/lib/private/`, [`docs/PRIVATE_JOBS.md`](docs/PRIVATE_JOBS.md) |
| Bug fixes found during the port | Settlement used to run *after* dispatch, so a provider could work on a payment that never settled. A settlement was matched to "the latest unpaid job for this payee" and could swap two buyers' records; it is now matched by quote id. Reassignment kept stale timestamps, credited the wrong provider, and could resurrect a finished job. A double-click could settle one quote twice. Anyone who knew a public job id could cancel it; cancelling now needs a one-time token. Provider ids changed on every broker restart. The sandbox's deny rules missed a relocated `XORV_HOME`. | commits `fb7f041`, `b6e8ba6`, `2b3bdeb` |
| Fixes from an adversarial review (52 confirmed findings) | Re-registering a live node needs its session token, and node ids stay off-chain (agent URIs use the provider id). The broker refuses self-payment, and `XorvLedger` refuses self-paid receipts and ratings from the agent's own wallets. The ledger owner is named at deploy (`XORV_LEDGER_OWNER`), never the broker key. EIP-7702 buyers can rate. The demo routes (`/api/pay`, `/api/rate`) are rate-limited, capped per day and receipt-gated. Vaults are disk-backed with byte caps. Plus Privy's sign modal, WebSocket frame validation, private-job redaction, the Nansen budget and more, listed in the [CHANGELOG](CHANGELOG.md#fixed-after-an-adversarial-review-52-confirmed-findings). | commits `7b6f014`…`c4f6d14` |

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
| forge-std, OpenZeppelin Contracts (Foundry) | git submodules in `contracts/lib/` | MIT / Apache-2.0 (forge-std), MIT (OpenZeppelin) |
| Chainlink CRE SDK (`@chainlink/cre-sdk`) | dependency of `cre/refund-keeper` | see the package's licence |
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
   │                                          Qwen tool loop for "Auto": reads ERC-8004 reputation,
   │                                          XorvLedger receipts, Envio stats, Nansen trust → picks
   │                                          the provider (else the matcher, reputation tie-break)
   │                                          → frozen quote:
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
   │ 6  buyer signs an EIP-712 Rating (free) ─► broker asks Nansen: buyer and provider related? (403 if so)
   │                                            relays XorvLedger.rateJob
   │                                            └─► ERC-8004 ReputationRegistry.giveFeedback ("starred")
   ▼
 Envio HyperIndex follows XorvLedger + ERC-8004 → GraphQL → broker /api/leaderboard, /api/ledger
   → app network and providers pages, landing ledger

 Nansen (paid per call, x402 exact USDC on Monad mainnet) ← broker: provider wallet trust on
   registration, the related-wallet check before each rating relay, a tie-breaker in matching
```

**With the escrow** (`XORV_ESCROW_ADDRESS` and a self-hosted facilitator), step 2's 402 offers
`escrow` first: `payTo` is the escrow, and `extra` names the provider, the job id and the deadline
(buyers accept it only when both match the frozen quote). In step 3 the facilitator calls `XorvEscrow.fund` with a `ReceiveWithAuthorization`, so the
USDC goes buyer → escrow. After step 4 the broker calls `release(jobId, resultHash)` (escrow →
provider) or `refund`, and the step-5 receipt's payment tx is the release. A reassigned job is
re-pointed on-chain first. If the broker is gone, the Chainlink CRE workflow in `cre/` refunds every
job past its deadline, reading expired jobs from Envio and checking each on Monad.

Three rules hold the design together. They are explained in [ARCHITECTURE.md](ARCHITECTURE.md):

1. **The broker is never the payee.** The 402's `payTo` is the matched provider's own address, so the
   USDC moves buyer → provider in one transfer, or, when escrowed, buyer → escrow → provider, where
   the escrow can only pay the job's current provider or refund its buyer. The protocol fee is 0%.
2. **A quote is a price commitment.** x402 asks for the payment requirements twice, and both answers
   are read from the frozen quote. Buyers refuse any 402 that differs from it (`quoteMatchPolicy`).
3. **Pay first, then work, with free reassignment.** Settlement lands before dispatch. If the
   provider fails, the job goes to another provider at no extra charge (up to three providers in
   total), and the failure counts against the original provider's success rate.

---

## Sponsor integrations

Xorv is entered in Track 04, so it can take the bounties marked **All tracks** and the Track 04 ones
(the full checklists are in [SUBMISSION.md](SUBMISSION.md#bounties-entered)). Each subsection quotes
the portal card, then says what the integration does in the product, how it meets the card, where the
code is, and where it appears in the demo ([RECORDING.md](RECORDING.md)).

**Bounties entered:** Privy, Envio, Nansen, Kimi, Mera (One Passkey, Many Keys), Qwen 3.8 Max,
Chainlink CRE, Cleanverse CVI/CVA.

### Privy: the account that pays, rates, and runs agents

> **Bounty card** (Privy · All tracks · $5,000 USD): "Integrate Privy beyond authentication —
> login-only integrations will not qualify."

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
- **In the demo.** Three Privy features in the main flow: log in and see the embedded wallet appear
  in the header; pay from it (its signature modal shows the `TransferWithAuthorization`); rate with a
  free EIP-712 signature from the same wallet; then an MCP agent in Claude Code pays from the
  policy-bounded server wallet, with the policy's rules on the Privy dashboard and its id in
  `xorv_wallet`'s output ([RECORDING.md](RECORDING.md) 0:08–1:40).

### Envio: the network's memory

> **Bounty card** (Envio · All tracks · $1,000 USD): "Meaningfully use Envio's HyperIndex,
> HyperSync, or HyperRPC to power real on-chain data driving a core feature in your app."

- **What it does.** A HyperIndex v3 indexer follows **four contracts**: `XorvLedger` (6 events),
  `XorvEscrow` (4) and the ERC-8004 Identity (4) and Reputation (3) registries. It uses HyperSync, with configs for
  testnet (`config.yaml`) and mainnet (`config.mainnet.yaml`). It derives **15 entity types**, including each escrowed job's lifecycle (`EscrowJob`: funded,
  reassigned, released or refunded), which the Chainlink CRE refund keeper queries. The others
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
- **Bounty fit ("real on-chain data driving a core feature", depth).** Multiple contracts, a
  non-trivial schema, derived and aggregated entities, and a trust classification. The repo includes
  `config.yaml`, `schema.graphql`, the handlers, and 66 handler/ABI/query tests.
- **Code.** `services/indexer/` ([README](services/indexer/README.md)): `config.yaml`,
  `schema.graphql`, `src/handlers/*.ts`, `src/lib/{aggregates,trust,entities}.ts`, `src/queries.ts`.
- **It drives matching and routing too.** The Qwen router's `indexer_provider_stats` and
  `recent_receipts` tools read the indexer while choosing a provider. When no router runs, the
  deterministic matcher breaks price ties on reputation from the indexer: buyer ratings and Kimi
  verifier scores, shrunk toward a neutral prior (`services/broker/src/ai/reputation-book.ts`, one
  batched GraphQL query a minute at most). It falls back to the broker's own jobs when there is no
  indexer.
- **Deployment.** **TODO(deploy)**: the Envio Cloud GraphQL endpoint (`envio-cloud deployment endpoint
  <indexer> <commit>`). Envio Cloud's free plan keeps a deployment for 30 days, so it is deployed
  between Oct 10 and 13.
- **In the demo.** The network page and leaderboard, with the "indexed by Envio" label, and one live
  GraphQL query against the deployed indexer.

### Nansen: wallet trust the broker buys per call, over x402 on Monad

> **Bounty card** (Nansen AI · All tracks · $5,000 USD total prize pool): "Build a product
> experience powered by Nansen data/API/MCP/CLI that goes beyond exposing raw data."

- **What it does.** When a provider's node opens its control socket (not at registration, which
  is free and unauthenticated), the broker looks up its payout wallet on Nansen in the background:
  who first funded it and when (cross-chain), what it is linked to on Monad, and its Monad
  activity. It folds the answers into a **0–100 trust score** with written rules
  (age, exchange funding, activity, risky counterparties) that **never penalise missing data**, so a
  testnet-only wallet reads "No wallet history", not "low". That signal does three jobs. (1) It is
  shown on every provider: the badge on each row, and on `/providers/<id>` the wallet's age, first
  funder, activity, risk flags and "Xorv paid Nansen $0.03 over x402 on Monad" with each settlement
  linked on Monadscan. (2) **It stops wash ratings.** Before relaying a rating into ERC-8004 the
  broker checks whether buyer and provider are one party: the same wallet, one funded the other, a
  shared first funder that is not an exchange or bridge, or listed as related wallets. If so the
  rating is refused with **403 `related_wallets`**, nothing is relayed, and the check is stored on
  the job. A lookup that fails or times out never blocks an honest rating. 30% of the daily budget
  is reserved for these checks, and one that can't run because the budget is spent defers the rating
  (503 `trust_budget_spent`) rather than relaying it unchecked. (3) It breaks ties between equally
  priced providers in matching (at most ±0.1 on the 0–1 reliability scale, so it never beats a
  cheaper node or a real track record). The network page's *Wallet intelligence* panel shows what
  the broker bought today: the mode, the payer, calls and spend against the budget, the last payment
  and how many ratings were checked and refused.
- **How it pays.** Nansen answers with an x402 v2 402 whose Monad row is `exact` USDC on
  **mainnet** (`eip155:143`), $0.01 per profiler call. The broker's client registers only that
  network, hard-codes mainnet USDC, validates every request locally first (Nansen charges before it
  validates), checks the price per endpoint, caps each payment, reserves against a daily budget
  (released if signing or settlement fails) and keeps the settlement transaction with the cached
  answer. A few dollars of mainnet USDC on a separate key (`XORV_NANSEN_PAYER_KEY`) covers weeks;
  `NANSEN_API_KEY` takes precedence when set.
- **Modes.** `XORV_NANSEN_MODE=off` (the default: the app says Nansen is not configured) or `live`
  (`XORV_NANSEN_PAYER_KEY` or `NANSEN_API_KEY`). Recorded-shape Nansen answers exist only in the
  broker's tests (`services/broker/test/nansen-fixtures.ts`); a running broker refuses `fixture`.
- **What stays internal.** Nansen's redistribution guide keeps labels, smart-money data and
  leaderboards internal. Smart-money membership only nudges matching and never leaves the broker;
  related-wallet addresses are used for the sybil check and not published. Answers are cached
  briefly (a first funder for 7 days, related wallets for a day, activity for an hour). Everything
  shown carries "Powered by Nansen", linked to nansen.ai.
- **Bounty fit ("a product experience … that goes beyond exposing raw data").** Nansen's answers
  become decisions the product acts on (a refused rating, a ranking) and one explained number per
  provider, paid for agent to agent over x402 on Monad.
- **Code.** `services/broker/src/trust/{nansen,signal,service}.ts`,
  `services/broker/src/app.ts` (registration, `/api/providers/:id`, the rate guard, `/api/network`
  `nansen`), `services/broker/src/registry.ts` (`TRUST_TIEBREAK_WEIGHT`),
  `services/broker/src/scripts/nansen-probe.ts`, `apps/app/lib/trust.ts`,
  `apps/app/components/trust.tsx` (badge, *Wallet trust* panel, *Wallet intelligence* panel, "Powered
  by Nansen"), used by `live-lists.tsx`, `provider-view.tsx`, `network-view.tsx` and `rate-job.tsx`.
  Full design: [docs/NANSEN.md](docs/NANSEN.md).
- **In the demo.** The provider's trust badge and panel with its Monad mainnet payment links, then a
  rating from a wallet the provider funded, refused.

### Kimi K3: the result verifier that writes reputation

> **Bounty card** (Kimi · All tracks · $3,000 in credits): "Build a project genuinely powered by
> KIMI (Moonshot AI) — open scope, no category restrictions."

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

### Mera: one passkey, many keys (private jobs)

> **Bounty card** (Monad Foundation · All tracks · $2,500 USD): "Most creative non-wallet use of
> Mera's PRF-derived key material."

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

### Qwen 3.8 Max: an agent that reads Monad before it routes a job

> **Bounty card** (Alibaba Cloud · Trust, Identity & AI Infrastructure · $5,000 in credits): "Push
> Qwen 3.8 Max into genuinely agentic territory on Monad."

- **What it does.** When a buyer picks **Auto** and more than one live option fits under the ceiling,
  `qwen3.8-max` runs a bounded tool loop and chooses the **provider** that runs the job, not just the
  adapter. Its tools read Monad state:
  - `list_candidates`: the live, matchable providers under the buyer's ceiling (adapter, model,
    price, liveness, success stats, ERC-8004 agent id).
  - `erc8004_reputation(agentId)`: `getSummary` on the ERC-8004 **Reputation registry** for the
    XorvLedger client (payment-backed buyer ratings) and the verifier client (Kimi scores), plus the
    **Identity registry**'s agent-wallet check.
  - `recent_receipts(providerId)`: the provider's `JobRecorded` / `JobRated` events on **XorvLedger**,
    through the broker's ledger reader (Envio first, RPC fallback).
  - `indexer_provider_stats(providerId)`: the **Envio** indexer's `Provider` and `Agent` aggregates
    (success rate, average rating, earnings, verified score). It says so when no indexer is set.
  - `nansen_trust(providerId)`: the public view of the payout wallet's **Nansen** trust signal.
  - `select_provider({providerId, reason})`: the terminal pick.
- **Bounded and checked.** At most 4 model turns and 6 reads inside a 15 s budget
  (`XORV_ROUTER_TIMEOUT_MS`). Every read has its own timeout and a short cache. Thinking is on, with a
  256-token budget (`XORV_ROUTER_THINKING_BUDGET`). Model Studio documents non-streaming thinking for
  the commercial `qwen3.8-max`, and `tool_choice` stays `auto` because Qwen refuses `required` while
  thinking. The pick must be a live candidate under the ceiling, and a made-up one gets one retry. A
  timeout, provider error or invalid pick records `routing.fallback`, and the deterministic matcher
  takes over.
- **Visible.** `routing.steps` records every tool call with validated ids, a templated summary and
  explorer links (for example, "read agent #12's ERC-8004 reputation on Monad (avg 92 from 5 buyer
  ratings)"). The quote card and the job page render it as an agent trace. Nothing the model writes
  reaches the trace, and a private job's public record withholds the model's reason.
- **Also sold as capacity.** Providers can sell Qwen through the `qwen` adapter (streams reasoning and
  token cost) or the `qwen-code` adapter (drives the Qwen Code CLI with tools).
- **Code.** `services/broker/src/ai/router.ts`, `router-tools.ts`, `router-data.ts`,
  `apps/app/components/routing-trace.tsx`, `apps/app/lib/ai.ts`, `packages/protocol/src/llm.ts`
  (`LLM_PRESETS.qwen`, the tool-calling chat turn), `packages/cli/src/adapters/{hosted,qwen-code}.ts`.
  Tests: `services/broker/test/ai.test.ts` (multi-turn tool loop, each tool's data mapping, invalid
  pick, timeout and turn caps, private jobs), `apps/app/test/ai.test.ts`, and the e2e harness's mock
  Qwen driving the tool loop against the Monad fork.
- **In the demo.** An Auto quote shows the trace: Qwen listing candidates, reading ERC-8004
  reputation and XorvLedger receipts on Monad, then picking a provider.

### Chainlink CRE: refunds that don't need the broker

> **Bounty card** (Chainlink · All tracks · $3,000 USD): "Build, simulate, or deploy a Chainlink
> Runtime Environment (CRE) Workflow used as an orchestration layer within your project."

- **What it does.** An escrowed job promises the buyer a refund if the work is not delivered by the
  deadline. `cre/refund-keeper` keeps that promise without the broker. On a cron trigger it queries
  the Envio index for funded jobs past their deadline (HTTP with DON consensus), reads
  `XorvEscrow.isRefundable` for each on Monad, and writes one DON-signed report. The report goes
  through the KeystoneForwarder to `XorvRefundKeeper.onReport`, which refunds each job (per-job
  try/catch, a batch cap).
- **Bounty fit.** CRE is the orchestration layer between three systems: the indexer, the chain
  reads and the on-chain receiver. It is tested on the CRE SDK's own test runtime and compiles to
  WASM; `cre workflow simulate --broadcast` is the live step.
- **Code.** `cre/refund-keeper/` ([README](cre/README.md)), `contracts/src/XorvRefundKeeper.sol`.
- **Live.** **TODO(deploy)**: the simulation's refund tx, after `cre login` and the escrow deploy
  ([docs/DEPLOY-LATER.md](docs/DEPLOY-LATER.md)).

### Cleanverse: identity-gated value movement

> **Bounty card** (Cleanverse · Trust, Identity & AI Infrastructure · $2,000 USD): "Build an app that
> gates CVA asset movement behind on-chain CVI identity verification."

- **What it does.** `CleanverseGate` reads Cleanverse's own A-Pass on Monad (valid means not
  frozen, revoked or expired) and, once a pool is registered, the compliance validator. Set on the
  escrow, it blocks funding unless buyer and provider both verify, and blocks release and
  reassignment unless the payee does. Refunds are never gated. The facilitator refuses an
  unverified party before signing (`identity_not_verified`), the broker never quotes or reassigns to
  a provider without an A-Pass, and the network page shows the gate.
- **Evidence.** Fork tests against the real A-Pass and validator on Monad testnet (issue, freeze,
  revoke, expiry, an unregistered pool failing closed); the `pnpm e2e:escrow` gate stage.
- **CVA (blocked).** Moving aUSDC itself needs Cleanverse to onboard the app: every unregistered
  pool reverts `PoolNotRegistered()`, and every aUSDC transfer on a fork reverts
  `TransferNotAllowed()`. The gate moves USDC and AUSD today, and aUSDC once the pool is registered.
- **Code.** `contracts/src/CleanverseGate.sol`, `contracts/test/CleanverseGate*.t.sol`,
  `services/broker/src/identity.ts`.

### Also built (not entered: track-locked to other tracks)

The MetaMask plugin and the Hunyuan screen are part of the product and its tests. Their bounties name
a different track on the card, so a Track 04 project can't enter them, and neither has a beat of its
own in the main demo.

#### MetaMask Agent Wallet: `mm xorv run`

> **Bounty card** (Metamask · Onchain Finance & Trading · $2,500 USD): "Build a plugin that gives
> the MetaMask Agent Wallet a new trading superpower via its plugin architecture."

Not entered: the card is locked to another track and asks for a trading plugin. The plugin stays
as one of Xorv's four buyer clients.

- **What it does.** `@xorv/mm-plugin` adds native `mm xorv providers | quote | run | job | rate`
  commands to MetaMask's Agent Wallet CLI. `mm xorv run "<task>" --max 0.05` quotes the job and vets
  the quote: Monad only, at or under the ceiling, the amount equals the price, the payee is the
  quoted provider, and the buyer is not paying itself. It checks the USDC balance, then has
  **MetaMask sign the EIP-3009 authorization through `ctx.walletExecutor`**, so MetaMask policy,
  Guard Mode and 2FA apply. It recovers the signer before sending and returns the answer, the Monad
  settlement link and the XorvLedger receipt. `mm xorv rate` signs the gasless ERC-8004 rating the
  same way, after rebuilding the typed data locally and checking it field by field.
- **What it is.** A real plugin built on the official template. The `package.json#mm` manifest
  declares per-command capabilities (`wallet-read`, `wallet-submit` only where needed) and
  `targetChains: [10143, 143]`. It uses typed-data signing only and never submits a transaction.
  A companion skill (`skills/xorv-metamask/SKILL.md`) teaches agents to use it.
- **Code.** `packages/mm-plugin/` ([README](packages/mm-plugin/README.md)): `src/commands/xorv/*.ts`,
  `src/lib/{executor,pay,vet,rate}.ts`.
- **In the demo.** Only as an optional cutaway: `mm xorv providers`, then `mm xorv run …` with the
  MetaMask approval and the settlement link.

#### Hunyuan hy4: the safety screen

> **Bounty card** (Kepler Plan by Tencent · Social, Attention & Culture · $2,000 in Tencent Cloud
> vouchers): "Build a multimodal or interactive experience genuinely powered by Tencent's Hunyuan
> model."

Not entered: the card is locked to another track and asks for a multimodal or interactive
experience. The screen stays in the core loop as a product feature.

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
- **In the demo.** One line on the quote card ("Screened by Hunyuan hy4: allowed — …") and the
  *Screened* row on the job page. A hostile prompt refused with a 422 is an optional cutaway. On a
  private job, public views withhold the screen's written reason.

The three model roles (Qwen routes, Kimi verifies, Hunyuan screens) are documented in
[services/broker/README.md](services/broker/README.md). A missing key turns a role off and never
stops the broker. `GET /api/network` reports each role's state.

### ERC-8004 on Monad: identity and payment-backed reputation

- **Identity.** `xorv identity register` calls `IdentityRegistry.register(agentURI)` from the payout
  key. This makes that address both the owner and the agent wallet. `agentURI` is
  `<broker>/agents/<providerId>.json`, the registration file the broker serves (`x402Support: true`).
  The CLI builds it from the provider id, a one-way hash of the node id, so the node id (what a node
  registers with) never goes on-chain. On registration, the broker checks that the claimed agent's
  `getAgentWallet` equals the node's payout address. `XorvLedger` enforces the same rule on every
  receipt.
- **Reputation.** Buyer ratings arrive under tag `starred` with `clientAddress == XorvLedger`, one
  per paid job, signed by the payer, and never from the agent's own wallet, owner or operators (the
  ledger reverts `SelfDealing`). Kimi scores arrive under `xorv-verified` from the verifier EOA. The
  two signals stay separable, and the indexer classifies them.
- **Code.** `packages/protocol/src/erc8004.ts`, `packages/cli/src/commands/identity.ts`,
  `packages/contracts/contracts/XorvLedger.sol`, `services/broker/src/app.ts` (`/agents`,
  `/feedback`, `/verifications`, `verifyAgent`).
- **Registries** (canonical v2.0.0): testnet Identity `0x8004A818BFB912233c491871b3d84c89A494BD9e`,
  Reputation `0x8004B663056A597Dffe9eCcC1965A193B7388713`; mainnet Identity
  `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Reputation `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`.

---

## Deployments

XorvLedger is live on Monad testnet. Every remaining **TODO(deploy)** row is filled from the source
named next to it; do not remove the rows. `<broker>` is the broker's public URL and `<job>` a job id.

| | Monad testnet (`eip155:10143`) | Where the value comes from |
|---|---|---|
| XorvLedger | [`0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD`](https://testnet.monadscan.com/address/0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD) ([Sourcify](https://sourcify-api-monad.blockvision.org/repo-ui/10143/0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD)) | `address` in `packages/contracts/deployments/monadTestnet.json`, written by `pnpm deploy:ledger` |
| XorvLedger deploy tx | [`0xb342175f…`](https://testnet.monadscan.com/tx/0xb342175f22adb752d95400eb16288425c403c3f44427735f8439a234453dacc3) (block 66379818) | `txHash` in the same file |
| XorvLedger owner | [`0x77bB70848eB39523fDA7Bb3E8Db57a4b31EE1C49`](https://testnet.monadscan.com/address/0x77bB70848eB39523fDA7Bb3E8Db57a4b31EE1C49) | `owner` in the same file (`XORV_LEDGER_OWNER`, a key the broker's host doesn't hold) |
| Broker operator EOA (ledger writes, rating relay, verifier) | [`0x45d6510E68308566B7e1d7cA578707a59dC15752`](https://testnet.monadscan.com/address/0x45d6510E68308566B7e1d7cA578707a59dC15752) | `broker` in the same file; `pnpm setup:monad` prints it with its balance |
| XorvEscrow, XorvRefundKeeper, CleanverseGate | **TODO(deploy)**: on hold; built and tested on local chains and Monad forks | `contracts/script/Deploy.s.sol` ([docs/DEPLOY-LATER.md](docs/DEPLOY-LATER.md)) |
| Facilitator | Monad's public facilitator, `https://x402-facilitator.molandak.org` (the default; it pays settlement gas) | `curl -s <broker>/api/network | jq .facilitator` |
| Example x402 settlement (buyer → provider USDC) | [`0x579205fe…`](https://testnet.monadscan.com/tx/0x579205fe205b8069682f147377efd6d9a6ca404e2c1c6ea95312853a921202d7) (0.01 USDC, gas paid by the public facilitator) | `curl -s <broker>/api/jobs/<job> \| jq -r .job.payment.txHash` |
| Example `recordJobs` receipt | [`0xbddafbf6…`](https://testnet.monadscan.com/tx/0xbddafbf69499df11f5c0289b4cefb6491cd0b168fd799bae2c77145dd855c6c7) (`JobRecorded`) | `… \| jq -r .job.receiptTxHash` |
| Example `rateJob` → ERC-8004 feedback | **TODO(deploy)** | `… \| jq -r .job.rating.txHash` |
| Example Kimi `giveFeedback` (`xorv-verified`) | **TODO(deploy)** | `… \| jq -r .job.verification.feedbackTxHash` |
| Example Privy server-wallet payment (MCP agent) | **TODO(deploy)** | the `Payment:` link `xorv_run_job` prints |
| Example Nansen x402 payment (Monad **mainnet**, broker → Nansen) | **TODO(deploy)** | `curl -s <broker>/api/network \| jq -r .nansen.lastPaidTx.url` |
| Demo provider's ERC-8004 agent | **TODO(deploy)** | the agent id from `xorv identity show`, as `https://testnet.monadscan.com/nft/0x8004A818BFB912233c491871b3d84c89A494BD9e/<agentId>` |
| Envio GraphQL endpoint | **TODO(deploy)** | `envio-cloud deployment endpoint <indexer> <commit>` |
| Broker URL | **TODO(deploy)** | `XORV_PUBLIC_URL` |
| App URL | **TODO(deploy)** | the `apps/app` Vercel project ([DEPLOY.md §5](DEPLOY.md#5-deploy-the-app-and-the-landing-to-vercel)) |
| Landing URL | **TODO(deploy)** | the `apps/landing` Vercel project |
| USDC (Circle) | [`0x534b2f3A21130d7a60830c2Df862319e593943A3`](https://testnet.monadscan.com/token/0x534b2f3A21130d7a60830c2Df862319e593943A3) |
| ERC-8004 Identity / Reputation | `0x8004A818BFB912233c491871b3d84c89A494BD9e` / `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

The npm packages `@xorv/cli`, `@xorv/protocol` and `@xorv/mcp` at version 0.1.x are the **Hedera
prototype**. Until 0.2.0 is published, install from source (below).

---

## Quickstart

Needs Node 22.18+ (the broker alone runs on 22.13+, the CLI and MCP server on 20.19+) and pnpm 10.
Test USDC comes from <https://faucet.circle.com> (pick Monad Testnet) and
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
`TOKENHUB_API_KEY` turn on the AI roles; `XORV_NANSEN_MODE=live` (with `XORV_NANSEN_PAYER_KEY`
or `NANSEN_API_KEY`) turns on Nansen wallet trust ([docs/NANSEN.md](docs/NANSEN.md)).

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

The full order of operations, with faucets, env lines and the Oct 10–13 indexer redeploy, is in
[DEPLOY.md](DEPLOY.md). In short:

1. **Ledger.** `XORV_BROKER_ADDRESS=<operator address> XORV_LEDGER_OWNER=<cold owner address>
   pnpm deploy:ledger` deploys `XorvLedger` to Monad testnet (about 0.2 MON plus Monad's 10 MON
   account reserve). The owner is the only account that can rotate a leaked broker key out, so the
   script refuses an owner that is the broker or the operator key. It checks that the registries
   report v2.0.0, writes `packages/contracts/deployments/monadTestnet.json`, and prints the
   `XORV_LEDGER_*` and `ENVIO_XORV_LEDGER_*` lines. Verify it with
   `pnpm --filter @xorv/contracts verify:testnet`. See [packages/contracts/README.md](packages/contracts/README.md#deploy-and-verify).
2. **Indexer.** Deploy `services/indexer` to Envio Cloud with the printed `ENVIO_*` variables, then
   set `XORV_INDEXER_URL` on the broker. See [services/indexer/README.md](services/indexer/README.md#deploying-to-envio-cloud).
3. **Broker.** `docker compose up -d` (SQLite in a volume; `--profile mongo` adds MongoDB). Set
   `XORV_PUBLIC_URL` to the broker's public https URL: it is written into on-chain agent and
   feedback URIs. Set `XORV_TRUST_PROXY=1` (and `XORV_TRUSTED_HOPS`) behind a proxy. `/metrics`
   speaks Prometheus.
4. **App and landing.** Deploy `apps/app` (Next.js) with `NEXT_PUBLIC_XORV_BROKER_URL`,
   `NEXT_PUBLIC_XORV_NETWORK` and `NEXT_PUBLIC_PRIVY_APP_ID`, and `apps/landing` with
   `NEXT_PUBLIC_XORV_BROKER_URL`, `NEXT_PUBLIC_XORV_APP_URL` (the app's URL, or every "Open app"
   button points to `localhost:3002`), `NEXT_PUBLIC_XORV_LEDGER_ADDRESS` and
   `NEXT_PUBLIC_XORV_NETWORK` ([DEPLOY.md §5](DEPLOY.md#5-deploy-the-app-and-the-landing-to-vercel)).
   Private jobs need an https domain, because passkeys are scoped to it.

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
│   │                 rating relay, AI roles (src/ai), Nansen wallet trust (src/trust),
│   │                 private-job vaults, SQLite/Mongo, metrics
│   └── indexer/      Envio HyperIndex v3 (own lockfile, outside the pnpm workspace)
├── contracts/        Foundry: XorvEscrow, XorvRefundKeeper, CleanverseGate, tests, fork tests, Deploy.s.sol
├── cre/              Chainlink CRE workflow: the escrow refund keeper (bun, compiles to WASM)
├── apps/
│   ├── app/          xorv-app: job board; Privy wallet pays and rates; network, providers and
│   │                 private-jobs pages
│   └── landing/      xorv-landing: marketing site with the live XorvLedger receipts feed
├── e2e/                   `pnpm e2e`: the whole system on a Monad testnet fork, checked on-chain
├── docs/PRIVATE_JOBS.md   private jobs: derivations, envelope, vault, threat model, demo script
├── docs/NANSEN.md         Nansen wallet trust: x402 payments, scoring, the wash-rating guard
├── docs/DEPLOY-LATER.md   the escrow, keeper and gate deploy, CRE and Cleanverse steps (on hold)
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
own signing policy on top. A provider paying itself is refused by the broker (403 `self_payment`,
before anything settles) and by `XorvLedger` (`SelfDealing`), so it can't mint receipts or ratings
for the price of gas. The full threat model, including what is *not* protected, is in
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
| [docs/DEPLOY-LATER.md](docs/DEPLOY-LATER.md) | Deploying the escrow, refund keeper and Cleanverse gate; CRE and Cleanverse steps |
| [PLAN.md](PLAN.md) | What was combined into this branch, the completion checklist and what is blocked |
| [cre/README.md](cre/README.md) | The Chainlink CRE refund keeper |
| [docs/NANSEN.md](docs/NANSEN.md) | Nansen wallet trust: how the broker pays per call, the score, the wash-rating guard |
| [services/broker/README.md](services/broker/README.md) | The AI roles and Nansen trust |
| [services/indexer/README.md](services/indexer/README.md) | The Envio indexer |
| [packages/contracts/README.md](packages/contracts/README.md) | XorvLedger, gas, deploy |
| [packages/cli/README.md](packages/cli/README.md) · [packages/mcp/README.md](packages/mcp/README.md) · [packages/mm-plugin/README.md](packages/mm-plugin/README.md) | The three non-browser buyers and the provider node |

## Licence

MIT, see [LICENSE](LICENSE). Vendored and third-party code keeps its own licence (see
[Attribution](#attribution-of-external-code)).
