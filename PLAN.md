# Xorv on Monad: plan to done

Written 6 Oct 2026 under the coordinator's MASTER PIPELINE (`../METROPOLIS-ORCHESTRATION.md`).
Status is kept current in this file. Standing constraints:
- no Monad testnet or mainnet transactions until the user says go;
- no hosting deploys, no new repos;
- local anvil or an anvil fork only, with real contracts and real signed transactions;
- no production mocks.

## Goals

**Done** means the whole product runs end to end on a local chain with real contracts, and every
sponsor integration is real code with real tests. Where a key is missing, the product says "not
configured" and the item is marked BLOCKED with the exact user action. Nothing in the running
product fakes a result. Deploying to Monad testnet is a one-hour runbook (`docs/DEPLOY-LATER.md`)
the moment the user says go.

**Winning** in Track 04 (Trust, Identity & AI Infrastructure). The judging weights:
- 40% is sponsor fit. Each bounty's stated requirement must be met literally: Cleanverse (T4), Qwen (T4), Privy, Kimi, CRE, Envio.
- The rest is product quality, technical depth and the demo.

Xorv's pitch is trust: escrowed payment, reputation written by settlement, identity-gated value movement, a policy-locked operator key, and agents with an enforced budget.

## Phases (critical path marked ★)

1. ★ **Close the mocks.** Remove every mock and fixture mode from the running product; keep test doubles in tests only.
2. ★ **Completeness audit.** Walk every screen and flow, fix dead ends, states and 375px; commit the walk as a Playwright spec.
3. ★ **Zero-mock verification.** `docs/TEST-PLAN-ZERO-MOCK.md`, every item checked in Claude in Chrome with console and network clean.
4. **Quality gate.** Tests, typecheck, lint, Slither, secret scan, re-audit loop.
5. ★ **Judge package.** README, SUBMISSION.md, docs/DEPLOY-LATER.md.
6. **Testnet go** (BLOCKED, awaiting the user): fund deployers, deploy, host, record the video.

## Tasks

| # | Task | Acceptance | Verify | Status |
|---|---|---|---|---|
| 1.1 | Remove PRIVY MOCK MODE from the product | `XORV_SIGNER` is `key` or `privy`. `privy` without keys fails at boot, naming the keys. The local policy evaluator lives in tests only | `git grep -i "privy-mock"` finds nothing outside tests; protocol tests green | DONE (aa0b33f) |
| 1.2 | Remove agent FIXTURE MODE from the product | `xorv-agent` only calls a real API; without a key it says which key. Fixture replay moves to a test-only OpenAI-compatible server | agent tests green; `XORV_AGENT_FIXTURE` gone from `packages/agent/src` | DONE (aa0b33f) |
| 1.3 | Remove the mock A-Pass from the local stack | No `CLEANVERSE=mock`, no `XORV_CLEANVERSE_MOCK`. The local stack runs gate-off; the real gate runs on the Monad fork | `git grep -i cleanverse_mock` empty; fork e2e green | DONE (aa0b33f) |
| 1.4 | Process hygiene | No `pkill -f` in scripts; stop by PID | `git grep "pkill -f"` empty | DONE (aa0b33f) |
| 2.1 | Walk every app page | Board, job, providers, network, chain tx/address/token, 404: loading, empty, error and 375px all handled | Playwright spec `apps/app/e2e/walk.spec.ts` green | DONE: 10/10 in Google Chrome |
| 2.2 | Buyer flow in the browser | Quote → pay (demo account) → stream → result → escrow released | Chrome, console clean | DONE (Playwright + built-in browser) |
| 2.3 | Failure and cancel flows | A failed job refunds the buyer; cancel before start refunds with no reputation mark; invalid input is refused with a reason | Chrome plus broker tests | DONE: stop → refund verified on chain; invalid input refused |
| 2.4 | Landing page | Renders, links work, no old-chain copy, 375px | Chrome | DONE: dead `/chain` link found and fixed |
| 3.1 | Zero-mock test plan, executed | Every item PASS or UNTESTED (with the dependency) | `docs/TEST-PLAN-ZERO-MOCK.md` | DONE: 40 PASS, 0 FAIL, 8 UNTESTED (keys/testnet) |
| 4.1 | All suites green | TS (protocol, broker, CLI, MCP, agent, app), forge, fork tests, CRE, indexer, e2e stages | commands in README | DONE |
| 4.2 | Static analysis | Slither run on `contracts/src`; findings triaged | `docs/SECURITY-NOTES.md` | DONE: `docs/SECURITY-NOTES.md` |
| 4.3 | Secret scan | Nothing secret tracked; no `.env`, `*.key` | gitleaks or `git grep` | DONE: clean, including history |
| 5.1 | README judge package | One-command demo, new vs pre-existing, AI disclosure, why Monad, architecture diagram, sponsors | read-through | DONE |
| 5.2 | SUBMISSION.md | Portal fields per bounty, evidence links, 3-minute script | read-through | DONE |
| 5.3 | docs/DEPLOY-LATER.md | Ordered runbook: addresses and MON, keys, deploy and verify, hosting, smoke test, shot list; under 1 hour | read-through | DONE |
| 6.x | Testnet deploy, hosting, video | | | BLOCKED: awaiting testnet go |

## Gaps (from the code, 6 Oct)

| # | Evidence | Impact | Sev | Fix | Blocks |
|---|---|---|---|---|---|
| G1 | `packages/protocol/src/privy.ts:24,286,389` and `apps/app/components/network-view.tsx:266`: PRIVY MOCK MODE signs with a local key while presenting as Privy | A mock in the product path | P0 | Remove the mode; evaluator to tests | 1.1 |
| G2 | `packages/agent/src/llm.ts:51-56,126-133`, `index.ts:87-97`: FIXTURE MODE replays scripted model output in the shipped CLI | A scripted model stand-in in the product | P0 | Remove; replay server in tests | 1.2 |
| G3 | `scripts/local-stack.sh:93-102`, `services/broker/src/app.ts:243`, `network-view.tsx:240`: a mock A-Pass gates the local escrow | A mock in the product path | P0 | Remove; gate only over the real A-Pass (fork) | 1.3 |
| G4 | `scripts/e2e-local.sh` cleanup uses `pkill -f` for envio | Can kill another session's indexer | P1 | Track the PID | 1.4 |
| G5 | Privy live: no `PRIVY_APP_ID`/`PRIVY_APP_SECRET` | Privy bounty unproven live | P1 | User creates the app | BLOCKED |
| G6 | Kimi/Qwen live: no `MOONSHOT_API_KEY`/`DASHSCOPE_API_KEY` | Agent bounties unproven live | P1 | User keys | BLOCKED |
| G7 | Cleanverse CVA: aUSDC transfers revert `TransferNotAllowed()` and pools revert `PoolNotRegistered()` until Cleanverse onboards the app (also found independently in `thenar-monad-quest/docs/CLEANVERSE.md`) | CVA movement impossible for any app today | P1 | User gets docs access, pool registration and test A-Passes | BLOCKED |
| G8 | CRE simulate: not logged in | No simulation tx | P2 | `cre login` | BLOCKED |
| G9 | `.env.example:52` says contracts are "being built now; placeholders" | Stale copy | P3 | Rewrite | 5.1 |
| G10 | `packages/protocol/README.md:17` lists Arc/World Chain networks | Stale docs | P3 | Rewrite | 5.1 |
| G11 | Nothing on Monad testnet; no hosting; no public repo | Submission needs addresses, a URL and a repo | P0 for submission | DEPLOY-LATER runbook | BLOCKED: awaiting testnet go |

## Completion checklist (the same 30 items for the initial and final %)

Features and flows (10):
1. Buyer pays from the demo account in the browser.
2. Buyer pays from their own wallet.
3. Provider node registers (sponsored) and sells.
4. Failed job → refund.
5. Cancel.
6. Network page.
7. Chain viewer.
8. Landing page.
9. CLI `run`.
10. MCP + agent path.

Integrations and bounties (8):
11. Escrow/registry/log on the local chain.
12. Real AUSD on a fork.
13. Cleanverse CVI gate on the real A-Pass.
14. Privy live.
15. Kimi live.
16. Qwen live.
17. CRE (tests + compile).
18. Envio local + app.

Product integrity (4):
19. Zero mocks in the product path.
20. Persisted database (SQLite).
21. Honest "not configured" states.
22. 375px.

Quality (4):
23. Every suite green.
24. Static analysis.
25. Secret scan.
26. Playwright walk spec.

Submission (4):
27. README.
28. SUBMISSION.md.
29. DEPLOY-LATER.md.
30. Deployed + hosted + video (blocked).

**Initial: 15 / 30 = 50%.** Done at the start: 1, 3, 6, 9, 10 (with the scripted model, so it doesn't count fully), 11, 12, 13, 17, 18, 20, 22, 23 (as of the last commit), 28 (partial), 2 (proven on Arbitrum, unverified here). Counting 10 and 28 as halves and 2 as zero: 1, 3, 6, 9, 11, 12, 13, 17, 18, 20, 22, 23, plus three halves rounded = 15.

**Final: 24.5 / 30 = 82%** (6 Oct, after steps B–E).
- **Done (24):** 1, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29.
- **Half (1):** 10. The real agent binary, MCP and escrow are verified, but with a test-double model server; a live model run needs the keys.
- **Open, none of them independently solvable:**
  - 2: the visitor's own wallet. It needs a Privy app id for the app's wallet login, or a browser wallet funded on the local chain.
  - 14, 15, 16: Privy, Kimi and Qwen keys.
  - 30: the testnet go.

Gaps G1–G4 and G9–G10 are closed. G5–G8 and G11 are BLOCKED on the user (see USER_ACTION_REQUIRED in the coordinator report).
