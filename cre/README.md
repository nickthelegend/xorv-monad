# Chainlink CRE: the refund keeper

XorvEscrow lets **anyone** refund a job once its deadline passes, and the money can only go back to the buyer who paid. That promise is only as good as somebody actually calling `refund`. This CRE workflow is that somebody. It runs on a Chainlink decentralized oracle network, not on Xorv's broker, so it keeps working if the broker goes away.

```
cron (every 5 min)
  └─ HTTP, DON consensus ── Envio index: funded jobs whose deadline has passed
  └─ EVM read, Monad ────── XorvEscrow.isRefundable(jobId)   (the chain decides, not the index)
  └─ report ─────────────── abi.encode(bytes32[] jobIds), signed by the DON
  └─ EVM write ──────────── KeystoneForwarder → XorvRefundKeeper.onReport → XorvEscrow.refund(jobId)
```

- **The index proposes, the chain decides.** A job the index still lists as funded, but which the escrow says is settled, is dropped before the report is built.
- **`XorvRefundKeeper` also skips** anything that changed between the read and the write, so one stale entry can't sink a batch.
- **Sorted list, DON time.** Nodes must agree on the exact job list (identical aggregation). So the list is sorted, and the deadline cut-off uses the DON's agreed time (`runtime.now()`), never a node's own clock.

| Piece | Where |
|---|---|
| Workflow (TypeScript → WASM) | [`refund-keeper/main.ts`](refund-keeper/main.ts) |
| Receiver contract | [`contracts/src/XorvRefundKeeper.sol`](../contracts/src/XorvRefundKeeper.sol) (6 Foundry tests against the real escrow) |
| Chain | Monad testnet (`monad-testnet`, selector `2183018362218727504`) |
| Forwarder | Simulation `0xB9F79d863261869B234c481D1f9A7af84AeAd192` (MockKeystoneForwarder); production `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` |

## Run it

The steps below need a CRE account, a deployed escrow and keeper (`scripts/deploy-testnet.sh monad-testnet`), and the hosted indexer URL in `refund-keeper/config.*.json`.

1. Install dependencies and set up WASM tooling:

   ```bash
   cd cre/refund-keeper && bun install && cd ..
   ```

2. Log in. This opens a browser to sign in to your CRE account:

   ```bash
   cre login
   ```

3. Simulate. This produces a real transaction on Monad testnet through the MockKeystoneForwarder. `CRE_ETH_PRIVATE_KEY` in `cre/.env` pays its gas:

   ```bash
   cre workflow simulate refund-keeper --target staging-settings --broadcast
   ```

4. To compile only (no account needed):

   ```bash
   cd refund-keeper && ./node_modules/.bin/cre-compile main.ts dist/refund-keeper.wasm
   ```

5. To test without an account, run the workflow logic (`refund-keeper/workflow.ts`) under the SDK's own test runtime. `HttpActionsMock` stands in for the indexer and `EvmMock` stands in for the escrow and keeper on the `monad-testnet` selector. The tests cover:
   - only escrow-confirmed refundable jobs reach the report;
   - the report is `abi.encode(bytes32[])` sent to the keeper;
   - the deadline cut-off uses DON time;
   - an empty index or an index ahead of the chain writes nothing;
   - an unreachable index fails loudly.

   ```bash
   cd refund-keeper && bun test
   ```

Deploying the workflow to a live DON needs CRE deploy access. After that, switch the keeper to the production forwarder:

```bash
cast send <keeper> "setForwarder(address)" 0xF8344CFd5c43616a4366C34E3EEE75af79a74482
```
