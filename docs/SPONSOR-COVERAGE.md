# Sponsor coverage and Monad-native features

Audited 13 Oct 2026 from the code and from live runs on Monad testnet, not from the README. The statuses are:
- **Working:** real calls or transactions in the product path, with tests.
- **Partial:** the code is real and tested, but the live run waits on a key, an account or an asset.
- **Not used:** with the reason.

Bounty *claims* respect track locks (see [SUBMISSION.md](../SUBMISSION.md#bounties-entered)). Using a protocol is not a claim.

**Counts: 8 working · 4 partial · 13 not used.** Two of the working rows rest on fork evidence or contract-level evidence, and are labelled so.

## Sponsor protocols

| Protocol | Status | What Xorv does with it | Evidence |
|---|---|---|---|
| **Chainlink CRE** | **Working** | The `refund-keeper` workflow finds expired escrowed jobs in the Envio index, checks `isRefundable` on XorvEscrow, and sends a report through the forwarder to XorvRefundKeeper, which refunds the buyer. | `cre/refund-keeper` (4 bun tests, WASM compile). On 13 Oct, `cre workflow simulate --broadcast` refunded a real expired job: [`0xa85c2f…cd15`](https://testnet.monadvision.com/tx/0xa85c2f69d7ccb7fea3d3d574d453f9974125b493675d626a2e037e8002decd15). |
| **Chainlink Data Feeds** | **Working** | **USDC/USD** (testnet `0x3982…Ff95`) is a peg guard: the broker stops quoting while USDC is more than 2% off $1. **MON/USD** (mainnet `0xBcD7…22fb`; testnet has no MON feed) prices the facilitator's gas in dollars on the speed receipt. Readings are cached for a minute and published on `/api/network`. | `packages/protocol/src/price-feeds.ts`, `services/broker/src/prices.ts`. Tests cover the protocol, the broker cache and outage behaviour, and an integration test that refuses, then resumes, quoting. Live readings appear on the hosted broker's `/api/network`. |
| **Privy** | **Working** | 1. The app's embedded wallet pays the x402 / escrow authorization and signs gasless ERC-8004 ratings. 2. The MCP agent pays from a Privy **server wallet** whose policy allows only USDC payments of at most $0.05, direct or into this XorvEscrow, plus ledger ratings. | `packages/mcp/src/privy-policy.ts` and its tests. Live escrowed jobs paid from the server wallet: fund [`0x9d3ab6…c7b2`](https://testnet.monadvision.com/tx/0x9d3ab6147ac88fd14feedd7feef8ad1dae21b2389f7e4854d8386b67fb38c7b2), release [`0xb1cc49…b710`](https://testnet.monadvision.com/tx/0xb1cc49d5c863489678d9f1b7f69537eb427d0a4f4212d452bef1028e74b3b710). |
| **Kimi (Moonshot)** | **Working** | 1. It verifies every completed job, and the hosted broker **releases the escrow only on Kimi's pass** (`XORV_RELEASE_ON_VERDICT`; a fail refunds the buyer). The verdict is also written as ERC-8004 feedback for agent #2252. 2. The hosted provider node sells Kimi K3, with a persisted daily cap of 40 jobs and 120k tokens. | `services/broker/src/ai` (tests). Live: `job_4o0BmILtuvz5`, a 95/100 pass, then release [`0x8ab899…`](https://testnet.monadvision.com/tx/0x8ab89925367b418d559959e845ffbd8f1e4e1917e1bcf7a13ce262b3286b1e2b), and ERC-8004 feedback [`0x7a0677…`](https://testnet.monadvision.com/tx/0x7a0677caa130295ab9e78fdc3c4715ea2784d743cb82c3eb57b9ae056780eeb2). Railway service `provider`. |
| **Envio (HyperIndex)** | **Working** (local) · Cloud pending | It indexes XorvLedger, both ERC-8004 registries and XorvEscrow (`EscrowJob`). It feeds the leaderboard and the CRE keeper. | `services/indexer` (66 tests). Run live against the testnet contracts on 13 Oct (`envio dev`); the CRE refund above read from it. Envio Cloud needs the user's GitHub login (doitlater.md). |
| **Nansen** | **Working** | It profiles each provider's payout wallet (first funder, related wallets, activity) and refuses ratings between related wallets (the wash-rating guard). Calls are cached, with a daily budget. | `services/broker/src/trust` (tests). A live API-key run on 13 Oct made 4 calls and scored 1 wallet; it is on only while recording, to save the shared 100 credits. |
| **Cleanverse (CVI)** | **Working** (fork evidence) | `CleanverseGate` on XorvEscrow refuses to fund jobs for buyers or providers without an A-Pass, and the app shows identity badges. | `pnpm e2e:escrow` (31/31, 13 Oct) on a Monad testnet fork with Cleanverse's **real A-Pass contract** `0xbA82…58B9`. A buyer without an A-Pass was refused (`identity_not_verified`) before anything moved. Then Cleanverse's own validator issued one (impersonated on the fork), and the same buyer paid and was released: fork tx `0xf54f15…31a5` ([e2e/last-run-escrow.md](../e2e/last-run-escrow.md)). The testnet gate waits on A-Passes for real wallets (doitlater.md). |
| **Mera (Monad Foundation)** | Partial | Private jobs: keys come from the buyer's passkey through Mera. The result is sealed to it, and the passkey's signature is verified on chain through the P256 precompile `0x0100`. | `apps/app/lib/private/*`; tests include `passkey-onchain.test.ts`. A live check across two devices needs a person (doitlater.md). |
| **MetaMask (Agent Wallet plugin)** | Partial | `@xorv/mm-plugin`: `mm xorv run` buys a job and MetaMask signs the x402 authorization under the user's policy. | `packages/mm-plugin` (74 tests). A live run needs `mm login` (doitlater.md). The bounty is track-locked, so it is not claimed. |
| **Qwen (Alibaba)** | Partial | Qwen is the router on Auto: it reads providers' ERC-8004 reputation and XorvLedger receipts with tools, then picks one. Providers can also sell it. | `services/broker/src/ai/router*.ts` (tests). Shows "not configured" until `DASHSCOPE_API_KEY` is set (doitlater.md). |
| **Tencent Hunyuan** | Partial | Safety screen before any provider sees a prompt; also a provider adapter. | `services/broker/src/ai` (tests). No key, so it shows "not configured". The bounty is track-locked, so it is not claimed. |
| **Agora AUSD** | **Working** (on-chain settlement) | XorvEscrow settles any allow-listed EIP-3009 token, and AUSD is allow-listed. A buyer signs `ReceiveWithAuthorization` under AUSD's "Agora Dollar" domain, and the escrow holds the AUSD until delivery. The broker's quotes stay in USDC. | Monad testnet, 13 Oct, `e2e/live/ausd-escrow-job.mjs`: Agora faucet → test buyer [`0xb882bc…cfcd`](https://testnet.monadvision.com/tx/0xb882bc83750ec8e33108dbb6ab75b18746552a3b36422fabfd74bc0b1b1acfcd); 0.02 AUSD into XorvEscrow [`0x3ac185…96e2`](https://testnet.monadvision.com/tx/0x3ac185126ec55ba765456680c827363fcfa7d6534b5dc80f28c5d4faa68d96e2); released to the hosted provider [`0x68a065…7a61`](https://testnet.monadvision.com/tx/0x68a065816eb2d377c3c75c20f5a7af12a4c6d176ee109197e364b3d2588e7a61). |
| Zerion API | Not used | Tested 13 Oct: Zerion's testnet mode lists `monad-test-v2`, but it returned no positions or transactions for a wallet with live testnet activity. Mainnet data alone has nothing to say about a testnet marketplace. | none |
| Kuru | Not used | A DEX. Xorv buyers pay in USDC and never swap. | none |
| Perpl | Not used | Perpetuals; nothing in a pay-per-job marketplace takes positions. | none |
| Dynamic | Not used | Privy is the wallet layer; a second embedded-wallet provider would duplicate it. | none |
| Alchemy | Not used | The public Monad RPC plus Envio cover reads, and no key was issued. | none |
| Aurora Intents | Not used | Mainnet-only. | none |
| Mercuryo | Not used | Mainnet-only fiat on-ramp. | none |
| BlockVision | Not used | Explorer links go to MonadVision, and Xorv's own in-app chain viewer reads the RPC. | none |
| Tenderly | Not used | Writes are simulated through `eth_estimateGas` / `simulateContract` before sending. | none |
| QuickNode | Not used | RPC; the public Monad endpoint is enough. | none |
| Chainstack | Not used | RPC; as above. | none |
| Dwellir | Not used | RPC; as above. | none |
| Spectrum | Not used | RPC; as above. | none |

## Monad-native features (MONAD-TECH.md, top 8)

| # | Feature | Status | Where |
|---|---|---|---|
| 1 | Commit-state pipeline over `monadNewHeads` / `monadLogs` | Working | Network page: live Proposed → Voted → Finalized → Verified chips with measured medians, plus live XorvLedger events. |
| 2 | `eth_sendRawTransactionSync` and two timers; `txpool_statusByHash` | Working | Every settlement and escrow release is sent with sync send. The speed receipt shows "executed X ms · final Y ms", and `tx-status.ts` shows "seen by node" through `txpool_statusByHash`. |
| 3 | Mera passkeys plus on-chain P256 (`0x0100`) | Partial | Private jobs (see Mera above). |
| 4 | Native staking (`0x1000`) | Read-only | The network page reads the epoch, the validator proposing now and its stake. Xorv holds no MON to delegate, so there is no write path. |
| 5 | EIP-7702 / paymaster gasless onboarding | Not needed | Buyers never need MON: x402 and EIP-3009 let the facilitator pay all gas. That is the gasless path, without delegated EOAs. |
| 6 | Monad-correct gas | Working | Tight hard-coded gas limits; the fee shown as limit × price ("Monad charges the gas limit"); `reserve.ts` checks the broker's gas payers against the 10 MON reserve at boot and on every sweep. `dippedIntoReserve()` (`0x1001`) is not called: Xorv's contracts move USDC, never MON, so they have nothing to ask it. |
| 7 | x402 with the Monad facilitator | Working | `exact` through Monad's hosted facilitator, plus Xorv's own self-hosted facilitator for `exact` and `escrow`. |
| 8 | Verified, linked, indexed | Working | Sourcify-verified contracts on MonadVision, and every hash deep-linked (or opened in the in-app chain viewer). Envio does the indexing. Without it, the RPC fallback respects the 100-block `eth_getLogs` cap and scans only new blocks. |
