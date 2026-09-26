# Xorv end-to-end run

**PASS** — 174/174 checks, 21 steps, 218.2 s. Started 2026-09-26T19:16:20.284Z.

Produced by `pnpm e2e` (see [README.md](README.md)). Every value below was read back from the
forked chain or the running processes during the run; transaction hashes are local to that fork.

## Environment

| | |
|---|---|
| node | v22.21.1 |
| platform | win32 10.0.22631 |
| duration | 218.2 s |
| logs | (removed after a passing run) |

## Parties

| | |
|---|---|
| operator (broker EOA: ledger writes, rating relay, Kimi feedback) | `0x79eA4B61CC9e924F49500B8f3803c80Ba9023Eb8` |
| facilitator (submits EIP-3009 authorizations, pays settlement gas) | `0xAa836D4b6579268f0098ad4afa9A548582013602` |
| provider (payout address = ERC-8004 agent wallet) | `0x19957eF079d30419Fc65fD355D572b3E296eab42` |
| buyer (USDC only, no MON) | `0x448bb5458912C227026DB2642500770F312465EA` |
| provider ERC-8004 agent id | 1933 |
| provider id (broker) | prv_dKXOdVrQcw03 |

## Chain

| | |
|---|---|
| fork RPC | http://127.0.0.1:1270 |
| forked from | https://testnet-rpc.monad.xyz at block 65929744 |
| chain id | 10143 |
| USDC (Circle FiatToken, forked) | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| ERC-8004 Identity Registry (forked) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation Registry (forked) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| buyer USDC funding | minted via masterMinter 0x87f2e95621D8f12b83bb4a3E9975c0eAd524D437 |
| XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| XorvLedger deploy tx | `0x99916ccda93ab05de3782a6d00bfbe3b3f5b66094c7cdddfe1f8f55862d9ba2d` |

## Processes

| | |
|---|---|
| broker | http://127.0.0.1:27774 |

## Jobs

| | |
|---|---|
| CLI job | job_N0MhWxuTpyR0 |
| MCP job | job_40JiX_m_XZnS |
| private job | job_XmJZZ1o_PZoZ |

## Transactions

| | |
|---|---|
| cli job settlement | `0x661ed22287ad37bfb1234beb55f758eb34251b92005cfe7068eea5fc80bb8d98` |
| mcp job settlement | `0x1f1ead2f5c52283abf5f7d7426f3b9921529c2a9ae5f4b1b0e93a2db85855a00` |
| private job settlement | `0x19c327681dfc9347406f870fd3ab880b65df514ef0dce13823782a893294fe53` |
| ProviderRegistered | `0x47f5d1814c9a57158f13820b6e90d60ecaca015236d8afae0208805ecc766a35` |
| cli job receipt (JobRecorded) | `0x4de60be4fd2a5766cc68d6fe88013bcd652d9274121974b6d57c8fb0cbd4d1cf` |
| mcp job receipt (JobRecorded) | `0x9e2f69b1887416363a7084cafc3a81d88a578f45e333f1b2974dad858e30e81c` |
| private job receipt (JobRecorded) | `0xf460f42197d5a44edcc2cafb3a43aa7faef9c0ac524c1072f6bdcb531b6bfb32` |
| cli job rating (JobRated) | `0xbfbc9e0ec255d90c42c7eeaa398ebf3867aa295e575f09e8315d9a4f490ef339` |
| mcp job rating (JobRated) | `0x59594fc108cce2aa5f7fccad9c0eeecfecd07e2fef82a287c4093ffb084d5dc5` |
| cli job Kimi feedback (NewFeedback) | `0x3986add361aae063a53bd03ba3f3f62546d653b95362ffe131224ae90bd3c516` |
| mcp job Kimi feedback (NewFeedback) | `0x58377c17f2099c1ed8a51157b68cf54f5dc3780ff3be5a7a6b5d17a140f55769` |
| cli job rating (NewFeedback) | `0xbfbc9e0ec255d90c42c7eeaa398ebf3867aa295e575f09e8315d9a4f490ef339` |
| mcp job rating (NewFeedback) | `0x59594fc108cce2aa5f7fccad9c0eeecfecd07e2fef82a287c4093ffb084d5dc5` |

## AI roles (mock)

| | |
|---|---|
| Hunyuan screen calls | 4 |
| Qwen router calls | 1 |
| Kimi verifier calls | 2 |
| provider qwen adapter streams | 2 |

## Steps

| # | Step | Time | Result |
|---|---|---:|---|
| 1 | preflight | 0.1 s | ok |
| 2 | start the mock OpenAI-compatible model server | 0.0 s | ok |
| 3 | fork Monad testnet (Hardhat 3 / EDR, chain id 10143) | 85.6 s | ok |
| 4 | check the forked contracts are the real ones | 6.9 s | ok |
| 5 | fund the parties | 6.2 s | ok |
| 6 | deploy XorvLedger with packages/contracts' deploy script | 21.3 s | ok |
| 7 | start the broker (services/broker, self-hosted facilitator, AI roles on the mock) | 19.2 s | ok |
| 8 | provider: register an ERC-8004 identity (xorv identity register) | 16.0 s | ok |
| 9 | provider: go live (xorv start) | 8.4 s | ok |
| 10 | Hunyuan screen refuses an abusive prompt before any quote | 0.0 s | ok |
| 11 | buyer: xorv run --json (Qwen routes, x402 pays, qwen adapter answers) | 14.0 s | ok |
| 12 | Kimi verifies the result and writes ERC-8004 feedback | 0.0 s | ok |
| 13 | buyer rates the job through the broker API (EIP-712, gasless) | 2.7 s | ok |
| 14 | agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job) | 29.1 s | ok |
| 15 | private job through the broker API (sealed to the buyer's inbox key) | 4.7 s | ok |
| 16 | on-chain: x402 settlements (real USDC, facilitator pays gas) | 0.0 s | ok |
| 17 | on-chain: XorvLedger events | 0.1 s | ok |
| 18 | on-chain: ERC-8004 reputation (canonical Reputation Registry) | 0.0 s | ok |
| 19 | the broker's own views agree with the chain | 0.0 s | ok |
| 20 | the provider's own log is a record of its jobs | 0.0 s | ok |
| 21 | the private answer never touched the broker's disk | 0.0 s | ok |

## Checks

### Check the forked contracts are the real ones

| | Check | Detail |
|---|---|---|
| ✅ | USDC EIP-712 name | USDC |
| ✅ | USDC EIP-712 version | 2 |
| ✅ | USDC decimals | 6 |
| ✅ | ERC-8004 Identity Registry version | 2.0.0 |
| ✅ | ERC-8004 Reputation Registry version | 2.0.0 |
| ✅ | Reputation Registry is wired to the Identity Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |

### Fund the parties

| | Check | Detail |
|---|---|---|
| ✅ | buyer USDC balance after funding | 5000000 |
| ✅ | buyer holds no MON | 0 |

### Deploy XorvLedger with packages/contracts' deploy script

| | Check | Detail |
|---|---|---|
| ✅ | ledger.identity() is the canonical Identity Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ✅ | ledger.reputation() is the canonical Reputation Registry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| ✅ | ledger.broker() is the operator | `0x79eA4B61CC9e924F49500B8f3803c80Ba9023Eb8` |

### Start the broker (services/broker, self-hosted facilitator, AI roles on the mock)

| | Check | Detail |
|---|---|---|
| ✅ | broker network | eip155:10143 |
| ✅ | broker chain id | 10143 |
| ✅ | broker prices in the forked USDC | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| ✅ | facilitator is self-hosted | self |
| ✅ | facilitator EOA | `0xAa836D4b6579268f0098ad4afa9A548582013602` |
| ✅ | payments are available | true |
| ✅ | ledger address | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | ledger mode | write |
| ✅ | screener | hunyuan |
| ✅ | router | qwen |
| ✅ | verifier | kimi |
| ✅ | verifier writes ERC-8004 feedback from the operator | `0x79eA4B61CC9e924F49500B8f3803c80Ba9023Eb8` |

### Provider: register an ERC-8004 identity (xorv identity register)

| | Check | Detail |
|---|---|---|
| ✅ | agent owner is the provider's payout address | `0x19957eF079d30419Fc65fD355D572b3E296eab42` |
| ✅ | agent wallet is the provider's payout address | `0x19957eF079d30419Fc65fD355D572b3E296eab42` |
| ✅ | agentURI is the broker's registration file | http://127.0.0.1:27774/agents/e2e-node-0qatav61.json |

### Provider: go live (xorv start)

| | Check | Detail |
|---|---|---|
| ✅ | broker verified the agent id against the Identity Registry | 1933 |
| ✅ | registration file names the agent | 1933 |
| ✅ | registration file names the canonical Identity Registry | eip155:10143:0x8004A818BFB912233c491871b3d84c89A494BD9e |

### Hunyuan screen refuses an abusive prompt before any quote

| | Check | Detail |
|---|---|---|
| ✅ | quote refused with 422 | 422 |
| ✅ | screening verdict | block |
| ✅ | screened by | hunyuan |

### Buyer: xorv run --json (Qwen routes, x402 pays, qwen adapter answers)

| | Check | Detail |
|---|---|---|
| ✅ | job completed | completed |
| ✅ | payer is the buyer | `0x448bb5458912C227026DB2642500770F312465EA` |
| ✅ | screened by Hunyuan and allowed | hunyuan:allow |
| ✅ | routed by Qwen | qwen |
| ✅ | router's pick (over the cheaper echo) is the quoted adapter | qwen/qwen |
| ✅ | quote freezes $0.04 = 40000 USDC units | 40000 |
| ✅ | payTo is the provider, not the broker | `0x19957eF079d30419Fc65fD355D572b3E296eab42` |
| ✅ | result came from the provider's qwen adapter (mock answer token) | ans-fe724aa6b7dd6a3928ec |
| ✅ | resultHash = keccak256(result) | `0x7f4f40b643dc2e63f311eaff46373c59c8a988b648e3a346853ccc3dcf1b84aa` |
| ✅ | settlement tx reported | `0x661ed22287ad37bfb1234beb55f758eb34251b92005cfe7068eea5fc80bb8d98` |
| ✅ | XorvLedger receipt tx reported | `0x4de60be4fd2a5766cc68d6fe88013bcd652d9274121974b6d57c8fb0cbd4d1cf` |

### Kimi verifies the result and writes ERC-8004 feedback

| | Check | Detail |
|---|---|---|
| ✅ | verified by Kimi | kimi |
| ✅ | verification score | 92 |

### Buyer rates the job through the broker API (EIP-712, gasless)

| | Check | Detail |
|---|---|---|
| ✅ | rating signer is the payer | `0x448bb5458912C227026DB2642500770F312465EA` |
| ✅ | rating is for the provider's agent | 1933 |
| ✅ | typed data domain is this XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | a stranger's signature is refused | 401 |
| ✅ | served feedback file hashes to the committed feedbackHash | `0x1fb0f2c9bbb1b7f94b7f71cde5a851a5315c44288d0ccbcd51aad0cfa9cc7e7c` |

### Agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job)

| | Check | Detail |
|---|---|---|
| ✅ | MCP server lists xorv_run_job and xorv_rate_job | xorv_list_providers, xorv_network_status, xorv_quote, xorv_get_job, xorv_wallet, xorv_run_job, xorv_rate_job |
| ✅ | MCP result is the echo of the prompt |  |
| ✅ | MCP reports the XorvLedger receipt |  |

### Private job through the broker API (sealed to the buyer's inbox key)

| | Check | Detail |
|---|---|---|
| ✅ | private job completed | completed |
| ✅ | job is flagged private | true |
| ✅ | prompt is redacted from the public job |  |
| ✅ | the broker holds a sealed envelope | alg x25519-hkdf-sha256-aes256gcm |
| ✅ | the buyer's inbox key opens it to the provider's answer | ans-46cf730a00c0066c26b3 |
| ✅ | another inbox key cannot open it | DECRYPT_FAILED |
| ✅ | it is bound to its job id | DECRYPT_FAILED |
| ✅ | the plaintext answer is nowhere in the broker's API |  |
| ✅ | the plaintext answer never reached the Kimi verifier |  |
| ✅ | the private job was not verified (no readable result) |  |
| ✅ | resultHash commits to the envelope | `0xafa81d0b936bb2c5c0b96d1df294ba73b16d0d6b64502986c6f46f379b073055` |

### On-chain: x402 settlements (real USDC, facilitator pays gas)

| | Check | Detail |
|---|---|---|
| ✅ | cli: settlement succeeded | success |
| ✅ | cli: sent (and gas paid) by the facilitator | `0xAa836D4b6579268f0098ad4afa9A548582013602` |
| ✅ | cli: USDC Transfer buyer → provider for exactly 40000 | 0x448bb5458912C227026DB2642500770F312465EA→0x19957eF079d30419Fc65fD355D572b3E296eab42 40000 |
| ✅ | cli: EIP-3009 authorization used by the buyer |  |
| ✅ | cli: job.payment.amount | 40000 |
| ✅ | mcp: settlement succeeded | success |
| ✅ | mcp: sent (and gas paid) by the facilitator | `0xAa836D4b6579268f0098ad4afa9A548582013602` |
| ✅ | mcp: USDC Transfer buyer → provider for exactly 1000 | 0x448bb5458912C227026DB2642500770F312465EA→0x19957eF079d30419Fc65fD355D572b3E296eab42 1000 |
| ✅ | mcp: EIP-3009 authorization used by the buyer |  |
| ✅ | mcp: job.payment.amount | 1000 |
| ✅ | private: settlement succeeded | success |
| ✅ | private: sent (and gas paid) by the facilitator | `0xAa836D4b6579268f0098ad4afa9A548582013602` |
| ✅ | private: USDC Transfer buyer → provider for exactly 40000 | 0x448bb5458912C227026DB2642500770F312465EA→0x19957eF079d30419Fc65fD355D572b3E296eab42 40000 |
| ✅ | private: EIP-3009 authorization used by the buyer |  |
| ✅ | private: job.payment.amount | 40000 |
| ✅ | buyer USDC balance | 4919000 |
| ✅ | provider USDC balance | 81000 |
| ✅ | buyer spent no MON (still zero) | 0 |
| ✅ | buyer never sent a transaction (nonce 0) | 0 |

### On-chain: XorvLedger events

| | Check | Detail |
|---|---|---|
| ✅ | ProviderRegistered for the provider | `0x47f5d1814c9a57158f13820b6e90d60ecaca015236d8afae0208805ecc766a35` |
| ✅ | ProviderRegistered.payTo | `0x19957eF079d30419Fc65fD355D572b3E296eab42` |
| ✅ | ProviderRegistered.agentId | 1933 |
| ✅ | ProviderRegistered.label | e2e-provider |
| ✅ | ProviderRegistered.capabilities | echo:1000,qwen:40000 |
| ✅ | a sampled ProviderHeartbeat was published | `0xb7c077346b8a4dd726d92e93ab9bd63e2ff5b524a5f62bbfd774357afc1e51fc` |
| ✅ | cli: JobRecorded | `0x4de60be4fd2a5766cc68d6fe88013bcd652d9274121974b6d57c8fb0cbd4d1cf` |
| ✅ | cli: JobRecorded.agentId | 1933 |
| ✅ | cli: JobRecorded.buyer | `0x448bb5458912C227026DB2642500770F312465EA` |
| ✅ | cli: JobRecorded.payTo | `0x19957eF079d30419Fc65fD355D572b3E296eab42` |
| ✅ | cli: JobRecorded.amount | 40000 |
| ✅ | cli: JobRecorded.paymentTx is the settlement | `0x661ed22287ad37bfb1234beb55f758eb34251b92005cfe7068eea5fc80bb8d98` |
| ✅ | cli: JobRecorded.requestHash = keccak256(prompt) | `0xdf64005a292084bd28f244db7385fa59bcd29b90aa198d1991225323388836dc` |
| ✅ | cli: JobRecorded.resultHash = keccak256(result) | `0x7f4f40b643dc2e63f311eaff46373c59c8a988b648e3a346853ccc3dcf1b84aa` |
| ✅ | cli: JobRecorded.ok | true |
| ✅ | cli: the broker's receiptTxHash is that transaction | `0x4de60be4fd2a5766cc68d6fe88013bcd652d9274121974b6d57c8fb0cbd4d1cf` |
| ✅ | mcp: JobRecorded | `0x9e2f69b1887416363a7084cafc3a81d88a578f45e333f1b2974dad858e30e81c` |
| ✅ | mcp: JobRecorded.agentId | 1933 |
| ✅ | mcp: JobRecorded.buyer | `0x448bb5458912C227026DB2642500770F312465EA` |
| ✅ | mcp: JobRecorded.payTo | `0x19957eF079d30419Fc65fD355D572b3E296eab42` |
| ✅ | mcp: JobRecorded.amount | 1000 |
| ✅ | mcp: JobRecorded.paymentTx is the settlement | `0x1f1ead2f5c52283abf5f7d7426f3b9921529c2a9ae5f4b1b0e93a2db85855a00` |
| ✅ | mcp: JobRecorded.requestHash = keccak256(prompt) | `0x79c5a8868cd14446a1ada8ed4374fcc90257c693f5959e6b47a9b9e7af478828` |
| ✅ | mcp: JobRecorded.resultHash = keccak256(result) | `0x9563fef959d2744056daa4bfa0807258dde25481cbc88eb9f72003f7cd9dd72c` |
| ✅ | mcp: JobRecorded.ok | true |
| ✅ | mcp: the broker's receiptTxHash is that transaction | `0x9e2f69b1887416363a7084cafc3a81d88a578f45e333f1b2974dad858e30e81c` |
| ✅ | private: JobRecorded | `0xf460f42197d5a44edcc2cafb3a43aa7faef9c0ac524c1072f6bdcb531b6bfb32` |
| ✅ | private: JobRecorded.agentId | 1933 |
| ✅ | private: JobRecorded.buyer | `0x448bb5458912C227026DB2642500770F312465EA` |
| ✅ | private: JobRecorded.payTo | `0x19957eF079d30419Fc65fD355D572b3E296eab42` |
| ✅ | private: JobRecorded.amount | 40000 |
| ✅ | private: JobRecorded.paymentTx is the settlement | `0x19c327681dfc9347406f870fd3ab880b65df514ef0dce13823782a893294fe53` |
| ✅ | private: JobRecorded.requestHash = keccak256(prompt) | `0x099a76cc50b886a869b0e1de94a35a8f6ca670455bfffc21aa5e5b10dbe52d88` |
| ✅ | private: JobRecorded.resultHash = keccak256(result) | `0xafa81d0b936bb2c5c0b96d1df294ba73b16d0d6b64502986c6f46f379b073055` |
| ✅ | private: JobRecorded.ok | true |
| ✅ | private: the broker's receiptTxHash is that transaction | `0xf460f42197d5a44edcc2cafb3a43aa7faef9c0ac524c1072f6bdcb531b6bfb32` |
| ✅ | private: the on-chain resultHash is keccak256 of the sealed envelope | `0xafa81d0b936bb2c5c0b96d1df294ba73b16d0d6b64502986c6f46f379b073055` |
| ✅ | cli: JobRated | `0xbfbc9e0ec255d90c42c7eeaa398ebf3867aa295e575f09e8315d9a4f490ef339` |
| ✅ | cli: JobRated.value | 87 |
| ✅ | cli: JobRated.buyer | `0x448bb5458912C227026DB2642500770F312465EA` |
| ✅ | cli: JobRated.agentId | 1933 |
| ✅ | cli: ledger.jobs() marks it rated |  |
| ✅ | mcp: JobRated | `0x59594fc108cce2aa5f7fccad9c0eeecfecd07e2fef82a287c4093ffb084d5dc5` |
| ✅ | mcp: JobRated.value | 64 |
| ✅ | mcp: JobRated.buyer | `0x448bb5458912C227026DB2642500770F312465EA` |
| ✅ | mcp: JobRated.agentId | 1933 |
| ✅ | mcp: ledger.jobs() marks it rated |  |
| ✅ | cli: the relay tx the broker returned is the JobRated tx | `0xbfbc9e0ec255d90c42c7eeaa398ebf3867aa295e575f09e8315d9a4f490ef339` |
| ✅ | private: not rated |  |

### On-chain: ERC-8004 reputation (canonical Reputation Registry)

| | Check | Detail |
|---|---|---|
| ✅ | cli: Kimi's NewFeedback (tag1 "xorv-verified") | `0x3986add361aae063a53bd03ba3f3f62546d653b95362ffe131224ae90bd3c516` |
| ✅ | cli: verifier feedback client is the verifier EOA | `0x79eA4B61CC9e924F49500B8f3803c80Ba9023Eb8` |
| ✅ | cli: verifier feedback value | 92 |
| ✅ | cli: verifier feedback tag2 is the adapter | qwen |
| ✅ | cli: verifier feedbackURI | http://127.0.0.1:27774/verifications/job_N0MhWxuTpyR0.json |
| ✅ | cli: served verification file hashes to the on-chain feedbackHash | `0xff83cda8c82ec75de0476d917bac1e2e1f5206946122ca5b33f020db138189db` |
| ✅ | mcp: Kimi's NewFeedback (tag1 "xorv-verified") | `0x58377c17f2099c1ed8a51157b68cf54f5dc3780ff3be5a7a6b5d17a140f55769` |
| ✅ | mcp: verifier feedback client is the verifier EOA | `0x79eA4B61CC9e924F49500B8f3803c80Ba9023Eb8` |
| ✅ | mcp: verifier feedback value | 92 |
| ✅ | mcp: verifier feedback tag2 is the adapter | echo |
| ✅ | mcp: verifier feedbackURI | http://127.0.0.1:27774/verifications/job_40JiX_m_XZnS.json |
| ✅ | mcp: served verification file hashes to the on-chain feedbackHash | `0x4bff9bdbd93bc36188cace6d71073c700cbb58620a4a504a3b504a3bcff7be19` |
| ✅ | private: no verifier feedback | 2 xorv-verified entries |
| ✅ | cli: the buyer's rating as NewFeedback (tag1 "starred") | `0xbfbc9e0ec255d90c42c7eeaa398ebf3867aa295e575f09e8315d9a4f490ef339` |
| ✅ | cli: rating feedback client is XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | cli: rating feedback value | 87 |
| ✅ | cli: rating endpoint is the broker's jobs service | http://127.0.0.1:27774/api/quotes |
| ✅ | cli: served feedback file hashes to the on-chain feedbackHash | `0x1fb0f2c9bbb1b7f94b7f71cde5a851a5315c44288d0ccbcd51aad0cfa9cc7e7c` |
| ✅ | mcp: the buyer's rating as NewFeedback (tag1 "starred") | `0x59594fc108cce2aa5f7fccad9c0eeecfecd07e2fef82a287c4093ffb084d5dc5` |
| ✅ | mcp: rating feedback client is XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | mcp: rating feedback value | 64 |
| ✅ | mcp: rating endpoint is the broker's jobs service | http://127.0.0.1:27774/api/quotes |
| ✅ | mcp: served feedback file hashes to the on-chain feedbackHash | `0x41644adc9e642ee5f379b76231585c844e97120d02499f957cdef48a6740a485` |
| ✅ | cli: rating feedbackHash is what the buyer signed | `0x1fb0f2c9bbb1b7f94b7f71cde5a851a5315c44288d0ccbcd51aad0cfa9cc7e7c` |
| ✅ | getSummary([ledger], "starred").count | 2 |
| ✅ | getSummary([ledger], "starred") is the registry's mean of those NewFeedback values | 75 (0 decimals) |
| ✅ | getSummary([verifier], "xorv-verified").count | 2 |
| ✅ | getSummary([verifier], "xorv-verified") is the registry's mean of those NewFeedback values | 92 (0 decimals) |
| ✅ | getClients lists XorvLedger and the verifier | 0x79eA4B61CC9e924F49500B8f3803c80Ba9023Eb8, 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 |

### The broker's own views agree with the chain

| | Check | Detail |
|---|---|---|
| ✅ | ledger feed source (RPC scan of the fork) | rpc |
| ✅ | ledger feed links all three receipts to their jobs | job_XmJZZ1o_PZoZ, job_40JiX_m_XZnS, job_N0MhWxuTpyR0 |
| ✅ | ledger feed has both ratings | 2 |
| ✅ | leaderboard lists the provider |  |
| ✅ | no ledger publish errors | null |
| ✅ | no receipts left queued | 0 |

### The provider's own log is a record of its jobs

| | Check | Detail |
|---|---|---|
| ✅ | cli: logged once, as done | 1 |
| ✅ | mcp: logged once, as done | 1 |
| ✅ | private: logged once, as done | 1 |
| ✅ | the status footer is printed once, not once a second | 1 |

### The private answer never touched the broker's disk

| | Check | Detail |
|---|---|---|
| ✅ | broker database exists | 4096 bytes |
| ✅ | the private job is in the broker's database |  |
| ✅ | the answer is not (in the database or its WAL) |  |

## Step log

**preflight**

- run directory E:\Projects\xorv-monad-wt\cli\e2e\.runs\2026-09-26T19-16-20-294Z-Qz7RCD
- forking https://testnet-rpc.monad.xyz at its latest block

**start the mock OpenAI-compatible model server**

- listening on http://127.0.0.1:1269 (/qwen/v1, /kimi/v1, /hunyuan/v1)

**fork Monad testnet (Hardhat 3 / EDR, chain id 10143)**

- serving http://127.0.0.1:1270, forked at block 65929744

**fund the parties**

- minted 5.00 USDC through the token's masterMinter 0x87f2e95621D8f12b83bb4a3E9975c0eAd524D437 (configureMinter 0xc7c3eed3f6779862b27428f97e8220d36cdc1f21245e3852ea99c09f38c0cd20, mint 0x9826fef70a13156e9c035edbd2251989b4b196544b241e43779b985333c5f06c)

**deploy XorvLedger with packages/contracts' deploy script**

- XorvLedger at 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (block 65929747, tx 0x99916ccda93ab05de3782a6d00bfbe3b3f5b66094c7cdddfe1f8f55862d9ba2d)

**start the broker (services/broker, self-hosted facilitator, AI roles on the mock)**

- listening on http://127.0.0.1:27774

**provider: register an ERC-8004 identity (xorv identity register)**

- registered as agent #1933

**provider: go live (xorv start)**

- provider prv_dKXOdVrQcw03 connected, agent #1933
- ProviderRegistered in 0x47f5d1814c9a57158f13820b6e90d60ecaca015236d8afae0208805ecc766a35

**Hunyuan screen refuses an abusive prompt before any quote**

- the safety screen refused this prompt: asks the agent to read and send out the provider's keys

**buyer: xorv run --json (Qwen routes, x402 pays, qwen adapter answers)**

- job job_N0MhWxuTpyR0 completed in 3.1s; paid in 0x661ed22287ad37bfb1234beb55f758eb34251b92005cfe7068eea5fc80bb8d98

**Kimi verifies the result and writes ERC-8004 feedback**

- score 92/100 by kimi-k3; giveFeedback 0x3986add361aae063a53bd03ba3f3f62546d653b95362ffe131224ae90bd3c516

**buyer rates the job through the broker API (EIP-712, gasless)**

- rateJob relayed in 0xbfbc9e0ec255d90c42c7eeaa398ebf3867aa295e575f09e8315d9a4f490ef339

**agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job)**

- job job_40JiX_m_XZnS
- Relayed on-chain: https://testnet.monadscan.com/tx/0x59594fc108cce2aa5f7fccad9c0eeecfecd07e2fef82a287c4093ffb084d5dc5

**private job through the broker API (sealed to the buyer's inbox key)**

- job job_XmJZZ1o_PZoZ completed; settlement 0x19c327681dfc9347406f870fd3ab880b65df514ef0dce13823782a893294fe53
- receipt 0xf460f42197d5a44edcc2cafb3a43aa7faef9c0ac524c1072f6bdcb531b6bfb32

**on-chain: x402 settlements (real USDC, facilitator pays gas)**

- cli: 0x661ed22287ad37bfb1234beb55f758eb34251b92005cfe7068eea5fc80bb8d98 — 40000 0x448bb5458912C227026DB2642500770F312465EA→0x19957eF079d30419Fc65fD355D572b3E296eab42; gas 102808
- mcp: 0x1f1ead2f5c52283abf5f7d7426f3b9921529c2a9ae5f4b1b0e93a2db85855a00 — 1000 0x448bb5458912C227026DB2642500770F312465EA→0x19957eF079d30419Fc65fD355D572b3E296eab42; gas 85716
- private: 0x19c327681dfc9347406f870fd3ab880b65df514ef0dce13823782a893294fe53 — 40000 0x448bb5458912C227026DB2642500770F312465EA→0x19957eF079d30419Fc65fD355D572b3E296eab42; gas 85716

**on-chain: XorvLedger events**

- 1 ProviderRegistered, 1 ProviderHeartbeat, 3 JobRecorded, 2 JobRated

**on-chain: ERC-8004 reputation (canonical Reputation Registry)**

- xorv-verified/qwen 92 from 0x79eA4B61CC9e924F49500B8f3803c80Ba9023Eb8 (0x3986add361aae063a53bd03ba3f3f62546d653b95362ffe131224ae90bd3c516); starred/qwen 87 from 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (0xbfbc9e0ec255d90c42c7eeaa398ebf3867aa295e575f09e8315d9a4f490ef339); xorv-verified/echo 92 from 0x79eA4B61CC9e924F49500B8f3803c80Ba9023Eb8 (0x58377c17f2099c1ed8a51157b68cf54f5dc3780ff3be5a7a6b5d17a140f55769); starred/echo 64 from 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (0x59594fc108cce2aa5f7fccad9c0eeecfecd07e2fef82a287c4093ffb084d5dc5)

**the broker's own views agree with the chain**

- /api/ledger?kind=receipts: 3 receipts from rpc
