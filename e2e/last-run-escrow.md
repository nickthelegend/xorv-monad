# Xorv end-to-end run

**PASS** — 31/31 checks, 13 steps, 27.7 s. Started 2026-10-13T13:03:50.873Z.

Produced by `pnpm e2e:escrow` (see [README.md](README.md)). Every value below was read back from the
forked chain or the running processes during the run; transaction hashes are local to that fork.

## Environment

| | |
|---|---|
| node | v26.5.0 |
| platform | darwin 25.5.0 |
| duration | 27.7 s |

## Parties

| | |
|---|---|
| operator (owns the escrow; ledger writes) | `0x76C5Fdd086ee9126f816a26B87dB46Fb24Ffb83b` |
| facilitator (the escrow's attester: funds, releases, refunds) | `0x273885A39015B48c1E0D3F9141A900Ae46903a76` |
| provider | `0xD561D4c3C0Ac444E4c1bBE623fA618238eebcf8c` |
| buyer (USDC only, no MON) | `0x49A41e97D83C5ad6e5f1a819ee459c7e490642f2` |

## Chain

| | |
|---|---|
| XorvEscrow | `0xe9C2fafCCdBFb759B83f198e33A20433Ad043eb6` |
| CleanverseGate | `0x751eF15CA5b263679aCCcf87031BcaD811d72c0D` |

## Steps

| # | Step | Time | Result |
|---|---|---:|---|
| 1 | preflight | 0.0 s | ok |
| 2 | fork Monad testnet (Hardhat 3 / EDR, chain id 10143) | 4.2 s | ok |
| 3 | fund the parties | 2.7 s | ok |
| 4 | deploy XorvLedger (packages/contracts' script) | 1.7 s | ok |
| 5 | deploy XorvEscrow (contracts/, attester = the facilitator) | 0.3 s | ok |
| 6 | start the broker with the escrow (self-hosted facilitator) | 0.5 s | ok |
| 7 | provider: go live (xorv start, echo) | 1.3 s | ok |
| 8 | buyer: xorv run pays into the escrow; the release pays the provider | 3.8 s | ok |
| 9 | XorvLedger receipt records the release as the job's payment | 0.0 s | ok |
| 10 | buyer cancels a running job: the escrow refunds in full, no fault | 0.7 s | ok |
| 11 | Cleanverse: deploy the gate over the real A-Pass and set it on the escrow | 9.4 s | ok |
| 12 | a buyer without an A-Pass is refused before anything moves | 0.8 s | ok |
| 13 | Cleanverse issues the buyer an A-Pass; the same buyer pays and is released | 2.0 s | ok |

## Checks

### Fund the parties

| | Check | Detail |
|---|---|---|
| ✅ | buyer USDC | 5000000 |
| ✅ | buyer holds no MON | 0 |

### Deploy XorvEscrow (contracts/, attester = the facilitator)

| | Check | Detail |
|---|---|---|
| ✅ | escrow attester is the facilitator | `0x273885A39015B48c1E0D3F9141A900Ae46903a76` |
| ✅ | escrow accepts the forked USDC | true |

### Start the broker with the escrow (self-hosted facilitator)

| | Check | Detail |
|---|---|---|
| ✅ | broker reports the escrow | `0xe9C2fafCCdBFb759B83f198e33A20433Ad043eb6` |
| ✅ | no identity gate yet | null |

### Buyer: xorv run pays into the escrow; the release pays the provider

| | Check | Detail |
|---|---|---|
| ✅ | the quote named the escrow | `0xe9C2fafCCdBFb759B83f198e33A20433Ad043eb6` |
| ✅ | the 402 offered escrow first | escrow |
| ✅ | job completed | completed |
| ✅ | payment scheme | escrow |
| ✅ | payTo is the provider the escrow released to | `0xD561D4c3C0Ac444E4c1bBE623fA618238eebcf8c` |
| ✅ | funding moved exactly the price buyer → XorvEscrow | [{"from":"0x49A41e97D83C5ad6e5f1a819ee459c7e490642f2","to":"0xe9C2fafCCdBFb759B83f198e33A20433Ad043eb6","value":"1000"}] |
| ✅ | JobFunded in the funding tx |  |
| ✅ | JobReleased pays the provider | `0xD561D4c3C0Ac444E4c1bBE623fA618238eebcf8c` |
| ✅ | JobReleased carries the result's hash | `0x51800d14a07f0fbb8fc47e655c1f6603020127484c7d5b5e2b339042a82a609f` |
| ✅ | release moved the price XorvEscrow → provider |  |
| ✅ | buyer paid exactly the price | 1000 |
| ✅ | provider received exactly the price | 1000 |
| ✅ | escrow holds nothing for this job | 0 |
| ✅ | buyer still holds no MON | 0 |

### XorvLedger receipt records the release as the job's payment

| | Check | Detail |
|---|---|---|
| ✅ | JobRecorded.paymentTx is the release | `0x93b325f328b4d3acb6cb97acf1ce4df8b9da9d556430e85fe2ffb2f3e8970083` |
| ✅ | JobRecorded.payTo is the provider | `0xD561D4c3C0Ac444E4c1bBE623fA618238eebcf8c` |

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
| ✅ | payment refused | Error: paying http://127.0.0.1:61017/api/jobs/qte_CxCznttUJd6m → 402: the payment did not settle: identity_not_verified |
| ✅ | buyer's USDC did not move | 4999000 |

### Cleanverse issues the buyer an A-Pass; the same buyer pays and is released

| | Check | Detail |
|---|---|---|
| ✅ | gate now verifies the buyer | true |
| ✅ | released to the verified provider | `0xe5b3d409e04209d1eb08b56c4ccb2dd00b5650a400e380ece4ed4bf295896c00` |

## Step log

**preflight**

- run directory /Volumes/Extreme SSD/Projects/xorv-monad-main/e2e/.runs/escrow-39QRuo

**fork Monad testnet (Hardhat 3 / EDR, chain id 10143)**

- serving http://127.0.0.1:60995, forked at block 70688654

**deploy XorvLedger (packages/contracts' script)**

- XorvLedger at 0xC0BF43A4Ca27e0976195E6661b099742f10507e5

**deploy XorvEscrow (contracts/, attester = the facilitator)**

- XorvEscrow at 0xe9C2fafCCdBFb759B83f198e33A20433Ad043eb6 (tx 0x9528723ee6b957dee77c7be3bee6082bffb39b24a80f3965be74b362c3a24fdc)

**start the broker with the escrow (self-hosted facilitator)**

- listening on http://127.0.0.1:61017

**provider: go live (xorv start, echo)**

- provider prv_IsdACr9XE7Xe connected

**buyer: xorv run pays into the escrow; the release pays the provider**

- fund 0xf599ee7ae1d95e44c9250992fd8ffd0c8943511f1cd5159436f5c367cb7ad44f, release 0x93b325f328b4d3acb6cb97acf1ce4df8b9da9d556430e85fe2ffb2f3e8970083

**buyer cancels a running job: the escrow refunds in full, no fault**

- refund 0x35e94b4c2f6c71e0c2290aa3161755ef78d7bd2e85fa914cd331b9aac9506974

**Cleanverse: deploy the gate over the real A-Pass and set it on the escrow**

- CleanverseGate at 0x751eF15CA5b263679aCCcf87031BcaD811d72c0D
