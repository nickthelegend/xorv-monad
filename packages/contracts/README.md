# @xorv/contracts

`XorvLedger` is Xorv's public record on Monad. It replaces the Hedera prototype's HCS audit topics.

- **Providers.** The broker announces each provider node with `registerProvider`, then posts periodic
  capacity samples with `heartbeat`. Both write events only. When a provider has an ERC-8004 agent, its
  x402 `payTo` must be that agent's verified wallet (`IdentityRegistry.getAgentWallet`).
- **Receipts.** After an x402 payment settles and the job finishes, the broker writes a receipt with
  `recordJobs`. Receipts are batched. Each one binds the settlement tx to the job's request hash,
  result hash, duration, outcome, buyer, payee and agent.
- **Ratings.** The buyer can rate each recorded job once, with `rateJob`. The buyer can call it and pay
  the gas, or sign an EIP-712 `Rating` for free and let the broker relay it. A relayed signature is
  checked with ECDSA against the buyer first and then with ERC-1271, the order the ERC-8004 Identity
  Registry uses. So EOAs, EIP-7702 accounts (which have code, but whose key still signs) and ERC-1271
  smart accounts, including passkey wallets on Monad's P256 precompile, can all rate. The ledger
  forwards the rating to the ERC-8004 Reputation Registry as
  `giveFeedback(agentId, value, 0, "starred", tag2, endpoint, feedbackURI, feedbackHash)`.
- **Self-dealing.** The registry's own self-feedback rule only ever sees the ledger as the client, so
  the ledger applies it to the real parties. `recordJobs` reverts `SelfDealing(jobId)` for a receipt
  whose buyer is its `payTo`. `rateJob` reverts `SelfDealing(jobId)` when the buyer is the agent's
  current wallet, owner or an approved operator (per token or for all), read from the Identity
  Registry at rating time, on the direct and the relayed path alike.

Every rating reaches ERC-8004 with `clientAddress == XorvLedger`. So
`getSummary(agentId, [ledger], "starred", "")` is a provider score built only from paid, delivered
jobs, each rated by the wallet that paid, and never by the agent's own wallet, owner or operators. A
Sybil has to pay for every fake review, from a wallet that is not the agent's.

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

Figures come from `pnpm --filter @xorv/contracts gas:monad` (`pnpm gas:monad` inside this package),
run on Monad testnet on 2026-09-27 at block 66102919, after the self-dealing check and the
ECDSA-first signature check landed. It calls `eth_estimateGas` on the live chain with state overrides
against the real registries and a real ERC-8004 agent. Nothing is deployed and no key is needed. The
same run confirms three reverts against the real registries: a wrong signer (`BadSignature`), a
`payTo` that is not the agent's wallet (`PayToNotAgentWallet`) and a self-paid receipt
(`SelfDealing`).

| Call | Monad gas | Limit (×1.15) | MON at 102 gwei | Per job |
|---|---:|---:|---:|---:|
| deploy | 1,586,213 | 1,824,144 | 0.1861 | |
| `registerProvider` (with agent) | 75,172 | 86,447 | 0.0088 | |
| `heartbeat` | 33,080 | 38,042 | 0.0039 | |
| `recordJobs` × 1 | 106,056 | 121,964 | 0.0124 | 106,056 |
| `recordJobs` × 5 | 257,314 | 295,911 | 0.0302 | 51,462 |
| `recordJobs` × 20 | 820,818 | 943,940 | 0.0963 | 41,040 |
| `recordJobs` × 20, `NO_AGENT` | 789,054 | 907,412 | 0.0926 | 39,452 |
| `rateJob` direct (later rating) | 250,271 | 287,811 | 0.0294 | |
| `rateJob` relayed, EOA signature (later rating) | 260,327 | 299,376 | 0.0305 | |
| `rateJob` relayed, ERC-1271 (later rating) | 279,718 | 321,675 | 0.0328 | |
| `rateJob` direct (ledger's 1st rating of the agent) | 327,321 | 376,419 | 0.0384 | |
| `rateJob` relayed, EOA signature (ledger's 1st rating of the agent) | 337,378 | 387,984 | 0.0396 | |
| `rateJob` relayed, ERC-1271 (ledger's 1st rating of the agent) | 356,768 | 410,283 | 0.0418 | |

Most of `rateJob`'s gas is spent inside the registry's `giveFeedback`, which stores the value and both
tags; the self-dealing check adds two registry reads. Keep `tag2` under 32 bytes. `pnpm gas` prints
the same calls on Hardhat's simulated chain, which uses Ethereum pricing, so its figures are lower.

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
| `XORV_DEPLOYER_KEY` | The key that pays for the deployment, and nothing else. Read from the environment (or the repo-root `.env`), then the Hardhat keystore (`pnpm --filter @xorv/contracts exec hardhat keystore set XORV_DEPLOYER_KEY`), and only then `XORV_OPERATOR_KEY`. |
| `XORV_BROKER_ADDRESS` | The broker EOA allowed to write (the operator key's address). Defaults to the deployer. |
| `XORV_LEDGER_OWNER` | The owner: the one account that can rotate the broker (`setBroker`) or hand over ownership. Defaults to the deployer. Make it an address the broker's host doesn't hold (a hardware or multisig wallet). On `monadTestnet` and `monad` the script **refuses** an owner that is the broker or the operator key's address. |
| `XORV_ALLOW_OWNER_IS_BROKER` | `1` accepts an owner that is the broker's key anyway. Only for throwaway deployments: whoever leaks that key could take ownership first. |
| `MONADSCAN_API_KEY` / `ETHERSCAN_API_KEY` | Monadscan verification through Etherscan V2. Without it, only Sourcify is used. |
| `MONAD_TESTNET_RPC_URL` / `MONAD_RPC_URL` | Override the public RPCs. |

```sh
pnpm --filter @xorv/contracts exec hardhat run scripts/deploy.ts   # keyless dry run on an in-process chain
XORV_BROKER_ADDRESS=<operator address> XORV_LEDGER_OWNER=<cold owner address> \
  pnpm --filter @xorv/contracts deploy:testnet                      # needs ~0.2 MON plus Monad's 10 MON reserve
pnpm --filter @xorv/contracts verify:testnet                        # Sourcify (MonadVision), plus Monadscan with a key
```

The root scripts `pnpm deploy:ledger` and `pnpm verify:ledger` run the same two testnet commands.
`deploy` settles the owner before it touches the RPC and prints the deployer, broker and owner. It
checks that the registries report v2.0.0 and are wired to each other, and after the deployment it
reads `owner()` and `broker()` back. It then writes
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
| XorvLedger | <!-- TODO(deploy): testnet address = `address` in deployments/monadTestnet.json, written by `pnpm deploy:ledger` --> **TODO(deploy)**: not deployed yet | not deployed yet |
| ERC-8004 Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

## Trust and limits

- **Owner.** Named at deployment, as a constructor argument. The owner can rotate the broker and
  transfer ownership (in one step, with no accept), and it cannot touch receipts or ratings. Setting
  either role to the zero address is refused. The owner is the recovery plan for a leaked broker key,
  which is why the deploy script refuses a hot owner on Monad networks. To rotate a leaked or retired
  broker key, call `setBroker(<new broker>)` from the owner, then give the broker the new key and
  restart it. Receipts the old key wrote stay valid.
- **Broker.** The broker is the only writer of registrations, heartbeats and receipts, so a leaked
  broker key can forge receipts until the owner rotates it. Ratings still need the recorded buyer's
  signature.
- **The ledger must never own or operate a provider's agent NFT.** ERC-8004 rejects feedback from an
  agent's owner and operators, so doing this would block every rating for that agent. A test
  demonstrates it, and the broker detects it before offering or relaying a rating (409
  `ledger_authorized`).
- **Self-dealing the contract can't see.** The ledger refuses a provider paying itself, and ratings
  from the agent's own wallet, owner or operators. A second wallet that is merely related (one the
  provider funded) is beyond what a contract can see. The broker asks Nansen before it relays a
  rating and refuses related wallets, but `rateJob` stays open to the buyer directly, so that check
  is advisory. A wallet with no traceable link still costs the price of each job. Weigh ratings by
  distinct paying buyers; the indexer has the `buyer` of every `JobRecorded`.
- **Registry upgrades.** The 8004 team key (`0x5472…2603`) can upgrade the canonical ERC-8004
  registries.
