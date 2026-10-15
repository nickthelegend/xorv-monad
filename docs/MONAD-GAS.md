# Gas on Monad: what Xorv does differently

Monad prices and executes transactions differently from Ethereum in ways that matter to a service
paying gas on every job. This page lists each difference, what Xorv does about it, and where. The
live gas figures for XorvLedger are in [packages/contracts/README.md](../packages/contracts/README.md#gas).

| Monad rule | What Xorv does | Where |
|---|---|---|
| **Gas is charged on the limit, not on gas used.** Unused gas is not refunded. | Every write sets an explicit limit: `eth_estimateGas` × 1.15, rounded up, never a padded constant. A write whose estimate reverts is never sent, so a wallet can't fall back to a 30M limit and charge it in full. | `withGasHeadroom` in `packages/protocol/src/evm.ts`; the ledger writer, the escrow writer (`escrowWriter` in `x402.ts`), the facilitator |
| **The 10 MON reserve.** Each EOA keeps its last 10 MON to pay for in-flight transactions. A value spend that would dip below it reverts and still pays gas. | Buyers never hold MON: the facilitator pays their gas. The broker watches the accounts that do pay gas (the facilitator, which is also the escrow's attester, and the operator) against the reserve, logs loudly when one drops below it, and shows each on the Network page. They send no value, only gas, so the reserve rule bites only when they run low. `keepsReserve` encodes the full rule for any value-sending flow. | `packages/protocol/src/reserve.ts`, `refreshGasPayers` in `services/broker/src/app.ts`, `apps/app/components/network-view.tsx` |
| **`dippedIntoReserve()` at `0x1001`.** | Not applicable. It answers for the current transaction inside a contract, and Xorv's contracts move USDC, never MON. | — |
| **Contracts up to 128 KB.** | Not a constraint here. XorvEscrow is 10.4 KB, XorvRefundKeeper 2.9 KB, CleanverseGate 1.2 KB (`forge build --sizes`, in CI). | `contracts/` |
| **MIP-8 page storage.** The first access to a 128-slot page costs 8,100; the rest of that page is then warm. | Each escrowed job is one struct (buyer, deadline, status, fee, provider, amount, token: 3 slots) under one mapping key, so a job's reads and writes touch a single page. XorvLedger stores one packed slot per job and puts everything else in events. | `XorvEscrow.Job`, `XorvLedger` |
| **Parallel execution.** Transactions that write the same slot re-execute in order. | XorvEscrow's reentrancy guard uses transient storage (EIP-1153, `ReentrancyGuardTransient`), so it no longer writes one global slot on every fund, release and refund. Per-job state is keyed by job. The one shared write left is `totalEscrowed[token]`, which the owner's token sweep needs in order never to touch buyers' money. | `contracts/src/XorvEscrow.sol` |
| **No global mempool; `eth_getTransactionByHash` never returns a pending transaction.** | Escrow writes use `eth_sendRawTransactionSync`, so the receipt comes back in the send. For anything else the status comes from Monad's `txpool_statusByHash` and the block tags. | `packages/protocol/src/{sync-send,tx-status}.ts` |
| **The public RPC allows 25 `eth_call`s a second and 100-block `eth_getLogs`.** | Payment checks read in one Multicall3 call (`0xcA11…CA11`); history comes from the Envio indexer first and from 100-block windows otherwise. | `readBatch` in `packages/protocol/src/evm.ts`, `services/broker/src/{indexer,ledger-reader}.ts` |

## Escrow gas, before and after the transient guard

`forge test --gas-report`, medians. Foundry 1.7 prices with Ethereum's schedule, not Monad's (cold
access and storage are repriced on Monad), so read these as relative figures.

| Call | Storage guard | Transient guard |
|---|---:|---:|
| `fund` | 166,866 | 164,961 |
| `refund` | 95,249 | 93,344 |
| `cancel` | 68,675 | 66,770 |
| `reassign` | 99,412 | 97,507 |

`release`'s median moved with the fuzzed inputs (173,424 → 177,873 across runs). Its averages are
171,114 and 172,808 respectively, so no gain is claimed for it.

The point isn't the ~1.9k gas. With the storage guard, every escrow call in a block wrote the same
global slot twice; with the transient one, none does.

## On a local fork

anvil 1.7 doesn't apply Monad's gas rules: it charges gas used, enforces a 24 KB code limit, has no
reserve rule and no `0x1001`. So the local demo labels its timings and its reserve check as the
fork's. The rules above are what the code does on Monad itself.
