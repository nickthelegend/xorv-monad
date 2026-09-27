# Going live on Monad testnet

The order matters. Each step produces a value the next one needs (the
ledger address, the broker's public URL, the indexer endpoint, the app's
origin). Doing them out of order means redeploying.

| Piece | Runs on | Needs from earlier steps |
|---|---|---|
| XorvLedger contract | Monad testnet (Hardhat, `packages/contracts`) | a funded deployer key, the operator's address, a cold owner address |
| Broker | any host with Docker, or Node ≥ 22.13, behind public HTTPS | ledger address + deploy block |
| Indexer | Envio Cloud (`services/indexer`) | ledger address + deploy block |
| App + landing | Vercel, two projects (`apps/app`, `apps/landing`) | broker URL, ledger address |
| MCP agent wallet | Privy server wallet | broker URL |
| Provider node | any machine with the CLI and an AI subscription | broker URL |

Local tooling: Node ≥ 22.18 and pnpm 10.29.2 (`corepack enable` picks it up
from `package.json`), then `pnpm install && pnpm build` at the repo root.

## 1. Keys and funding

```bash
cp .env.example .env
pnpm setup:monad --new-keys   # prints fresh operator + facilitator keys; paste them into .env
```

- **MON** from https://faucet.monad.xyz for the operator (`XORV_OPERATOR_KEY`:
  ledger deploy and writes, rating relays, verifier feedback) and the
  facilitator (`XORV_FACILITATOR_KEY`: settlement gas). Keep each above the
  ~10 MON Monad holds back as a per-account reserve.
- **USDC** from https://faucet.circle.com (network: Monad Testnet) for a
  buyer key (no MON needed, the facilitator pays gas). Put it in
  `XORV_DEMO_PAYER_KEY` in `.env` to have `pnpm usdc` report it.
- Optional AI roles: `TOKENHUB_API_KEY` (Hunyuan screener), `DASHSCOPE_API_KEY`
  (Qwen router), `MOONSHOT_API_KEY` (Kimi verifier). Each turns on when its
  key is set.

`pnpm usdc` shows who holds what; `pnpm setup:monad` shows what's missing.

## 2. Deploy XorvLedger

Set two addresses in `.env`:

- `XORV_BROKER_ADDRESS`: the operator's address, the only EOA the ledger
  accepts writes from.
- `XORV_LEDGER_OWNER`: an address the broker's host does **not** hold (a
  hardware or multisig wallet). The owner is the only account that can rotate
  the broker (`setBroker`) or hand over ownership, so it is how a leaked
  operator key gets rotated out. It defaults to the deployer, and on Monad
  testnet and mainnet the script refuses an owner that is the broker or the
  operator key's address, so a plain operator-key deploy stops here until
  you name one.

Then:

```bash
pnpm deploy:ledger
```

It pays with `XORV_DEPLOYER_KEY` (environment, then the Hardhat keystore),
or the operator key when neither has one; the deployer holds no role. It
prints the deployer, broker and owner, the address and deploy block, and
writes `packages/contracts/deployments/monadTestnet.json`. Paste the two values into
`.env` as `XORV_LEDGER_ADDRESS` and `XORV_LEDGER_FROM_BLOCK`, and commit the
deployments file (the script refuses to overwrite it later without
`XORV_REDEPLOY=1`, because a new address orphans everything indexed under the
old one). Verify the source with `pnpm verify:ledger`
(Sourcify always, Monadscan too when `MONADSCAN_API_KEY` is set).

## 3. Start the broker

Pick the host first: `XORV_PUBLIC_URL` is written into on-chain agent and
feedback URIs, so it has to be the final HTTPS URL before any provider
registers. A quick tunnel whose URL changes on restart is not good enough.
In `.env`:

```bash
XORV_PUBLIC_URL=https://broker.example.com
XORV_APP_URL=https://<app>.vercel.app          # step 5; the "web" service in agent files
XORV_CORS_ORIGINS=https://<app>.vercel.app,https://<landing>.vercel.app
XORV_TRUST_PROXY=1                             # behind a TLS-terminating proxy
XORV_TRUSTED_HOPS=1                            # proxies in front; the client IP is read this many X-Forwarded-For entries from the right
```

Then either:

```bash
docker compose up -d --build     # SQLite in the xorv-data volume, healthcheck on /health
```

or, without Docker (Node ≥ 22.13; data in `./data`):

```bash
pnpm install --frozen-lockfile && pnpm build
pnpm broker:start
```

Check `https://broker.example.com/api/network`: the facilitator, the ledger and
`aiRoles` should all say what you configured. Re-run `pnpm setup:monad` for
the same answers with balances.

## 4. Deploy the indexer to Envio Cloud

Details in [services/indexer/README.md](services/indexer/README.md#deploying-to-envio-cloud).

1. https://envio.dev/app/login with GitHub, install the *Envio Deployments*
   app on this repository.
2. Add an indexer: root directory `services/indexer`, config `config.yaml`,
   deployment branch `main`.
3. Environment: `ENVIO_XORV_LEDGER_ADDRESS` and `ENVIO_XORV_LEDGER_START_BLOCK`
   (the same two values as step 2). Add `ENVIO_XORV_VERIFIER_ADDRESSES` only if
   `XORV_VERIFIER_KEY` is a separate key.
4. Set the endpoint it prints
   (`https://indexer.dev.hyperindex.xyz/<id>/v1/graphql`) as `XORV_INDEXER_URL`
   on the broker and restart it. `/api/leaderboard` now comes from Envio.

**Redeploy between Oct 10 and Oct 13.** The free Development plan deletes a
deployment after 30 days; one made in September expires before judging
(Oct 14–27) is over. Push to the deployment branch (or redeploy from the
dashboard) in that window, and update `XORV_INDEXER_URL` if the endpoint
changed.

## 5. Deploy the app and the landing to Vercel

Two Vercel projects on this repository. The Hedera prototype was served from
`xorv-app.vercel.app` and `xorv.vercel.app`; reuse those projects to keep the
domains, or create new ones and use their origins in step 3.

| Setting | App | Landing |
|---|---|---|
| Root Directory | `apps/app` | `apps/landing` |
| Framework, install, build | from `apps/app/vercel.json` | from `apps/landing/vercel.json` |
| Include files outside the root directory | on (the default) | on |
| Node.js version | 22.x | 22.x |

Both `vercel.json` files install from the root lockfile, filtered to the site
and its workspace dependencies, and build those dependencies first: for the
app that is `@xorv/protocol`, which it imports through its compiled `dist/`;
the landing has none today.

Environment variables (`NEXT_PUBLIC_*` are inlined at build time: redeploy
after changing one). The `.env.example` in each app says what each one does.

- Both: `ENABLE_EXPERIMENTAL_COREPACK=1`, so Vercel runs the pnpm version
  pinned in the root `package.json` instead of guessing from the lockfile.
- App: `NEXT_PUBLIC_XORV_BROKER_URL`, `NEXT_PUBLIC_XORV_NETWORK=eip155:10143`,
  `NEXT_PUBLIC_PRIVY_APP_ID` (plus `NEXT_PUBLIC_PRIVY_CLIENT_ID` if the Privy
  app uses one); server-only `XORV_DEMO_PAYER_KEY` for "Pay from demo
  account" (testnet only). The demo routes are bounded without further
  settings: per-IP and deployment-wide rate limits, one payment attempt per
  quote, a per-job cap (`XORV_DEMO_MAX_USDC_UNITS`), a rolling 24 h cap
  (`XORV_DEMO_DAILY_USDC_UNITS`, default 5000000 = $5), and ratings only
  from the browser that paid (an HttpOnly receipt, HMAC-keyed from the demo
  key unless `XORV_DEMO_RECEIPT_SECRET` is set).
- Landing: `NEXT_PUBLIC_XORV_BROKER_URL`, `NEXT_PUBLIC_XORV_APP_URL`,
  `NEXT_PUBLIC_XORV_LEDGER_ADDRESS`, `NEXT_PUBLIC_XORV_NETWORK`.

Then add the app's origin to the Privy app's allowed origins
(dashboard.privy.io), and make sure both origins are in the broker's
`XORV_CORS_ORIGINS` and the app's in `XORV_APP_URL` (restart the broker if you
changed them).

## 6. Create the MCP agent's Privy wallet

`privy:setup` reads the Privy credentials from the shell, not from `.env`:

```bash
export XORV_PRIVY_APP_ID=<app id> XORV_PRIVY_APP_SECRET=<app secret>
pnpm privy:setup --cap-usdc 0.50 --broker https://broker.example.com
```

(PowerShell: `$env:XORV_PRIVY_APP_ID="…"; $env:XORV_PRIVY_APP_SECRET="…"`.)
It creates a policy that caps each payment and allows only USDC
authorizations and XorvLedger ratings on this chain, binds a server wallet
to it, and prints the `XORV_PRIVY_*` lines for the MCP client's `env` block.
Fund the printed address with test USDC. `--dry-run` prints the policy
without creating anything.

## 7. Register a provider identity

On the machine that will sell capacity (install the CLI as in
[packages/cli/README.md](packages/cli/README.md)):

```bash
xorv init --broker https://broker.example.com
xorv wallet                  # the payout address, with faucet links
# send it a little MON: registering is the one transaction a provider pays for
xorv identity register       # ERC-8004 agent, agentURI = <broker>/agents/<providerId>.json
xorv identity show
xorv start
```

The agent URI names the provider id, never the node id: the node id is what
the node registers with, so it stays off-chain. `xorv start` saves the
session's bearer token to the node's config and presents it when it
re-registers; a live session cannot be taken over without it (409
`node_live`). A node restarted without its token waits out the old session
once, then registers with a fresh one.

## 8. One paid job, and the hashes the submission needs

```bash
XORV_PAYER_KEY=0x<buyer key with test USDC> \
  xorv run "Explain what a Merkle tree is, briefly." --max 0.05 --broker https://broker.example.com
```

Then pay for one from the deployed app with a Privy login, and rate it.
`GET https://broker.example.com/api/jobs/<id>` returns every hash for a job.

| Evidence | Where it comes from |
|---|---|
| XorvLedger address and deployment | `address` and `txHash` in `packages/contracts/deployments/monadTestnet.json` (`pnpm deploy:ledger`) |
| Provider ERC-8004 registration | `xorv identity register` output; `xorv identity show` prints the agent id |
| x402 USDC settlement (buyer pays no gas) | `xorv run` output; `payment.txHash` on the job |
| On-chain receipt (`recordJobs`) | `receiptTxHash` on the job, a few seconds after it finishes |
| Buyer rating relayed to ERC-8004 (`rateJob`) | `rating.txHash` on the job |
| Kimi verifier feedback | `verification.feedbackTxHash` (with `MOONSHOT_API_KEY` set) |
| Privy embedded-wallet payment | the app job's `payment.txHash` |
| Privy server-wallet payment (MCP agent) | `xorv_run_job`'s "Paid" explorer link, or `payment.txHash` on that job |
| Nansen x402 payment (Monad **mainnet**) | `curl -s <broker>/api/network \| jq .nansen.lastPaidTx` with `XORV_NANSEN_MODE=live` and `XORV_NANSEN_PAYER_KEY` set, after a provider connects |
| Envio GraphQL endpoint | the Envio Cloud dashboard, or `envio-cloud deployment endpoint <indexer> <commit>` (step 4) |

The ledger's own history is at `https://testnet.monadscan.com/address/<XORV_LEDGER_ADDRESS>`
and, through the broker, at `/api/ledger?kind=receipts` (or `ratings`,
`registrations`).
