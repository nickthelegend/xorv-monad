# Xorv end-to-end run

**PASS** — 31/31 checks, 13 steps, 29.2 s. Started 2026-10-13T10:11:07.845Z.

Produced by `pnpm e2e:escrow` (see [README.md](README.md)). Every value below was read back from the
forked chain or the running processes during the run; transaction hashes are local to that fork.

## Environment

| | |
|---|---|
| node | v26.5.0 |
| platform | darwin 25.5.0 |
| duration | 29.2 s |

## Parties

| | |
|---|---|
| operator (owns the escrow; ledger writes) | `0xF488Ec64477d2CdF8dce2720C2f6E7C96ebD8A0e` |
| facilitator (the escrow's attester: funds, releases, refunds) | `0x7CFD32c27987c75D5B61ed2977A368B2E91bBb9d` |
| provider | `0x63c38c127d65E914d8E15bc4b4893c01Fb5F488C` |
| buyer (USDC only, no MON) | `0x435Fa8f00F903D26AE79c27E41047BB5f3b7A014` |

## Chain

| | |
|---|---|
| XorvEscrow | `0xE1AD7769393b85608365adBc985D0b084592201b` |
| CleanverseGate | `0x0f2c731Bd23932a70F4f430144a5c35Dbc701DBc` |

## Steps

| # | Step | Time | Result |
|---|---|---:|---|
| 1 | preflight | 0.0 s | ok |
| 2 | fork Monad testnet (Hardhat 3 / EDR, chain id 10143) | 4.8 s | ok |
| 3 | fund the parties | 2.8 s | ok |
| 4 | deploy XorvLedger (packages/contracts' script) | 2.1 s | ok |
| 5 | deploy XorvEscrow (contracts/, attester = the facilitator) | 0.3 s | ok |
| 6 | start the broker with the escrow (self-hosted facilitator) | 0.8 s | ok |
| 7 | provider: go live (xorv start, echo) | 0.5 s | ok |
| 8 | buyer: xorv run pays into the escrow; the release pays the provider | 3.9 s | ok |
| 9 | XorvLedger receipt records the release as the job's payment | 0.0 s | ok |
| 10 | buyer cancels a running job: the escrow refunds in full, no fault | 0.7 s | ok |
| 11 | Cleanverse: deploy the gate over the real A-Pass and set it on the escrow | 9.7 s | ok |
| 12 | a buyer without an A-Pass is refused before anything moves | 0.8 s | ok |
| 13 | Cleanverse issues the buyer an A-Pass; the same buyer pays and is released | 2.1 s | ok |

## Checks

### Fund the parties

| | Check | Detail |
|---|---|---|
| ✅ | buyer USDC | 5000000 |
| ✅ | buyer holds no MON | 0 |

### Deploy XorvEscrow (contracts/, attester = the facilitator)

| | Check | Detail |
|---|---|---|
| ✅ | escrow attester is the facilitator | `0x7CFD32c27987c75D5B61ed2977A368B2E91bBb9d` |
| ✅ | escrow accepts the forked USDC | true |

### Start the broker with the escrow (self-hosted facilitator)

| | Check | Detail |
|---|---|---|
| ✅ | broker reports the escrow | `0xE1AD7769393b85608365adBc985D0b084592201b` |
| ✅ | no identity gate yet | null |

### Buyer: xorv run pays into the escrow; the release pays the provider

| | Check | Detail |
|---|---|---|
| ✅ | the quote named the escrow | `0xE1AD7769393b85608365adBc985D0b084592201b` |
| ✅ | the 402 offered escrow first | escrow |
| ✅ | job completed | completed |
| ✅ | payment scheme | escrow |
| ✅ | payTo is the provider the escrow released to | `0x63c38c127d65E914d8E15bc4b4893c01Fb5F488C` |
| ✅ | funding moved exactly the price buyer → XorvEscrow | [{"from":"0x435Fa8f00F903D26AE79c27E41047BB5f3b7A014","to":"0xE1AD7769393b85608365adBc985D0b084592201b","value":"1000"}] |
| ✅ | JobFunded in the funding tx |  |
| ✅ | JobReleased pays the provider | `0x63c38c127d65E914d8E15bc4b4893c01Fb5F488C` |
| ✅ | JobReleased carries the result's hash | `0x51800d14a07f0fbb8fc47e655c1f6603020127484c7d5b5e2b339042a82a609f` |
| ✅ | release moved the price XorvEscrow → provider |  |
| ✅ | buyer paid exactly the price | 1000 |
| ✅ | provider received exactly the price | 1000 |
| ✅ | escrow holds nothing for this job | 0 |
| ✅ | buyer still holds no MON | 0 |

### XorvLedger receipt records the release as the job's payment

| | Check | Detail |
|---|---|---|
| ✅ | JobRecorded.paymentTx is the release | `0x6c96e37ef16e0bd0abe6748209017a82aa7458c31614bcc4d39b6d391fc52777` |
| ✅ | JobRecorded.payTo is the provider | `0x63c38c127d65E914d8E15bc4b4893c01Fb5F488C` |

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
| ✅ | payment refused | Error: paying http://127.0.0.1:53506/api/jobs/qte_nKVf4WIx9tLH → 402: the payment did not settle: identity_not_verified |
| ✅ | buyer's USDC did not move | 4999000 |

### Cleanverse issues the buyer an A-Pass; the same buyer pays and is released

| | Check | Detail |
|---|---|---|
| ✅ | gate now verifies the buyer | true |
| ✅ | released to the verified provider | `0xf54f15cdcb966b69642f94339571bb0d655f292b1c3de0436e7a2395566c31a5` |

## Step log

**preflight**

- run directory /Volumes/Extreme SSD/Projects/xorv-monad-main/e2e/.runs/escrow-EEQYfy

**fork Monad testnet (Hardhat 3 / EDR, chain id 10143)**

- serving http://127.0.0.1:53496, forked at block 70654680

**deploy XorvLedger (packages/contracts' script)**

- XorvLedger at 0xC0BF43A4Ca27e0976195E6661b099742f10507e5

**deploy XorvEscrow (contracts/, attester = the facilitator)**

- XorvEscrow at 0xE1AD7769393b85608365adBc985D0b084592201b (tx 0xb29124a82746d2943a64113aed05f0c1ee04fe16e27292ec3dc73ab74ad4b772)

**start the broker with the escrow (self-hosted facilitator)**

- listening on http://127.0.0.1:53506

**provider: go live (xorv start, echo)**

- provider prv_0OjmUfKCdEJv connected

**buyer: xorv run pays into the escrow; the release pays the provider**

- fund 0xf102ddbcc81f13d7e9285b8e62eac7d2d2587edb35779291e73f359d583f61f9, release 0x6c96e37ef16e0bd0abe6748209017a82aa7458c31614bcc4d39b6d391fc52777

**buyer cancels a running job: the escrow refunds in full, no fault**

- refund 0x9ee0892f18ce7100f645031d5f8e49abe98ab78422112f08c30a3e443cce8800

**Cleanverse: deploy the gate over the real A-Pass and set it on the escrow**

- CleanverseGate at 0x0f2c731Bd23932a70F4f430144a5c35Dbc701DBc
