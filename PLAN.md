# Xorv on Monad: the combined line, and what is left

Written 7 Oct 2026. Two lines of Xorv on Monad existed, and this branch combines them:
- **`main`** (26–28 Sep): x402 `exact` payments straight to the provider, `XorvLedger` receipts and
  ERC-8004 identity and reputation, live on Monad testnet; the Qwen router, Kimi verifier, Nansen
  trust, Mera private jobs and Privy.
- **`metropolis-escrow`** (4–7 Oct): its own registry and log contracts, plus three pieces `main`
  lacked: an escrow with refunds, a Chainlink CRE refund keeper and a Cleanverse CVI gate.

`main` keeps its contracts and live deployment. The three missing pieces were ported onto it and
adapted to XorvLedger and ERC-8004: the escrow's own reputation hook is unset, and the ledger
receipt points at the escrow's release.

Standing constraints:
- no Monad testnet or mainnet transactions until the user says go;
- local chains and Monad forks only;
- no mocks or fixture modes in the running product;
- a missing key means an honest "not configured".

## What was done in this combine

| # | Task | Verify | Status |
|---|---|---|---|
| 1 | Port `XorvEscrow`, `XorvRefundKeeper`, `CleanverseGate` with their Foundry tests | `cd contracts && forge test`: 76 pass; fork tests 5 pass | DONE |
| 2 | x402 `escrow` scheme in the protocol (server, client, facilitator) next to `exact` | protocol 267 tests | DONE |
| 3 | Broker: escrow quotes, fund → release with result hash / refund / re-point / cancel; ledger receipt = release; identity gate | broker 353 tests | DONE |
| 4 | Buyers (CLI, MCP, app) accept escrow rows only for the quoted escrow and provider; app shows escrow state | CLI 267, MCP 83, app 116 | DONE |
| 5 | Envio: XorvEscrow events, `EscrowJob` | indexer 66 tests | DONE |
| 6 | CRE refund keeper over `EscrowJob` | 4 bun tests, WASM compile | DONE |
| 7 | End to end on a Monad fork: release, ledger receipt, cancel refund, Cleanverse gate on the real A-Pass | `pnpm e2e:escrow`: 31/31 | DONE |
| 8 | Compliance: Nansen fixture mode out of the product (tests only; `fixture` refused at boot) | broker tests | DONE |
| 9 | Compliance: no MetaMask or Hunyuan bounty claims | already "not entered" in `main` before the combine | NO CHANGE NEEDED |
| 10 | CI: `contracts` and `cre` jobs | GitHub Actions on `main` | see the push |
| 11 | Docs: README, SUBMISSION (CRE and Cleanverse entries), ARCHITECTURE, CHANGELOG, docs/DEPLOY-LATER.md | read-through | DONE |

Not carried over from `metropolis-escrow`, because `main` already covers each one on its own design:
- `XorvRegistry` and `XorvLog`: `XorvLedger` and ERC-8004 do this job.
- The `/chain` viewer: `main` links Monadscan.
- The Privy *operator* signer: `main` uses Privy for the app wallet and the MCP agent.

## Completion checklist (30 items, the same for the initial and final %)

Flows (8):
1. A buyer pays in the browser (Privy wallet).
2. `xorv run` pays.
3. An MCP agent pays.
4. A provider registers an ERC-8004 identity and sells.
5. A rating reaches ERC-8004.
6. A failed or expired job refunds the buyer.
7. Cancel refunds.
8. Private jobs (Mera).

Integrations (12):
9. XorvLedger live on testnet.
10. The Envio indexer, tested.
11. Envio live on Envio Cloud.
12. Privy live (the app's wallet, and the MCP server wallet paying).
13. A live Nansen payment.
14. Kimi live.
15. Qwen live.
16. The CRE workflow, tested and compiled.
17. A CRE simulation broadcasting a refund.
18. The Cleanverse CVI gate on the real A-Pass.
19. Cleanverse CVA (aUSDC moving).
20. The escrow on testnet.

Integrity (4):
21. Zero mocks in the product path.
22. Honest "not configured" states.
23. Bounty claims match their cards (no track-locked claims).
24. Persistence.

Quality (3):
25. Every suite and CI green.
26. End-to-end on a fork, for the ledger and the escrow.
27. Secret scan over the full history.

Submission (3):
28. README and SUBMISSION describe the product.
29. The deploy runbooks (DEPLOY.md, docs/DEPLOY-LATER.md).
30. Hosted app and video.

**Initial (`main` at `4ad9456`): 15 / 30 = 50%.**
- **Done:** 2, 3, 4, 5, 8, 9, 10, 23, 24, 25, 28.
- **Half:**
  - 1: code and unit tests; live needs a Privy app id;
  - 12, 13, 14, 15: code, tests and fork e2e; live needs keys;
  - 22: Nansen offered a fixture mode;
  - 26: the ledger only;
  - 29: ledger only.
- **Zero:**
  - 6, 7: an `exact` payment can't be refunded;
  - 11, 16, 17, 18, 19, 20;
  - 21: Nansen fixture mode in the product;
  - 27, 30.

**Final: 22.5 / 30 = 75%** (7 Oct, after this combine; item 25 counts once CI is green on `main`).
- **Done (20):** 2, 3, 4, 5, 6, 7, 8, 9, 10, 16, 18, 21, 22, 23, 24, 25, 26, 27, 28, 29.
- **Half (5 × ½):** 1, 12, 13, 14, 15. The code is real and tested; the live run needs the user's keys.
- **Open (5), each blocked on the user, none solvable by an agent:**
  - 11: an Envio Cloud account;
  - 17: `cre login` and the testnet go;
  - 19: Cleanverse onboarding (docs, a registered pool, A-Passes);
  - 20: the testnet go;
  - 30: the testnet go and the recording.

## USER_ACTION_REQUIRED

| What | Unblocks |
|---|---|
| `MOONSHOT_API_KEY` (platform.moonshot.ai) | Kimi live (14) |
| `DASHSCOPE_API_KEY` and the workspace URL (Alibaba Model Studio) | Qwen live (15) |
| A Privy app id and secret, with Monad testnet gas sponsorship | Privy live (1, 12) |
| A mainnet key holding a few USDC, or `NANSEN_API_KEY` | Nansen live (13) |
| `cre login`, plus ~0.5 MON for the CRE broadcast key | CRE simulation (17) |
| An Envio Cloud account (GitHub login) | Envio live (11) |
| Cleanverse docs access, a registered pool and test A-Passes | the gate on testnet; CVA (19) |
| MON for the operator and facilitator, and the **testnet go** | the escrow deploy (20), hosting and video (30): [docs/DEPLOY-LATER.md](docs/DEPLOY-LATER.md) |
