# Sponsor gap — what each bounty asks, what Xorv has, what's left

Status as of 6 Oct 2026. Nothing is deployed yet: every integration below is built and tested
**locally** (Anvil, or an Anvil fork of Monad testnet), with real contracts and real signed
transactions. **The running product contains no mocks or fixture modes.** Where a key is missing,
the product says "not configured" (or, for the agent, names the key and stops). Test doubles exist
only in test files. The live step for each bounty is listed with the exact key or account it needs.

Track: **04 — Trust, Identity & AI Infrastructure.**

| Bounty | Verdict | Blocked on |
|---|---|---|
| Cleanverse CVI/CVA (T4, $2k) | **BLOCKED for CVA.** The CVI gate is built and verified against Cleanverse's real A-Pass on a fork. No app can move aUSDC until Cleanverse onboards it | Cleanverse: docs access, pool registration, test A-Passes |
| Privy (All, $5k) | **Built, live run BLOCKED.** The signer, policy and sponsorship are real code, and the policy is tested against real calldata and a real chain | `PRIVY_APP_ID`, `PRIVY_APP_SECRET` |
| Chainlink CRE (All, $3k) | **Met, short of the simulation run**: compiles to WASM, logic tested under the SDK's own test runtime | `cre login` |
| Envio (All, $1k) | **Met locally**: indexer over the local chain, app reads it, e2e checks it | Envio Cloud deploy (hosting is paused for now) |
| Kimi (All, credits) | **Built, live run BLOCKED.** The agent loop, MCP, escrow payments and budget are tested end to end; the model call needs the key | `MOONSHOT_API_KEY` |
| Alibaba Qwen 3.8 Max (T4, credits) | **Built, live run BLOCKED**, same as Kimi | `DASHSCOPE_API_KEY` and the workspace URL |

---

## Cleanverse — Best Integration of CVI/CVA

> "Build an app that **gates CVA asset movement behind on-chain CVI identity verification**."

**Built.**
- `XorvEscrow.setIdentityGate`: with a gate set, `fund` requires buyer and provider to be verified, and `release` and `reassign` require the payee to be. Refunds are never gated, so a lapsed credential can't trap money.
- `CleanverseGate` (`contracts/src/CleanverseGate.sol`) answers from Cleanverse's own A-Pass validity view. That view is false once Cleanverse freezes, revokes or expires a credential, so a freeze takes effect in Xorv in the same block. Once a pool is registered, the gate also requires the compliance validator's `complianceVerify(pool, user)`, failing closed until then.
- Off-chain: the facilitator refuses an unverified party before anything is signed (`identity_not_verified`), and the broker never matches an unverified provider. The CLI explains the refusal, and the app shows the gate and each provider's A-Pass standing.

**How it was built without docs.** The docs are invite-only and the contracts are unverified, so the A-Pass interface was read off the Monad testnet deployment on a local fork:
- the validator `0xaC7e…1792` holds `ISSUER_ROLE`;
- `0xb8dd3664` issues a credential;
- `0xf480b6f5` is the validity view;
- `freeze`, `unfreeze` and `revoke` behave as named.

**Evidence.**
- `forge test --match-contract CleanverseGateTest`: 13 tests, including fuzzing.
- `FORK_TESTS=1 forge test --match-contract CleanverseGateFork`: 3 tests against the **real** A-Pass and validator, with real AUSD from Agora's faucet:
  - issue → fund;
  - freeze → payout blocked;
  - unfreeze → paid;
  - revoke → no new jobs;
  - expiry;
  - an unregistered pool fails closed.
- `MODE=fork CLEANVERSE=1 scripts/e2e-local.sh`: 18/18. A buyer without an A-Pass is refused with nothing moved. Once issued one (by the impersonated validator, on the fork only), the same buyer pays, and the job settles through the gated escrow.

**Blocked: CVA itself.** (Also found independently in `thenar-monad-quest/docs/CLEANVERSE.md`: every unregistered pool reverts `PoolNotRegistered()`, and on a fork every aUSDC transfer reverts `TransferNotAllowed()`, even the owner's own mint.) aUSDC (`0xFA96…1026`) moves only between wallets its own transfer policy (`0x2c6E…eBFf`) recognises. That policy keeps its own credential store, populated by Cleanverse's backend: it returns nothing even for a wallet that holds an A-Pass. aUSDC also has no EIP-3009, which Xorv's gasless x402 escrow funding relies on. So the gate is enforced today on the AUSD/USDC value Xorv moves, while escrowing aUSDC itself needs two things from Cleanverse:
- the escrow recognised by the aUSDC policy;
- a pool registered with the validator.

**Live step.**
1. `XORV_CLEANVERSE=1 scripts/deploy-testnet.sh monad-testnet` deploys the gate and sets it.
2. Real A-Passes for the demo buyer and provider come through Cleanverse (UAT API `generate_apass`, invite-only).
3. Request access: t.me/TheCleanverseGroup or support@cleanverse.com. Ask for: A-Passes for two wallets, a validator pool for the escrow, and the escrow added to the aUSDC policy.

## Privy — beyond authentication

> "Your project must integrate Privy **beyond authentication** … bonus points for **multiple Privy features**."

**Built** (`packages/protocol/src/privy.ts`): the broker's operator, its hot wallet, becomes a **Privy server wallet** with three properties.
- **Policy engine.** `operatorPolicy` allows exactly the eight calls the broker makes:
  - escrow `fund`, `release`, `refund`, `reassign`, `cancel`;
  - log `append`;
  - registry `registerFor`;
  - EIP-3009 `transferWithAuthorization`.

  Each is allowed on this chain only, at zero value. Everything else is denied, including the escrow's owner-only functions and any MON transfer.
- **Native gas sponsorship.** It sends with `sponsor: true`, so the operator needs no MON.
- **Key custody.** The key never leaves Privy.

`pnpm --filter @xorv/broker privy:setup` creates the policy and the wallet; `--print` shows the policy JSON.

Without the Privy keys the broker signs with its raw key and says so: `/api/network` reports `operator.signer.mode = "key"` with no policy, and the app shows "Privy not configured on this broker". There is no stand-in.

**Evidence.**
- `packages/protocol/test/privy.test.ts`: 11 tests (policy shape, evaluation under Privy's documented rules, the real sender's request body, sponsored-hash polling, authorization keys).
- `privy.anvil.test.ts`: 3 tests. A test sender stands in for Privy's enclave and applies the policy. The broker's real fund/release path passes it, and an owner-only `pause` is refused before signing, although the chain would accept it.

**Live step.**
1. Create the app at dashboard.privy.io and enable gas sponsorship for Monad Testnet.
2. Set `PRIVY_APP_ID` and `PRIVY_APP_SECRET`, then run `privy:setup`.
3. Hand the escrow's attester role and the registry's operator role to the printed address (two `cast send`s, also printed).
4. Set `XORV_SIGNER=privy`.

Testnet subsidy: monad@privy.io.

## Chainlink — Best workflow with CRE

> "Build, simulate, or deploy a CRE Workflow used as an **orchestration layer**." A CLI simulation is accepted.

**Built** (`cre/refund-keeper`), as a pipeline:
- cron;
- HTTP with DON consensus, querying the Envio index for funded jobs past their deadline;
- an EVM read of `isRefundable` on Monad for each one, so an index ahead of the chain can't cause a bad refund;
- a DON-signed report;
- KeystoneForwarder;
- `XorvRefundKeeper.onReport` (a real receiver, with 6 Foundry tests) calling `XorvEscrow.refund`.

**Evidence.**
- `bun test` in `cre/refund-keeper`: 4 tests under the SDK's own `HttpActionsMock` and `EvmMock` on the `monad-testnet` selector. They cover:
  - only escrow-confirmed jobs reach the report;
  - the report is `abi.encode(bytes32[])` sent to the keeper;
  - the cut-off uses DON time;
  - empty index, index ahead of chain, and unreachable index.
- `cre-compile` builds the WASM.

**Live step.** `cre login`, then `cre workflow simulate refund-keeper --target staging-settings --broadcast`. That needs the contracts on testnet and the hosted index URL in the config.

## Envio — Best Use of Envio

> HyperIndex/HyperSync powering a core feature; derived/aggregated entities; a consumer; a demo of data flowing end to end.

**Built** (`indexer/`):
- three contracts;
- entities: Job (full lifecycle, seconds to settle), Provider (on-chain score, earnings, heartbeats), Buyer, Receipt, and the DailyStat and Network aggregates.

Consumers: the app's History panel (totals, provider leaderboard, day by day) and the CRE workflow's expired-jobs query. It's load-bearing because Monad's public RPC serves 100 blocks per `eth_getLogs`.

**Evidence.**
- 4 handler tests.
- `INDEXER=1 scripts/e2e-local.sh`: 8/8, the index checked against the chain.
- The local stack's app shows a real Codex job: funded, released, 8 s to settle, provider score 66.7%.

**Live step.** Deploy to Envio Cloud (envio.dev, GitHub login) with `indexer/config.yaml` on Monad testnet, then set `NEXT_PUBLIC_XORV_INDEXER_URL`.

## Kimi and Qwen — genuinely agentic, not bolted on

**Built.** `xorv-agent` (`packages/agent`): Kimi k2.6 or Qwen 3.8 Max (thinking on) as an autonomous **buyer**.
- Its tools are the Xorv MCP server.
- It reads the live market, picks what to hire, and pays each job in AUSD through the escrow over x402.
- It stays inside a budget enforced in code.

Providers can also *sell* Kimi and Qwen capacity through the `kimi` and `qwen` adapters.

The agent has no offline mode: without a key it names the key and stops. In tests, and in the `AGENT=1` e2e when no key is set, a **test-double model server** (`packages/agent/test/model-server.ts`) speaks each API's documented response format (Kimi's `reasoning_content`, Qwen's call ids). That exercises the real binary, MCP server, escrow payments and budget, but it is not a model run. `XORV_AGENT_RECORD` keeps a live run's responses as evidence.

**Evidence.**
- 9 agent tests.
- `AGENT=1 scripts/e2e-local.sh`: both brains, through the test-double model server, buy two jobs each through the real escrow, 6/6 checks each. With the keys set, the same stage calls the live APIs.

**Live step.** Set the key, run `xorv-agent "<goal>" --brain kimi|qwen --budget 0.30`, and keep the recording with `XORV_AGENT_RECORD`.

## Not claimed

| Bounty | Why not |
|---|---|
| Agora AUSD (T1, T2) | Track-locked away from T4, and both require Mera sign-in. Xorv still settles in AUSD. |
| Mera, Dynamic, MetaMask Agent Wallet, Kuru, Perpl, Nansen, Aurora | Not this product, or mainnet-only. |
| Alchemy | Possible later (Gas Manager overlaps with Privy sponsorship). |
| Tencent Hunyuan | T3 only. |

## Keys and accounts the user needs to provide

| For | What | Where |
|---|---|---|
| Kimi | `MOONSHOT_API_KEY` | platform.moonshot.ai |
| Qwen | `DASHSCOPE_API_KEY` + workspace `XORV_QWEN_BASE_URL` | Alibaba Cloud Model Studio |
| Privy | `PRIVY_APP_ID`, `PRIVY_APP_SECRET`; gas sponsorship on for Monad Testnet | dashboard.privy.io |
| CRE | `cre login` (browser) | CRE account |
| Envio | Envio Cloud account (GitHub) | envio.dev |
| Cleanverse | Docs/UAT API access; A-Passes for two demo wallets | t.me/TheCleanverseGroup, support@cleanverse.com |
| Monad (when deploys resume) | Testnet MON for the deployer | faucet.monad.xyz |
