# End-to-end harness

`pnpm e2e` runs the whole Xorv system — chain, broker, provider node, buyers — against **real contract
code**, and checks every claim it makes on-chain. It is the one test in the repo that needs the network:
it forks Monad testnet.

```sh
pnpm install
pnpm build          # the harness runs the built broker, CLI and MCP server
pnpm e2e            # ≈ 1–2 minutes; writes e2e/last-run.md
```

Exit code 0 means every step finished and every check held; anything else is a failure, with the tail of
each process's output printed and the full logs kept in a temp directory (the path is printed).

## What it runs

| | Real code | Stand-in |
|---|---|---|
| Chain | A local fork of **Monad testnet** (chain id 10143) — Hardhat 3's EDR, from `packages/contracts` (`hardhat node --network monadFork`). Circle's **real USDC** (FiatToken v2.2, EIP-712 `"USDC"`/`"2"`, EIP-3009) and the **canonical ERC-8004 v2.0.0 registries** at their `0x8004…` addresses are forked in with the rest of the state. | — |
| XorvLedger | Deployed by the contracts package's own `scripts/deploy.ts` (`--network monadForkRpc`), which recognises the fork by its chain id and wires the ledger to the canonical registries. | — |
| Broker | `services/broker/dist` — x402 upfront settlement through its **self-hosted facilitator**, the XorvLedger writer (batched receipts, registrations, sampled heartbeats), the gasless rating relay, private-job handling, SQLite persistence. | — |
| AI roles | The broker's Hunyuan screen, Qwen router and Kimi verifier run their real code (JSON mode, validation, fallbacks, ERC-8004 feedback writes). | The **models**: a local OpenAI-compatible server (`src/mock-llm.ts`) answers by rule, one base URL and key per preset. |
| Provider | `packages/cli/dist` — `xorv identity register` (a real `IdentityRegistry.register` from the payout key), then `xorv start` selling `echo` and `qwen` (the hosted-model adapter, streaming from the mock). | — |
| Buyers | `xorv run --json`; the MCP server (`packages/mcp/dist`) over stdio via the MCP SDK client (`xorv_run_job`, `xorv_rate_job`); a private job straight through the broker API with the protocol's x402 client. | The passkey PRF output (fixed bytes into `deriveInboxKeys`). |

Every key is generated for the run. MON comes from `hardhat_setBalance`; the buyer's USDC is **minted
through the token's own masterMinter** (impersonated), so balances, supply and events are genuine. The
buyer never holds MON.

## What it checks

- **Payments:** each settlement is a transaction from the facilitator EOA whose logs hold exactly one USDC
  `Transfer` buyer → provider for the quoted amount, plus the buyer's `AuthorizationUsed`; balances move by
  exactly the sum; the buyer's MON balance and nonce stay 0.
- **The quote path:** the Hunyuan screen refuses an abusive prompt with a 422 before any quote; the Qwen
  router's pick (the dearer `qwen`, over `echo`) is the adapter that ran; `payTo` is the provider.
- **XorvLedger:** `ProviderRegistered` (payTo, agentId, label, capability string), a sampled
  `ProviderHeartbeat`, and a `JobRecorded` per job with `jobId`/`requestHash`/`resultHash`/`amount`/
  `paymentTx` recomputed from the job; `JobRated` for each rating and `jobs()` marking it rated.
- **ERC-8004:** the agent's owner and wallet are the payout address and its URI resolves to a registration
  file pointing back at it; Kimi's `NewFeedback` (tag1 `xorv-verified`, client = verifier EOA) and each
  buyer rating's `NewFeedback` (tag1 `starred`, client = XorvLedger) on the canonical Reputation Registry;
  the served feedback files hash to the on-chain `feedbackHash`; `getSummary` averages match.
- **Ratings:** a stranger's signature is refused (401) before any gas is spent; the buyer's EIP-712
  signature is relayed.
- **Private jobs:** the broker only ever holds the sealed envelope — the buyer's inbox key opens it to the
  provider's answer, the answer appears nowhere in the broker's API, database or the verifier's inputs, and
  the receipt's `resultHash` is `keccak256(envelope)`.
- **The broker's own views** (`/api/ledger` scanning the fork over RPC, `/api/leaderboard`,
  `/api/network`) agree with the chain.

The last green run's report is committed as [last-run.md](last-run.md).

## Prerequisites

- Node ≥ 22.13 and pnpm, `pnpm install && pnpm build` done.
- **Network access to the Monad testnet RPC** (`https://testnet-rpc.monad.xyz`): the fork reads contract
  state from it lazily throughout the run. The public RPC rate-limits; a private one is faster.
- About 1.5 GB of free memory (the fork node is the largest process).

## Options

| Variable | Default | |
|---|---|---|
| `MONAD_FORK_URL` | `https://testnet-rpc.monad.xyz` | RPC to fork from (e.g. a private Monad testnet endpoint). |
| `MONAD_FORK_BLOCK` | latest | Pin the fork block for a reproducible run. |

Nothing else from your environment reaches the processes under test: every `XORV_*`, model key, Mongo URI
or indexer URL in your shell or the repo-root `.env` is dropped or blanked (see `src/env.ts`), so the run
can neither spend real money nor test your local setup instead of the code.

## Layout

| File | |
|---|---|
| `src/run.ts` | The run: steps, checks, report. |
| `src/chain.ts` | Fork, funding (MON, USDC via masterMinter), ledger deployment. |
| `src/onchain.ts` | Reading settlements, ledger events and ERC-8004 feedback back off the fork. |
| `src/mock-llm.ts` | The OpenAI-compatible model stand-in. |
| `src/api.ts` | The broker's public API and x402 payment, as any buyer uses them. |
| `src/procs.ts` | Child processes: logged, awaited, and always torn down (process trees on Windows). |
| `src/env.ts` | Sealed environments for the children. |
| `src/report.ts` | The terminal output and `last-run.md`. |
