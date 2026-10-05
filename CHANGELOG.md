# Changelog

All notable changes to this project.

## [0.4.0] — Xorv on Arbitrum — 2026-09-30

Built for the Arbitrum Open House Singapore buildathon. Back to the Xorv name.

### Added
- **XorvEscrow** (Solidity). Job payments wait in escrow until the work is delivered: `fund` via EIP-3009
  `receiveWithAuthorization` with a nonce derived from the job id and refund deadline; `release` with the
  result's SHA-256; `reassign` when another provider takes over; `refund` by the attester any time or by
  anyone after the deadline. Fee snapshotted per job and capped at 5%; `sweep` reaches only excess; pause
  never blocks an exit. 51 unit/fuzz tests, 4 invariants, fork tests against the real USDG and USDC.
- **XorvRegistry** (Rust, Arbitrum Stylus). Provider reputation written by the escrow inside every
  settlement; sponsored registration so providers need no ETH; Laplace-smoothed score. 47 Rust tests.
- **x402 `escrow` scheme** — client, resource server and facilitator — offered ahead of `exact` by the
  broker and used by `xorv run`, the MCP server, the browser wallet and the demo route.
- Broker settles escrow by job outcome, serialized per job, with retries and a visible `lastError`;
  ranks equal-priced providers by on-chain score; checks contract wiring at boot.
- Job page shows escrow state and every transaction, with a refund button once the deadline passes.
- Networks: Arbitrum Sepolia (default), Robinhood Chain Testnet, Arbitrum One, Robinhood Chain, and a
  local Nitro dev node. Paxos **USDG** is the default token everywhere it exists; USDC accepted.
- `scripts/deploy-testnet.sh`, `scripts/e2e-local.sh` (fork + Nitro), `scripts/interop-nitro.sh`.

### Fixed
- A gas-estimation hole that let a release succeed while skipping the registry update (found on a Nitro node).
- Reassignment re-matched the provider that had just failed.
- A settlement that returned failure left the dispatched job running unpaid.
- Reassignment left the job's `providerAddress` pointing at the failed provider.

- On-chain receipts for escrowed jobs are published once the escrow settles and record where the money
  went (`settlement`: released to the provider, or refunded to the buyer). They used to go out at funding
  time naming the provider, so refunded jobs looked paid in the public log.
- A job whose escrow was refunded from outside, or missed its deadline, is now stopped on the node and its
  slot freed; the node used to keep working on it unpaid.
- Stopped jobs no longer skew provider stats: an unsettled payment isn't a completion, a buyer's cancel
  isn't a provider failure.
- `xorv start` removes job directories a crashed run left behind.
- The app picks up wallets that inject late (`ethereum#initialized`).

### Removed
- World ID / AgentKit and World Chain (Arc-build sponsor integrations with no Arbitrum counterpart).

## [0.3.0] — Kazuo on Arc — 2026-09-13

The Arc port, built for ETHOnline 2026 under the name Kazuo; the Hedera original stayed Xorv. Entries
below use today's names — the mechanical rename back to Xorv also rewrote this history.

### Added
- **World AgentKit — human-backed nodes and agents.** Provider nodes sign a broker-issued SIWE challenge
  with their payout key; the broker verifies it and resolves the address in AgentBook on World Chain.
  Human-backed nodes win price ties ahead of track record, buyers can pass `humanBackedOnly`
  (`xorv run --human-backed-only`, MCP `human_backed_only`), and one human can back at most three live
  nodes. Buyers (CLI, MCP) prove themselves the same way; jobs record `providerHumanBacked` and
  `buyerHumanBacked`. New `GET /api/agentkit/challenge`, `xorv agentkit status|register`.
- **Privy in the job board.** Email sign-in creates an embedded wallet on Arc that pays for jobs with the
  unchanged EIP-712 path (no gas, no extension); external wallets connect through the same modal. The
  wallet popover can send USDC. Without a Privy app id the app falls back to the injected wallet.
- **World Chain networks** in `@xorv/protocol`: `eip155:4801` (Sepolia) and `eip155:480`, each with its own
  USDC, RPC, explorer and gas token, via a single `NETWORKS` table.
- Architecture diagram (ARCHITECTURE.md), World builder feedback (FEEDBACK-WORLD.md), Railway + Vercel deploys.

### Changed
- Everything `xorv` is now `xorv`: packages (`@xorv/*`), binary, `XORV_*` env, `~/.xorv`, MCP tools
  (`xorv_*`), metrics, the Claude Code skill (`/xorv`), brand assets. The audit contract source is
  `XorvLog.sol`; its ABI is unchanged, so the deployed log at `0x383f…65eef3` is still the one in use.
- The broker honours `PORT` when `XORV_BROKER_PORT` is unset (Railway, Render, Fly).
- Remaining Hedera wording in the app, CLI README and skill that described current behaviour now says Arc.

### Removed
- Dead `@privy-io/server-auth` dependency and the Hiero/`@x402/hedera` bundler exclusions.
- The Dockerfile `VOLUME` instruction (Railway rejects it; compose mounts the volume explicitly).

## [0.2.0] — Arc

Ported from Hedera to [Arc](https://www.circle.com/arc), Circle's L1 where USDC
is the native gas token. The 0.1.0 entry below describes the Hedera release and
is kept for the record.

### Changed

- **Settlement** is now the stock x402 EVM `exact` scheme over **EIP-3009
  `transferWithAuthorization`**. The buyer signs typed data, never broadcasts,
  and needs no gas; the facilitator relays it and pays the fee. No Xorv-specific
  scheme code, where Hedera needed a bespoke signer.
- **The audit trail** is the `XorvLog` contract — one contract, three indexed
  event streams — replacing three Consensus Service topics. Same envelope
  format, so a consumer written against the old topics still parses it.
- **Any EVM wallet can pay.** HashPack over WalletConnect is gone, along with the
  project id, the relay handshake and the second copy of the Hedera SDK. The
  browser signs `eth_signTypedData_v4`.
- **On-chain heartbeats are sampled hourly**, not every five minutes. Each entry
  costs $0.00088; at the inherited cadence an idle provider cost the broker
  $0.25/day against a 0% fee.
- Clients register the `eip155:*` wildcard rather than a network read from local
  config, so a buyer can pay whatever a broker quotes.

### Removed

- **HBAR, and the choice of asset.** Arc has one. With it went the exchange-rate
  client, its cache, the tinybar conversions, and the dual `accepts` array.
- **`xorv wallet associate`.** ERC-20 needs no opt-in; the failure it guarded
  against cannot happen.
- **Address→account-id resolution.** On Arc the address *is* the account, and it
  exists without ever being funded.
- Key-curve guessing. An EVM private key has one format.

## [0.1.0] — 2026-07-31

First release. Built for the [Hedera x402 bounty](https://hedera.com/x402-bounty/).

### The network

- **Provider CLI** (`xorv`) — `init`, `start`, `run`, `status`, `earnings`,
  `doctor`, `wallet`, `jobs`, `price`, `test`, `logs`, `config`, `pause`,
  `resume`, `cancel`, `completion`.
- **Six adapters** — `claude-code`, `codex`, `grok`, `opencode`,
  `openai-compatible` (Ollama, LM Studio, vLLM, OpenRouter…), and a built-in
  `echo` that exercises the whole payment path with nothing installed.
- **Broker** — provider registry, heartbeat liveness, price × reputation
  matching, x402 402-gating, self-hosted facilitator, HCS audit trail, SQLite
  persistence, Prometheus metrics, per-IP rate limits.
- **MCP server** (`@xorv/mcp`) — five tools that let any agent discover
  capacity, price a job, buy it, and get a HashScan link back.
- **Job board** and **landing site**.

### Payments

- x402 `exact` scheme on Hedera, via partially-signed `TransferTransaction`.
- **Buyers never need HBAR** — the facilitator co-signs as fee payer.
- Payment goes **directly from buyer to provider**; the broker is never the
  payee. Protocol fee 0%.
- USDC or HBAR, buyer's choice, priced from the Mirror Node's own exchange rate.
- Free reassignment to another provider when a job fails.

### On Hedera testnet

- Registry topic `0.0.9848245`, heartbeat `0.0.9848246`, receipts `0.0.9848247`.
- USDC `0.0.429274`.
- Receipts carry a SHA-256 of the result, so the payload stays private and the
  record stays verifiable.

### Quality

- 220 tests — unit plus a full-lifecycle integration suite that needs no Hedera
  credentials and no network.
- CI on Node 22 and 24, a Node 20.11 floor check for the CLI, and a
  committed-secret scan.
- Dockerfile and compose for the broker.

### Known limitations

Stated in full in `SECURITY.md`. The short version: the per-job directory is
blast-radius reduction rather than a sandbox; reputation is gameable; job ids
are capability tokens with no buyer authentication; there is no refund path;
rate limiting is per-process.
