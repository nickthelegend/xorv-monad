# Deploy later: from "go" to live in under an hour

The ordered runbook for when the user says go. Until then nothing here runs: no Monad
transactions, no hosting, no new repos. Everything below has been rehearsed on a local chain
(`scripts/local-stack.sh`, `scripts/e2e-local.sh`, `MODE=fork`).

**Secrets are set by the user, never by an agent.**
- They go in `.env` locally (gitignored) and in each host's dashboard.
- No script writes a key to a host; `go-live.sh` writes only contract addresses.

## 0. Before "go" (user, ~10 min, can happen any time)

| What | Where | Sets |
|---|---|---|
| Kimi key | platform.moonshot.ai | `MOONSHOT_API_KEY` |
| Qwen key + workspace endpoint | Alibaba Cloud Model Studio | `DASHSCOPE_API_KEY`, `XORV_QWEN_BASE_URL` |
| Privy app, with **Gas sponsorship → Monad Testnet** on | dashboard.privy.io | `PRIVY_APP_ID`, `PRIVY_APP_SECRET` (`NEXT_PUBLIC_PRIVY_APP_ID` for the app's wallet login) |
| CRE account | `cre login` (browser) | CLI session |
| Envio account | envio.dev (GitHub login) | Envio Cloud project |
| Cleanverse access | t.me/TheCleanverseGroup or support@cleanverse.com | Test A-Passes for the demo payer and provider; a validator pool for the escrow |
| Railway and Vercel projects for **Monad** (not the Arbitrum ones) | dashboards | `deployments/hosting.env` (gitignored): `RAILWAY_PROJECT`, `RAILWAY_SERVICE`, `VERCEL_SCOPE`, `VERCEL_APP_PROJECT`, `VERCEL_LANDING_PROJECT` |

## 1. Fund (user, ~5 min)

| Address | Role | Needs |
|---|---|---|
| `0x62d754a6278D732ca25dF5635161A6C9E87Bd511` | Deployer, owner, operator (attester) | **3 MON** from faucet.monad.xyz. The deploy costs about 0.7 MON (Monad charges on the gas limit); the rest covers settlements until Privy sponsors them. |
| `0xfFE96EAb848d2e738D47F94CFa7D347DB004b8f9` | Demo payer (the app's "demo account pays") | **0 MON.** AUSD only: `scripts/faucet-ausd.sh` (Agora's faucet, 10,000 AUSD, 60 s global cooldown) |
| `0x4C60e93bf606012872799D51Ad6f03d9654C71c4` | Demo provider | Nothing. It is paid in AUSD and registered by the operator. |
| `CRE_ETH_PRIVATE_KEY`'s address (`cre/.env`) | Pays the CRE simulation's broadcast | **0.2 MON** |

## 2. Contracts (~10 min)

```bash
scripts/deploy-testnet.sh monad-testnet
```

This deploys XorvRegistry, XorvEscrow, XorvLog and XorvRefundKeeper, wires them, verifies them on
Sourcify (`sourcify-api-monad.blockvision.org`), and writes `deployments/monad-testnet.json` plus the
addresses into `.env`. It checks the wiring back from chain and must print `escrow.attester` and
`registry.operator` = the operator.

**Cleanverse gate.** Turn it on only once Cleanverse has issued A-Passes to the demo payer and
provider; otherwise no job can be paid. Either deploy with it:

```bash
XORV_CLEANVERSE=1 scripts/deploy-testnet.sh monad-testnet
```

or add it later:

```bash
forge create contracts/src/CleanverseGate.sol:CleanverseGate --rpc-url monad_testnet --private-key $XORV_OPERATOR_KEY --broadcast \
  --constructor-args 0xbA82D189540CaC9DC6FF46B6837CaC1BFdEC58B9 0xaC7e5179C2C7f03f209136886c172eb34F161792 0x0000000000000000000000000000000000000000
cast send $XORV_ESCROW_ADDRESS "setIdentityGate(address)" <gate> --rpc-url https://testnet-rpc.monad.xyz --private-key $XORV_OPERATOR_KEY
```

Once Cleanverse registers a pool, redeploy the gate with that pool as the third argument.

## 3. Privy operator wallet (~5 min)

```bash
pnpm --filter @xorv/broker privy:setup          # creates the policy (8 allowed calls) and the server wallet
cast send $XORV_ESCROW_ADDRESS   "setAttester(address)" <privy wallet> --rpc-url https://testnet-rpc.monad.xyz --private-key $XORV_OPERATOR_KEY
cast send $XORV_REGISTRY_ADDRESS "setOperator(address)" <privy wallet> --rpc-url https://testnet-rpc.monad.xyz --private-key $XORV_OPERATOR_KEY
```

Then in `.env` and on Railway: `XORV_SIGNER=privy`, `XORV_PRIVY_WALLET_ID`, `XORV_PRIVY_WALLET_ADDRESS`,
`PRIVY_APP_ID`, `PRIVY_APP_SECRET`. Testnet subsidy: monad@privy.io.

## 4. Repo

Published (7 Oct) as branch `metropolis-escrow` of https://github.com/nickthelegend/xorv-monad, next to that repo's `main` (the 26–28 Sep ERC-8004 build, already live on Monad testnet). Which line becomes the submission's `main`, or how the two merge, is the user's call; nothing here force-pushes `main`.

## 5. Hosting (~15 min)

```bash
scripts/faucet-ausd.sh                 # demo payer gets AUSD
scripts/go-live.sh                     # Railway broker vars (addresses only) + Vercel app and landing
```

- **Railway (broker).** Uses the repo's Dockerfile. In the dashboard, the user sets:
  - `XORV_OPERATOR_KEY` (or the Privy variables);
  - `XORV_DEMO_PAYER_KEY`;
  - `XORV_MONGO_URI` if wanted.

  It needs a volume for the SQLite file; mount it at `/app/data` with the image's UID (see the Arbitrum memory: the volume UID trap).
- **Vercel (app, landing).** `scripts/deploy-web.sh` deploys from a clean export of HEAD. Set `NEXT_PUBLIC_XORV_BROKER_URL` to the Railway URL.
- **Envio Cloud.** Point it at the repo's `indexer/` with `config.yaml` (Monad testnet, the deployed addresses and start block). Then set `NEXT_PUBLIC_XORV_INDEXER_URL` on the app.

## 6. Chainlink CRE (~5 min)

Put the Envio Cloud GraphQL URL, the escrow and the keeper into `cre/refund-keeper/config.staging.json`, then:

```bash
cd cre && cre workflow simulate refund-keeper --target staging-settings --broadcast
```

Record the tx hash; the receiver is `XorvRefundKeeper` through the MockKeystoneForwarder.

## 7. Agents, live (~5 min)

```bash
XORV_AGENT_RECORD=evidence/kimi-run.json xorv-agent "Write and independently review a Solidity function that splits a payment 70/30" --brain kimi --budget 0.30
XORV_AGENT_RECORD=evidence/qwen-run.json xorv-agent "…" --brain qwen --budget 0.30
```

## 8. Smoke test (~5 min)

| Check | Expect |
|---|---|
| `curl $BROKER/health` | `{ok:true}` |
| `curl $BROKER/api/network` | the deployed escrow, registry and log; `operator.signer.mode` = `privy` with 8 rules; `escrow.identityGate` set if Cleanverse is live |
| `xorv run "hello" --broker $BROKER --max 0.25` | completed; escrow released; links open on Monadscan |
| The app: quote → demo account pays → result | job completed, escrow released, receipt in the audit log |
| The app's Network page | History from Envio Cloud matches the jobs run |
| `MODE=fork scripts/e2e-local.sh` against the same build | green |

## 9. Video shot list (≤ 3 minutes; script in SUBMISSION.md)

1. Landing → "Run a job".
2. `xorv start` registering on Monad.
3. App: prompt → quote (402 terms) → pay with no MON → streaming → released.
4. Monadscan: fund and release txs.
5. Network page: Identity and signing (Cleanverse gate, Privy policy), History (Envio).
6. Cleanverse freeze → release refused → unfreeze → paid (fork or live).
7. `xorv-agent --brain qwen` buying jobs within budget.
8. CRE simulate → refund tx.
9. End card.

Total: about 50 minutes of work after "go", most of it waiting on deploys.
