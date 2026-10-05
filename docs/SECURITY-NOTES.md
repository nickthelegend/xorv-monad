# Security notes

## Static analysis (Slither, 6 Oct 2026)

`slither contracts --filter-paths "lib/|test/|script/" --exclude-dependencies` over `contracts/src`.
Every finding is triaged below. None needed a code change.

| Impact | Check | Where | Verdict |
|---|---|---|---|
| High | reentrancy-balance | `XorvEscrow.fund`: balance read before `receiveWithAuthorization`, compared after | **False positive.** `fund` is `onlyAttester` and `nonReentrant`, as is every function that moves money, so the token can't re-enter the escrow. The before/after read is the point: it makes a fee-on-transfer token revert (`AmountMismatch`) instead of leaving the escrow short. Tokens are allowlisted (AUSD, USDC). |
| Medium | incorrect-equality | `XorvEscrow.sweep`: `excess == 0` | Intended: "nothing to sweep" reverts. `excess` is `balance - totalEscrowed`, never manipulable downwards. |
| Medium | uninitialized-local | `XorvRefundKeeper.onReport`: `refunded` | A counter that starts at zero by Solidity's definition. |
| Low | missing-zero-check | `XorvRegistry.setEscrow` / `setOperator` | Intended: zero disables outcome reporting / sponsored registration. Owner-only. |
| Low | missing-zero-check | `CleanverseGate.hasValidAPass` / `passesCompliance` (`account`) | A zero account simply isn't verified. |
| Low | calls-loop | `XorvRefundKeeper.onReport` → `escrow.refund` per job | Bounded by `MAX_BATCH` (50); each call is in `try/catch`, so one bad job can't block the batch. |
| Low | reentrancy-events, timestamp, shadowing-local | various | Events after external calls are informational under `nonReentrant`. Deadlines are minutes-to-hours, far above validator timestamp drift. Shadowed names are constructor parameters. |
| Info | low-level-calls, missing-inheritance | `CleanverseGate` | Deliberate: the A-Pass is unverified and its validity view has no known name, so it is called by selector and every failure reads as "not verified". |

## Other checks

- **Tests:** 125 Solidity tests (unit, fuzz with 1,024 runs, 4 invariants), plus fork tests against the real AUSD, USDC and Cleanverse A-Pass.
- **Secrets:** nothing secret is tracked in git, in the working tree or in history. The only key-like literals are Anvil's and Arbitrum Nitro's published dev keys. `.env`, `.env.local-stack` and `cre/.env` are gitignored. Hosting scripts write only contract addresses; the owner sets every secret in each dashboard.
- **Operator key:** with Privy configured, the broker's key never leaves Privy's enclave, and the policy allows eight calls on this chain at zero value (`docs/SPONSOR-GAP.md`).
