# Xorv end-to-end run

**PASS** — 31/31 checks, 13 steps, 51.6 s. Started 2026-10-07T20:26:58.971Z.

Produced by `pnpm e2e:escrow` (see [README.md](README.md)). Every value below was read back from the
forked chain or the running processes during the run; transaction hashes are local to that fork.

## Environment

| | |
|---|---|
| node | v26.5.0 |
| platform | darwin 25.5.0 |
| duration | 51.6 s |

## Parties

| | |
|---|---|
| operator (owns the escrow; ledger writes) | `0x02358b61941f41bD8ee7509701B6472A50Fc1F31` |
| facilitator (the escrow's attester: funds, releases, refunds) | `0x072BA8c37F6eDCbd545F88A760357FAa0B37a5B9` |
| provider | `0x31f2F9190d5cA552B228460DCA04B157D48effE0` |
| buyer (USDC only, no MON) | `0x571cF316919ef064bC01510c77cdbA07E372cA93` |

## Chain

| | |
|---|---|
| XorvEscrow | `0x581aaDD9e3c52713f9Efb8eA3132F65f717f8572` |
| CleanverseGate | `0xAa78A169a318806dB9cAceB3c3b2Ee4d58950854` |

## Steps

| # | Step | Time | Result |
|---|---|---:|---|
| 1 | preflight | 0.0 s | ok |
| 2 | fork Monad testnet (Hardhat 3 / EDR, chain id 10143) | 7.8 s | ok |
| 3 | fund the parties | 4.2 s | ok |
| 4 | deploy XorvLedger (packages/contracts' script) | 14.1 s | ok |
| 5 | deploy XorvEscrow (contracts/, attester = the facilitator) | 0.2 s | ok |
| 6 | start the broker with the escrow (self-hosted facilitator) | 5.6 s | ok |
| 7 | provider: go live (xorv start, echo) | 1.0 s | ok |
| 8 | buyer: xorv run pays into the escrow; the release pays the provider | 5.0 s | ok |
| 9 | XorvLedger receipt records the release as the job's payment | 0.0 s | ok |
| 10 | buyer cancels a running job: the escrow refunds in full, no fault | 1.1 s | ok |
| 11 | Cleanverse: deploy the gate over the real A-Pass and set it on the escrow | 7.8 s | ok |
| 12 | a buyer without an A-Pass is refused before anything moves | 1.4 s | ok |
| 13 | Cleanverse issues the buyer an A-Pass; the same buyer pays and is released | 2.7 s | ok |

## Checks

### Fund the parties

| | Check | Detail |
|---|---|---|
| ✅ | buyer USDC | 5000000 |
| ✅ | buyer holds no MON | 0 |

### Deploy XorvEscrow (contracts/, attester = the facilitator)

| | Check | Detail |
|---|---|---|
| ✅ | escrow attester is the facilitator | `0x072BA8c37F6eDCbd545F88A760357FAa0B37a5B9` |
| ✅ | escrow accepts the forked USDC | true |

### Start the broker with the escrow (self-hosted facilitator)

| | Check | Detail |
|---|---|---|
| ✅ | broker reports the escrow | `0x581aaDD9e3c52713f9Efb8eA3132F65f717f8572` |
| ✅ | no identity gate yet | null |

### Buyer: xorv run pays into the escrow; the release pays the provider

| | Check | Detail |
|---|---|---|
| ✅ | the quote named the escrow | `0x581aaDD9e3c52713f9Efb8eA3132F65f717f8572` |
| ✅ | the 402 offered escrow first | escrow |
| ✅ | job completed | completed |
| ✅ | payment scheme | escrow |
| ✅ | payTo is the provider the escrow released to | `0x31f2F9190d5cA552B228460DCA04B157D48effE0` |
| ✅ | funding moved exactly the price buyer → XorvEscrow | [{"from":"0x571cF316919ef064bC01510c77cdbA07E372cA93","to":"0x581aaDD9e3c52713f9Efb8eA3132F65f717f8572","value":"1000"}] |
| ✅ | JobFunded in the funding tx |  |
| ✅ | JobReleased pays the provider | `0x31f2F9190d5cA552B228460DCA04B157D48effE0` |
| ✅ | JobReleased carries the result's hash | `0x51800d14a07f0fbb8fc47e655c1f6603020127484c7d5b5e2b339042a82a609f` |
| ✅ | release moved the price XorvEscrow → provider |  |
| ✅ | buyer paid exactly the price | 1000 |
| ✅ | provider received exactly the price | 1000 |
| ✅ | escrow holds nothing for this job | 0 |
| ✅ | buyer still holds no MON | 0 |

### XorvLedger receipt records the release as the job's payment

| | Check | Detail |
|---|---|---|
| ✅ | JobRecorded.paymentTx is the release | `0x431a7bea30bd8557aa241db463d7f71e74f00e13736d5913a7ce7154cbaa5c90` |
| ✅ | JobRecorded.payTo is the provider | `0x31f2F9190d5cA552B228460DCA04B157D48effE0` |

### Buyer cancels a running job: the escrow refunds in full, no fault

| | Check | Detail |
|---|---|---|
| ✅ | cancel says refunded | true |
| ✅ | JobRefunded, provider not at fault | false |
| ✅ | buyer made whole | 4999000 |

### Cleanverse: deploy the gate over the real A-Pass and set it on the escrow

| | Check | Detail |
|---|---|---|
| ✅ | provider holds an A-Pass | 1 |
| ✅ | buyer holds none yet | false |

### A buyer without an A-Pass is refused before anything moves

| | Check | Detail |
|---|---|---|
| ✅ | payment refused | Error: paying http://127.0.0.1:51978/api/jobs/qte_nQhlxD4RXi6r → 402: the payment did not settle: identity_not_verified |
| ✅ | buyer's USDC did not move | 4999000 |

### Cleanverse issues the buyer an A-Pass; the same buyer pays and is released

| | Check | Detail |
|---|---|---|
| ✅ | gate now verifies the buyer | true |
| ✅ | released to the verified provider | `0xe45bc3aa16008111bbc39ccd86a1102501c56550439c61a03b3d57e4c3ac14a4` |

## Step log

**preflight**

- run directory /Volumes/Extreme SSD/Projects/xorv-monad-main/e2e/.runs/escrow-tThOXP

**fork Monad testnet (Hardhat 3 / EDR, chain id 10143)**

- serving http://127.0.0.1:51831, forked at block 69065098

**deploy XorvLedger (packages/contracts' script)**

- XorvLedger at 0xC0BF43A4Ca27e0976195E6661b099742f10507e5

**deploy XorvEscrow (contracts/, attester = the facilitator)**

- XorvEscrow at 0x581aaDD9e3c52713f9Efb8eA3132F65f717f8572 (tx 0x9816b45fc63b3eab2d721245d3628afdaa2218964a47ca8c7409f68122130456)

**start the broker with the escrow (self-hosted facilitator)**

- listening on http://127.0.0.1:51978

**provider: go live (xorv start, echo)**

- provider prv_N5jU19vSXBGp connected

**buyer: xorv run pays into the escrow; the release pays the provider**

- fund 0xa73d17facef6414bda3eeec8f96adda2f2b54d7e609ccf9380e44112b2a9b998, release 0x431a7bea30bd8557aa241db463d7f71e74f00e13736d5913a7ce7154cbaa5c90

**buyer cancels a running job: the escrow refunds in full, no fault**

- refund 0x2516bbd91013ded6b915d1781df729245519d8ca275f073f3418c7970e42fe02

**Cleanverse: deploy the gate over the real A-Pass and set it on the escrow**

- CleanverseGate at 0xAa78A169a318806dB9cAceB3c3b2Ee4d58950854
