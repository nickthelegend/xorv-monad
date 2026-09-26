# Changelog

All notable changes to this project.

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
