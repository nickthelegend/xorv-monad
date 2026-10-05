# PLAN — Xorv on Arbitrum · Arbitrum Open House Singapore Buildathon

> Single source of truth. Status: **DONE** (implemented + verified, evidence noted) · **IN PROGRESS** · **NOT STARTED** · **BLOCKED (why)**.
> Repo: `/Volumes/Extreme SSD/Projects/xorv-arbitrum`. Forked from the Arc port (`xorv-arc`, "Kazuo") and renamed back to Xorv.
> The Hedera original (`xorv`) and the Arc port (`xorv-arc`) are **not touched**.
> Buildathon: online, Sep 14 – **Oct 4 2026**. Today: 2026-09-29/30.

## 0. The project in one paragraph

Xorv is a decentralized AI capacity network. A provider runs `xorv start`, which drives a coding-agent CLI they
already pay for (Claude Code / Codex / …) inside an OS sandbox. A buyer (web app, `xorv run`, or an MCP-connected
agent) gets a quote from the broker, receives HTTP 402, and signs an EIP-3009 authorization — zero gas, no account.
On Arbitrum the money no longer goes straight to the provider: it goes into **XorvEscrow**, which releases it to the
provider when the result arrives, refunds it when the job fails, and lets *anyone* refund the buyer after the
deadline. Every outcome is written to **XorvRegistry**, a Stylus (Rust) contract holding each provider's on-chain
reputation. Settlement is in **Paxos USDG** (default) or Circle USDC, on **Arbitrum Sepolia** and **Robinhood Chain
Testnet**.

## 1. Judging requirements (verified from HackQuest, 2026-09-29)

| Requirement / criterion | How Xorv meets it | Status |
|---|---|---|
| **Must be deployed on an Arbitrum chain** (Arbitrum Sepolia, Arbitrum One, Robinhood Chain…) | Escrow + registry + log on Arbitrum Sepolia **and** Robinhood Chain Testnet | BLOCKED (operator has 0 ETH on both — faucet) |
| Smart contract quality | XorvEscrow: 44 unit/fuzz + 4 invariants + fork tests vs real USDG/USDC; security table in `contracts/README.md`; Stylus registry with Rust tests | IN PROGRESS (registry) |
| Product-market fit | Idle AI subscriptions → per-job income; buyers pay per task with no account/API key | docs |
| Innovation | x402 **escrow scheme** (job-bound EIP-3009 nonce), Solidity↔Stylus interop, agents paying agents | IN PROGRESS |
| Real problem solving | Buyer risk removed by escrow + permissionless refunds; provider reputation earned on chain | IN PROGRESS |
| **Extra consideration: Paxos USDG** | USDG is the default settlement token on both chains | IN PROGRESS |
| ≥1 of 3 prizes reserved for Robinhood Chain, ≥1 for Arbitrum | Deployed on both | BLOCKED (funds) |
| Stylus (Rust) encouraged ("Solidity, Rust" tech stack) | XorvRegistry in Stylus, called by the Solidity escrow | IN PROGRESS |

## 2. Definition of Done

1. `forge test` green (unit + fuzz + invariant); `FORK_TESTS=1` fork suite green against real tokens.
2. Stylus registry: `cargo test` green, `cargo stylus check` passes on Arbitrum Sepolia (and Robinhood if supported).
3. `pnpm build && pnpm test` green; app + landing `next build` green; no World/Arc/Hedera leftovers in code.
4. Broker offers the **escrow** scheme (and `exact` as interop fallback); releases on delivery, refunds on failure,
   reassigns on provider loss; buyers (CLI, MCP, browser wallet) pay through escrow.
5. Full flow proven end to end on a local chain **forked from Arbitrum Sepolia** with the real USDG contract:
   quote → 402 → sign → fund → provider runs → release → registry reputation updated.
6. Contracts deployed + verified on Arbitrum Sepolia and Robinhood Chain Testnet; at least one real paid job on
   Arbitrum Sepolia in USDG with explorer links. *(BLOCKED on faucet funds)*
7. Public GitHub repo; app + landing on Vercel; broker on Railway. 
8. README / ARCHITECTURE / SUBMISSION / CHANGELOG match reality.

## 3. Phases

### Phase 1 — Contracts · P0 — DONE
| Task | Status | Evidence |
|---|---|---|
| XorvEscrow.sol | DONE | `ab28c66`; 51 forge tests pass |
| Invariant suite (solvency, accounting, money + supply conservation) | DONE | 4/4, 0 reverts |
| Fork tests vs real USDG (Arb Sepolia, Robinhood) + USDC | DONE | `59b2861`; 2/2 |
| Registry gas-estimation hole (found on Nitro) | DONE | `2e2b1eb`; regression test fails on old code, passes on new |
| XorvRegistry in Stylus (Rust) | DONE | `3b45217`; 47 Rust tests, `cargo stylus check` passes on Arb Sepolia + Robinhood |
| Solidity ↔ Stylus interop on a real Nitro node | DONE | `scripts/interop-nitro.sh` 8/8 |
| Deploy script + one-command testnet deploy (wiring, cache bid, verification) | DONE | rehearsed on Nitro |
| contracts/README.md security write-up | DONE | |

### Phase 2 — Retarget to Arbitrum · P0 — DONE
Networks (Arb Sepolia default, Robinhood Testnet, Arbitrum One, Robinhood mainnet, Nitro dev), per-network
stablecoins with verified EIP-712 domains (USDG first), World ID removed, Privy optional. `38355d8`.
Arbitrum One USDG address corrected to Paxos' published `0x004B…9bbC` (`82e03e2`).

### Phase 3 — Escrow in the payment path · P0 — DONE
| Task | Status | Evidence |
|---|---|---|
| x402 `escrow` scheme (client / server / facilitator), pinned to the configured escrow | DONE | 19 unit + 2 anvil tests |
| Broker: escrow offered first, exact fallback; release / reassign / refund by outcome; cancel refunds | DONE | `486d917`; 9 broker escrow tests |
| Bugs fixed on the way: reassign re-picked the failed node; failed settlement left job running unpaid; stale providerAddress | DONE | tests in escrow.test.ts |
| CLI, MCP, app wallet, app demo route pay via escrow; job page escrow panel + refund button | DONE | |

### Phase 4 — Stylus registry in the product · P1 — DONE
Sponsored `registerFor`, reputation cache, matcher ranks on on-chain score, `/api/providers` + `/api/network`
expose it, boot-time wiring checks. `8b95049`; 4 reputation tests.

### Phase 5 — Full-stack E2E · P0 — DONE
`scripts/e2e-local.sh`: MODE=fork (real USDG contract) 9/9; MODE=nitro (with Stylus registry) 13/13. `82e03e2`.

### Phase 6 — Testnet deployment · P0 — BLOCKED
| Task | Status |
|---|---|
| Deploy to Arbitrum Sepolia (`scripts/deploy-testnet.sh arbitrum-sepolia`) | BLOCKED — operator `0xeEE4…B51E` has 0 ETH; faucets need a human (CAPTCHA) |
| Deploy to Robinhood Chain Testnet | BLOCKED — same |
| Real paid job in USDG on Arbitrum Sepolia | BLOCKED — payer `0x0329…9F36` has 0 USDG |
| After deploy: set XORV_ESCROW/REGISTRY/LOG on Railway; NEXT_PUBLIC_* on Vercel; fill `DEPLOYMENTS` in constants.ts; update README/SUBMISSION | NOT STARTED (depends on above) |

### Phase 7 — Public deployment · P1 — DONE (escrow off until Phase 6)
| Task | Status | Evidence |
|---|---|---|
| GitHub repo | DONE (private until docs final) | github.com/nickthelegend/xorv-arbitrum |
| Railway broker with /data volume | DONE | https://broker-production-38c5.up.railway.app — health 200, CORS verified |
| Vercel landing + app | DONE | https://xorv-arbitrum.vercel.app · https://xorv-arbitrum-app.vercel.app — 200, no console errors |

### Phase 8 — Docs & submission · P1 — DONE (addresses pending Phase 6)
README, ARCHITECTURE, SUBMISSION (HackQuest answers), CHANGELOG 0.4.0, CLI/MCP READMEs, landing Contracts section.

### Phase 9 — Audit loop — DONE (this pass)
No TODO/FIXME/stub in source; landing copy that contradicted escrow/sandboxing fixed; CI now runs forge +
cargo (fmt, clippy, test). Re-run after Phase 6.

## 4. Known facts (verified on chain, don't re-derive)

- Arbitrum Sepolia `421614`, RPC `https://sepolia-rollup.arbitrum.io/rpc`, explorer `https://sepolia.arbiscan.io`
- Robinhood Chain Testnet `46630`, RPC `https://rpc.testnet.chain.robinhood.com`, explorer `https://explorer.testnet.chain.robinhood.com`
- USDG Arb Sepolia `0xFFC95faa3d63Cde504a05B567C600B78C0b41892`, USDG Robinhood `0x7E955252E15c84f5768B83c41a71F9eba181802F` —
  domain `("Global Dollar","1")`, EIP-3009 in a facet (`getFacet(bytes4)`), **no `version()`**
- USDC Arb Sepolia `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` — domain `("USD Coin","2")`
- Both support `receiveWithAuthorization(…, bytes signature)` (ERC-1271 capable)
- Base's AuthCaptureEscrow (x402 `auth-capture`) is **not** deployed on any Arbitrum chain
- Wallets (reused from the Arc port): operator `0xeEE4CA97A7Af69B42d9cafD3955735C1130eB51E`, payer
  `0x03294Ce27e218d1611B2ebc0b0ffdDb95F129F36`, provider `0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B` — all 0 balance
  on both chains as of 2026-09-30.

## 5. USER_ACTION_REQUIRED

Done (2026-10-02): live on Arbitrum Sepolia — XorvEscrow `0x383F5153db8Bb18c7c25157Fb3493645A465EeF3`,
XorvRegistry (Stylus) `0x38b65014fee7c87d5e13afbc555388f612a7a2a1`, XorvLog `0x135738387e4bEC5573914F1A2A812728b9b268C8`;
public broker and both sites point at them; paid jobs settled on chain. Operator gas left ~0.024 ETH (~0.00002 per job).

1. **Sign Claude Code back in** on the provider machine: run `claude` once and log in.
2. **Run a public provider for the demo** when you want one online (it sells your Codex to anyone using the
   public site's demo button): `XORV_HOME=~/.xorv-public-provider node packages/cli/dist/index.js start --port 8412`.
3. **Make the repo public** when ready to submit: `gh repo edit nickthelegend/xorv-arbitrum --visibility public --accept-visibility-change-consequences`.
4. Optional — **Privy email login**: allow `https://xorv-arbitrum-app.vercel.app` in the Privy dashboard, then set `NEXT_PUBLIC_PRIVY_APP_ID` on the Vercel app project.
5. Optional — **Robinhood Chain Testnet**: its faucet needs a Google sign-in; then `scripts/deploy-testnet.sh robinhood-testnet`.
6. **HackQuest submission**: register on the buildathon page and paste from SUBMISSION.md.
