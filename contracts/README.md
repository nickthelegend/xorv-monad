# Xorv contracts

Three contracts, two languages, one rule: **a buyer's money is never at the
mercy of the node they happened to draw, or of the broker in between.**

| Contract | Language | What it does |
|---|---|---|
| [`XorvEscrow`](src/XorvEscrow.sol) | Solidity | Holds each job's payment from "buyer signed" to "work delivered". |
| [`XorvRegistry`](stylus/registry) | Rust (Arbitrum Stylus) | Provider registry and on-chain reputation, written by the escrow. |
| [`XorvLog`](src/XorvLog.sol) | Solidity | Append-only audit trail (registrations, heartbeats, receipts) as event logs. |

```
 buyer ──signs ReceiveWithAuthorization (no gas)──┐
                                                  ▼
 broker attester ── fund() ──► XorvEscrow ◄── USDG / USDC (EIP-3009)
                                   │
            release()  ────────────┼──► provider (minus fee, 0% today)
            refund()   ────────────┼──► buyer   (attester any time; anyone after deadline)
            reassign() ────────────┘    (payee changes, money stays)
                                   │
                                   └── recordOutcome() ──► XorvRegistry (Stylus)
                                                           completed / failed / earned / score
```

## XorvEscrow

### Lifecycle

| From | Call | Who | To | Money moves |
|---|---|---|---|---|
| — | `fund(Funding)` | attester | Funded | buyer → escrow |
| Funded | `release(jobId, resultHash)` | attester (before deadline), or buyer (any time) | Released | escrow → provider (+ fee) |
| Funded | `refund(jobId)` | attester (any time — counts against provider) | Refunded | escrow → buyer |
| Funded | `refund(jobId)` | **anyone** after the deadline (no blame) | Refunded | escrow → buyer |
| Funded | `reassign(jobId, newProvider)` | attester, before deadline | Funded | none |

`Released` and `Refunded` are terminal. Every transition is one storage write
of `status` before any external call.

### Security properties, and the test that pins each one

| Property | How | Test |
|---|---|---|
| Buyer needs no gas | EIP-3009 authorization, relayed by the attester | `test_fund_buyerNeedsNoGas` |
| Authorization can't be front-run into a bare transfer | `receiveWithAuthorization` requires `msg.sender == to`; `to` is the escrow | `test_fund_authorizationCannotBeFrontRun` |
| One signature commits to the job, amount, token, payee **and** refund deadline | nonce = `keccak256(TYPEHASH, chainId, escrow, jobId, deadline)`, recomputed on chain | `test_fund_signatureCommitsTo{JobId,Deadline,Amount}`, `testFuzz_foreignSignerCannotFund` |
| Nonce can't be replayed across chains or escrow deployments | `chainId` and `address(this)` in the derivation | `test_fundingNonce_isBoundToChainAndContract` |
| Only the attester can choose the provider at funding | `fund` is `onlyAttester` | `test_fund_onlyAttester` |
| Buyer can always get their money back | permissionless `refund` after the deadline; works while paused | `test_refund_anyoneAfterDeadlineWithoutBlame`, `test_refund_worksWhilePaused` |
| Broker can't hold funds hostage by stalling | attester can't `release` after the deadline; buyer can refund | `test_release_attesterCannotReleaseAfterDeadline` |
| Owner can never touch escrowed funds | no admin withdrawal; `sweep` only reaches `balance − totalEscrowed` | `test_sweepReachesOnlyExcess`, `invariant_solvent` |
| Fee can't be raised on a job already funded | fee snapshotted per job; capped at 5% | `test_release_takesSnapshottedFee`, `test_feeIsCapped` |
| Fee-on-transfer tokens can't short the escrow | balance measured before/after the pull | `test_fund_rejectsFeeOnTransferToken` |
| A broken registry can't block payment | `try/catch` with a fixed gas budget | `test_brokenRegistryNeverBlocksPayment`, `test_gasBurningRegistryNeverBlocksPayment` |
| …and can't be *starved* to skip a reputation update | if the call failed with < 1/63 of its budget left, revert (EIP-150) | `test_starvingTheRegistryCallReverts` |
| Smart-contract wallets can pay | `bytes signature` overload → ERC-1271 | `test_fund_fromSmartContractWallet` |
| No state is created or destroyed money-wise | ghost accounting over random call sequences | `invariant_moneyIsConserved`, `invariant_supplyIsConserved`, `invariant_accountingMatchesGhost` |
| Ownership can't be lost by accident | `Ownable2Step`; `renounceOwnership` disabled | `test_ownershipTransferIsTwoStep`, `test_renounceIsDisabled` |

Standard hygiene: Solidity 0.8.28, OpenZeppelin 5.4 (`SafeERC20`,
`ReentrancyGuard`, `Pausable`, `Ownable2Step`), custom errors, checks-effects-
interactions, a packed 3-slot `Job` struct, and events for every state change.

### Against the real tokens

The unit tests use a faithful EIP-3009 mock. The fork tests use the real
thing: they sign exactly as a wallet does, against each token's on-chain
`DOMAIN_SEPARATOR`, and run fund → release on

- **Paxos USDG** on Arbitrum Sepolia (`0xFFC9…1892`) — EIP-3009 lives in a facet behind the proxy, and there is no `version()`; the domain is `("Global Dollar", "1")`
- **Paxos USDG** on Robinhood Chain Testnet (`0x7E95…802F`)
- **Circle USDC** on Arbitrum Sepolia (`0x75fa…AA4d`), domain `("USD Coin", "2")`

```bash
FORK_TESTS=1 forge test --match-contract Fork
```

### Design lineage

Base's [commerce-payments](https://github.com/base/commerce-payments)
`AuthCaptureEscrow` (which x402's `auth-capture` scheme targets) uses the same
core trick — an EIP-3009 nonce derived from a hash of the payment terms. It is
not deployed on any Arbitrum chain, and its authorize/capture/void model has no
notion of a job moving between providers, a result hash, or reputation.
XorvEscrow is the job-shaped version of that idea.

## Running

```bash
git submodule update --init --recursive   # forge-std, openzeppelin-contracts
forge test                                 # 44 unit/fuzz + 4 invariants, offline
FORK_TESTS=1 forge test --match-contract Fork
```

## Deploying

```bash
# 1. Stylus registry (Rust) — see stylus/registry/README.md
# 2. Escrow + log; the stablecoin allowlist is chosen by chain id
XORV_OPERATOR_KEY=0x… XORV_REGISTRY_ADDRESS=0x… \
  forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia --broadcast
# 3. Point the registry at the escrow
cast send $XORV_REGISTRY_ADDRESS "setEscrow(address)" $XORV_ESCROW_ADDRESS --private-key $XORV_OPERATOR_KEY --rpc-url arbitrum_sepolia
```
