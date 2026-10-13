# Monad Metropolis: submission

Everything the submission form asks for, in the order it asks. Fields marked **TODO(deploy)** only
exist after deployment or recording. Each one says the command or file that produces it. Fill them in
from the checklist at the end (`grep -n "TODO(deploy)" SUBMISSION.md` lists them), and never with
invented values.

---

## Project

**Sponsors and Monad-native features:** [docs/SPONSOR-COVERAGE.md](docs/SPONSOR-COVERAGE.md) lists 8 sponsor protocols working: Chainlink CRE, Chainlink Data Feeds, Privy, Kimi, Envio, Nansen, Agora AUSD ([an AUSD escrow job on testnet](https://testnet.monadvision.com/tx/0x3ac185126ec55ba765456680c827363fcfa7d6534b5dc80f28c5d4faa68d96e2)) and Cleanverse (fork evidence on the real A-Pass). It also lists 4 partial and 13 not used, each with a reason. It also covers the 8 Monad-native features.

| Field | Value |
|---|---|
| **Project name** | Xorv |
| **One-liner** | A decentralized marketplace for AI capacity: pay per job in USDC over x402 on Monad, with every job receipted on-chain and provider reputation held in ERC-8004. |
| **Track** | **04: Trust, Identity & AI Infrastructure** |
| **Repository** | <https://github.com/nickthelegend/xorv-monad> (MIT) |
| **Demo video (~3 min)** | [docs/demo/xorv-demo.mp4](docs/demo/xorv-demo.mp4) (2:02, 1080p, captions burned in plus [an .srt](docs/demo/xorv-demo.srt)). It was recorded on 13 Oct from the live hosted app, broker and provider on Monad testnet by `node e2e/web/record-demo.mjs .env`. In it an MCP agent pays $0.02 from its Privy server wallet into XorvEscrow, the escrow releases to the Kimi provider, Kimi verifies the answer, a Nansen wallet profile appears, and the CRE refund shows on chain. Every timing on screen was measured live. Upload this file to the portal's video field. |
| **Founder pitch (≤2 min)** | **user**: record the pitch in [RECORDING.md](RECORDING.md#the-founder-pitch-200-or-less), paste the link |
| **Project graphic (≤3 MB)** | [docs/demo/xorv-graphic.png](docs/demo/xorv-graphic.png) (1200×630, from `brand/xorv-logo.svg`) |
| **Working Monad link** | <https://xorv-monad-app.vercel.app> (app; broker <https://broker-production-2d62.up.railway.app>, with a live Kimi provider node) |
| **Judge access** | Open the app, log in with any email (Privy creates a wallet), get test USDC from <https://faucet.circle.com> (Monad Testnet), post a job and pay. No MON is needed. Or run `pnpm install && pnpm build && pnpm test` from the repo. |

### Why Track 04

The track is for "protocols, primitives, or infrastructure layers that other applications build on"
and lists "agent identity and reputation under ERC-8004". Xorv is:

- **a payment primitive for AI work**: any x402 client can buy a job, and the repo ships four buyers
  (web app, CLI, MCP server, MetaMask plugin);
- **identity bound to payment**: `XorvLedger` credits an ERC-8004 agent only when `payTo` equals
  the agent's registered wallet;
- **reputation that costs something to fake**: one rating per paid job, signed by the wallet that
  paid, never from the agent's own wallet, owner or operators (`XorvLedger` refuses it on-chain),
  refused by the broker when Nansen links the buyer's wallet to the provider's, delivered to the
  ERC-8004 Reputation Registry through the ledger, and readable by any other marketplace;
- **AI trust services**: a safety screen protecting provider machines, and a verifier publishing an
  independent score on-chain.

It is not a consumer app. It is the rail that consumer apps and agents buy AI work through.

---

## Problem

People pay $20–200 a month for AI subscriptions and model credits and use a fraction of them. Anyone
who needs one job done, or an agent that needs a second model's opinion, has to buy a whole plan or
an API key. Nobody has a way to sell the unused part per job: there is no trustworthy way to find a
provider, pay them a fraction of a cent to a few dollars without an account, know the work was done,
or tell good providers from bad ones.

## Solution

Xorv connects the two sides with an open protocol:

1. A provider runs `xorv init && xorv start`. Their machine dials out to the broker and offers the
   CLIs and model keys it has (Claude Code, Codex, Qwen, Kimi, Hunyuan, Qwen Code, local models),
   each at a price they set.
2. A buyer asks for a quote. Hunyuan screens the prompt; when the buyer chose "Auto", Qwen 3.8 Max
   runs a tool loop that reads ERC-8004 reputation, XorvLedger receipts, Envio aggregates and Nansen
   trust on Monad and picks the provider; the quote freezes that provider, a price and a USDC amount.
3. The buyer signs **one EIP-3009 USDC authorization**. With a self-hosted facilitator it goes into
   **XorvEscrow** (the `escrow` scheme, offered first): the money waits there until the job
   delivers, then is released to the provider with the result's hash, or refunded in full if the job
   fails, is cancelled or passes its deadline. Without it, the authorization pays the provider's own
   address directly (`exact`). Either way the facilitator settles on Monad **before** the job runs
   and pays the gas, and the broker is never the payee.
4. The job runs in the provider's sandbox and streams back live. A failed job moves to another
   provider at no extra charge (an escrowed job is re-pointed on-chain). If the broker disappears,
   a **Chainlink CRE** workflow refunds every escrowed job past its deadline. With the
   **Cleanverse** gate set, only parties holding a valid A-Pass can fund or be paid.
5. The job is receipted on `XorvLedger`, Kimi scores the result and writes the score to ERC-8004, and
   the buyer rates it with a free EIP-712 signature that the broker relays into ERC-8004, unless
   Nansen shows the buyer's and the provider's wallets are one party.
6. The broker pays Nansen per call (USDC over x402 on Monad) to score each connected provider's
   payout wallet; the score is shown on each provider and breaks ties in matching.
7. An Envio indexer turns all of it into the network page and the provider leaderboard.

Private jobs add end-to-end encryption: the answer is sealed on the provider's machine to a key
derived from the buyer's passkey (Mera), and it decrypts on any device that has that passkey.

## Monad integration

| What runs on Monad | Where |
|---|---|
| Every job payment: x402 `exact`, EIP-3009 `transferWithAuthorization` on Circle USDC (`0x534b…43A3` testnet), buyer → provider, gas paid by the facilitator | `packages/protocol/src/x402.ts`, `services/broker/src/app.ts` |
| `XorvEscrow`: x402 `escrow` scheme (EIP-3009 `receiveWithAuthorization` into the escrow), release with the result hash, refund (by anyone after the deadline), on-chain re-pointing; Cleanverse A-Pass gate on fund and payout; refunds by the CRE keeper | `contracts/src/`, `packages/protocol/src/escrow.ts`, `services/broker/src/escrow.ts`, `cre/refund-keeper` |
| `XorvLedger`: provider registrations, sampled heartbeats, batched job receipts, payer-signed ratings | `packages/contracts/contracts/XorvLedger.sol` |
| ERC-8004 identity (canonical v2.0.0 registries): `xorv identity register`, `payTo == agentWallet` enforced on every receipt | `packages/cli/src/commands/identity.ts`, `XorvLedger._checkAgentWallet` |
| ERC-8004 reputation: buyer ratings through the ledger (`starred`), Kimi verifications from the verifier EOA (`xorv-verified`) | `XorvLedger.rateJob`, `services/broker/src/ai/feedback.ts` |
| Envio HyperIndex over XorvLedger, XorvEscrow and both ERC-8004 registries, via HyperSync | `services/indexer/` |
| The broker buying Nansen wallet data: x402 `exact` USDC on Monad **mainnet** (`eip155:143`), one EIP-3009 authorization per $0.01 call, settlement tx kept with each answer | `services/broker/src/trust/nansen.ts` |

**Why Monad.** 300 ms blocks and about 600 ms finality mean a payment settles before the job
starts, so providers work on money that has already landed. Batched receipts cost about 41k gas each
(measured on live Monad), cheap enough to receipt every job and keep reputation on-chain. It is EVM,
so x402 `exact` works with EIP-3009 and Circle USDC, and buyers need no MON. The ERC-8004 registries
are already live on Monad. The Monad-specific costs are handled: every write sets its gas limit to
`estimateGas` × 1.15 because Monad bills the limit; receipts are batched and heartbeats sampled; the
ledger stores one slot per job; reads go through Envio because the public RPC caps `eth_getLogs` at
100 blocks. More detail in [README → Why Monad](README.md#why-monad) and
[ARCHITECTURE.md](ARCHITECTURE.md#xorvledger-the-public-record).

### Monad-native integrations

Each one says where it runs today: **live** on Monad testnet (read-only until the testnet go),
**built** (code and tests), or on the **local fork** that `pnpm demo` runs (labelled so in the app).
Details and file links are in [README → Monad-native](README.md#monad-native); coverage per item is in
[docs/ROADMAP-WIN.md](docs/ROADMAP-WIN.md#monad-native-coverage).

| Monad feature | In Xorv | Runs | Evidence |
|---|---|---|---|
| `monadNewHeads` / `monadLogs` commit states | Live block pipeline (Proposed → Voted → Finalized → Verified, measured ms) and live XorvLedger / ERC-8004 events | live | `docs/screens/wave/m1-commit-*.png` |
| `eth_sendRawTransactionSync` | Escrow writes get their receipt in the send | built, fork-tested | `packages/protocol/test/escrow.anvil.test.ts` |
| Executed vs final timers | Speed receipt: executed and final, labelled with the chain | built | `docs/screens/wave/m2-timers-*.png` |
| `txpool_statusByHash` + block tags | `GET /api/tx/:hash`, live badges per transaction | live + built | testnet read of `0x5792…02d7` → finalized |
| Staking precompile `0x1000` | Epoch, current proposer and stake, consensus set size | live | testnet read: epoch 1381, validator #172, 199 validators |
| P256 precompile `0x0100` | Passkey (WebAuthn) signatures verified on chain | built + live check | `packages/protocol/test/p256.anvil.test.ts`; testnet `eth_call` true/false |
| Gas on the limit, 10 MON reserve, MIP-8, parallel execution | Explicit limits, reserve monitoring, one-page job struct, transient guard | built | [docs/MONAD-GAS.md](docs/MONAD-GAS.md) |
| Monad's x402 facilitator | Default settlement for `exact` payments | live since 28 Sep | settlement `0x579205fe…02d7` |
| Multicall3, MonadVision, Sourcify | Batched payment reads; every hash on MonadVision; XorvLedger verified | live + built | XorvLedger on Sourcify |

## Deployed contracts and transactions

**Live on Monad testnet (12 Oct, testnet go).** All contracts are Sourcify-verified, and every link opens on MonadVision.

| | Address / URL | Evidence |
|---|---|---|
| App | <https://xorv-monad-app.vercel.app> | Vercel |
| Broker | <https://broker-production-2d62.up.railway.app> (`/api/network`) | Railway; settles through its self-hosted x402 facilitator `0xf4c4…2F79` (both `exact` and `escrow`) |
| Provider node (Kimi K3) | Railway service `provider`, `Dockerfile.provider` | a real seller for the hosted app: $0.02 per job, one at a time, replies capped at 4,000 tokens; a persisted daily cap (40 jobs, 120k tokens per UTC day) guards the model credit, since testnet USDC is free |
| XorvLedger (current) | [`0x40918C2fEc752B3b8C30bB121779011132668408`](https://testnet.monadvision.com/address/0x40918C2fEc752B3b8C30bB121779011132668408) | deploy tx [`0xfa8979…3390`](https://testnet.monadvision.com/tx/0xfa8979372f92329aea91a2eaf7c31b7037339ada52f9a20bccc510d203753390); a live provider registration [`0x9a5c33…9e08`](https://testnet.monadvision.com/tx/0x9a5c336ef1b3e1381eb333cb31d97342c7919f325d1ee5361947064761519e08), finalized in block 70463902 |
| XorvEscrow | [`0x87d57e81b71d3eF5172156b5f3c6D01f5b74Df91`](https://testnet.monadvision.com/address/0x87d57e81b71d3eF5172156b5f3c6D01f5b74Df91) | attester = the facilitator `0xf4c4…2F79`; live: see the escrowed job and the CRE refund below |
| XorvRefundKeeper (Chainlink CRE receiver) | [`0x69Abe4e96A5A84caAF01F2B3151e3CA1C53F223f`](https://testnet.monadvision.com/address/0x69Abe4e96A5A84caAF01F2B3151e3CA1C53F223f) | forwarder: Chainlink's MockKeystoneForwarder `0xB9F7…D192` |
| MCP agent's Privy server wallet | [`0x6613490F1A424e7595149D26cF4e274C9C0a40fB`](https://testnet.monadvision.com/address/0x6613490F1A424e7595149D26cF4e274C9C0a40fB) | policy: x402 USDC ≤ $0.05 per payment (direct or into XorvEscrow only), plus ledger ratings |

**First live escrowed job (12 Oct):** an MCP agent paid $0.001 USDC from its policy-bounded Privy server
wallet into XorvEscrow ([fund `0xb95dc3…8bbd`](https://testnet.monadvision.com/tx/0xb95dc3df81f5b29b79d77f170dc9a644f6929a8cb40ce16c775f533aa0458bbd)),
and the escrow released it to the provider ([release `0x23a926…0ca3`](https://testnet.monadvision.com/tx/0x23a926c9df1df27615c2ab820fc1deddc48e2e31190d8afca251f3ef12eb0ca3))
with an XorvLedger receipt ([`0x07ed16…4899`](https://testnet.monadvision.com/tx/0x07ed16e0ab225ab103b1b527eb0348de0f095a4f31464df526a3e18c5e924899))
and a Kimi verification. Measured by the broker on Monad: payment executed in 468 ms and final in
1,147 ms; release executed in 302 ms and final in 973 ms. Both receipts came back in the send itself
(`eth_sendRawTransactionSync`).

**Fully hosted paid job (13 Oct):** the MCP agent bought a Kimi K3 answer from the hosted provider
node on Railway, for $0.02 paid into XorvEscrow from the Privy wallet
([fund `0x9d3ab6…c7b2`](https://testnet.monadvision.com/tx/0x9d3ab6147ac88fd14feedd7feef8ad1dae21b2389f7e4854d8386b67fb38c7b2),
[release `0xb1cc49…b710`](https://testnet.monadvision.com/tx/0xb1cc49d5c863489678d9f1b7f69537eb427d0a4f4212d452bef1028e74b3b710),
[ledger receipt `0x14f102…9b64`](https://testnet.monadvision.com/tx/0x14f1022608290821b49cfc269ba82e32890b283f1920b9ebce567e0c257c9b64)).
Kimi's verifier scored it 95/100. Payment executed in 473 ms and was final in 1,150 ms; release
executed in 177 ms and was final in 855 ms.

**Release on the verifier's verdict (13 Oct):** with `XORV_RELEASE_ON_VERDICT=on`, the hosted broker held `job_4o0BmILtuvz5` in escrow until Kimi passed it (95/100). It then released [`0x8ab899…1e2b`](https://testnet.monadvision.com/tx/0x8ab89925367b418d559959e845ffbd8f1e4e1917e1bcf7a13ce262b3286b1e2b), 3.9 s after delivery, and wrote the verdict as ERC-8004 feedback [`0x7a0677…eeb2`](https://testnet.monadvision.com/tx/0x7a0677caa130295ab9e78fdc3c4715ea2784d743cb82c3eb57b9ae056780eeb2). A failed verdict refunds the buyer instead.

**A browser purchase with no login (13 Oct):** on the hosted app, "Pay from demo account" paid $0.02 into XorvEscrow for `job_qYHL9A_f9aGZ` ([`0x8922a3…28dd`](https://testnet.monadvision.com/tx/0x8922a3a27429753fc04634bbbbed437ec7711f4a3fef6af9dde16c798a9628dd)). The payment was final in 1.02 s, Kimi passed the work (95/100), and the escrow released to agent #2252.

**First CRE refund (13 Oct):** a $0.001 escrowed job was funded from the Privy wallet and left undelivered
([fund `0x7f1cfd…0a9c`](https://testnet.monadvision.com/tx/0x7f1cfd8d1a61f3276274912a8c364b8e8b0d371b98f5de50ffc091d0add80a9c)).
After its deadline, `cre workflow simulate refund-keeper --broadcast` read it from the Envio index as
Funded and past its deadline. It checked `isRefundable` on the escrow, then sent the report through the
MockKeystoneForwarder to XorvRefundKeeper, which refunded the buyer
([refund `0xa85c2f…cd15`](https://testnet.monadvision.com/tx/0xa85c2f69d7ccb7fea3d3d574d453f9974125b493675d626a2e037e8002decd15)).
The index then showed the job as Refunded.

The September deployment (the first XorvLedger, `0xc4b5…5FCD`, with its live paid job and receipt) stays
on chain as history; its rows follow. Its record is `packages/contracts/deployments/monadTestnet-sept.json`.


All live values as of 13 Oct. The rows marked **user** wait on an item in the user's deferred list (doitlater.md).
The September XorvLedger rows are kept as history; the current deployment is the 12 Oct one. `<broker>` is the broker's public URL and `<job>` a job id from the
deployed app.

| | Monad testnet (`eip155:10143`) | Where the value comes from |
|---|---|---|
| `XorvLedger` (current, 12 Oct) | [`0x40918C2fEc752B3b8C30bB121779011132668408`](https://testnet.monadvision.com/address/0x40918C2fEc752B3b8C30bB121779011132668408), deploy tx [`0xfa8979…3390`](https://testnet.monadvision.com/tx/0xfa8979372f92329aea91a2eaf7c31b7037339ada52f9a20bccc510d203753390) (block 70456136), Sourcify-verified | `packages/contracts/deployments/monadTestnet.json` |
| `XorvEscrow`, `XorvRefundKeeper` | [`0x87d57e81b71d3eF5172156b5f3c6D01f5b74Df91`](https://testnet.monadvision.com/address/0x87d57e81b71d3eF5172156b5f3c6D01f5b74Df91), [`0x69Abe4e96A5A84caAF01F2B3151e3CA1C53F223f`](https://testnet.monadvision.com/address/0x69Abe4e96A5A84caAF01F2B3151e3CA1C53F223f), Sourcify-verified. `CleanverseGate` is not deployed to testnet: **user** (A-Passes) | `contracts/script/Deploy.s.sol` output |
| `XorvLedger` (September) | [`0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD`](https://testnet.monadscan.com/address/0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD) — source verified on [Sourcify](https://sourcify-api-monad.blockvision.org/repo-ui/10143/0xc4b5461e2C19bab790c8C01cfBDf72b6d8AE5FCD) | `packages/contracts/deployments/monadTestnet.json` |
| Deploy transaction | [`0xb342175f22adb752d95400eb16288425c403c3f44427735f8439a234453dacc3`](https://testnet.monadscan.com/tx/0xb342175f22adb752d95400eb16288425c403c3f44427735f8439a234453dacc3) (block 66379818) | same file |
| x402 settlement (buyer → provider USDC) | [`0x579205fe205b8069682f147377efd6d9a6ca404e2c1c6ea95312853a921202d7`](https://testnet.monadscan.com/tx/0x579205fe205b8069682f147377efd6d9a6ca404e2c1c6ea95312853a921202d7): 0.01 USDC, submitted and gas-paid by Monad's public facilitator | a live `xorv run` job |
| `recordJobs` receipt | [`0xbddafbf69499df11f5c0289b4cefb6491cd0b168fd799bae2c77145dd855c6c7`](https://testnet.monadscan.com/tx/0xbddafbf69499df11f5c0289b4cefb6491cd0b168fd799bae2c77145dd855c6c7): `JobRecorded` with that payment tx and the result hash | same job |
| `rateJob` → ERC-8004 `giveFeedback` (`starred`) | [`0x11761f…4348`](https://testnet.monadvision.com/tx/0x11761ff5a77199d4946d3f74f903dc468aa5b273e1899b6bd74ef8acada54348): the MCP agent rated `job_EKJtz-mTs66f` 92/100 from its Privy wallet, and the broker relayed it | `… \| jq -r .job.rating.txHash`, after rating the job in the app |
| Kimi verifier `giveFeedback` (`xorv-verified`) | [`0xf4dbbe…ca4d`](https://testnet.monadvision.com/tx/0xf4dbbe91e7c727e15d3d9a327a603c8aea5f3000c05f8f852280d9ecb7e5ca4d): Kimi's 92/100 on `job_EKJtz-mTs66f` | `… \| jq -r .job.verification.feedbackTxHash` (needs `MOONSHOT_API_KEY` on the broker) |
| Privy server-wallet payment (MCP agent) | [`0x9d3ab6…c7b2`](https://testnet.monadvision.com/tx/0x9d3ab6147ac88fd14feedd7feef8ad1dae21b2389f7e4854d8386b67fb38c7b2) into XorvEscrow, released [`0xb1cc49…b710`](https://testnet.monadvision.com/tx/0xb1cc49d5c863489678d9f1b7f69537eb427d0a4f4212d452bef1028e74b3b710) | the `Payment:` link `xorv_run_job` prints ([packages/mcp/README.md](packages/mcp/README.md)) |
| Demo provider's ERC-8004 agent | [agent #2252](https://testnet.monadvision.com/nft/0x8004A818BFB912233c491871b3d84c89A494BD9e/2252) (registered [`0xe4a0ab…3f26`](https://testnet.monadvision.com/tx/0xe4a0ab0243ceb04caa9a324f6cb281ba7e4c241d3e67e88a78a2f60993939f26)) | the agent id from `xorv identity show`; link as `https://testnet.monadscan.com/nft/0x8004A818BFB912233c491871b3d84c89A494BD9e/<agentId>` |
| Envio GraphQL endpoint | **user** (Envio Cloud needs a GitHub login). Run live locally against the testnet contracts on 13 Oct; the CRE refund read from it | the Envio Cloud dashboard, or `envio-cloud deployment endpoint <indexer> <commit>` |
| Nansen x402 payment, broker → Nansen (Monad **mainnet**) | Not made: the live run used `NANSEN_API_KEY` (4 calls, 1 wallet scored, 13 Oct), so no x402 payment tx exists. The x402 path needs a mainnet key holding USDC | `curl -s <broker>/api/network \| jq -r .nansen.lastPaidTx.url` with `XORV_NANSEN_MODE=live` |
| ERC-8004 Identity / Reputation (canonical, not ours) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` / `0x8004B663056A597Dffe9eCcC1965A193B7388713` | |
| USDC (Circle) | `0x534b2f3A21130d7a60830c2Df862319e593943A3` | |

## Pre-existing work and AI tools

Xorv began as a Hedera x402 prototype (<https://github.com/nickthelegend/xorv>). Commit `321b563`
imports it unchanged, and **everything after it was built during Metropolis** (from 2026-09-26). The
[README](README.md#prior-work-what-existed-before-metropolis-and-what-is-new) lists what was carried
over and what is new. The port was built with **Claude Code** and Claude agents under the author's
direction, as disclosed in the [README](README.md#ai-tools-disclosure). External code is attributed
[there too](README.md#attribution-of-external-code).

---

## Bounties entered

Xorv is entered in **Track 04: Trust, Identity & AI Infrastructure**. The portal's Tracks & Bounties
page says each sponsor bounty names its track, and only the ones marked **All tracks** pair with any
primary track. So a Track 04 project can enter the All-tracks bounties and the Track 04 ones, and
nothing locked to another track. Every card below is quoted verbatim from that page, with its track
and prize.

Each checklist maps a requirement to its evidence. **Code** means it is in the repo and tested.
**Live** means it still needs the deployment or the recording. Each card's own submission fields
appear in the portal when the bounty is added: re-read them before submitting, because requirement
adherence is 40% of each bounty score.

| Bounty | Sponsor | Track on the card | Prize |
|---|---|---|---|
| Privy! | Privy | All tracks | $5,000 USD |
| Best Use of Envio | Envio | All tracks | $1,000 USD |
| Best use of Nansen | Nansen AI | All tracks | $5,000 USD total prize pool |
| Best Builds Powered by KIMI | Kimi | All tracks | $3,000 in credits |
| Mera: One Passkey, Many Keys | Monad Foundation | All tracks | $2,500 USD |
| Best Builds with Qwen 3.8 Max | Alibaba Cloud | Trust, Identity & AI Infrastructure | $5,000 in credits |
| Best workflow with CRE | Chainlink | All tracks | $3,000 USD |
| Best Integration of CVI/CVA | Cleanverse | Trust, Identity & AI Infrastructure | $2,000 USD |

### Privy: "Privy!"

> **Card** (Privy · All tracks · $5,000 USD): "Integrate Privy beyond authentication — login-only
> integrations will not qualify."

The sponsor's brief adds that the demo must clearly show the functionality powered by Privy, with
bonus points for meaningfully integrating multiple Privy features. Xorv uses three on camera.

| Requirement | Evidence | Status |
|---|---|---|
| Beyond login: the embedded wallet **pays** for jobs | x402 `exact` EIP-3009 signed by the Privy wallet via `toViemAccount`, `@x402/fetch` v2 (`apps/app/components/wallet-provider.tsx`, `apps/app/lib/x402-pay.ts`, `apps/app/components/composer.tsx`). Privy's sign modal gets JSON-safe typed data (`apps/app/lib/typed-data.ts`, byte-for-byte digest test in `apps/app/test/typed-data.test.ts`) | Code |
| Beyond login: the embedded wallet **signs ratings**, gaslessly | EIP-712 `Rating`, relayed to `XorvLedger.rateJob` → ERC-8004 (`apps/app/lib/rating.ts`, `apps/app/components/rate-job.tsx`) | Code |
| Multiple features: **server wallet + policy** for an AI agent | MCP buyer on `@privy-io/node/viem` `createViemAccount`; `pnpm privy:setup` writes a policy (USDC `TransferWithAuthorization` on this chain ≤ cap, XorvLedger ratings, optional payee allowlist, optional P-256 owner key); `xorv_wallet` shows the wallet id and its policy id (`packages/mcp/src/signer.ts`, `packages/mcp/src/privy-policy.ts`, `packages/mcp/src/scripts/privy-setup.ts`) | Code |
| Multiple features: embedded wallet created at login, pinned to Monad | `createOnLogin: "users-without-wallets"`, `defaultChain`/`supportedChains` (`apps/app/components/providers.tsx`) | Code |
| Multiple features: key export | `useExportWallet` (`wallet-provider.tsx`) | Code |
| Provider payout to a Privy wallet (no key on the node) | `xorv init` → "Use an address I already control" (`packages/cli/src/commands/init.ts`) | Code |
| Demo clearly shows it | The recorded cut ([docs/demo/xorv-demo.mp4](docs/demo/xorv-demo.mp4)) shows the policy-bounded server wallet paying live; the narrated script: [RECORDING.md](RECORDING.md): 0:08–0:16 login creates the embedded wallet; 0:30–0:42 it signs the x402 payment; 1:06–1:16 it signs the gasless rating; 1:16–1:40 an MCP agent pays from the policy-bounded server wallet, with the policy on screen; 2:20–2:52 it pays for the private job | Live: the server wallet pays (txs above); the embedded-wallet login needs a person |

### Envio: "Best Use of Envio"

> **Card** (Envio · All tracks · $1,000 USD): "Meaningfully use Envio's HyperIndex, HyperSync, or
> HyperRPC to power real on-chain data driving a core feature in your app."

The sponsor's brief adds that entries are judged on depth (multichain, a non-trivial schema, derived
or aggregated entities), live and correct data, originality and craft, and asks for an indexer with a
public `config.yaml`, `schema.graphql` and handlers, a consumer, and a short demo.

| Requirement | Evidence | Status |
|---|---|---|
| HyperIndex indexer, public config, schema and handlers | `services/indexer/config.yaml`, `config.mainnet.yaml`, `schema.graphql`, `src/handlers/{XorvLedger,IdentityRegistry,ReputationRegistry}.ts` | Code |
| Depth: more than a single-event indexer | 4 contracts (XorvLedger, XorvEscrow, the two ERC-8004 registries), 17 events, 15 entity types, including `EscrowJob` (funded → reassigned → released/refunded), which the Chainlink CRE refund keeper queries; derived `Provider` earnings, success rate and rating; `Agent` reputation split by writer; `NetworkStats`, `DailyStats`, `ProviderDay`, `BuyerDay` | Code |
| Non-trivial logic | Feedback classified by client address (ledger = buyer rating, broker = verified, else other); revocations undo exactly; receipts that arrive before their registration are claimed later; broker rotation respected (`src/lib/trust.ts`, `src/lib/aggregates.ts`) | Code |
| Real on-chain data driving a feature | Broker `/api/leaderboard`, `/api/ledger`, `/api/receipts` read Envio first (`services/broker/src/indexer.ts`, `ledger-reader.ts`) → app network page ("indexed by Envio"), providers leaderboard, landing ledger | Code |
| Envio in the core loop (matching, routing) | The Qwen router's `indexer_provider_stats` and `recent_receipts` tools read the indexer while choosing a provider; when no router runs, the deterministic matcher breaks price ties on indexed reputation (buyer ratings + Kimi scores, shrunk toward a neutral prior; one batched GraphQL query a minute at most) — `services/broker/src/ai/router-tools.ts`, `router-data.ts`, `reputation-book.ts` | Code |
| HyperSync | Both configs read `monad-testnet.hypersync.xyz` / `monad.hypersync.xyz` | Code |
| Tests | 52 handler, ABI, config and query tests (`services/indexer/test`) | Code (run in Docker/WSL, and in CI) |
| Hosted indexer with live data | Envio Cloud, deployed between Oct 10 and 13 so the 30-day free deployment outlives judging | **user** (GitHub login); run live locally against testnet on 13 Oct |
| Short end-to-end demo | RECORDING.md 1:40–1:55 (network page, leaderboard, a live GraphQL query) | The CRE refund in the recorded cut read the live local index |

### Nansen AI: "Best use of Nansen"

> **Card** (Nansen AI · All tracks · $5,000 USD total prize pool): "Build a product experience powered
> by Nansen data/API/MCP/CLI that goes beyond exposing raw data."

The broker is itself a paying agent: it buys Nansen profiler data per call, in USDC over x402 on
Monad **mainnet**, and turns it into three decisions the product acts on. Nansen's CEO also judges
the main track. Full design: [docs/NANSEN.md](docs/NANSEN.md).

| Requirement | Evidence | Status |
|---|---|---|
| Powered by Nansen's API | Four endpoints: `profiler/address/first-funder`, `related-wallets`, `transactions`, `smart-money/pnl-leaderboard` (`services/broker/src/trust/nansen.ts`) | Code |
| Paid per call over x402 on Monad | Only `exact` on `eip155:143` registered, mainnet USDC hard-coded (never read from a stablecoin override); every request validated locally first, because Nansen charges before it validates; a per-endpoint price table ($0.01 profiler, $0.05 smart money); a per-call cap (`XORV_NANSEN_PER_CALL_CAP`, $0.05) and a daily budget (`XORV_NANSEN_DAILY_CAP`, $1) with reservations released when signing or settlement fails; an optional pinned payee (`XORV_NANSEN_PIN_PAYTO=observed`); the settlement tx kept with each cached answer. `NANSEN_API_KEY` takes precedence (credits, no payment). Tested against Nansen's real captured 402s (`services/broker/test/trust.test.ts`) | Code |
| Beyond raw data 1: **a provider trust score** | One 0–100 number per payout wallet from written rules that never penalise missing data (`services/broker/src/trust/signal.ts` `TRUST_RULES`: wallet age, exchange funding, activity, risky counterparties), on `/api/providers`, `/api/providers/:id` and `/api/leaderboard`. Bought when a provider's node opens its control socket (not at registration, which is free), refreshed every 6 h (`services/broker/src/trust/service.ts`) | Code |
| Beyond raw data 2: **a wash-rating guard** | `POST /api/jobs/:id/rate` refuses with 403 `related_wallets` when buyer and provider are one party (same wallet, one funded the other, a shared non-exchange first funder, related wallets), before anything reaches ERC-8004, and stores the check on the job (`signal.ts` `relatedParties`, `service.ts` `checkRelated`, `services/broker/src/app.ts`). 30% of the daily budget is reserved for it; when a check can't run for lack of budget the rating is deferred (503 `trust_budget_spent`), never relayed unchecked | Code |
| Beyond raw data 3: **a matching tie-breaker** | The score nudges reliability by at most ±0.1 after price (`services/broker/src/registry.ts` `TRUST_TIEBREAK_WEIGHT`), so it breaks ties and never beats a cheaper node or a real track record; smart-money membership adds an internal nudge that is never shown | Code |
| Visible in the product | Trust badge on every provider row (`apps/app/components/live-lists.tsx`); the *Wallet trust* panel on `/providers/<id>` with wallet age, first funder, activity, risk flags and "Xorv paid Nansen $0.03 over x402 on Monad" with each settlement linked on Monadscan (`provider-view.tsx`); the network page's *Wallet intelligence* spend panel: mode, payer, calls and spend against the budget, last payment, ratings checked and refused (`network-view.tsx`); the rating widget's *Rating refused* (`rate-job.tsx`). All in `apps/app/components/trust.tsx` and `apps/app/lib/trust.ts`. Nansen also appears on the landing page's Built-with and FAQ | Code |
| Respects Nansen's redistribution rules | Smart-money data and related-wallet addresses stay in the broker; the public view is built in one function (`publicTrustView`); every surface says "Powered by Nansen", linked to nansen.ai; answers are cached briefly (7 days for a first funder, 1 day for related wallets, 1 hour for activity) ([docs/NANSEN.md §5](docs/NANSEN.md#5-what-is-published-and-what-is-not)) | Code |
| Modes: off, live | `XORV_NANSEN_MODE=off` (default; the app says "not configured"), `live` (`XORV_NANSEN_PAYER_KEY`, a mainnet key with a few USDC, or `NANSEN_API_KEY`). Recorded-shape answers exist only in the tests; a running broker refuses `fixture` | Code |
| A paid call on Monad mainnet | `XORV_NANSEN_MODE=live` with `XORV_NANSEN_PAYER_KEY` (~$2 of mainnet USDC), then `pnpm nansen:probe --mode live <address>` or connect the demo provider | Live via `NANSEN_API_KEY` (13 Oct); x402 on mainnet not made |
| Demo | RECORDING.md 1:55–2:10 (trust panel with its Monad payment links, then a refused wash rating) | The recorded cut shows the live Nansen trust panel |

### Kimi: "Best Builds Powered by KIMI"

> **Card** (Kimi · All tracks · $3,000 in credits): "Build a project genuinely powered by KIMI
> (Moonshot AI) — open scope, no category restrictions."

| What Kimi does | Evidence | Status |
|---|---|---|
| **Load-bearing core-loop role: the result verifier**, scoring every completed public job | `services/broker/src/ai/verifier.ts` | Code |
| Its score becomes **on-chain ERC-8004 reputation** (`xorv-verified`), with a hash-committed feedback file | `services/broker/src/ai/feedback.ts`, `GET /verifications/<jobId>.json` | Code |
| Visible in the product | The job page's *Verified* row with the "ERC-8004 feedback" link; the indexer's `XORV_VERIFIED` reputation; RECORDING.md 0:56–1:06 | Code |
| Provider backend: `kimi` adapter (`kimi-k3`) | `packages/cli/src/adapters/hosted.ts` | Code |
| Live calls with a Moonshot key | `MOONSHOT_API_KEY` on the demo broker and the hosted provider | Live: verifier scores on every job (e.g. `job_ccTfHv-CM1O1`, 95/100), and a hosted Kimi K3 provider under a daily cap |

### Monad Foundation: "Mera: One Passkey, Many Keys"

> **Card** (Monad Foundation · All tracks · $2,500 USD): "Most creative non-wallet use of Mera's
> PRF-derived key material."

The sponsor's brief adds that it is for anything that is not signing blockchain transactions from a
wallet account, judged on novelty, correct use of the primitives (salts genuinely namespaced, nothing
sensitive persisted), and **a live cross-device test**: a second device or fresh profile must
reproduce the same keys and decrypt the same state.

| Requirement | Evidence | Status |
|---|---|---|
| Non-wallet use of PRF key material | E2E-encrypted AI job results (X25519 inbox), an encrypted job-history vault (AES-256-GCM), a self-certifying vault identity and write authorization (Ed25519 in a Mera signing session). None of it signs a transaction; Privy pays. | Code |
| At least one PRF namespace doing non-account work | Three: `xorv:inbox:v1`, `xorv:vault:v1`, `xorv:vault-auth:v1` (`packages/protocol/src/sealed.ts`, `vault.ts`) | Code |
| Salts genuinely namespaced | One PRF salt per namespace (`sha256(label)`), bound again in the HKDF salt and info; ceremonies pinned to one credential; known-answer vectors and `node:crypto` cross-checks (`packages/protocol/test/{sealed,vault}.test.ts`) | Code |
| Nothing sensitive persisted | Keys only in memory, zeroed on lock, 30-min auto-lock; unsaved prompts dropped on lock; a test scans the private-job code for storage APIs (`apps/app/test/private-keyring.test.ts`, `private-pending.test.ts`) | Code |
| The result is bound to the chain | The job page checks the envelope against the `resultHash` in the job's XorvLedger receipt on Monad, read over the browser's own RPC (`apps/app/lib/private/receipt-check.ts`) | Code |
| Cross-device test | Real Mera against a fake *synced* authenticator reproduces keys, history and results on "device B" (`apps/app/test/private-keyring.test.ts`, `test/support/fake-authenticator.ts`) | Code |
| **Live** cross-device test | Second device or fresh profile, same synced passkey, on the deployed https app: RECORDING.md 2:20–2:52, and a standalone 75-second cut scripted in [docs/PRIVATE_JOBS.md §6](docs/PRIVATE_JOBS.md#6-cross-device-demo-script-for-the-video-about-75-s) | **user** (needs two devices and a person) |

### Alibaba Cloud: "Best Builds with Qwen 3.8 Max"

> **Card** (Alibaba Cloud · Trust, Identity & AI Infrastructure · $5,000 in credits): "Push Qwen 3.8
> Max into genuinely agentic territory on Monad."

Qwen 3.8 Max is a bounded, tool-using agent on the quote path. For every "Auto" quote with more than one
live option under the ceiling, it reads Monad state and then picks the provider that runs the job.

| What Qwen does | Evidence | Status |
|---|---|---|
| **Agentic, on Monad:** a tool loop (≤4 turns, ≤6 reads, 15 s budget, thinking on with a 256-token budget) over `list_candidates`, `erc8004_reputation` (ERC-8004 Reputation `getSummary` for the XorvLedger and verifier clients + Identity agent-wallet check), `recent_receipts` (XorvLedger `JobRecorded`/`JobRated`, indexer first, RPC fallback), `indexer_provider_stats` (Envio aggregates), `nansen_trust` (public trust view), then `select_provider` | `services/broker/src/ai/router.ts`, `router-tools.ts`, `router-data.ts`; `packages/protocol/src/llm.ts` (tool-calling chat turn) | Code |
| **Load-bearing:** it chooses the provider (not just the adapter); the pick is checked against live candidates and the ceiling, gets one retry, else the deterministic matcher takes over and `routing.fallback` is recorded | `services/broker/test/ai.test.ts` (multi-turn loop, each tool's mapping, invalid pick, timeout, turn caps), integration tests | Code |
| **Visible:** `routing.steps` — every tool call with validated ids, a templated summary and explorer links — rendered as an agent trace on the quote card and the job page; private jobs withhold the model's reason | `apps/app/components/routing-trace.tsx`, `apps/app/lib/ai.ts`, `apps/app/test/ai.test.ts`; RECORDING.md quote beat | Code |
| Exercised end to end against a Monad testnet fork (mock Qwen driving the real tool loop over the fork's ERC-8004 registries and XorvLedger) | `e2e/src` mock LLM, `e2e/README.md` | Code |
| Provider backend: `qwen` adapter (`qwen3.8-max`, streamed reasoning, token cost) | `packages/cli/src/adapters/hosted.ts` | Code |
| Provider backend: `qwen-code` adapter (Qwen Code CLI with tools, on Qwen 3.8 Max) | `packages/cli/src/adapters/qwen-code.ts` | Code |
| Live calls with a Model Studio key | `DASHSCOPE_API_KEY` on the demo broker and provider | **user**: no key yet, so the app shows Qwen as "not configured" |

### Chainlink: "Best workflow with CRE"

> **Card** (Chainlink · All tracks · $3,000 USD): "Build, simulate, or deploy a Chainlink Runtime
> Environment (CRE) Workflow used as an orchestration layer within your project." A CLI simulation is
> accepted.

Xorv's buyers can pay into **XorvEscrow** (`contracts/`), which releases to the provider on delivery
and lets anyone refund the buyer once a job's deadline passes. The CRE workflow is what makes that
guarantee real when the broker is gone: it orchestrates the refunds off the broker.

| Requirement | Evidence | Status |
|---|---|---|
| A CRE workflow as an orchestration layer | `cre/refund-keeper`: cron → HTTP with DON consensus (the Envio index's `EXPIRED_ESCROW_JOBS_QUERY`) → an EVM read of `XorvEscrow.isRefundable` on Monad for each job → one DON-signed report → KeystoneForwarder → `XorvRefundKeeper.onReport` → `XorvEscrow.refund` | Code |
| A correct on-chain receiver | `contracts/src/XorvRefundKeeper.sol` (IReceiver, forwarder-only, per-job try/catch, batch cap); 6 Foundry tests against the real escrow | Code |
| Tested | 4 tests on the CRE SDK's own test runtime (`HttpActionsMock`, `EvmMock` on the `monad-testnet` selector): only refundable jobs reach the report, DON time sets the cut-off, empty/ahead-of-chain/unreachable index; compiles to WASM; CI job `cre` | Code |
| Simulation | `cre workflow simulate refund-keeper --target staging-settings --broadcast` against the deployed escrow and keeper | Live (13 Oct): refunded a real expired job, [`0xa85c2f…cd15`](https://testnet.monadvision.com/tx/0xa85c2f69d7ccb7fea3d3d574d453f9974125b493675d626a2e037e8002decd15) |

### Cleanverse: "Best Integration of CVI/CVA"

> **Card** (Cleanverse · Trust, Identity & AI Infrastructure · $2,000 USD): "Build an app that gates
> CVA asset movement behind on-chain CVI identity verification."

| Requirement | Evidence | Status |
|---|---|---|
| CVI identity verification, on chain, where value moves | `contracts/src/CleanverseGate.sol` reads Cleanverse's own A-Pass validity (false once frozen, revoked or expired) and, once a pool is registered, the compliance validator's `complianceVerify`. `XorvEscrow.setIdentityGate`: `fund` requires buyer and provider verified, `release`/`reassign` require the payee; refunds are never gated | Code |
| Against Cleanverse's real contracts | Fork tests against the real A-Pass and validator on Monad testnet (issue, freeze, unfreeze, revoke, expiry, an unregistered pool failing closed), with real AUSD (`contracts/test/CleanverseGate.fork.t.sol`); `pnpm e2e:escrow`'s gate stage (a buyer without an A-Pass refused with nothing moved, then paying once issued one) | Code |
| The product respects it | The facilitator refuses an unverified party before signing (`identity_not_verified`); the broker never quotes or reassigns to a provider without an active A-Pass; the network page shows the gate | Code |
| Moving CVA (aUSDC) itself | aUSDC has no EIP-3009 and its transfer policy keeps its own credential store: every unregistered pool reverts `PoolNotRegistered()`, and on a fork every aUSDC transfer reverts `TransferNotAllowed()`. No app can move CVA until Cleanverse onboards it | Blocked: Cleanverse docs access, pool registration and test A-Passes |

### Also built (not entered: track-locked to other tracks)

These stay in the product and in the repo's tests. Their bounties name a different track on the card,
so a Track 04 project cannot enter them, and they are not in the main demo.

**MetaMask: "Best Agent Wallet Plugin".**

> **Card** (Metamask · Onchain Finance & Trading · $2,500 USD): "Build a plugin that gives the
> MetaMask Agent Wallet a new trading superpower via its plugin architecture."

Xorv's plugin buys AI jobs rather than trading, and the card is locked to Onchain Finance & Trading.
What it is, as a buyer client:

| Feature | Evidence | Status |
|---|---|---|
| A real Agent Wallet plugin (npm package adding `mm` commands) | `@xorv/mm-plugin`: `mm xorv providers`, `quote`, `run`, `job`, `rate`, on the official template (`packages/mm-plugin/`) | Code |
| Valid manifest with scoped capabilities | `package.json#mm`: `schemaVersion: 1`, `minCliVersion: ^7.0.0`, per-command `capabilities` and `dataAccess`, `targetChains: [10143, 143]`; validated with MetaMask's own `PluginManifestSchema` (`test/manifest.test.ts`) | Code |
| Signs only through MetaMask, after checking the quote | EIP-3009 and rating signatures only through `ctx.walletExecutor` typed-data, readable intent, signer recovered before sending; quote vetting, spend cap, not paying yourself, balance check (`src/lib/{executor,vet,pay}.ts`) | Code |
| Runs in Agent Wallet | `providers` and `quote` ran in Agent Wallet 7.0.0 from a local install ([packages/mm-plugin/README.md](packages/mm-plugin/README.md#example-session)) | Partly verified |
| Published to npm | `pnpm --filter @xorv/protocol publish --access public`, then `pnpm --filter @xorv/mm-plugin publish --access public` | Not yet |

**Tencent Kepler Plan: "Build with Hunyuan: Multimodal & Interactive Experiences".**

> **Card** (Kepler Plan by Tencent · Social, Attention & Culture · $2,000 in Tencent Cloud vouchers):
> "Build a multimodal or interactive experience genuinely powered by Tencent's Hunyuan model."

Xorv's Hunyuan role is a text safety screen, and the card is locked to Social, Attention & Culture.
What it is, as a product feature:

| Feature | Evidence | Status |
|---|---|---|
| The safety screen on every quote, before any provider sees the prompt; a block is a 422 | `services/broker/src/ai/screener.ts`, integration test "refuses to quote a prompt the Hunyuan screen blocks…" | Code |
| Explicit failure policy | `XORV_SCREENER_FAIL=open\|closed` | Code |
| Visible in the product | Quote card "Screened by Hunyuan hy4: …", the job page's *Screened* row (reasons withheld on private jobs); the blocked-prompt shot is an optional cutaway in RECORDING.md | Code |
| Provider backend: `hunyuan` adapter (`hy4-preview` via TokenHub) | `packages/cli/src/adapters/hosted.ts` | Code |

**Monad Foundation: "Best Community Team Project"** (All tracks, $5,000 USD) is for teams from
Metropolis community supporters. It is not a separate entry: see the last item of
[Before you submit](#before-you-submit).

---

## Team

| | |
|---|---|
| Nivesh Gajengi ([@nickthelegend](https://github.com/nickthelegend)) | Design, product, and direction of the Claude Code agents that built the port <!-- TODO: add teammates, if any --> |

## What's next

- **Mainnet.** `config.mainnet.yaml`, `deploy:mainnet` and the mainnet chain table are ready. It needs
  a funded deploy and a mainnet broker.
- **Private jobs outside the browser.** Today only browser buyers hold a passkey, so CLI, MCP and
  MetaMask-plugin buyers post public jobs.
- **Reputation that resists self-dealing, further.** `XorvLedger` already refuses a provider paying
  itself and ratings from the agent's own wallet, owner or operators, and the broker refuses to relay
  ratings between wallets Nansen links. A provider could still rate itself from a wallet with no
  traceable tie to it. The indexer already has every receipt's buyer, so the next step is weighting
  scores by distinct paying buyers and by each buyer's own Nansen trust.
- **A protocol fee without custody.** It would need a payment splitter contract as the `payTo`. The
  broker must never become the payee.
- **Publish 0.2.0** of `@xorv/protocol`, `@xorv/cli`, `@xorv/mcp` and `@xorv/mm-plugin` to npm.

---

## Before you submit

Deadline: **Oct 13 2026, 11:59 PM ET** (Oct 14 03:59 UTC). The version saved at the deadline is
the one judged.

**Deploy** (the full order, with env lines, is [DEPLOY.md](DEPLOY.md))
- [ ] Fund the deployer (or operator) EOA with MON, above the 10 MON reserve, and deploy the ledger
      with a **cold owner**: `XORV_BROKER_ADDRESS=<operator address> XORV_LEDGER_OWNER=<address the
      broker's host doesn't hold> pnpm deploy:ledger`. The script refuses an owner that is the broker
      or the operator key on testnet. Then `pnpm --filter @xorv/contracts verify:testnet`, and commit
      `packages/contracts/deployments/monadTestnet.json`.
- [ ] Run the broker on a public https URL with `XORV_PUBLIC_URL` set to it (it goes into on-chain
      agent and feedback URIs), `XORV_LEDGER_ADDRESS`, `XORV_LEDGER_FROM_BLOCK`, `XORV_TRUST_PROXY=1`
      and `XORV_TRUSTED_HOPS` behind a proxy, and the three model keys. Check with
      `pnpm setup:monad` and `GET /api/network`.
- [ ] Register the demo provider's ERC-8004 identity (`xorv identity register`) and start it with the
      `qwen`, `kimi` or `hunyuan` adapter and one CLI adapter.
- [ ] **Deploy the Envio indexer between Oct 10 and Oct 13** (the free plan keeps a deployment for 30
      days; judging runs to Oct 27 and winners are announced Nov 3). Set `ENVIO_XORV_LEDGER_ADDRESS`,
      `ENVIO_XORV_LEDGER_START_BLOCK`, and `ENVIO_XORV_VERIFIER_ADDRESSES` if the verifier has its own
      key. Then set `XORV_INDEXER_URL` on the broker.
- [ ] Deploy the two sites on https ([DEPLOY.md §5](DEPLOY.md#5-deploy-the-app-and-the-landing-to-vercel)):
  - `apps/app`: `NEXT_PUBLIC_XORV_BROKER_URL`, `NEXT_PUBLIC_XORV_NETWORK=eip155:10143`,
    `NEXT_PUBLIC_PRIVY_APP_ID`, and optionally the server-only `XORV_DEMO_PAYER_KEY`;
  - `apps/landing`: `NEXT_PUBLIC_XORV_BROKER_URL`, `NEXT_PUBLIC_XORV_APP_URL` (the app's https URL:
    without it every "Open app" and "Post a job" button points to `http://localhost:3002`),
    `NEXT_PUBLIC_XORV_LEDGER_ADDRESS` and `NEXT_PUBLIC_XORV_NETWORK`.

  Add the app's domain to the Privy app's allowed origins, both domains to `XORV_CORS_ORIGINS`, and
  the app's to `XORV_APP_URL`.
- [ ] Pay one job end to end in the deployed app, rate it, and let Kimi verify it. Copy the
      settlement, receipt, rating and feedback transaction hashes.
- [ ] Privy server wallet: `pnpm privy:setup --cap-usdc 0.05 --broker <broker URL>`, fund the printed
      address with test USDC, configure the MCP server built from source, and pay one job with
      `xorv_run_job`. Copy its payment link.
- [ ] Nansen: fund a **separate** Monad **mainnet** key with ~$2 USDC, set `XORV_NANSEN_MODE=live`
      and `XORV_NANSEN_PAYER_KEY` on the broker, start the demo provider (its signal is bought when
      its node connects), and check `GET /api/network` → `nansen.lastPaidTx`. Copy one paid tx.
      Stage the refused rating as in [docs/NANSEN.md §7](docs/NANSEN.md#7-seeing-it).
- [ ] Optional: publish to npm with pnpm, not npm (it rewrites the `workspace:*` range), and with
      `--access public`, because a scoped package is private on its first publish and neither
      `@xorv/protocol` nor `@xorv/mm-plugin` sets `publishConfig`:
      `pnpm --filter @xorv/protocol publish --access public`, then
      `pnpm --filter @xorv/mm-plugin publish --access public`.

**Fill placeholders**
- [ ] `grep -rn "TODO(deploy)" README.md SUBMISSION.md packages/contracts/README.md` and replace each
      one (README header links, "What is proven" and Deployments; this file's Project and Deployed
      contracts tables and bounty statuses; the XorvLedger row in `packages/contracts/README.md`)
      with the value from the command named next to it.

**Record**
- [x] The demo video: [docs/demo/xorv-demo.mp4](docs/demo/xorv-demo.mp4), recorded from the live hosted stack. The longer narrated cut in [RECORDING.md](RECORDING.md), showing the Monad integration and each
      entered bounty: three Privy features, Envio, Nansen, Kimi, Qwen and the live cross-device Mera
      decrypt.
- [ ] The ≤2-minute founder pitch (same file).
- [ ] The project graphic (≤3 MB).

**Hygiene**
- [ ] **Rotate every credential that was ever pasted anywhere**: in a chat, a terminal recording,
      a screenshot, an issue, or a `.env` shared for debugging. That covers operator, facilitator,
      verifier, deployer, demo and Nansen payer keys, the Privy app secret, the DashScope, Moonshot,
      TokenHub and Nansen API keys, the Envio API token and the Monadscan key. Then re-run `pnpm setup:monad`.
- [ ] Confirm that no `.env` or key is tracked (CI's "No keys in the tree" job) and that the repo is
      public.

**Submission form**
- [ ] Primary track: **Trust, Identity & AI Infrastructure** (Track 04).
- [ ] Add the six bounties entered, and answer each one's fields from its checklist above: *Privy!*,
      *Best Use of Envio*, *Best use of Nansen*, *Best Builds Powered by KIMI*, *Mera: One Passkey,
      Many Keys*, *Best Builds with Qwen 3.8 Max*.
- [ ] Do not add *Best Agent Wallet Plugin* (MetaMask) or *Build with Hunyuan* (Tencent): their cards
      name other tracks.
- [ ] *Best Community Team Project* (All tracks): select your community group in the portal profile
      if eligible.
