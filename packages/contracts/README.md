# @xorv/contracts

`XorvLedger` is Xorv's public record on Monad. It replaces the Hedera prototype's HCS audit topics.

- **Providers.** The broker announces each provider node with `registerProvider`, then posts periodic
  capacity samples with `heartbeat`. Both write events only. When a provider has an ERC-8004 agent, its
  x402 `payTo` must be that agent's verified wallet (`IdentityRegistry.getAgentWallet`).
- **Receipts.** After an x402 payment settles and the job finishes, the broker writes a receipt with
  `recordJobs`. Receipts are batched. Each one binds the settlement tx to the job's request hash,
  result hash, duration, outcome, buyer, payee and agent.
- **Ratings.** The buyer can rate each recorded job once, with `rateJob`. The buyer can call it and pay
  the gas, or sign an EIP-712 `Rating` for free and let the broker relay it. `SignatureChecker`
  accepts EOA signatures and ERC-1271 smart-account signatures, including passkey wallets on Monad's
  P256 precompile. The ledger forwards the rating to the ERC-8004 Reputation Registry as
  `giveFeedback(agentId, value, 0, "starred", tag2, endpoint, feedbackURI, feedbackHash)`.

Every rating reaches ERC-8004 with `clientAddress == XorvLedger`. So
`getSummary(agentId, [ledger], "starred", "")` is a provider score built only from paid, delivered
jobs, each rated by the wallet that paid. A Sybil has to pay for every fake review.

The interface (events, errors, `NO_AGENT`, `RATING_TYPEHASH`, EIP-712 domain `"XorvLedger"` / `"1"`) is
fixed by the port spec, because `packages/protocol` and the Envio indexer depend on it.
[`abi/XorvLedger.json`](abi/XorvLedger.json) is the committed copy of the ABI, and `test/abi.test.ts`
keeps it identical to the spec and to the build.

## Why this shape, on Monad

- **Monad bills the gas limit, not the gas used.** Blocks are built before execution, so the whole
  limit is charged. Every Xorv transaction therefore sets its limit to `eth_estimateGas` × 1.15. A
  padded constant, or a wallet default, is money thrown away.
- **Batching.** The 21k intrinsic cost and the cold account accesses (10,100 gas each on Monad) are paid
  once per transaction. The broker queues receipts and writes them with one `recordJobs` call. Within a
  batch, the ledger checks each (agent, payTo) pair against the Identity Registry only once.
- **State growth is the expensive part.** A new storage slot costs about 27.9k gas on Monad (8,000 page
  load, 2,800 page write, 17,000 state growth), while log data is cheap. So each job gets one packed
  slot (`buyer`, `agentId`, `rated`), which is exactly what `rateJob` has to check. Everything else
  lives in events, which the indexer reads. Registrations and heartbeats store nothing.
- **Real identity.** The canonical ERC-8004 v2.0.0 registries are already live on both Monad chains.
  The ledger binds payments to them and never deploys its own.

### Gas

Figures come from `pnpm gas:monad`, run 2026-09-26. It calls `eth_estimateGas` on the live chain with
state overrides against the real registries. Nothing is deployed and no key is needed. Testnet and
mainnet agree, except that the first rating of an agent costs more on mainnet (327,559 direct).

| Call | Monad gas | Limit (×1.15) | MON at 102 gwei | Per job |
|---|---:|---:|---:|---:|
| deploy | 1,478,800 | 1,700,620 | 0.1735 | |
| `registerProvider` (with agent) | 75,172 | 86,447 | 0.0088 | |
| `heartbeat` | 33,080 | 38,042 | 0.0039 | |
| `recordJobs` × 1 | 105,967 | 121,862 | 0.0124 | 105,967 |
| `recordJobs` × 5 | 256,871 | 295,401 | 0.0301 | 51,374 |
| `recordJobs` × 20 | 819,044 | 941,900 | 0.0961 | 40,952 |
| `rateJob` direct (later rating) | 229,663 | 264,112 | 0.0269 | |
| `rateJob` relayed, EOA signature (later rating) | 249,915 | 287,402 | 0.0293 | |
| `rateJob` relayed, ERC-1271 (later rating) | 252,289 | 290,132 | 0.0296 | |
| `rateJob` relayed, EOA signature (ledger's 1st rating of the agent) | 330,700 | 380,305 | 0.0388 | |

Most of `rateJob`'s gas is spent inside the registry's `giveFeedback`, which stores the value and both
tags. Keep `tag2` under 32 bytes. `pnpm gas` prints the same calls on Hardhat's simulated chain, which
uses Ethereum pricing (for example, `recordJobs` × 20 costs 660,377 there).

## Use

```sh
pnpm --filter @xorv/contracts build        # compile (solc 0.8.24, cancun, optimizer 200)
pnpm --filter @xorv/contracts test         # tests against the real ERC-8004 code, plus gas and ABI checks
pnpm --filter @xorv/contracts typecheck
pnpm --filter @xorv/contracts abi          # regenerate abi/XorvLedger.json after a contract change
pnpm --filter @xorv/contracts gas:monad    # live Monad gas figures (read-only)
```

The tests need no keys and no network. They deploy the ERC-8004 registries from
[`contracts/vendor/erc8004`](contracts/vendor/erc8004/README.md): verbatim upstream v2.0.0, behind
ERC1967 proxies.

### Deploy and verify

| Variable | Used for |
|---|---|
| `XORV_DEPLOYER_KEY` | Deployer key, which also becomes the owner. Falls back to `XORV_OPERATOR_KEY`. Read from the environment, the repo-root `.env`, or `pnpm --filter @xorv/contracts exec hardhat keystore set XORV_DEPLOYER_KEY`. |
| `XORV_BROKER_ADDRESS` | The broker EOA allowed to write. Defaults to the deployer. |
| `MONADSCAN_API_KEY` / `ETHERSCAN_API_KEY` | Monadscan verification through Etherscan V2. Without it, only Sourcify is used. |
| `MONAD_TESTNET_RPC_URL` / `MONAD_RPC_URL` | Override the public RPCs. |

```sh
pnpm --filter @xorv/contracts exec hardhat run scripts/deploy.ts   # keyless dry run on an in-process chain
pnpm --filter @xorv/contracts deploy:testnet                        # needs ~0.2 MON plus Monad's 10 MON reserve
pnpm --filter @xorv/contracts verify:testnet                        # Sourcify (MonadVision), plus Monadscan with a key
```

`deploy` checks that the registries report v2.0.0 and are wired to each other. It then writes
[`deployments/<network>.json`](deployments/README.md) and prints the lines to paste into the broker
and indexer environments:

```
XORV_LEDGER_ADDRESS=0x…
XORV_LEDGER_FROM_BLOCK=…
ENVIO_XORV_LEDGER_ADDRESS=0x…
ENVIO_XORV_LEDGER_START_BLOCK=…
```

It refuses to replace a recorded deployment unless `XORV_REDEPLOY=1` is set. A new address orphans
everything indexed under the old one. The mainnet commands are `deploy:mainnet` and `verify:mainnet`.

## Addresses

| | Monad testnet (10143) | Monad mainnet (143) |
|---|---|---|
| XorvLedger | _not deployed yet_ | _not deployed yet_ |
| ERC-8004 Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

## Trust and limits

- **Owner.** The owner can rotate the broker and transfer ownership. It cannot touch receipts or
  ratings. Setting either role to the zero address is refused.
- **Broker.** The broker is the only writer of registrations, heartbeats and receipts, so a leaked
  broker key can forge receipts until the owner rotates it. Ratings still need the recorded buyer's
  signature.
- **The ledger must never own or operate a provider's agent NFT.** ERC-8004 rejects feedback from an
  agent's owner and operators, so doing this would block every rating for that agent. A test
  demonstrates it.
- **Self-dealing.** A provider can pay for its own jobs from a second wallet and rate itself. This is
  only as hard as paying the price of each job. Weigh ratings by distinct paying buyers. The indexer has
  the `buyer` of every `JobRecorded`.
- **Registry upgrades.** The 8004 team key (`0x5472…2603`) can upgrade the canonical ERC-8004
  registries.
