# @xorv/indexer

An [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview) (v3) indexer for Xorv on Monad.
It follows three contracts and turns their events into the numbers the network page, the provider
leaderboard and the landing ledger show:

| Contract | Address (testnet 10143 / mainnet 143) | Events |
|---|---|---|
| `XorvLedger` (packages/contracts) | `ENVIO_XORV_LEDGER_ADDRESS` | `ProviderRegistered`, `ProviderHeartbeat`, `JobRecorded`, `JobRated`, `BrokerSet`, `OwnershipTransferred` |
| ERC-8004 `IdentityRegistry` v2.0.0 | `0x8004A818BFB912233c491871b3d84c89A494BD9e` / `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `Registered`, `URIUpdated`, `MetadataSet` (`agentWallet` only), `Transfer` |
| ERC-8004 `ReputationRegistry` v2.0.0 | `0x8004B663056A597Dffe9eCcC1965A193B7388713` / `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `NewFeedback`, `FeedbackRevoked`, `ResponseAppended` |

`config.yaml` is Monad testnet (the default everywhere) and `config.mainnet.yaml` is the same
indexer on mainnet. Both read HyperSync (`monad-testnet.hypersync.xyz` / `monad.hypersync.xyz`), so a
full history sync takes seconds and never touches the public RPC's 100-block `eth_getLogs` cap. The
RPC in the config is only a fallback.

The broker reads it through `XORV_INDEXER_URL` (below). It is an accelerator, never a dependency:
with the variable unset or the indexer down, the broker answers `/api/leaderboard` from memory and
`/api/ledger` from a bounded RPC scan.

## What it derives

`schema.graphql` is the reference; every field has a comment. It defines **14 entity types** (plus
one enum, `FeedbackKind`), from 13 events on 3 contracts:

| Entity | Id | What it holds |
|---|---|---|
| `Provider` | `providerId` (`keccak256(brokerProviderId)`) | registration (payTo, label, capabilities, agent), last heartbeat, `jobsTotal/jobsOk/jobsFailed`, `successRate`, `earnedUsdc`, `settledUsdc`, `avgDurationMs`, `ratingsCount`, `avgRating` |
| `ProviderCapability` | `<providerId>-<adapter>` | one offer (`adapter`, `priceUsdMicros`, `active`), parsed from the capability string |
| `Agent` | agentId (decimal) | every ERC-8004 agent on the chain: owner, agentURI, `wallet` (the payee XorvLedger checks), `isXorvProvider`, and reputation split three ways (below) |
| `Job` | `jobId` (`keccak256(brokerJobId)`) | one x402 receipt: buyer, payTo, amount, `paid`, payment tx, request/result hashes, duration, `ok`, rating |
| `Rating` | `jobId` | a buyer's rating (`JobRated`), linked to the ERC-8004 feedback relayed in the same transaction |
| `Feedback` | `<agentId>-<client>-<feedbackIndex>` | every ERC-8004 `NewFeedback`, with its `kind`, revocation and responses |
| `FeedbackResponse` | `<block>-<logIndex>` | ERC-8004 `ResponseAppended` |
| `Buyer` | address | jobs, `spentUsdc`, ratings given |
| `Ledger`, `Broker` | address | the ledger's owner and broker history (who counts as the verifier, and when) |
| `NetworkStats` | `"global"` | the singleton: providers, agents, buyers, jobs, success rate, `volumeUsdc`, `earnedUsdc`, ratings, heartbeats, feedback |
| `DailyStats` | `yyyy-mm-dd` (UTC) | the same per day, with exact `uniqueBuyers` / `activeProviders` counts |
| `ProviderDay`, `BuyerDay` | `<id>-<yyyy-mm-dd>` | per-provider and per-buyer daily series (they also make the distinct counts exact) |

Rules the numbers follow:

- **Money.** Amounts are USDC base units (6 decimals) as `BigInt`. A receipt is *paid* when its
  `paymentTx` is not zero. `settledUsdc` / `volumeUsdc` count every paid receipt, because x402 settles
  before the job runs and a failed job was still paid for. `earnedUsdc` counts paid *and* ok receipts:
  what a provider got for delivered work. Unpaid receipts are jobs, never volume.
- **Reputation is split by who wrote it.** Anyone can call `giveFeedback`, so the client address
  decides what an entry is worth, and each entry is classified once, when it arrives:
  - `BUYER_RATING`: tag1 `"starred"` from the XorvLedger itself. `rateJob` relays exactly one per paid
    job, authorised by the wallet that paid. Feeds `Agent.buyerRating*` (and `Provider.avgRating`,
    from `JobRated`).
  - `XORV_VERIFIED`: tag1 `"xorv-verified"` from the ledger's active broker (the broker's operator EOA,
    which runs the Kimi result verifier) or from `ENVIO_XORV_VERIFIER_ADDRESSES`. Feeds
    `Agent.verifiedCount/verifiedScore`. A rotated-out broker stops counting from its `BrokerSet` on.
  - `OTHER`: everything else. Indexed and shown, never mixed into Xorv scores.

  Revoking an entry takes back exactly what it added.
- **Attribution.** `JobRecorded` carries the agentId and payTo but not the providerId. A receipt finds
  its provider through the agent (the ledger already proved `payTo == agentWallet`), or through the
  payee for `NO_AGENT` providers. Receipts indexed before their provider's registration are claimed by
  it when the registration arrives, ratings included.
- **Encoding.** Addresses and bytes32 values are lowercase hex (`address_format: lowercase`), so
  lowercase an address before filtering on it. Timestamps are unix seconds from the block.

## Queries

[`src/queries.ts`](src/queries.ts) has the GraphQL the broker and the apps run, their row types and a
small `queryIndexer(url, query, variables)` client with an injectable `fetch`. It imports nothing, so it
can be copied as is (this package sits outside the pnpm workspace). The five main ones are also
exported by name as `QUERIES`:

| `QUERIES.` | Constant | Variables | Returns |
|---|---|---|---|
| `leaderboard` | `LEADERBOARD_QUERY` | `{ limit }` | providers by earnings, then ok jobs, then rating, each with its agent's split reputation |
| `recentJobs` | `RECENT_JOBS_QUERY` | `{ limit }` | latest receipts, newest first |
| `networkStats` | `NETWORK_STATS_QUERY` | `{ days }` | the `NetworkStats` singleton plus the last N `DailyStats` |
| `providerById` | `PROVIDER_BY_ID_QUERY` | `{ id, jobs, days }` | one provider with offers, agent, recent jobs and a daily series |
| `agentFeedback` | `AGENT_FEEDBACK_QUERY` | `{ agentId, limit }` | an agent's scores with `buyerRatings`, `verifications` and `otherFeedback` listed separately |

Also exported: `LEADERBOARD_BY_RATING_QUERY`, `RECENT_RATINGS_QUERY`, `BUYER_JOBS_QUERY`,
`OFFERS_BY_ADAPTER_QUERY`, `JOB_BY_ID_QUERY` and `agentFeedbackByKindQuery(kind)` (one page of one
kind). `test/queries.test.ts` checks every field, filter and sort key against `schema.graphql`, so a
renamed column fails the tests instead of the broker's leaderboard.

Hasura serves the API: every entity is a root field (`Provider(where:, order_by:, limit:)`) with a
`Provider_by_pk(id:)` companion. `BigInt` and `Float` columns may arrive as strings, so read them
with `toBigInt` / `toNumber`.

## Configuration

| Variable | Needed for | Meaning |
|---|---|---|
| `ENVIO_API_TOKEN` | local runs only | HyperSync token (required since Nov 2025), from https://envio.dev/app/api-tokens. Envio Cloud does not need it. |
| `ENVIO_XORV_LEDGER_ADDRESS` | always | XorvLedger address: `address` in `packages/contracts/deployments/<network>.json`, also printed by `pnpm deploy:ledger`. Unset, the configs fall back to the zero address and index no XorvLedger events (only the ERC-8004 registries). |
| `ENVIO_XORV_LEDGER_START_BLOCK` | recommended | its deploy block (`blockNumber` in the same file). Keep it at or before the deploy block so the constructor's `BrokerSet` is indexed. |
| `ENVIO_XORV_VERIFIER_ADDRESSES` | optional | extra comma-separated addresses whose `"xorv-verified"` feedback counts: a verifier with its own key, or the broker when the start block is after the deploy |
| `ENVIO_ERC8004_START_BLOCK` | optional | skip ERC-8004 history before this block (default: every agent on the chain) |
| `ENVIO_MONAD_RPC_URL` | optional | fallback RPC (defaults to the public Monad RPC) |

They are interpolated into the config files. Only `ENVIO_`-prefixed variables reach an Envio Cloud
deployment, which is why none of them reuse the broker's `XORV_*` names. Envio also interpolates
inside YAML comments, so never write a `${…}` placeholder in a comment there (a test checks this).

## Running it

Envio 3.12 ships no Windows binary (`envio doesn't support win32-x64`). Everything below runs on
Linux, macOS or WSL2, or in a Linux container. That is also why this package is excluded from the
root workspace (`!services/indexer` in `pnpm-workspace.yaml`): it has its own `pnpm-workspace.yaml`
and `pnpm-lock.yaml`, and its `node_modules` must never be installed from Windows. Node 22+ and
pnpm 10 (`corepack enable`).

### Tests, in a throwaway container (works from Windows)

The tests need no database, no network and no token: they drive the handlers with Envio's
`createTestIndexer` and simulated events. From the repository root, with Docker running:

```sh
docker run --rm -m 3g -v "$PWD:/repo:ro" node:22 sh -c '
  mkdir -p /work/services /work/packages/contracts &&
  cp -r /repo/services/indexer /work/services/ && cp -r /repo/packages/contracts/abi /work/packages/contracts/ &&
  cd /work/services/indexer && rm -rf node_modules .envio &&
  corepack enable && pnpm install --frozen-lockfile && pnpm check'
```

`pnpm check` is `envio codegen && tsc --noEmit && vitest run`. Copying into the container keeps Linux
`node_modules` off the host, and bringing `packages/contracts/abi` along lets `test/abis.test.ts`
compare `abis/XorvLedger.json` with the contract's committed ABI (without it, that one test is
skipped and the SPEC §4 check still runs). On Linux/macOS/WSL you can just run
`pnpm install && pnpm check` in this folder.

### A local indexer with GraphQL (WSL2, Linux or macOS, plus Docker)

```sh
cd services/indexer
cp .env.example .env        # set ENVIO_API_TOKEN and the ledger address/start block
pnpm install
pnpm dev                    # codegen, then Postgres + Hasura in Docker, then the indexer
```

`envio dev` starts Postgres and Hasura as Docker containers (Docker Desktop with WSL integration on
Windows) and watches the handlers. GraphQL is at `http://localhost:8080/v1/graphql` and the Hasura
console at `http://localhost:8080` (admin secret `testing`). Point the broker at it with
`XORV_INDEXER_URL=http://localhost:8080/v1/graphql`. `pnpm dev:mainnet` does the same with
`config.mainnet.yaml`.

After changing `config.yaml`, `schema.graphql` or an ABI, start from an empty database: `pnpm stop`
(stops the containers and deletes the database) and `pnpm dev` again.

## Deploying to Envio Cloud

1. Sign in at https://envio.dev/app/login with GitHub and install the *Envio Deployments* GitHub App
   on the repository.
2. **Add Indexer**: root directory `services/indexer`, config file `config.yaml` (a second indexer
   with `config.mainnet.yaml` for mainnet), and the deployment branch.
3. Set the environment variables from the table above (`ENVIO_XORV_LEDGER_ADDRESS`,
   `ENVIO_XORV_LEDGER_START_BLOCK`, optionally `ENVIO_XORV_VERIFIER_ADDRESSES`). No API token is needed.
4. Every push to that branch rebuilds and re-indexes from the start block (HyperSync makes this
   quick). The public, unauthenticated endpoint looks like
   `https://indexer.dev.hyperindex.xyz/<deployment-id>/v1/graphql`. The `envio-cloud` CLI
   (`npm i -g envio-cloud`, it has a Windows build) prints it:
   `envio-cloud deployment endpoint <indexer> <commit>`.
5. Set that URL as `XORV_INDEXER_URL` on the broker.

**Timing.** The free Development plan keeps a deployment for at most **30 days**. Metropolis judging
runs Oct 14–27 and winners are announced Nov 3, so a deployment made now would expire mid-judging.
Push (or redeploy) between **Oct 10 and Oct 13** so the deployment judges see lives until after
Nov 3, then update `XORV_INDEXER_URL` if the endpoint changed.

## Maintenance

- **XorvLedger ABI.** `abis/XorvLedger.json` is a verbatim copy of
  `packages/contracts/abi/XorvLedger.json`. After a contract change, copy it again
  (`cp ../../packages/contracts/abi/XorvLedger.json abis/`). The tests fail until you do, and until
  `config.yaml` subscribes to every event it declares (ERC-5267's `EIP712DomainChanged` excepted).
- **ERC-8004 ABIs** are hand-written, event-only, and pinned to the topic0 values of the deployed
  v2.0.0 registries.
- **Two configs, one set of handlers.** Keep the contract and event lists of `config.yaml` and
  `config.mainnet.yaml` identical; a test compares them.
