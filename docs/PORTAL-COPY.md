# Portal copy (hackathon.monad.xyz)

Paste-ready. Every claim here links to a transaction or to code. The longer evidence is in [SUBMISSION.md](../SUBMISSION.md) and [SPONSOR-COVERAGE.md](SPONSOR-COVERAGE.md).

## Project name

Xorv

## Tagline (≤ 80 chars)

Pay-per-job AI with escrow, verified and reputed on Monad.

## Short description (≤ 280 chars)

Xorv is a marketplace where people and AI agents buy AI work one job at a time, paying USDC over x402. Monad holds the money in escrow and releases it only after a verifier passes the work, or refunds it. Every job is receipted, and providers carry ERC-8004 reputation.

## Full description

**Problem.** People pay $20–200 a month for AI they barely use. An agent that needs one job done has to buy a whole plan or API key. Nobody can sell or buy AI work per job with confidence: there is no trustworthy way to find a provider, pay fractions of a cent without an account, know the work was done, or get the money back when it wasn't.

**Solution.** Providers run a node that offers the models they can serve (hosted APIs like Kimi K3, local models and coding CLIs), each at their own price. A buyer, whether a person in the browser or an agent over MCP, gets a quote that freezes the provider and the price. They then sign one EIP-3009 USDC authorization, and it goes into **XorvEscrow** on Monad.
- **On delivery:** Kimi verifies the result. On a pass the escrow releases to the provider with the result's hash; on a fail it refunds the buyer.
- **If the broker vanishes:** a Chainlink CRE workflow refunds every job past its deadline.
- **On the record:** every job is receipted on XorvLedger, and verdicts and buyer ratings become ERC-8004 reputation.
- **Fraud checks:** Nansen profiles provider wallets and blocks self-rating. A Cleanverse gate can require verified identity.
- **The money itself:** a Chainlink USDC/USD feed pauses quoting if USDC loses its peg. AUSD settles through the same escrow.

**Why Monad.** Paying per job only works if the payment is final before anyone loses patience.
- **Speed:** with `eth_sendRawTransactionSync`, Xorv's payments execute in about 0.3–0.5 s and are final in about 1 s. Every job shows its own speed receipt, measured live.
- **Gas:** buyers never hold MON, because the facilitator pays the gas. Fees are shown as gas limit × price, because that is what Monad charges, and gas payers are checked against the 10 MON reserve.
- **Live chain views:** the network page streams Monad's Proposed → Voted → Finalized → Verified pipeline (`monadNewHeads` / `monadLogs`) and reads the validator set from the staking precompile.

**What's live (Monad testnet).**
- **App:** <https://xorv-monad-app.vercel.app>, where a judge can buy a job without logging in ("Pay from demo account").
- **Backend:** a broker with its own x402 facilitator.
- **Provider:** a Kimi K3 node registered as ERC-8004 agent #2252.
- **Contracts:** XorvLedger, XorvEscrow and XorvRefundKeeper, all Sourcify-verified.
- **Quality:** about 1,400 automated tests and fork end-to-end runs (193/193 and 31/31), with CI green.

## Track

04: Trust, Identity & AI Infrastructure

## Links

| | |
|---|---|
| Repository | <https://github.com/nickthelegend/xorv-monad> (MIT) |
| Live app | <https://xorv-monad-app.vercel.app> |
| Broker API | <https://broker-production-2d62.up.railway.app/api/network> |
| Demo video | `docs/demo/xorv-demo.mp4` in the repo (2:02); upload the file, or the re-take from [RECORDING-RUNBOOK.md](RECORDING-RUNBOOK.md) |
| Graphic | `docs/demo/xorv-graphic.png` (1200×630) |

## Contracts (Monad testnet, Sourcify-verified)

| Contract | Address |
|---|---|
| XorvLedger | [`0x40918C2fEc752B3b8C30bB121779011132668408`](https://testnet.monadvision.com/address/0x40918C2fEc752B3b8C30bB121779011132668408) |
| XorvEscrow | [`0x87d57e81b71d3eF5172156b5f3c6D01f5b74Df91`](https://testnet.monadvision.com/address/0x87d57e81b71d3eF5172156b5f3c6D01f5b74Df91) |
| XorvRefundKeeper (Chainlink CRE receiver) | [`0x69Abe4e96A5A84caAF01F2B3151e3CA1C53F223f`](https://testnet.monadvision.com/address/0x69Abe4e96A5A84caAF01F2B3151e3CA1C53F223f) |
| ERC-8004 Identity / Reputation (canonical) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` / `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

## Three best transactions

1. **A browser buyer, no login, paid into escrow:** [`0x8922a3…28dd`](https://testnet.monadvision.com/tx/0x8922a3a27429753fc04634bbbbed437ec7711f4a3fef6af9dde16c798a9628dd). Final in 1.02 s; Kimi passed the work at 95/100; released to agent #2252.
2. **Escrow released only after Kimi's pass:** [`0x8ab899…1e2b`](https://testnet.monadvision.com/tx/0x8ab89925367b418d559959e845ffbd8f1e4e1917e1bcf7a13ce262b3286b1e2b), with the verdict written as ERC-8004 feedback [`0x7a0677…eeb2`](https://testnet.monadvision.com/tx/0x7a0677caa130295ab9e78fdc3c4715ea2784d743cb82c3eb57b9ae056780eeb2).
3. **Chainlink CRE refunded an expired job, with no human involved:** [`0xa85c2f…cd15`](https://testnet.monadvision.com/tx/0xa85c2f69d7ccb7fea3d3d574d453f9974125b493675d626a2e037e8002decd15).

## Bounties

Enter the ones marked **Submit**. Requirement adherence is 40% of each score, so re-read each card's own fields in the portal before pasting.

| Bounty | Submit? | Paste into the bounty's fields |
|---|---|---|
| **Privy!** (All tracks) | **Submit** | An AI agent pays from a Privy **server wallet** whose policy allows only USDC payments of at most $0.05, either direct or into XorvEscrow, plus ratings on XorvLedger. Live: escrow fund [`0x9d3ab6…c7b2`](https://testnet.monadvision.com/tx/0x9d3ab6147ac88fd14feedd7feef8ad1dae21b2389f7e4854d8386b67fb38c7b2), and an agent rating [`0x11761f…4348`](https://testnet.monadvision.com/tx/0x11761ff5a77199d4946d3f74f903dc468aa5b273e1899b6bd74ef8acada54348) relayed into ERC-8004. People log in with Privy, and the embedded wallet signs the x402 payment and a gasless rating. Code: `packages/mcp/src/privy-policy.ts`, `apps/app/components/wallet-provider.tsx`. |
| **Best workflow with CRE** (All tracks) | **Submit** | `cre/refund-keeper`: a cron trigger reads the Envio index for funded escrow jobs past their deadline, under consensus. It checks `isRefundable` on XorvEscrow, then writes a report through the forwarder to XorvRefundKeeper, which refunds the buyer. Live broadcast: [`0xa85c2f…cd15`](https://testnet.monadvision.com/tx/0xa85c2f69d7ccb7fea3d3d574d453f9974125b493675d626a2e037e8002decd15). Chainlink Data Feeds (USDC/USD peg guard, MON/USD gas pricing) are used too. |
| **Best Builds Powered by KIMI** (All tracks) | **Submit** | Kimi K3 verifies every job, and the escrow **releases only on Kimi's pass** (a fail refunds the buyer). Each verdict is written as ERC-8004 feedback. A hosted provider also sells Kimi K3 per job, under a persisted daily cap. Live: release after a pass [`0x8ab899…`](https://testnet.monadvision.com/tx/0x8ab89925367b418d559959e845ffbd8f1e4e1917e1bcf7a13ce262b3286b1e2b), feedback [`0x7a0677…`](https://testnet.monadvision.com/tx/0x7a0677caa130295ab9e78fdc3c4715ea2784d743cb82c3eb57b9ae056780eeb2). |
| **Best use of Nansen** (All tracks) | **Submit** | Nansen profiles each provider's payout wallet (first funder, related wallets, activity), shown on the provider page with "Powered by Nansen". It refuses ratings between related wallets, which stops wash-rating. Calls are cached and budgeted. Run live with the API key on 13 Oct. |
| **Best Use of Envio** (All tracks) | Submit if Envio Cloud is deployed first | HyperIndex over XorvLedger, both ERC-8004 registries and XorvEscrow (`EscrowJob`). It feeds the leaderboard and the CRE keeper; 66 tests. It ran live against the testnet contracts; the hosted endpoint needs the Envio Cloud login (doitlater.md). |
| **Best Integration of CVI/CVA** (Track 04) | Submit, labelled fork evidence | `CleanverseGate` on XorvEscrow refuses to fund jobs for parties without an A-Pass. On a fork with the real A-Pass contract (31/31), an unverified buyer was refused before any money moved, then paid once Cleanverse's validator issued a pass. CVA is not used. |
| **Mera: One Passkey, Many Keys** (All tracks) | Submit only after the two-device check | Private jobs: keys come from the buyer's passkey through Mera, results are sealed to it on the provider, and the passkey signature is verified on chain with the P256 precompile `0x0100`. The live cross-device check needs a person. |
| **Best Builds with Qwen 3.8 Max** (Track 04) | Don't submit without `DASHSCOPE_API_KEY` | The tool-using router is built and tested (fork e2e 193/193 with a scripted Qwen), but it has no live calls without a key. |

## Team and attribution

- Nivesh Gajengi ([@nickthelegend](https://github.com/nickthelegend)): design, product, and direction of the agents that built the port.
- **Prior work:** Xorv began as a Hedera x402 prototype (<https://github.com/nickthelegend/xorv>), imported unchanged at commit `321b563`. Everything after it was built during Metropolis, from 26 Sep 2026. See the README's "Prior work" section.
- **AI tools disclosure:** built with **Claude Code** (Anthropic). Claude agents did the planning, research, implementation, tests and docs under the author's direction, and those commits carry a `Co-Authored-By: Claude` trailer. The author chose the design, the bounties and the scope, and reviewed the work.
