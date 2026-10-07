# Deploy later: the escrow, the CRE keeper and the Cleanverse gate

Testnet deploys are **on hold** until the user says go. Everything here has been built and tested on
local chains and on forks of Monad testnet only. XorvLedger is already live; its steps are in
[DEPLOY.md](../DEPLOY.md). This runbook covers what was added on top of it:
- `XorvEscrow`;
- `XorvRefundKeeper` with the Chainlink CRE workflow;
- `CleanverseGate`.

**Agents never set secrets.** Keys go in the user's `.env` (gitignored) and in each host's dashboard.
No script here writes a key anywhere.

## 0. Before "go" (the user)

| What | Where | Gives |
|---|---|---|
| MON for the operator and the facilitator | faucet.monad.xyz | Deploy gas; settlement gas for `fund`, `release` and `refund`. Monad holds about 10 MON back per account and bills the gas **limit**, so keep each above ~11 MON |
| A CRE account | `cre login` (opens a browser) | The CLI session for `cre workflow simulate` |
| The CRE broadcast key | a fresh EOA in `cre/.env` as `CRE_ETH_PRIVATE_KEY` (gitignored), with ~0.5 MON | Pays the simulation's on-chain report |
| An Envio Cloud project | envio.dev | The indexer endpoint the keeper queries |
| Cleanverse access | t.me/TheCleanverseGroup or support@cleanverse.com | Test A-Passes for the demo buyer and provider; a registered pool for CVA (aUSDC) |
| AI and Privy keys (optional) | Moonshot, Alibaba Model Studio, dashboard.privy.io | `MOONSHOT_API_KEY`, `DASHSCOPE_API_KEY`, `PRIVY_APP_ID`/`PRIVY_APP_SECRET` |

## 1. Deploy the escrow and the keeper (~5 min)

```bash
cd contracts
git submodule update --init --recursive
forge test
XORV_OPERATOR_KEY=0x… XORV_FACILITATOR_KEY=0x… \
  forge script script/Deploy.s.sol --rpc-url https://testnet-rpc.monad.xyz --broadcast \
  --verify --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org
```

What the script does:
- **Owner:** the operator owns both contracts.
- **Attester:** the escrow's attester (fund, release, refund, reassign, cancel) is the facilitator key's address.
- **Tokens:** Circle USDC and AUSD on chain 10143.
- **Forwarder:** the keeper trusts Monad testnet's MockKeystoneForwarder (`0xB9F79d86…`), which `cre workflow simulate --broadcast` delivers through.
- **Registry:** the escrow's registry hook is left unset, because reputation goes through XorvLedger to ERC-8004.

Record the printed addresses and the deploy block.

## 2. Point the broker at it

In `.env`, and on the broker's host:

```
XORV_FACILITATOR=self
XORV_FACILITATOR_KEY=…            # the attester's key (the user sets it)
XORV_ESCROW_ADDRESS=<XorvEscrow>
XORV_ESCROW_DEADLINE_S=1800
```

Check `curl -s <broker>/api/network | jq .escrow`: it should show the address, and `identityGate`
should be `null` until step 4. Without `self` and a facilitator key, the broker warns at boot and
stays on `exact`.

## 3. Index it and run the CRE keeper

1. Set `ENVIO_XORV_ESCROW_ADDRESS` and `ENVIO_XORV_ESCROW_START_BLOCK` on the Envio Cloud
   indexer (`services/indexer`), next to the ledger's, and redeploy it
   ([services/indexer/README.md](../services/indexer/README.md#deploying-to-envio-cloud)).
2. Put the indexer's GraphQL URL, the escrow and the keeper into
   `cre/refund-keeper/config.staging.json`.
3. Run:

   ```bash
   cd cre && cre login
   cre workflow simulate refund-keeper --target staging-settings --broadcast
   ```

   To see a refund, first fund a job and let its deadline pass, for example with
   `XORV_ESCROW_DEADLINE_S=120` and a provider that is stopped mid-job. Record the refund tx for
   SUBMISSION.md.

## 4. Turn on the Cleanverse gate (only after A-Passes are issued)

With the gate on, nobody without a valid A-Pass can fund a job or be paid, so turn it on only once
Cleanverse has issued A-Passes to the demo buyer and provider. Either redeploy with
`XORV_CLEANVERSE=1` in step 1, or add the gate to the existing escrow:

```bash
forge create src/CleanverseGate.sol:CleanverseGate --rpc-url https://testnet-rpc.monad.xyz \
  --private-key $XORV_OPERATOR_KEY --broadcast \
  --constructor-args 0xbA82D189540CaC9DC6FF46B6837CaC1BFdEC58B9 0xaC7e5179C2C7f03f209136886c172eb34F161792 0x0000000000000000000000000000000000000000
cast send <XorvEscrow> "setIdentityGate(address)" <gate> \
  --rpc-url https://testnet-rpc.monad.xyz --private-key $XORV_OPERATOR_KEY
```

The first two arguments are Cleanverse's A-Pass and compliance validator on Monad testnet. Once
Cleanverse registers a pool for Xorv, redeploy the gate with that pool as the third argument. That
pool is also what lets aUSDC (CVA) move at all; until then every aUSDC transfer reverts
`TransferNotAllowed()`.

## 5. Smoke test

| Check | Expect |
|---|---|
| `curl <broker>/api/network \| jq .escrow` | the escrow; `identityGate` set if step 4 ran |
| `xorv run "hello" --broker <broker> --max 0.05` | the 402 offers `escrow` first; `JobFunded` then `JobReleased` on Monadscan; the XorvLedger receipt's payment tx is the release |
| Cancel a running job in the app | `JobRefunded`, buyer made whole |
| The CRE simulation | a refund tx through the keeper |
| The app's network page | XorvEscrow and the identity gate rows |

Rehearse it all first on a fork with no keys and no funds:

```bash
pnpm build && (cd contracts && forge build) && pnpm e2e:escrow
```

## 6. Fill in the docs

Replace each **TODO(deploy)** in README.md and SUBMISSION.md for the escrow, keeper, gate and CRE
simulation with explorer links (`grep -n "TODO(deploy)" README.md SUBMISSION.md`).
