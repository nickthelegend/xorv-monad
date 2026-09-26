# Xorv end-to-end run

**PASS** — 188/188 checks, 22 steps, 119.4 s. Started 2026-09-26T19:46:20.355Z.

Produced by `pnpm e2e` (see [README.md](README.md)). Every value below was read back from the
forked chain or the running processes during the run; transaction hashes are local to that fork.

## Environment

| | |
|---|---|
| node | v22.21.1 |
| platform | win32 10.0.22631 |
| duration | 119.4 s |
| logs | (removed after a passing run) |

## Parties

| | |
|---|---|
| operator (broker EOA: ledger writes, rating relay, Kimi feedback) | `0x13327F9Da33fb2B63af3DC53b94cC69Eb8cFc5ee` |
| facilitator (submits EIP-3009 authorizations, pays settlement gas) | `0x9Fe091dfBFe24Cf8E4Cd327E1501E4618897B18c` |
| provider (payout address = ERC-8004 agent wallet) | `0x7a30a2C8d3268b91210b3Ab3450b34c850b7edD0` |
| buyer (USDC only, no MON) | `0x1D2766b2Ac334c53D12f1F0FEF3C3590c8e53781` |
| provider ERC-8004 agent id | 1933 |
| provider id (broker) | prv_PFVTluV4j_wR |

## Chain

| | |
|---|---|
| fork RPC | http://127.0.0.1:33684 |
| forked from | https://testnet-rpc.monad.xyz at block 65935337 |
| chain id | 10143 |
| USDC (Circle FiatToken, forked) | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| ERC-8004 Identity Registry (forked) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation Registry (forked) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| buyer USDC funding | minted via masterMinter 0x87f2e95621D8f12b83bb4a3E9975c0eAd524D437 |
| XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| XorvLedger deploy tx | `0xabbd3d107f2bf34fe153e29a389fb596ba2cf95ab1014e5bc846c3d5c1f0fb16` |

## Processes

| | |
|---|---|
| broker | http://127.0.0.1:52563 |

## Jobs

| | |
|---|---|
| CLI job | job_AY_-opH1Aq2X |
| MCP job | job_Y3U08ShK-l80 |
| private job | job_Rn5OjM4BdpYJ |

## Transactions

| | |
|---|---|
| cli job settlement | `0x81148fb27318915a0ad34cf715e298cc08d62e3c82e31c64dfe0710bc114f84e` |
| mcp job settlement | `0xdd575b48947b4bf7969b080447a29b1879b0e8f1ced9b3bc46260e8581a1f41f` |
| private job settlement | `0xdfbafb835dc64334d56dd6a28c570537efda307c1451e1643236b08943cba041` |
| ProviderRegistered | `0x27dba75a6f63cf4164b5a63adeb841fc3213d0740bc7f04968ae69f8437738fe` |
| cli job receipt (JobRecorded) | `0x09e63c6b70860bc3742c8f1e16f8cd35b9b01c9d6ba3bd074b76bb5a62fdd7a5` |
| mcp job receipt (JobRecorded) | `0x5570319fdd7d1ca9578d288bdac5b872f5ab1b26b2ad58b631c8ebdf22143298` |
| private job receipt (JobRecorded) | `0x7d3fc6d3b0b1434fb04482c4681647683e0734d31338d82001f348db3e94b6ba` |
| cli job rating (JobRated) | `0x98e71e9d5efe51918ce680257a1a63fa5cbc7ae895cd41d8d8d646a9981dd6bb` |
| mcp job rating (JobRated) | `0x916c216d6c4b0667b75642ef43c0353506ada9f719553792bfc6346fb00f7587` |
| cli job Kimi feedback (NewFeedback) | `0xacc0cfdabafae307bafee48ed59cc7aaf0b49fb16617358de7dcd3941a9088c1` |
| mcp job Kimi feedback (NewFeedback) | `0xa0422f577ae3decaca0167333f0e0d218e68b791f72f98fa5fd6f10ab67c9afa` |
| cli job rating (NewFeedback) | `0x98e71e9d5efe51918ce680257a1a63fa5cbc7ae895cd41d8d8d646a9981dd6bb` |
| mcp job rating (NewFeedback) | `0x916c216d6c4b0667b75642ef43c0353506ada9f719553792bfc6346fb00f7587` |

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
| 1 | preflight | 0.0 s | ok |
| 2 | start the mock OpenAI-compatible model server | 0.0 s | ok |
| 3 | fork Monad testnet (Hardhat 3 / EDR, chain id 10143) | 30.9 s | ok |
| 4 | check the forked contracts are the real ones | 9.5 s | ok |
| 5 | fund the parties | 3.9 s | ok |
| 6 | deploy XorvLedger with packages/contracts' deploy script | 10.9 s | ok |
| 7 | start the broker (services/broker, self-hosted facilitator, AI roles on the mock) | 12.6 s | ok |
| 8 | provider: register an ERC-8004 identity (xorv identity register) | 8.6 s | ok |
| 9 | provider: go live (xorv start) | 4.2 s | ok |
| 10 | Hunyuan screen refuses an abusive prompt before any quote | 0.0 s | ok |
| 11 | buyer: xorv run --json (Qwen routes, x402 pays, qwen adapter answers) | 9.2 s | ok |
| 12 | Kimi verifies the result and writes ERC-8004 feedback | 0.0 s | ok |
| 13 | buyer rates the job through the broker API (EIP-712, gasless) | 1.7 s | ok |
| 14 | agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job) | 19.1 s | ok |
| 15 | private job through the broker API (sealed to the buyer's inbox key) | 2.0 s | ok |
| 16 | on-chain: x402 settlements (real USDC, facilitator pays gas) | 0.0 s | ok |
| 17 | on-chain: XorvLedger events | 0.0 s | ok |
| 18 | on-chain: ERC-8004 reputation (canonical Reputation Registry) | 0.0 s | ok |
| 19 | the broker's own views agree with the chain | 0.0 s | ok |
| 20 | the provider's own log is a record of its jobs | 0.0 s | ok |
| 21 | provider: xorv identity show and xorv earnings agree with the chain | 5.4 s | ok |
| 22 | the private answer never touched the broker's disk | 0.0 s | ok |

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
| ✅ | ledger.broker() is the operator | `0x13327F9Da33fb2B63af3DC53b94cC69Eb8cFc5ee` |

### Start the broker (services/broker, self-hosted facilitator, AI roles on the mock)

| | Check | Detail |
|---|---|---|
| ✅ | broker network | eip155:10143 |
| ✅ | broker chain id | 10143 |
| ✅ | broker prices in the forked USDC | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| ✅ | facilitator is self-hosted | self |
| ✅ | facilitator EOA | `0x9Fe091dfBFe24Cf8E4Cd327E1501E4618897B18c` |
| ✅ | payments are available | true |
| ✅ | ledger address | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | ledger mode | write |
| ✅ | screener | hunyuan |
| ✅ | router | qwen |
| ✅ | verifier | kimi |
| ✅ | verifier writes ERC-8004 feedback from the operator | `0x13327F9Da33fb2B63af3DC53b94cC69Eb8cFc5ee` |

### Provider: register an ERC-8004 identity (xorv identity register)

| | Check | Detail |
|---|---|---|
| ✅ | agent owner is the provider's payout address | `0x7a30a2C8d3268b91210b3Ab3450b34c850b7edD0` |
| ✅ | agent wallet is the provider's payout address | `0x7a30a2C8d3268b91210b3Ab3450b34c850b7edD0` |
| ✅ | agentURI is the broker's registration file | http://127.0.0.1:52563/agents/e2e-node-9a00htn6.json |

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
| ✅ | payer is the buyer | `0x1D2766b2Ac334c53D12f1F0FEF3C3590c8e53781` |
| ✅ | screened by Hunyuan and allowed | hunyuan:allow |
| ✅ | routed by Qwen | qwen |
| ✅ | router's pick (over the cheaper echo) is the quoted adapter | qwen/qwen |
| ✅ | quote freezes $0.04 = 40000 USDC units | 40000 |
| ✅ | payTo is the provider, not the broker | `0x7a30a2C8d3268b91210b3Ab3450b34c850b7edD0` |
| ✅ | result came from the provider's qwen adapter (mock answer token) | ans-ad7928998a58682de026 |
| ✅ | resultHash = keccak256(result) | `0x4110531d1f527c15f5a29868cb735e7f01f776ccfe1b18a39805425a7aed352f` |
| ✅ | settlement tx reported | `0x81148fb27318915a0ad34cf715e298cc08d62e3c82e31c64dfe0710bc114f84e` |
| ✅ | XorvLedger receipt tx reported | `0x09e63c6b70860bc3742c8f1e16f8cd35b9b01c9d6ba3bd074b76bb5a62fdd7a5` |

### Kimi verifies the result and writes ERC-8004 feedback

| | Check | Detail |
|---|---|---|
| ✅ | verified by Kimi | kimi |
| ✅ | verification score | 92 |

### Buyer rates the job through the broker API (EIP-712, gasless)

| | Check | Detail |
|---|---|---|
| ✅ | rating signer is the payer | `0x1D2766b2Ac334c53D12f1F0FEF3C3590c8e53781` |
| ✅ | rating is for the provider's agent | 1933 |
| ✅ | typed data domain is this XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | a stranger's signature is refused | 401 |
| ✅ | served feedback file hashes to the committed feedbackHash | `0x9b0c34b3bda52c78e180b316af000b46a62f77e9652e17a3ebee778ea082553d` |

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
| ✅ | the buyer's inbox key opens it to the provider's answer | ans-de756b795165a56d492e |
| ✅ | another inbox key cannot open it | DECRYPT_FAILED |
| ✅ | it is bound to its job id | DECRYPT_FAILED |
| ✅ | the plaintext answer is nowhere in the broker's API |  |
| ✅ | the plaintext answer never reached the Kimi verifier |  |
| ✅ | the private job was not verified (no readable result) |  |
| ✅ | resultHash commits to the envelope | `0x9e0680b8e1f6c0332ea071160d9d4afb70ecf205c6820cf789a6960433f340a0` |

### On-chain: x402 settlements (real USDC, facilitator pays gas)

| | Check | Detail |
|---|---|---|
| ✅ | cli: settlement succeeded | success |
| ✅ | cli: sent (and gas paid) by the facilitator | `0x9Fe091dfBFe24Cf8E4Cd327E1501E4618897B18c` |
| ✅ | cli: USDC Transfer buyer → provider for exactly 40000 | 0x1D2766b2Ac334c53D12f1F0FEF3C3590c8e53781→0x7a30a2C8d3268b91210b3Ab3450b34c850b7edD0 40000 |
| ✅ | cli: EIP-3009 authorization used by the buyer |  |
| ✅ | cli: job.payment.amount | 40000 |
| ✅ | mcp: settlement succeeded | success |
| ✅ | mcp: sent (and gas paid) by the facilitator | `0x9Fe091dfBFe24Cf8E4Cd327E1501E4618897B18c` |
| ✅ | mcp: USDC Transfer buyer → provider for exactly 1000 | 0x1D2766b2Ac334c53D12f1F0FEF3C3590c8e53781→0x7a30a2C8d3268b91210b3Ab3450b34c850b7edD0 1000 |
| ✅ | mcp: EIP-3009 authorization used by the buyer |  |
| ✅ | mcp: job.payment.amount | 1000 |
| ✅ | private: settlement succeeded | success |
| ✅ | private: sent (and gas paid) by the facilitator | `0x9Fe091dfBFe24Cf8E4Cd327E1501E4618897B18c` |
| ✅ | private: USDC Transfer buyer → provider for exactly 40000 | 0x1D2766b2Ac334c53D12f1F0FEF3C3590c8e53781→0x7a30a2C8d3268b91210b3Ab3450b34c850b7edD0 40000 |
| ✅ | private: EIP-3009 authorization used by the buyer |  |
| ✅ | private: job.payment.amount | 40000 |
| ✅ | buyer USDC balance | 4919000 |
| ✅ | provider USDC balance | 81000 |
| ✅ | buyer spent no MON (still zero) | 0 |
| ✅ | buyer never sent a transaction (nonce 0) | 0 |

### On-chain: XorvLedger events

| | Check | Detail |
|---|---|---|
| ✅ | ProviderRegistered for the provider | `0x27dba75a6f63cf4164b5a63adeb841fc3213d0740bc7f04968ae69f8437738fe` |
| ✅ | ProviderRegistered.payTo | `0x7a30a2C8d3268b91210b3Ab3450b34c850b7edD0` |
| ✅ | ProviderRegistered.agentId | 1933 |
| ✅ | ProviderRegistered.label | e2e-provider |
| ✅ | ProviderRegistered.capabilities | echo:1000,qwen:40000 |
| ✅ | a sampled ProviderHeartbeat was published | `0xdb6add3e307ca4765d8f6f1468adfb8353d06a6bf93d58520fc09417f6785c41` |
| ✅ | cli: JobRecorded | `0x09e63c6b70860bc3742c8f1e16f8cd35b9b01c9d6ba3bd074b76bb5a62fdd7a5` |
| ✅ | cli: JobRecorded.agentId | 1933 |
| ✅ | cli: JobRecorded.buyer | `0x1D2766b2Ac334c53D12f1F0FEF3C3590c8e53781` |
| ✅ | cli: JobRecorded.payTo | `0x7a30a2C8d3268b91210b3Ab3450b34c850b7edD0` |
| ✅ | cli: JobRecorded.amount | 40000 |
| ✅ | cli: JobRecorded.paymentTx is the settlement | `0x81148fb27318915a0ad34cf715e298cc08d62e3c82e31c64dfe0710bc114f84e` |
| ✅ | cli: JobRecorded.requestHash = keccak256(prompt) | `0x50a44f43e4781b69867181ef373268f488e1f405a1e9cc22d84e975efd231eb1` |
| ✅ | cli: JobRecorded.resultHash = keccak256(result) | `0x4110531d1f527c15f5a29868cb735e7f01f776ccfe1b18a39805425a7aed352f` |
| ✅ | cli: JobRecorded.ok | true |
| ✅ | cli: the broker's receiptTxHash is that transaction | `0x09e63c6b70860bc3742c8f1e16f8cd35b9b01c9d6ba3bd074b76bb5a62fdd7a5` |
| ✅ | mcp: JobRecorded | `0x5570319fdd7d1ca9578d288bdac5b872f5ab1b26b2ad58b631c8ebdf22143298` |
| ✅ | mcp: JobRecorded.agentId | 1933 |
| ✅ | mcp: JobRecorded.buyer | `0x1D2766b2Ac334c53D12f1F0FEF3C3590c8e53781` |
| ✅ | mcp: JobRecorded.payTo | `0x7a30a2C8d3268b91210b3Ab3450b34c850b7edD0` |
| ✅ | mcp: JobRecorded.amount | 1000 |
| ✅ | mcp: JobRecorded.paymentTx is the settlement | `0xdd575b48947b4bf7969b080447a29b1879b0e8f1ced9b3bc46260e8581a1f41f` |
| ✅ | mcp: JobRecorded.requestHash = keccak256(prompt) | `0x6a10c25d5acd75310ea6f02ff41268047141fd971a6a25c34cb1ee8740e282dc` |
| ✅ | mcp: JobRecorded.resultHash = keccak256(result) | `0x6e1f47c402cf0332818c0b56e170264cf748f7ee81c5a6289b7ce0e63a50958c` |
| ✅ | mcp: JobRecorded.ok | true |
| ✅ | mcp: the broker's receiptTxHash is that transaction | `0x5570319fdd7d1ca9578d288bdac5b872f5ab1b26b2ad58b631c8ebdf22143298` |
| ✅ | private: JobRecorded | `0x7d3fc6d3b0b1434fb04482c4681647683e0734d31338d82001f348db3e94b6ba` |
| ✅ | private: JobRecorded.agentId | 1933 |
| ✅ | private: JobRecorded.buyer | `0x1D2766b2Ac334c53D12f1F0FEF3C3590c8e53781` |
| ✅ | private: JobRecorded.payTo | `0x7a30a2C8d3268b91210b3Ab3450b34c850b7edD0` |
| ✅ | private: JobRecorded.amount | 40000 |
| ✅ | private: JobRecorded.paymentTx is the settlement | `0xdfbafb835dc64334d56dd6a28c570537efda307c1451e1643236b08943cba041` |
| ✅ | private: JobRecorded.requestHash = keccak256(prompt) | `0x34107b3171978d59af17ef0dca5d405c0941af3e10b9cbba101fca631e5a6cd4` |
| ✅ | private: JobRecorded.resultHash = keccak256(result) | `0x9e0680b8e1f6c0332ea071160d9d4afb70ecf205c6820cf789a6960433f340a0` |
| ✅ | private: JobRecorded.ok | true |
| ✅ | private: the broker's receiptTxHash is that transaction | `0x7d3fc6d3b0b1434fb04482c4681647683e0734d31338d82001f348db3e94b6ba` |
| ✅ | private: the on-chain resultHash is keccak256 of the sealed envelope | `0x9e0680b8e1f6c0332ea071160d9d4afb70ecf205c6820cf789a6960433f340a0` |
| ✅ | cli: JobRated | `0x98e71e9d5efe51918ce680257a1a63fa5cbc7ae895cd41d8d8d646a9981dd6bb` |
| ✅ | cli: JobRated.value | 87 |
| ✅ | cli: JobRated.buyer | `0x1D2766b2Ac334c53D12f1F0FEF3C3590c8e53781` |
| ✅ | cli: JobRated.agentId | 1933 |
| ✅ | cli: ledger.jobs() marks it rated |  |
| ✅ | mcp: JobRated | `0x916c216d6c4b0667b75642ef43c0353506ada9f719553792bfc6346fb00f7587` |
| ✅ | mcp: JobRated.value | 64 |
| ✅ | mcp: JobRated.buyer | `0x1D2766b2Ac334c53D12f1F0FEF3C3590c8e53781` |
| ✅ | mcp: JobRated.agentId | 1933 |
| ✅ | mcp: ledger.jobs() marks it rated |  |
| ✅ | cli: the relay tx the broker returned is the JobRated tx | `0x98e71e9d5efe51918ce680257a1a63fa5cbc7ae895cd41d8d8d646a9981dd6bb` |
| ✅ | private: not rated |  |

### On-chain: ERC-8004 reputation (canonical Reputation Registry)

| | Check | Detail |
|---|---|---|
| ✅ | cli: Kimi's NewFeedback (tag1 "xorv-verified") | `0xacc0cfdabafae307bafee48ed59cc7aaf0b49fb16617358de7dcd3941a9088c1` |
| ✅ | cli: verifier feedback client is the verifier EOA | `0x13327F9Da33fb2B63af3DC53b94cC69Eb8cFc5ee` |
| ✅ | cli: verifier feedback value | 92 |
| ✅ | cli: verifier feedback tag2 is the adapter | qwen |
| ✅ | cli: verifier feedbackURI | http://127.0.0.1:52563/verifications/job_AY_-opH1Aq2X.json |
| ✅ | cli: served verification file hashes to the on-chain feedbackHash | `0x8a5fd1e9f8c1023ff8bd476ca09033478376d845c48b209a152c66e4c029d5ca` |
| ✅ | mcp: Kimi's NewFeedback (tag1 "xorv-verified") | `0xa0422f577ae3decaca0167333f0e0d218e68b791f72f98fa5fd6f10ab67c9afa` |
| ✅ | mcp: verifier feedback client is the verifier EOA | `0x13327F9Da33fb2B63af3DC53b94cC69Eb8cFc5ee` |
| ✅ | mcp: verifier feedback value | 92 |
| ✅ | mcp: verifier feedback tag2 is the adapter | echo |
| ✅ | mcp: verifier feedbackURI | http://127.0.0.1:52563/verifications/job_Y3U08ShK-l80.json |
| ✅ | mcp: served verification file hashes to the on-chain feedbackHash | `0x974dd5eb1a8328b6bc98033db57dc6b1d9d29d1d9b0e6e775d57e19ac5bdc568` |
| ✅ | private: no verifier feedback | 2 xorv-verified entries |
| ✅ | cli: the buyer's rating as NewFeedback (tag1 "starred") | `0x98e71e9d5efe51918ce680257a1a63fa5cbc7ae895cd41d8d8d646a9981dd6bb` |
| ✅ | cli: rating feedback client is XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | cli: rating feedback value | 87 |
| ✅ | cli: rating endpoint is the broker's jobs service | http://127.0.0.1:52563/api/quotes |
| ✅ | cli: served feedback file hashes to the on-chain feedbackHash | `0x9b0c34b3bda52c78e180b316af000b46a62f77e9652e17a3ebee778ea082553d` |
| ✅ | mcp: the buyer's rating as NewFeedback (tag1 "starred") | `0x916c216d6c4b0667b75642ef43c0353506ada9f719553792bfc6346fb00f7587` |
| ✅ | mcp: rating feedback client is XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | mcp: rating feedback value | 64 |
| ✅ | mcp: rating endpoint is the broker's jobs service | http://127.0.0.1:52563/api/quotes |
| ✅ | mcp: served feedback file hashes to the on-chain feedbackHash | `0xe9f87bdbe262da237d4af982cf376f148da1f8c5de259cc7ca3c69f1dac039d3` |
| ✅ | cli: rating feedbackHash is what the buyer signed | `0x9b0c34b3bda52c78e180b316af000b46a62f77e9652e17a3ebee778ea082553d` |
| ✅ | getSummary([ledger], "starred").count | 2 |
| ✅ | getSummary([ledger], "starred") is the registry's mean of those NewFeedback values | 75 (0 decimals) |
| ✅ | getSummary([verifier], "xorv-verified").count | 2 |
| ✅ | getSummary([verifier], "xorv-verified") is the registry's mean of those NewFeedback values | 92 (0 decimals) |
| ✅ | getClients lists XorvLedger and the verifier | 0x13327F9Da33fb2B63af3DC53b94cC69Eb8cFc5ee, 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 |

### The broker's own views agree with the chain

| | Check | Detail |
|---|---|---|
| ✅ | ledger feed source (RPC scan of the fork) | rpc |
| ✅ | ledger feed links all three receipts to their jobs | job_Rn5OjM4BdpYJ, job_Y3U08ShK-l80, job_AY_-opH1Aq2X |
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

### Provider: xorv identity show and xorv earnings agree with the chain

| | Check | Detail |
|---|---|---|
| ✅ | identity show exits 0 | 0 |
| ✅ | identity show: agent id | 1933 |
| ✅ | identity show: owner and agent wallet are the payout address |  |
| ✅ | earnings exits 0 | 0 |
| ✅ | earnings: cli job recorded as ok | 40000 units |
| ✅ | earnings: cli amount is the settled USDC | 40000 |
| ✅ | earnings: cli carries its settlement tx | `0x81148fb27318915a0ad34cf715e298cc08d62e3c82e31c64dfe0710bc114f84e` |
| ✅ | earnings: mcp job recorded as ok | 1000 units |
| ✅ | earnings: mcp amount is the settled USDC | 1000 |
| ✅ | earnings: mcp carries its settlement tx | `0xdd575b48947b4bf7969b080447a29b1879b0e8f1ced9b3bc46260e8581a1f41f` |
| ✅ | earnings: private job recorded as ok | 40000 units |
| ✅ | earnings: private amount is the settled USDC | 40000 |
| ✅ | earnings: private carries its settlement tx | `0xdfbafb835dc64334d56dd6a28c570537efda307c1451e1643236b08943cba041` |
| ✅ | earnings total is the provider's on-chain USDC balance | 81000 |

### The private answer never touched the broker's disk

| | Check | Detail |
|---|---|---|
| ✅ | broker database exists | 4096 bytes |
| ✅ | the private job is in the broker's database |  |
| ✅ | the answer is not (in the database or its WAL) |  |

## Step log

**preflight**

- run directory E:\Projects\xorv-monad-wt\cli\e2e\.runs\2026-09-26T19-46-20-362Z-4lwaJ8
- forking https://testnet-rpc.monad.xyz at its latest block

**start the mock OpenAI-compatible model server**

- listening on http://127.0.0.1:33682 (/qwen/v1, /kimi/v1, /hunyuan/v1)

**fork Monad testnet (Hardhat 3 / EDR, chain id 10143)**

- serving http://127.0.0.1:33684, forked at block 65935337

**fund the parties**

- minted 5.00 USDC through the token's masterMinter 0x87f2e95621D8f12b83bb4a3E9975c0eAd524D437 (configureMinter 0xe51bac25a077bb66266da7bdde5317fe571a14fc7208204d80149e5821daa712, mint 0xc142f7a2aa946693e54fbf24ceb7bf4467989ecd084e2d71a1128869021fa700)

**deploy XorvLedger with packages/contracts' deploy script**

- XorvLedger at 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (block 65935340, tx 0xabbd3d107f2bf34fe153e29a389fb596ba2cf95ab1014e5bc846c3d5c1f0fb16)

**start the broker (services/broker, self-hosted facilitator, AI roles on the mock)**

- listening on http://127.0.0.1:52563

**provider: register an ERC-8004 identity (xorv identity register)**

- registered as agent #1933

**provider: go live (xorv start)**

- provider prv_PFVTluV4j_wR connected, agent #1933
- ProviderRegistered in 0x27dba75a6f63cf4164b5a63adeb841fc3213d0740bc7f04968ae69f8437738fe

**Hunyuan screen refuses an abusive prompt before any quote**

- the safety screen refused this prompt: asks the agent to read and send out the provider's keys

**buyer: xorv run --json (Qwen routes, x402 pays, qwen adapter answers)**

- job job_AY_-opH1Aq2X completed in 4.1s; paid in 0x81148fb27318915a0ad34cf715e298cc08d62e3c82e31c64dfe0710bc114f84e

**Kimi verifies the result and writes ERC-8004 feedback**

- score 92/100 by kimi-k3; giveFeedback 0xacc0cfdabafae307bafee48ed59cc7aaf0b49fb16617358de7dcd3941a9088c1

**buyer rates the job through the broker API (EIP-712, gasless)**

- rateJob relayed in 0x98e71e9d5efe51918ce680257a1a63fa5cbc7ae895cd41d8d8d646a9981dd6bb

**agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job)**

- job job_Y3U08ShK-l80
- Relayed on-chain: https://testnet.monadscan.com/tx/0x916c216d6c4b0667b75642ef43c0353506ada9f719553792bfc6346fb00f7587

**private job through the broker API (sealed to the buyer's inbox key)**

- job job_Rn5OjM4BdpYJ completed; settlement 0xdfbafb835dc64334d56dd6a28c570537efda307c1451e1643236b08943cba041
- receipt 0x7d3fc6d3b0b1434fb04482c4681647683e0734d31338d82001f348db3e94b6ba

**on-chain: x402 settlements (real USDC, facilitator pays gas)**

- cli: 0x81148fb27318915a0ad34cf715e298cc08d62e3c82e31c64dfe0710bc114f84e — 40000 0x1D2766b2Ac334c53D12f1F0FEF3C3590c8e53781→0x7a30a2C8d3268b91210b3Ab3450b34c850b7edD0; gas 102820
- mcp: 0xdd575b48947b4bf7969b080447a29b1879b0e8f1ced9b3bc46260e8581a1f41f — 1000 0x1D2766b2Ac334c53D12f1F0FEF3C3590c8e53781→0x7a30a2C8d3268b91210b3Ab3450b34c850b7edD0; gas 85740
- private: 0xdfbafb835dc64334d56dd6a28c570537efda307c1451e1643236b08943cba041 — 40000 0x1D2766b2Ac334c53D12f1F0FEF3C3590c8e53781→0x7a30a2C8d3268b91210b3Ab3450b34c850b7edD0; gas 85728

**on-chain: XorvLedger events**

- 1 ProviderRegistered, 1 ProviderHeartbeat, 3 JobRecorded, 2 JobRated

**on-chain: ERC-8004 reputation (canonical Reputation Registry)**

- xorv-verified/qwen 92 from 0x13327F9Da33fb2B63af3DC53b94cC69Eb8cFc5ee (0xacc0cfdabafae307bafee48ed59cc7aaf0b49fb16617358de7dcd3941a9088c1); starred/qwen 87 from 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (0x98e71e9d5efe51918ce680257a1a63fa5cbc7ae895cd41d8d8d646a9981dd6bb); xorv-verified/echo 92 from 0x13327F9Da33fb2B63af3DC53b94cC69Eb8cFc5ee (0xa0422f577ae3decaca0167333f0e0d218e68b791f72f98fa5fd6f10ab67c9afa); starred/echo 64 from 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (0x916c216d6c4b0667b75642ef43c0353506ada9f719553792bfc6346fb00f7587)

**the broker's own views agree with the chain**

- /api/ledger?kind=receipts: 3 receipts from rpc
