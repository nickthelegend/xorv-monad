# Xorv end-to-end run

**PASS** — 31/31 checks, 13 steps, 31.0 s. Started 2026-10-07T13:40:29.530Z.

Produced by `pnpm e2e:escrow` (see [README.md](README.md)). Every value below was read back from the
forked chain or the running processes during the run; transaction hashes are local to that fork.

## Environment

| | |
|---|---|
| node | v26.5.0 |
| platform | darwin 25.5.0 |
| duration | 31.0 s |

## Parties

| | |
|---|---|
| operator (owns the escrow; ledger writes) | `0x5c19c933f05c206C986403f21A1AED3C3595B07c` |
| facilitator (the escrow's attester: funds, releases, refunds) | `0x18f398c23c1C2A60Df47eCeC31056455a9eBDF84` |
| provider | `0xeA723f94Aa30bC8E70193C293019820787273837` |
| buyer (USDC only, no MON) | `0xB209Def37cA62Bc6f46C5195B7c0649763AABFf7` |

## Chain

| | |
|---|---|
| XorvEscrow | `0x7dB43E49515A3eaE00207e7840CbE3Dc30F08b7a` |
| CleanverseGate | `0xa169C206998465B8D5d4721099ec6F5dbA8D4B6A` |

## Steps

| # | Step | Time | Result |
|---|---|---:|---|
| 1 | preflight | 0.0 s | ok |
| 2 | fork Monad testnet (Hardhat 3 / EDR, chain id 10143) | 5.6 s | ok |
| 3 | fund the parties | 3.4 s | ok |
| 4 | deploy XorvLedger (packages/contracts' script) | 2.6 s | ok |
| 5 | deploy XorvEscrow (contracts/, attester = the facilitator) | 0.2 s | ok |
| 6 | start the broker with the escrow (self-hosted facilitator) | 0.5 s | ok |
| 7 | provider: go live (xorv start, echo) | 0.5 s | ok |
| 8 | buyer: xorv run pays into the escrow; the release pays the provider | 4.3 s | ok |
| 9 | XorvLedger receipt records the release as the job's payment | 0.0 s | ok |
| 10 | buyer cancels a running job: the escrow refunds in full, no fault | 1.1 s | ok |
| 11 | Cleanverse: deploy the gate over the real A-Pass and set it on the escrow | 9.1 s | ok |
| 12 | a buyer without an A-Pass is refused before anything moves | 1.0 s | ok |
| 13 | Cleanverse issues the buyer an A-Pass; the same buyer pays and is released | 2.2 s | ok |

## Checks

### Fund the parties

| | Check | Detail |
|---|---|---|
| ✅ | buyer USDC | 5000000 |
| ✅ | buyer holds no MON | 0 |

### Deploy XorvEscrow (contracts/, attester = the facilitator)

| | Check | Detail |
|---|---|---|
| ✅ | escrow attester is the facilitator | `0x18f398c23c1C2A60Df47eCeC31056455a9eBDF84` |
| ✅ | escrow accepts the forked USDC | true |

### Start the broker with the escrow (self-hosted facilitator)

| | Check | Detail |
|---|---|---|
| ✅ | broker reports the escrow | `0x7dB43E49515A3eaE00207e7840CbE3Dc30F08b7a` |
| ✅ | no identity gate yet | null |

### Buyer: xorv run pays into the escrow; the release pays the provider

| | Check | Detail |
|---|---|---|
| ✅ | the quote named the escrow | `0x7dB43E49515A3eaE00207e7840CbE3Dc30F08b7a` |
| ✅ | the 402 offered escrow first | escrow |
| ✅ | job completed | completed |
| ✅ | payment scheme | escrow |
| ✅ | payTo is the provider the escrow released to | `0xeA723f94Aa30bC8E70193C293019820787273837` |
| ✅ | funding moved exactly the price buyer → XorvEscrow | [{"from":"0xB209Def37cA62Bc6f46C5195B7c0649763AABFf7","to":"0x7dB43E49515A3eaE00207e7840CbE3Dc30F08b7a","value":"1000"}] |
| ✅ | JobFunded in the funding tx |  |
| ✅ | JobReleased pays the provider | `0xeA723f94Aa30bC8E70193C293019820787273837` |
| ✅ | JobReleased carries the result's hash | `0x51800d14a07f0fbb8fc47e655c1f6603020127484c7d5b5e2b339042a82a609f` |
| ✅ | release moved the price XorvEscrow → provider |  |
| ✅ | buyer paid exactly the price | 1000 |
| ✅ | provider received exactly the price | 1000 |
| ✅ | escrow holds nothing for this job | 0 |
| ✅ | buyer still holds no MON | 0 |

### XorvLedger receipt records the release as the job's payment

| | Check | Detail |
|---|---|---|
| ✅ | JobRecorded.paymentTx is the release | `0xa7c83f15ef63ad06e0f1f65aede0583be751860a33e62ec10f4035ce27c4cd80` |
| ✅ | JobRecorded.payTo is the provider | `0xeA723f94Aa30bC8E70193C293019820787273837` |

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
| ✅ | payment refused | Error: paying http://127.0.0.1:54753/api/jobs/qte_QybmHy40bxLi → 402: the payment did not settle: identity_not_verified |
| ✅ | buyer's USDC did not move | 4999000 |

### Cleanverse issues the buyer an A-Pass; the same buyer pays and is released

| | Check | Detail |
|---|---|---|
| ✅ | gate now verifies the buyer | true |
| ✅ | released to the verified provider | `0x8eae6a419f87b15ffaac538bdb15901172b896a531945ddf4b65db899d1c33ac` |

## Step log

**preflight**

- run directory /Volumes/Extreme SSD/Projects/xorv-monad-main/e2e/.runs/escrow-wjwnLH

**fork Monad testnet (Hardhat 3 / EDR, chain id 10143)**

- serving http://127.0.0.1:54693, forked at block 68984406

**deploy XorvLedger (packages/contracts' script)**

- XorvLedger at 0xC0BF43A4Ca27e0976195E6661b099742f10507e5

**deploy XorvEscrow (contracts/, attester = the facilitator)**

- XorvEscrow at 0x7dB43E49515A3eaE00207e7840CbE3Dc30F08b7a (tx 0x25faecfcc10fb821d68789a9b4f729d4a5df32a25755e6733bf2665a6272946b)

**start the broker with the escrow (self-hosted facilitator)**

- listening on http://127.0.0.1:54753

**provider: go live (xorv start, echo)**

- provider prv_UeiI6iXxlRx- connected

**buyer: xorv run pays into the escrow; the release pays the provider**

- fund 0xd4850f212fc957ddbcc22bfc027501dcaed2b7965ccba686254c0682b0fa9b53, release 0xa7c83f15ef63ad06e0f1f65aede0583be751860a33e62ec10f4035ce27c4cd80

**buyer cancels a running job: the escrow refunds in full, no fault**

- refund 0x1871902fdb0abbe80352f31f80fd2b2eda465b1d4060eb8aa361160c5e36ac22

**Cleanverse: deploy the gate over the real A-Pass and set it on the escrow**

- CleanverseGate at 0xa169C206998465B8D5d4721099ec6F5dbA8D4B6A
