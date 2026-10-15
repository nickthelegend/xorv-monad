# Xorv end-to-end run

**PASS** — 193/193 checks, 22 steps, 21.2 s. Started 2026-10-13T13:05:08.929Z.

Produced by `pnpm e2e` (see [README.md](README.md)). Every value below was read back from the
forked chain or the running processes during the run; transaction hashes are local to that fork.

## Environment

| | |
|---|---|
| node | v26.5.0 |
| platform | darwin 25.5.0 |
| duration | 21.2 s |
| logs | (removed after a passing run) |

## Parties

| | |
|---|---|
| operator (broker EOA: ledger writes, rating relay, Kimi feedback) | `0x0b7bff77617d5C96c7fca08E4001453F33F604b6` |
| facilitator (submits EIP-3009 authorizations, pays settlement gas) | `0xb8215261f87c685D58E8bcAEB2d3EC3b7CA8f53d` |
| provider (payout address = ERC-8004 agent wallet) | `0x9C659239313B82657fd4865e896E33ebf3C29179` |
| buyer (USDC only, no MON) | `0xaB2AC33Ea1Bc58F2Dd77f0E7247FF3B92A8522a7` |
| provider ERC-8004 agent id | 2276 |
| provider id (broker) | prv_jVgz0qKGJWk0 |

## Chain

| | |
|---|---|
| fork RPC | http://127.0.0.1:61155 |
| forked from | https://testnet-rpc.monad.xyz at block 70688914 |
| chain id | 10143 |
| USDC (Circle FiatToken, forked) | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| ERC-8004 Identity Registry (forked) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation Registry (forked) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| buyer USDC funding | minted via masterMinter 0x87f2e95621D8f12b83bb4a3E9975c0eAd524D437 |
| XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| XorvLedger deploy tx | `0xe094059d6e8f3d6cb45c2d9c406dc156b2e1c35a91f9111df89a5d957540fa17` |

## Processes

| | |
|---|---|
| broker | http://127.0.0.1:61170 |

## Jobs

| | |
|---|---|
| CLI job | job__0k-ZPaXrKwk |
| MCP job | job_2K6HCxpBXaJU |
| private job | job_CrqqdMGQF7PZ |

## Transactions

| | |
|---|---|
| cli job settlement | `0x0859ec88fe89a02c5b2d3c2c9fc66943ed2d50edf17a70322d601ad1a4d89376` |
| mcp job settlement | `0xa2c2277843115a2f800cbc65a36c0f895b0435456af0e845a140d027d883a41b` |
| private job settlement | `0x8acb29ffd42b9f9c776d196db06fc06cbd0303afeb4e735029efedff3e052d31` |
| ProviderRegistered | `0x6332e552b331fbdbd2dc79e5f245578eb5aea78f7acfb7964e97e546d01ce5f8` |
| cli job receipt (JobRecorded) | `0x26af037fcba472c13cb9cc1df65dc9d9cc6a3a2738f4722a04fc14a10942a8ce` |
| mcp job receipt (JobRecorded) | `0x35390f1f7049f038828d60e2883eec57c022095422e22eb3a58bf84e068f8868` |
| private job receipt (JobRecorded) | `0xbaa7141eaff56c847447a099f49d8a012f8ede7f74d9aa969ee931770fce05a9` |
| cli job rating (JobRated) | `0x0ac2beb8e80c5cab590630e20fdde5af467fdfb53f650486d69241b2d65cb37e` |
| mcp job rating (JobRated) | `0x3ccc5b0620e168b7012d1410cc2d62aca0cb07f32ad7b0b0f04f1f6f69a11345` |
| cli job Kimi feedback (NewFeedback) | `0x2fe0f112d034cb9b2a9c991a1ec1c602c57b42cefa1da606109aef72a70502d9` |
| mcp job Kimi feedback (NewFeedback) | `0xddd22a84519ea1ff1778c94f1d05b873451d9f73eb26e72e1fd63e979cfab25b` |
| cli job rating (NewFeedback) | `0x0ac2beb8e80c5cab590630e20fdde5af467fdfb53f650486d69241b2d65cb37e` |
| mcp job rating (NewFeedback) | `0x3ccc5b0620e168b7012d1410cc2d62aca0cb07f32ad7b0b0f04f1f6f69a11345` |

## AI roles (mock)

| | |
|---|---|
| Hunyuan screen calls | 4 |
| Qwen router calls | 3 |
| Kimi verifier calls | 2 |
| provider qwen adapter streams | 2 |

## Steps

| # | Step | Time | Result |
|---|---|---:|---|
| 1 | preflight | 0.0 s | ok |
| 2 | start the mock OpenAI-compatible model server | 0.0 s | ok |
| 3 | fork Monad testnet (Hardhat 3 / EDR, chain id 10143) | 2.4 s | ok |
| 4 | check the forked contracts are the real ones | 2.0 s | ok |
| 5 | fund the parties | 1.9 s | ok |
| 6 | deploy XorvLedger with packages/contracts' deploy script | 1.4 s | ok |
| 7 | start the broker (services/broker, self-hosted facilitator, AI roles on the mock) | 0.5 s | ok |
| 8 | provider: register an ERC-8004 identity (xorv identity register) | 2.1 s | ok |
| 9 | provider: go live (xorv start) | 0.5 s | ok |
| 10 | Hunyuan screen refuses an abusive prompt before any quote | 0.0 s | ok |
| 11 | buyer: xorv run --json (Qwen routes, x402 pays, qwen adapter answers) | 3.2 s | ok |
| 12 | Kimi verifies the result and writes ERC-8004 feedback | 0.0 s | ok |
| 13 | buyer rates the job through the broker API (EIP-712, gasless) | 1.1 s | ok |
| 14 | agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job) | 3.3 s | ok |
| 15 | private job through the broker API (sealed to the buyer's inbox key) | 1.9 s | ok |
| 16 | on-chain: x402 settlements (real USDC, facilitator pays gas) | 0.0 s | ok |
| 17 | on-chain: XorvLedger events | 0.0 s | ok |
| 18 | on-chain: ERC-8004 reputation (canonical Reputation Registry) | 0.0 s | ok |
| 19 | the broker's own views agree with the chain | 0.0 s | ok |
| 20 | the provider's own log is a record of its jobs | 0.0 s | ok |
| 21 | provider: xorv identity show and xorv earnings agree with the chain | 0.7 s | ok |
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
| ✅ | ledger.broker() is the operator | `0x0b7bff77617d5C96c7fca08E4001453F33F604b6` |

### Start the broker (services/broker, self-hosted facilitator, AI roles on the mock)

| | Check | Detail |
|---|---|---|
| ✅ | broker network | eip155:10143 |
| ✅ | broker chain id | 10143 |
| ✅ | broker prices in the forked USDC | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| ✅ | facilitator is self-hosted | self |
| ✅ | facilitator EOA | `0xb8215261f87c685D58E8bcAEB2d3EC3b7CA8f53d` |
| ✅ | payments are available | true |
| ✅ | ledger address | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | ledger mode | write |
| ✅ | screener | hunyuan |
| ✅ | router | qwen |
| ✅ | verifier | kimi |
| ✅ | verifier writes ERC-8004 feedback from the operator | `0x0b7bff77617d5C96c7fca08E4001453F33F604b6` |

### Provider: register an ERC-8004 identity (xorv identity register)

| | Check | Detail |
|---|---|---|
| ✅ | agent owner is the provider's payout address | `0x9C659239313B82657fd4865e896E33ebf3C29179` |
| ✅ | agent wallet is the provider's payout address | `0x9C659239313B82657fd4865e896E33ebf3C29179` |
| ✅ | agentURI is the broker's registration file | http://127.0.0.1:61170/agents/prv_jVgz0qKGJWk0.json |
| ✅ | agentURI does not publish the node id | false |

### Provider: go live (xorv start)

| | Check | Detail |
|---|---|---|
| ✅ | provider id is the one the CLI put in the agent URI | prv_jVgz0qKGJWk0 |
| ✅ | broker verified the agent id against the Identity Registry | 2276 |
| ✅ | registration file names the agent | 2276 |
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
| ✅ | payer is the buyer | `0xaB2AC33Ea1Bc58F2Dd77f0E7247FF3B92A8522a7` |
| ✅ | screened by Hunyuan and allowed | hunyuan:allow |
| ✅ | routed by Qwen | qwen |
| ✅ | router's pick (over the cheaper echo) is the quoted adapter | qwen/qwen |
| ✅ | router picked the quoted provider | prv_jVgz0qKGJWk0 |
| ✅ | router's trace: listed candidates, read the provider, then selected | list_candidates → erc8004_reputation → recent_receipts → indexer_provider_stats → nansen_trust → select_provider |
| ✅ | quote freezes $0.04 = 40000 USDC units | 40000 |
| ✅ | payTo is the provider, not the broker | `0x9C659239313B82657fd4865e896E33ebf3C29179` |
| ✅ | result came from the provider's qwen adapter (mock answer token) | ans-bc83987ad31637a394ab |
| ✅ | resultHash = keccak256(result) | `0x0e3949010d35cfbfe3643841afbb7d838ad1e5a776cde4d96e28024bd8f976ed` |
| ✅ | settlement tx reported | `0x0859ec88fe89a02c5b2d3c2c9fc66943ed2d50edf17a70322d601ad1a4d89376` |
| ✅ | XorvLedger receipt tx reported | `0x26af037fcba472c13cb9cc1df65dc9d9cc6a3a2738f4722a04fc14a10942a8ce` |

### Kimi verifies the result and writes ERC-8004 feedback

| | Check | Detail |
|---|---|---|
| ✅ | verified by Kimi | kimi |
| ✅ | verification score | 92 |

### Buyer rates the job through the broker API (EIP-712, gasless)

| | Check | Detail |
|---|---|---|
| ✅ | rating signer is the payer | `0xaB2AC33Ea1Bc58F2Dd77f0E7247FF3B92A8522a7` |
| ✅ | rating is for the provider's agent | 2276 |
| ✅ | typed data domain is this XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | a stranger's signature is refused | 401 |
| ✅ | served feedback file hashes to the committed feedbackHash | `0x6aa799ca49e7aafde1d6b633a86b106e1e16d70d3dff0cb07b71f99692549c90` |

### Agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job)

| | Check | Detail |
|---|---|---|
| ✅ | MCP server lists xorv_run_job and xorv_rate_job | xorv_list_providers, xorv_network_status, xorv_quote, xorv_get_job, xorv_wallet, xorv_run_job, xorv_rate_job |
| ✅ | MCP result is the echo of the prompt |  |
| ✅ | MCP reports the XorvLedger receipt |  |
| ✅ | xorv_wallet shows the buyer's address and on-chain USDC balance | USDC: $4.96 |

### Private job through the broker API (sealed to the buyer's inbox key)

| | Check | Detail |
|---|---|---|
| ✅ | private job completed | completed |
| ✅ | job is flagged private | true |
| ✅ | prompt is redacted from the public job |  |
| ✅ | the broker holds a sealed envelope | alg x25519-hkdf-sha256-aes256gcm |
| ✅ | the buyer's inbox key opens it to the provider's answer | ans-2ef6e51afa8e94a2a46a |
| ✅ | another inbox key cannot open it | DECRYPT_FAILED |
| ✅ | it is bound to its job id | DECRYPT_FAILED |
| ✅ | the plaintext answer is nowhere in the broker's API |  |
| ✅ | the plaintext answer never reached the Kimi verifier |  |
| ✅ | the private job was not verified (no readable result) |  |
| ✅ | resultHash commits to the envelope | `0x5c2f6e2e28c8cb509b98ef1b7943c000e953902e71ac287e3f7b363daaeda348` |

### On-chain: x402 settlements (real USDC, facilitator pays gas)

| | Check | Detail |
|---|---|---|
| ✅ | cli: settlement succeeded | success |
| ✅ | cli: sent (and gas paid) by the facilitator | `0xb8215261f87c685D58E8bcAEB2d3EC3b7CA8f53d` |
| ✅ | cli: USDC Transfer buyer → provider for exactly 40000 | 0xaB2AC33Ea1Bc58F2Dd77f0E7247FF3B92A8522a7→0x9C659239313B82657fd4865e896E33ebf3C29179 40000 |
| ✅ | cli: EIP-3009 authorization used by the buyer |  |
| ✅ | cli: job.payment.amount | 40000 |
| ✅ | mcp: settlement succeeded | success |
| ✅ | mcp: sent (and gas paid) by the facilitator | `0xb8215261f87c685D58E8bcAEB2d3EC3b7CA8f53d` |
| ✅ | mcp: USDC Transfer buyer → provider for exactly 1000 | 0xaB2AC33Ea1Bc58F2Dd77f0E7247FF3B92A8522a7→0x9C659239313B82657fd4865e896E33ebf3C29179 1000 |
| ✅ | mcp: EIP-3009 authorization used by the buyer |  |
| ✅ | mcp: job.payment.amount | 1000 |
| ✅ | private: settlement succeeded | success |
| ✅ | private: sent (and gas paid) by the facilitator | `0xb8215261f87c685D58E8bcAEB2d3EC3b7CA8f53d` |
| ✅ | private: USDC Transfer buyer → provider for exactly 40000 | 0xaB2AC33Ea1Bc58F2Dd77f0E7247FF3B92A8522a7→0x9C659239313B82657fd4865e896E33ebf3C29179 40000 |
| ✅ | private: EIP-3009 authorization used by the buyer |  |
| ✅ | private: job.payment.amount | 40000 |
| ✅ | buyer USDC balance | 4919000 |
| ✅ | provider USDC balance | 81000 |
| ✅ | buyer spent no MON (still zero) | 0 |
| ✅ | buyer never sent a transaction (nonce 0) | 0 |

### On-chain: XorvLedger events

| | Check | Detail |
|---|---|---|
| ✅ | ProviderRegistered for the provider | `0x6332e552b331fbdbd2dc79e5f245578eb5aea78f7acfb7964e97e546d01ce5f8` |
| ✅ | ProviderRegistered.payTo | `0x9C659239313B82657fd4865e896E33ebf3C29179` |
| ✅ | ProviderRegistered.agentId | 2276 |
| ✅ | ProviderRegistered.label | e2e-provider |
| ✅ | ProviderRegistered.capabilities | echo:1000,qwen:40000 |
| ✅ | a sampled ProviderHeartbeat was published | `0x975b46d39e44e3e23151c25fa3d3f16ca983597fa3582b8104754d248a074088` |
| ✅ | cli: JobRecorded | `0x26af037fcba472c13cb9cc1df65dc9d9cc6a3a2738f4722a04fc14a10942a8ce` |
| ✅ | cli: JobRecorded.agentId | 2276 |
| ✅ | cli: JobRecorded.buyer | `0xaB2AC33Ea1Bc58F2Dd77f0E7247FF3B92A8522a7` |
| ✅ | cli: JobRecorded.payTo | `0x9C659239313B82657fd4865e896E33ebf3C29179` |
| ✅ | cli: JobRecorded.amount | 40000 |
| ✅ | cli: JobRecorded.paymentTx is the settlement | `0x0859ec88fe89a02c5b2d3c2c9fc66943ed2d50edf17a70322d601ad1a4d89376` |
| ✅ | cli: JobRecorded.requestHash = keccak256(prompt) | `0x6e1633dd537e76a213d5ab3acc252094e2698c108f083217cfb3704a1d71b6c0` |
| ✅ | cli: JobRecorded.resultHash = keccak256(result) | `0x0e3949010d35cfbfe3643841afbb7d838ad1e5a776cde4d96e28024bd8f976ed` |
| ✅ | cli: JobRecorded.ok | true |
| ✅ | cli: the broker's receiptTxHash is that transaction | `0x26af037fcba472c13cb9cc1df65dc9d9cc6a3a2738f4722a04fc14a10942a8ce` |
| ✅ | mcp: JobRecorded | `0x35390f1f7049f038828d60e2883eec57c022095422e22eb3a58bf84e068f8868` |
| ✅ | mcp: JobRecorded.agentId | 2276 |
| ✅ | mcp: JobRecorded.buyer | `0xaB2AC33Ea1Bc58F2Dd77f0E7247FF3B92A8522a7` |
| ✅ | mcp: JobRecorded.payTo | `0x9C659239313B82657fd4865e896E33ebf3C29179` |
| ✅ | mcp: JobRecorded.amount | 1000 |
| ✅ | mcp: JobRecorded.paymentTx is the settlement | `0xa2c2277843115a2f800cbc65a36c0f895b0435456af0e845a140d027d883a41b` |
| ✅ | mcp: JobRecorded.requestHash = keccak256(prompt) | `0xffbf065b72e6ed9ea159c9334c8613201e59dd0aac2554d94c68097f53ad0c6d` |
| ✅ | mcp: JobRecorded.resultHash = keccak256(result) | `0xd1f2cc99e3118d14bb86b0401178c0d445f5d31b740e17196d587d1d0588592a` |
| ✅ | mcp: JobRecorded.ok | true |
| ✅ | mcp: the broker's receiptTxHash is that transaction | `0x35390f1f7049f038828d60e2883eec57c022095422e22eb3a58bf84e068f8868` |
| ✅ | private: JobRecorded | `0xbaa7141eaff56c847447a099f49d8a012f8ede7f74d9aa969ee931770fce05a9` |
| ✅ | private: JobRecorded.agentId | 2276 |
| ✅ | private: JobRecorded.buyer | `0xaB2AC33Ea1Bc58F2Dd77f0E7247FF3B92A8522a7` |
| ✅ | private: JobRecorded.payTo | `0x9C659239313B82657fd4865e896E33ebf3C29179` |
| ✅ | private: JobRecorded.amount | 40000 |
| ✅ | private: JobRecorded.paymentTx is the settlement | `0x8acb29ffd42b9f9c776d196db06fc06cbd0303afeb4e735029efedff3e052d31` |
| ✅ | private: JobRecorded.requestHash = keccak256(prompt) | `0xdeafdfccbdffe975fb37875e99e22412ebcc9d545fac506d77ffb1cd95595b5c` |
| ✅ | private: JobRecorded.resultHash = keccak256(result) | `0x5c2f6e2e28c8cb509b98ef1b7943c000e953902e71ac287e3f7b363daaeda348` |
| ✅ | private: JobRecorded.ok | true |
| ✅ | private: the broker's receiptTxHash is that transaction | `0xbaa7141eaff56c847447a099f49d8a012f8ede7f74d9aa969ee931770fce05a9` |
| ✅ | private: the on-chain resultHash is keccak256 of the sealed envelope | `0x5c2f6e2e28c8cb509b98ef1b7943c000e953902e71ac287e3f7b363daaeda348` |
| ✅ | cli: JobRated | `0x0ac2beb8e80c5cab590630e20fdde5af467fdfb53f650486d69241b2d65cb37e` |
| ✅ | cli: JobRated.value | 87 |
| ✅ | cli: JobRated.buyer | `0xaB2AC33Ea1Bc58F2Dd77f0E7247FF3B92A8522a7` |
| ✅ | cli: JobRated.agentId | 2276 |
| ✅ | cli: ledger.jobs() marks it rated |  |
| ✅ | mcp: JobRated | `0x3ccc5b0620e168b7012d1410cc2d62aca0cb07f32ad7b0b0f04f1f6f69a11345` |
| ✅ | mcp: JobRated.value | 64 |
| ✅ | mcp: JobRated.buyer | `0xaB2AC33Ea1Bc58F2Dd77f0E7247FF3B92A8522a7` |
| ✅ | mcp: JobRated.agentId | 2276 |
| ✅ | mcp: ledger.jobs() marks it rated |  |
| ✅ | cli: the relay tx the broker returned is the JobRated tx | `0x0ac2beb8e80c5cab590630e20fdde5af467fdfb53f650486d69241b2d65cb37e` |
| ✅ | private: not rated |  |

### On-chain: ERC-8004 reputation (canonical Reputation Registry)

| | Check | Detail |
|---|---|---|
| ✅ | cli: Kimi's NewFeedback (tag1 "xorv-verified") | `0x2fe0f112d034cb9b2a9c991a1ec1c602c57b42cefa1da606109aef72a70502d9` |
| ✅ | cli: verifier feedback client is the verifier EOA | `0x0b7bff77617d5C96c7fca08E4001453F33F604b6` |
| ✅ | cli: verifier feedback value | 92 |
| ✅ | cli: verifier feedback tag2 is the adapter | qwen |
| ✅ | cli: verifier feedbackURI | http://127.0.0.1:61170/verifications/job__0k-ZPaXrKwk.json |
| ✅ | cli: served verification file hashes to the on-chain feedbackHash | `0x90059ab43fa9c8c84d3d3a5db8b69ec150e81621aa39eea6e3ac221e3848ffa6` |
| ✅ | mcp: Kimi's NewFeedback (tag1 "xorv-verified") | `0xddd22a84519ea1ff1778c94f1d05b873451d9f73eb26e72e1fd63e979cfab25b` |
| ✅ | mcp: verifier feedback client is the verifier EOA | `0x0b7bff77617d5C96c7fca08E4001453F33F604b6` |
| ✅ | mcp: verifier feedback value | 92 |
| ✅ | mcp: verifier feedback tag2 is the adapter | echo |
| ✅ | mcp: verifier feedbackURI | http://127.0.0.1:61170/verifications/job_2K6HCxpBXaJU.json |
| ✅ | mcp: served verification file hashes to the on-chain feedbackHash | `0xfe3a89f9d1657dfb7526b0d78b2dac885f39af39e2ed631b08662184685abe89` |
| ✅ | private: no verifier feedback | 2 xorv-verified entries |
| ✅ | cli: the buyer's rating as NewFeedback (tag1 "starred") | `0x0ac2beb8e80c5cab590630e20fdde5af467fdfb53f650486d69241b2d65cb37e` |
| ✅ | cli: rating feedback client is XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | cli: rating feedback value | 87 |
| ✅ | cli: rating endpoint is the broker's jobs service | http://127.0.0.1:61170/api/quotes |
| ✅ | cli: served feedback file hashes to the on-chain feedbackHash | `0x6aa799ca49e7aafde1d6b633a86b106e1e16d70d3dff0cb07b71f99692549c90` |
| ✅ | mcp: the buyer's rating as NewFeedback (tag1 "starred") | `0x3ccc5b0620e168b7012d1410cc2d62aca0cb07f32ad7b0b0f04f1f6f69a11345` |
| ✅ | mcp: rating feedback client is XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | mcp: rating feedback value | 64 |
| ✅ | mcp: rating endpoint is the broker's jobs service | http://127.0.0.1:61170/api/quotes |
| ✅ | mcp: served feedback file hashes to the on-chain feedbackHash | `0xaf1e28500968ccb1a8c564150d6f494cddc914221947ff9f6fca9240db586389` |
| ✅ | cli: rating feedbackHash is what the buyer signed | `0x6aa799ca49e7aafde1d6b633a86b106e1e16d70d3dff0cb07b71f99692549c90` |
| ✅ | getSummary([ledger], "starred").count | 2 |
| ✅ | getSummary([ledger], "starred") is the registry's mean of those NewFeedback values | 75 (0 decimals) |
| ✅ | getSummary([verifier], "xorv-verified").count | 2 |
| ✅ | getSummary([verifier], "xorv-verified") is the registry's mean of those NewFeedback values | 92 (0 decimals) |
| ✅ | getClients lists XorvLedger and the verifier | 0x0b7bff77617d5C96c7fca08E4001453F33F604b6, 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 |

### The broker's own views agree with the chain

| | Check | Detail |
|---|---|---|
| ✅ | ledger feed source (RPC scan of the fork) | rpc |
| ✅ | ledger feed links all three receipts to their jobs | job_CrqqdMGQF7PZ, job_2K6HCxpBXaJU, job__0k-ZPaXrKwk |
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
| ✅ | identity show: agent id | 2276 |
| ✅ | identity show: owner and agent wallet are the payout address |  |
| ✅ | earnings exits 0 | 0 |
| ✅ | earnings: cli job recorded as ok | 40000 units |
| ✅ | earnings: cli amount is the settled USDC | 40000 |
| ✅ | earnings: cli carries its settlement tx | `0x0859ec88fe89a02c5b2d3c2c9fc66943ed2d50edf17a70322d601ad1a4d89376` |
| ✅ | earnings: mcp job recorded as ok | 1000 units |
| ✅ | earnings: mcp amount is the settled USDC | 1000 |
| ✅ | earnings: mcp carries its settlement tx | `0xa2c2277843115a2f800cbc65a36c0f895b0435456af0e845a140d027d883a41b` |
| ✅ | earnings: private job recorded as ok | 40000 units |
| ✅ | earnings: private amount is the settled USDC | 40000 |
| ✅ | earnings: private carries its settlement tx | `0x8acb29ffd42b9f9c776d196db06fc06cbd0303afeb4e735029efedff3e052d31` |
| ✅ | earnings total is the provider's on-chain USDC balance | 81000 |

### The private answer never touched the broker's disk

| | Check | Detail |
|---|---|---|
| ✅ | broker database exists | 4096 bytes |
| ✅ | the private job is in the broker's database |  |
| ✅ | the answer is not (in the database or its WAL) |  |

## Step log

**preflight**

- run directory /Volumes/Extreme SSD/Projects/xorv-monad-main/e2e/.runs/2026-10-13T13-05-08-929Z-MYuiln
- forking https://testnet-rpc.monad.xyz at its latest block

**start the mock OpenAI-compatible model server**

- listening on http://127.0.0.1:61154 (/qwen/v1, /kimi/v1, /hunyuan/v1)

**fork Monad testnet (Hardhat 3 / EDR, chain id 10143)**

- serving http://127.0.0.1:61155, forked at block 70688914

**fund the parties**

- minted $5.00 of USDC through the token's masterMinter 0x87f2e95621D8f12b83bb4a3E9975c0eAd524D437 (configureMinter 0xf66107b610995321df9586698b317b6f19a0d1bb3ce54fd320f3911c7f80b38b, mint 0xd4ddb4baa0a004edc427940464dd5b8ec10761cac46793c7ce052722c0acb6cc)

**deploy XorvLedger with packages/contracts' deploy script**

- XorvLedger at 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (block 70688917, tx 0xe094059d6e8f3d6cb45c2d9c406dc156b2e1c35a91f9111df89a5d957540fa17)

**start the broker (services/broker, self-hosted facilitator, AI roles on the mock)**

- listening on http://127.0.0.1:61170

**provider: register an ERC-8004 identity (xorv identity register)**

- registered as agent #2276

**provider: go live (xorv start)**

- provider prv_jVgz0qKGJWk0 connected, agent #2276
- ProviderRegistered in 0x6332e552b331fbdbd2dc79e5f245578eb5aea78f7acfb7964e97e546d01ce5f8

**Hunyuan screen refuses an abusive prompt before any quote**

- the safety screen refused this prompt: asks the agent to read and send out the provider's keys

**buyer: xorv run --json (Qwen routes, x402 pays, qwen adapter answers)**

- job job__0k-ZPaXrKwk completed in 2.0s; paid in 0x0859ec88fe89a02c5b2d3c2c9fc66943ed2d50edf17a70322d601ad1a4d89376

**Kimi verifies the result and writes ERC-8004 feedback**

- score 92/100 by kimi-k3; giveFeedback 0x2fe0f112d034cb9b2a9c991a1ec1c602c57b42cefa1da606109aef72a70502d9

**buyer rates the job through the broker API (EIP-712, gasless)**

- rateJob relayed in 0x0ac2beb8e80c5cab590630e20fdde5af467fdfb53f650486d69241b2d65cb37e

**agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job)**

- job job_2K6HCxpBXaJU
- Relayed on-chain: https://testnet.monadvision.com/tx/0x3ccc5b0620e168b7012d1410cc2d62aca0cb07f32ad7b0b0f04f1f6f69a11345

**private job through the broker API (sealed to the buyer's inbox key)**

- job job_CrqqdMGQF7PZ completed; settlement 0x8acb29ffd42b9f9c776d196db06fc06cbd0303afeb4e735029efedff3e052d31
- receipt 0xbaa7141eaff56c847447a099f49d8a012f8ede7f74d9aa969ee931770fce05a9

**on-chain: x402 settlements (real USDC, facilitator pays gas)**

- cli: 0x0859ec88fe89a02c5b2d3c2c9fc66943ed2d50edf17a70322d601ad1a4d89376 — 40000 0xaB2AC33Ea1Bc58F2Dd77f0E7247FF3B92A8522a7→0x9C659239313B82657fd4865e896E33ebf3C29179; gas 102820
- mcp: 0xa2c2277843115a2f800cbc65a36c0f895b0435456af0e845a140d027d883a41b — 1000 0xaB2AC33Ea1Bc58F2Dd77f0E7247FF3B92A8522a7→0x9C659239313B82657fd4865e896E33ebf3C29179; gas 85740
- private: 0x8acb29ffd42b9f9c776d196db06fc06cbd0303afeb4e735029efedff3e052d31 — 40000 0xaB2AC33Ea1Bc58F2Dd77f0E7247FF3B92A8522a7→0x9C659239313B82657fd4865e896E33ebf3C29179; gas 85720

**on-chain: XorvLedger events**

- 1 ProviderRegistered, 1 ProviderHeartbeat, 3 JobRecorded, 2 JobRated

**on-chain: ERC-8004 reputation (canonical Reputation Registry)**

- xorv-verified/qwen 92 from 0x0b7bff77617d5C96c7fca08E4001453F33F604b6 (0x2fe0f112d034cb9b2a9c991a1ec1c602c57b42cefa1da606109aef72a70502d9); starred/qwen 87 from 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (0x0ac2beb8e80c5cab590630e20fdde5af467fdfb53f650486d69241b2d65cb37e); xorv-verified/echo 92 from 0x0b7bff77617d5C96c7fca08E4001453F33F604b6 (0xddd22a84519ea1ff1778c94f1d05b873451d9f73eb26e72e1fd63e979cfab25b); starred/echo 64 from 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (0x3ccc5b0620e168b7012d1410cc2d62aca0cb07f32ad7b0b0f04f1f6f69a11345)

**the broker's own views agree with the chain**

- /api/ledger?kind=receipts: 3 receipts from rpc
