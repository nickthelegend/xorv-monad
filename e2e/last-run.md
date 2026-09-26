# Xorv end-to-end run

**PASS** — 168/168 checks, 20 steps, 90.3 s. Started 2026-09-26T18:37:17.496Z.

Produced by `pnpm e2e` (see [README.md](README.md)). Every value below was read back from the
forked chain or the running processes during the run; transaction hashes are local to that fork.

## Environment

| | |
|---|---|
| node | v22.21.1 |
| platform | win32 10.0.22631 |
| duration | 90.2 s |
| logs | (removed after a passing run) |

## Parties

| | |
|---|---|
| operator (broker EOA: ledger writes, rating relay, Kimi feedback) | `0xA6B8dd1060b38B3a3aFc0771021f17EF2f9D1FF4` |
| facilitator (submits EIP-3009 authorizations, pays settlement gas) | `0x6F9C9a30E79240123F75E59B5F479C05090677e7` |
| provider (payout address = ERC-8004 agent wallet) | `0xf116e8b0E1c1e828dc97D28048ff9c7C9a61A6c3` |
| buyer (USDC only, no MON) | `0x7F883811A53d7E7EB5BE3E4dDF6115473696e861` |
| provider ERC-8004 agent id | 1933 |
| provider id (broker) | prv_0torF89hxrGp |

## Chain

| | |
|---|---|
| fork RPC | http://127.0.0.1:62722 |
| forked from | https://testnet-rpc.monad.xyz at block 65922007 |
| chain id | 10143 |
| USDC (Circle FiatToken, forked) | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| ERC-8004 Identity Registry (forked) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation Registry (forked) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| buyer USDC funding | minted via masterMinter 0x87f2e95621D8f12b83bb4a3E9975c0eAd524D437 |
| XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| XorvLedger deploy tx | `0xdfb579156bd667817f3a104d4abe481baae01ae0257b230dc68c094d6a51cd2d` |

## Processes

| | |
|---|---|
| broker | http://127.0.0.1:4467 |

## Jobs

| | |
|---|---|
| CLI job | job_CNUk81G6_g-q |
| MCP job | job_4tpjDXx5ssuY |
| private job | job_B8uQEHV2trsw |

## Transactions

| | |
|---|---|
| cli job settlement | `0x2af1193810646b3e43782dcd006dba7cab2fcd8112d1ee3d3a58ebea9380b260` |
| mcp job settlement | `0x91ecd970a28971bec64e0ca0d158e1f208d47e5c95d90ace5c43bf9cfd86dbe0` |
| private job settlement | `0xb9a17166bd6e375119086821ce153822ffb9dfcf0228f10801b5572bcc703e5b` |
| ProviderRegistered | `0xccbf88cf8d9ac3cbf8576b9bae7542616f55f51d06a9416926a7daa2b8062165` |
| cli job receipt (JobRecorded) | `0x1da9337b0363b67e9604721792fb2f866e9721a9a1fe610020b217bcfb21ee79` |
| mcp job receipt (JobRecorded) | `0x296a079ab50ab7f434847a8a98c776ffe46336102a0dda70e86d3b0677110061` |
| private job receipt (JobRecorded) | `0x7cf7ee3d6749db6b39c87ba7a79a830b06da9c8156ecb095407bfc12f688abb5` |
| cli job rating (JobRated) | `0xa86c93e84943200047e49ba0c6df0443ac6effffb1c65ba8f697136e62a64d1d` |
| mcp job rating (JobRated) | `0xec3da39dc23a72a0b01cbbfab0370ea7f03af14c0ec05b668806243356111653` |
| cli job Kimi feedback (NewFeedback) | `0x0f63842634cdbc52fc92828f0dc12e18dcac18a01116c04fce15ab3f942978ec` |
| mcp job Kimi feedback (NewFeedback) | `0x4f023b79704c48acfdcc34b652051fde41e89fec6ef7c371b134fcc0de54603e` |
| cli job rating (NewFeedback) | `0xa86c93e84943200047e49ba0c6df0443ac6effffb1c65ba8f697136e62a64d1d` |
| mcp job rating (NewFeedback) | `0xec3da39dc23a72a0b01cbbfab0370ea7f03af14c0ec05b668806243356111653` |

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
| 2 | start the mock OpenAI-compatible model server | 0.2 s | ok |
| 3 | fork Monad testnet (Hardhat 3 / EDR, chain id 10143) | 15.9 s | ok |
| 4 | check the forked contracts are the real ones | 4.3 s | ok |
| 5 | fund the parties | 4.4 s | ok |
| 6 | deploy XorvLedger with packages/contracts' deploy script | 15.0 s | ok |
| 7 | start the broker (services/broker, self-hosted facilitator, AI roles on the mock) | 8.8 s | ok |
| 8 | provider: register an ERC-8004 identity (xorv identity register) | 9.8 s | ok |
| 9 | provider: go live (xorv start) | 5.5 s | ok |
| 10 | Hunyuan screen refuses an abusive prompt before any quote | 0.0 s | ok |
| 11 | buyer: xorv run --json (Qwen routes, x402 pays, qwen adapter answers) | 8.2 s | ok |
| 12 | Kimi verifies the result and writes ERC-8004 feedback | 0.0 s | ok |
| 13 | buyer rates the job through the broker API (EIP-712, gasless) | 2.5 s | ok |
| 14 | agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job) | 11.7 s | ok |
| 15 | private job through the broker API (sealed to the buyer's inbox key) | 2.2 s | ok |
| 16 | on-chain: x402 settlements (real USDC, facilitator pays gas) | 0.0 s | ok |
| 17 | on-chain: XorvLedger events | 0.0 s | ok |
| 18 | on-chain: ERC-8004 reputation (canonical Reputation Registry) | 0.0 s | ok |
| 19 | the broker's own views agree with the chain | 0.0 s | ok |
| 20 | the private answer never touched the broker's disk | 0.0 s | ok |

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
| ✅ | ledger.broker() is the operator | `0xA6B8dd1060b38B3a3aFc0771021f17EF2f9D1FF4` |

### Start the broker (services/broker, self-hosted facilitator, AI roles on the mock)

| | Check | Detail |
|---|---|---|
| ✅ | broker network | eip155:10143 |
| ✅ | broker chain id | 10143 |
| ✅ | broker prices in the forked USDC | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| ✅ | facilitator is self-hosted | self |
| ✅ | facilitator EOA | `0x6F9C9a30E79240123F75E59B5F479C05090677e7` |
| ✅ | payments are available | true |
| ✅ | ledger address | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | ledger mode | write |
| ✅ | screener | hunyuan |
| ✅ | router | qwen |
| ✅ | verifier | kimi |
| ✅ | verifier writes ERC-8004 feedback from the operator | `0xA6B8dd1060b38B3a3aFc0771021f17EF2f9D1FF4` |

### Provider: register an ERC-8004 identity (xorv identity register)

| | Check | Detail |
|---|---|---|
| ✅ | agent owner is the provider's payout address | `0xf116e8b0E1c1e828dc97D28048ff9c7C9a61A6c3` |
| ✅ | agent wallet is the provider's payout address | `0xf116e8b0E1c1e828dc97D28048ff9c7C9a61A6c3` |
| ✅ | agentURI is the broker's registration file | http://127.0.0.1:4467/agents/e2e-node-xtchil3y.json |

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
| ✅ | payer is the buyer | `0x7F883811A53d7E7EB5BE3E4dDF6115473696e861` |
| ✅ | screened by Hunyuan and allowed | hunyuan:allow |
| ✅ | routed by Qwen | qwen |
| ✅ | router's pick (over the cheaper echo) is the quoted adapter | qwen/qwen |
| ✅ | quote freezes $0.04 = 40000 USDC units | 40000 |
| ✅ | payTo is the provider, not the broker | `0xf116e8b0E1c1e828dc97D28048ff9c7C9a61A6c3` |
| ✅ | result came from the provider's qwen adapter (mock answer token) | ans-21cd93a46116e9fc2aec |
| ✅ | resultHash = keccak256(result) | `0x3748c75ea6097e4325b7bb96412bf42b169374f1e57a5368d9147a9da175f2fa` |
| ✅ | settlement tx reported | `0x2af1193810646b3e43782dcd006dba7cab2fcd8112d1ee3d3a58ebea9380b260` |
| ✅ | XorvLedger receipt tx reported | `0x1da9337b0363b67e9604721792fb2f866e9721a9a1fe610020b217bcfb21ee79` |

### Kimi verifies the result and writes ERC-8004 feedback

| | Check | Detail |
|---|---|---|
| ✅ | verified by Kimi | kimi |
| ✅ | verification score | 92 |

### Buyer rates the job through the broker API (EIP-712, gasless)

| | Check | Detail |
|---|---|---|
| ✅ | rating signer is the payer | `0x7F883811A53d7E7EB5BE3E4dDF6115473696e861` |
| ✅ | rating is for the provider's agent | 1933 |
| ✅ | typed data domain is this XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | a stranger's signature is refused | 401 |
| ✅ | served feedback file hashes to the committed feedbackHash | `0x9fd1c141f6dd2ff256380efdf2c406adfb39e9dab1105441530b340edf4bf9ff` |

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
| ✅ | the buyer's inbox key opens it to the provider's answer | ans-298555c1b3d3f8a14fb9 |
| ✅ | the plaintext answer is nowhere in the broker's API |  |
| ✅ | the plaintext answer never reached the Kimi verifier |  |
| ✅ | the private job was not verified (no readable result) |  |
| ✅ | resultHash commits to the envelope | `0xc5e2ac925fc25b2f684cb370c23105dd3317062a0c7109a43a55ee4cb96391f3` |

### On-chain: x402 settlements (real USDC, facilitator pays gas)

| | Check | Detail |
|---|---|---|
| ✅ | cli: settlement succeeded | success |
| ✅ | cli: sent (and gas paid) by the facilitator | `0x6F9C9a30E79240123F75E59B5F479C05090677e7` |
| ✅ | cli: USDC Transfer buyer → provider for exactly 40000 | 0x7F883811A53d7E7EB5BE3E4dDF6115473696e861→0xf116e8b0E1c1e828dc97D28048ff9c7C9a61A6c3 40000 |
| ✅ | cli: EIP-3009 authorization used by the buyer |  |
| ✅ | cli: job.payment.amount | 40000 |
| ✅ | mcp: settlement succeeded | success |
| ✅ | mcp: sent (and gas paid) by the facilitator | `0x6F9C9a30E79240123F75E59B5F479C05090677e7` |
| ✅ | mcp: USDC Transfer buyer → provider for exactly 1000 | 0x7F883811A53d7E7EB5BE3E4dDF6115473696e861→0xf116e8b0E1c1e828dc97D28048ff9c7C9a61A6c3 1000 |
| ✅ | mcp: EIP-3009 authorization used by the buyer |  |
| ✅ | mcp: job.payment.amount | 1000 |
| ✅ | private: settlement succeeded | success |
| ✅ | private: sent (and gas paid) by the facilitator | `0x6F9C9a30E79240123F75E59B5F479C05090677e7` |
| ✅ | private: USDC Transfer buyer → provider for exactly 40000 | 0x7F883811A53d7E7EB5BE3E4dDF6115473696e861→0xf116e8b0E1c1e828dc97D28048ff9c7C9a61A6c3 40000 |
| ✅ | private: EIP-3009 authorization used by the buyer |  |
| ✅ | private: job.payment.amount | 40000 |
| ✅ | buyer USDC balance | 4919000 |
| ✅ | provider USDC balance | 81000 |
| ✅ | buyer spent no MON (still zero) | 0 |
| ✅ | buyer never sent a transaction (nonce 0) | 0 |

### On-chain: XorvLedger events

| | Check | Detail |
|---|---|---|
| ✅ | ProviderRegistered for the provider | `0xccbf88cf8d9ac3cbf8576b9bae7542616f55f51d06a9416926a7daa2b8062165` |
| ✅ | ProviderRegistered.payTo | `0xf116e8b0E1c1e828dc97D28048ff9c7C9a61A6c3` |
| ✅ | ProviderRegistered.agentId | 1933 |
| ✅ | ProviderRegistered.label | e2e-provider |
| ✅ | ProviderRegistered.capabilities | echo:1000,qwen:40000 |
| ✅ | a sampled ProviderHeartbeat was published | `0xa56e2aa55bf7fac04dfab1cca71c745ef359031767054da7fe72e57746518cc0` |
| ✅ | cli: JobRecorded | `0x1da9337b0363b67e9604721792fb2f866e9721a9a1fe610020b217bcfb21ee79` |
| ✅ | cli: JobRecorded.agentId | 1933 |
| ✅ | cli: JobRecorded.buyer | `0x7F883811A53d7E7EB5BE3E4dDF6115473696e861` |
| ✅ | cli: JobRecorded.payTo | `0xf116e8b0E1c1e828dc97D28048ff9c7C9a61A6c3` |
| ✅ | cli: JobRecorded.amount | 40000 |
| ✅ | cli: JobRecorded.paymentTx is the settlement | `0x2af1193810646b3e43782dcd006dba7cab2fcd8112d1ee3d3a58ebea9380b260` |
| ✅ | cli: JobRecorded.requestHash = keccak256(prompt) | `0xe22f6e2d727ac3da67b4d51021be3dd4e53868f3d033825b40a47fa40518e3b5` |
| ✅ | cli: JobRecorded.resultHash = keccak256(result) | `0x3748c75ea6097e4325b7bb96412bf42b169374f1e57a5368d9147a9da175f2fa` |
| ✅ | cli: JobRecorded.ok | true |
| ✅ | cli: the broker's receiptTxHash is that transaction | `0x1da9337b0363b67e9604721792fb2f866e9721a9a1fe610020b217bcfb21ee79` |
| ✅ | mcp: JobRecorded | `0x296a079ab50ab7f434847a8a98c776ffe46336102a0dda70e86d3b0677110061` |
| ✅ | mcp: JobRecorded.agentId | 1933 |
| ✅ | mcp: JobRecorded.buyer | `0x7F883811A53d7E7EB5BE3E4dDF6115473696e861` |
| ✅ | mcp: JobRecorded.payTo | `0xf116e8b0E1c1e828dc97D28048ff9c7C9a61A6c3` |
| ✅ | mcp: JobRecorded.amount | 1000 |
| ✅ | mcp: JobRecorded.paymentTx is the settlement | `0x91ecd970a28971bec64e0ca0d158e1f208d47e5c95d90ace5c43bf9cfd86dbe0` |
| ✅ | mcp: JobRecorded.requestHash = keccak256(prompt) | `0x9fc5489df4422ff0e55c87848e07d103ed6ea7a51f43bced43afc69e74d4cb28` |
| ✅ | mcp: JobRecorded.resultHash = keccak256(result) | `0x8fa74e31091b595515b1d9c9322990497680dd29925c35a6ae69be07cb49ed12` |
| ✅ | mcp: JobRecorded.ok | true |
| ✅ | mcp: the broker's receiptTxHash is that transaction | `0x296a079ab50ab7f434847a8a98c776ffe46336102a0dda70e86d3b0677110061` |
| ✅ | private: JobRecorded | `0x7cf7ee3d6749db6b39c87ba7a79a830b06da9c8156ecb095407bfc12f688abb5` |
| ✅ | private: JobRecorded.agentId | 1933 |
| ✅ | private: JobRecorded.buyer | `0x7F883811A53d7E7EB5BE3E4dDF6115473696e861` |
| ✅ | private: JobRecorded.payTo | `0xf116e8b0E1c1e828dc97D28048ff9c7C9a61A6c3` |
| ✅ | private: JobRecorded.amount | 40000 |
| ✅ | private: JobRecorded.paymentTx is the settlement | `0xb9a17166bd6e375119086821ce153822ffb9dfcf0228f10801b5572bcc703e5b` |
| ✅ | private: JobRecorded.requestHash = keccak256(prompt) | `0xdabc72310ca6bb0a4da31176153f3c5cf6ed201118ce6671fe0271a7a11bc5d6` |
| ✅ | private: JobRecorded.resultHash = keccak256(result) | `0xc5e2ac925fc25b2f684cb370c23105dd3317062a0c7109a43a55ee4cb96391f3` |
| ✅ | private: JobRecorded.ok | true |
| ✅ | private: the broker's receiptTxHash is that transaction | `0x7cf7ee3d6749db6b39c87ba7a79a830b06da9c8156ecb095407bfc12f688abb5` |
| ✅ | private: the on-chain resultHash is keccak256 of the sealed envelope | `0xc5e2ac925fc25b2f684cb370c23105dd3317062a0c7109a43a55ee4cb96391f3` |
| ✅ | cli: JobRated | `0xa86c93e84943200047e49ba0c6df0443ac6effffb1c65ba8f697136e62a64d1d` |
| ✅ | cli: JobRated.value | 87 |
| ✅ | cli: JobRated.buyer | `0x7F883811A53d7E7EB5BE3E4dDF6115473696e861` |
| ✅ | cli: JobRated.agentId | 1933 |
| ✅ | cli: ledger.jobs() marks it rated |  |
| ✅ | mcp: JobRated | `0xec3da39dc23a72a0b01cbbfab0370ea7f03af14c0ec05b668806243356111653` |
| ✅ | mcp: JobRated.value | 64 |
| ✅ | mcp: JobRated.buyer | `0x7F883811A53d7E7EB5BE3E4dDF6115473696e861` |
| ✅ | mcp: JobRated.agentId | 1933 |
| ✅ | mcp: ledger.jobs() marks it rated |  |
| ✅ | cli: the relay tx the broker returned is the JobRated tx | `0xa86c93e84943200047e49ba0c6df0443ac6effffb1c65ba8f697136e62a64d1d` |
| ✅ | private: not rated |  |

### On-chain: ERC-8004 reputation (canonical Reputation Registry)

| | Check | Detail |
|---|---|---|
| ✅ | cli: Kimi's NewFeedback (tag1 "xorv-verified") | `0x0f63842634cdbc52fc92828f0dc12e18dcac18a01116c04fce15ab3f942978ec` |
| ✅ | cli: verifier feedback client is the verifier EOA | `0xA6B8dd1060b38B3a3aFc0771021f17EF2f9D1FF4` |
| ✅ | cli: verifier feedback value | 92 |
| ✅ | cli: verifier feedback tag2 is the adapter | qwen |
| ✅ | cli: verifier feedbackURI | http://127.0.0.1:4467/verifications/job_CNUk81G6_g-q.json |
| ✅ | cli: served verification file hashes to the on-chain feedbackHash | `0x05cfb5e61c72237f43de0d91c1cc6fd5f218777923544848950453e49901f297` |
| ✅ | mcp: Kimi's NewFeedback (tag1 "xorv-verified") | `0x4f023b79704c48acfdcc34b652051fde41e89fec6ef7c371b134fcc0de54603e` |
| ✅ | mcp: verifier feedback client is the verifier EOA | `0xA6B8dd1060b38B3a3aFc0771021f17EF2f9D1FF4` |
| ✅ | mcp: verifier feedback value | 92 |
| ✅ | mcp: verifier feedback tag2 is the adapter | echo |
| ✅ | mcp: verifier feedbackURI | http://127.0.0.1:4467/verifications/job_4tpjDXx5ssuY.json |
| ✅ | mcp: served verification file hashes to the on-chain feedbackHash | `0xc82c666384a95311962f131eedefe73f556a650e97eb7de75168819c4dce93a4` |
| ✅ | private: no verifier feedback | 2 xorv-verified entries |
| ✅ | cli: the buyer's rating as NewFeedback (tag1 "starred") | `0xa86c93e84943200047e49ba0c6df0443ac6effffb1c65ba8f697136e62a64d1d` |
| ✅ | cli: rating feedback client is XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | cli: rating feedback value | 87 |
| ✅ | cli: rating endpoint is the broker's jobs service | http://127.0.0.1:4467/api/quotes |
| ✅ | cli: served feedback file hashes to the on-chain feedbackHash | `0x9fd1c141f6dd2ff256380efdf2c406adfb39e9dab1105441530b340edf4bf9ff` |
| ✅ | mcp: the buyer's rating as NewFeedback (tag1 "starred") | `0xec3da39dc23a72a0b01cbbfab0370ea7f03af14c0ec05b668806243356111653` |
| ✅ | mcp: rating feedback client is XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | mcp: rating feedback value | 64 |
| ✅ | mcp: rating endpoint is the broker's jobs service | http://127.0.0.1:4467/api/quotes |
| ✅ | mcp: served feedback file hashes to the on-chain feedbackHash | `0x380cbb9bb852c11127647908f547872f67c4d996dda3fadaeccc6c29aab94b2e` |
| ✅ | cli: rating feedbackHash is what the buyer signed | `0x9fd1c141f6dd2ff256380efdf2c406adfb39e9dab1105441530b340edf4bf9ff` |
| ✅ | getSummary([ledger], "starred").count | 2 |
| ✅ | getSummary([ledger], "starred") is the registry's mean of those NewFeedback values | 75 (0 decimals) |
| ✅ | getSummary([verifier], "xorv-verified").count | 2 |
| ✅ | getSummary([verifier], "xorv-verified") is the registry's mean of those NewFeedback values | 92 (0 decimals) |
| ✅ | getClients lists XorvLedger and the verifier | 0xA6B8dd1060b38B3a3aFc0771021f17EF2f9D1FF4, 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 |

### The broker's own views agree with the chain

| | Check | Detail |
|---|---|---|
| ✅ | ledger feed source (RPC scan of the fork) | rpc |
| ✅ | ledger feed links all three receipts to their jobs | job_B8uQEHV2trsw, job_4tpjDXx5ssuY, job_CNUk81G6_g-q |
| ✅ | ledger feed has both ratings | 2 |
| ✅ | leaderboard lists the provider |  |
| ✅ | no ledger publish errors | null |
| ✅ | no receipts left queued | 0 |

### The private answer never touched the broker's disk

| | Check | Detail |
|---|---|---|
| ✅ | broker database exists | 4096 bytes |
| ✅ | the private job is in the broker's database |  |
| ✅ | the answer is not (in the database or its WAL) |  |

## Step log

**preflight**

- run directory E:\Projects\xorv-monad-wt\cli\e2e\.runs\2026-09-26T18-37-17-524Z-7KXAOO
- forking https://testnet-rpc.monad.xyz at its latest block

**start the mock OpenAI-compatible model server**

- listening on http://127.0.0.1:62721 (/qwen/v1, /kimi/v1, /hunyuan/v1)

**fork Monad testnet (Hardhat 3 / EDR, chain id 10143)**

- serving http://127.0.0.1:62722, forked at block 65922007

**fund the parties**

- minted 5.00 USDC through the token's masterMinter 0x87f2e95621D8f12b83bb4a3E9975c0eAd524D437 (configureMinter 0x1a356ac5f70d3ebe3f3bd8a86f17f1d808109ccdd39710818c6ff9e47c24cd0e, mint 0xf975381398a9283c36e44abd65e5a3b9ac11ae6656cc6ec612c93acba1757645)

**deploy XorvLedger with packages/contracts' deploy script**

- XorvLedger at 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (block 65922010, tx 0xdfb579156bd667817f3a104d4abe481baae01ae0257b230dc68c094d6a51cd2d)

**start the broker (services/broker, self-hosted facilitator, AI roles on the mock)**

- listening on http://127.0.0.1:4467

**provider: register an ERC-8004 identity (xorv identity register)**

- registered as agent #1933

**provider: go live (xorv start)**

- provider prv_0torF89hxrGp connected, agent #1933
- ProviderRegistered in 0xccbf88cf8d9ac3cbf8576b9bae7542616f55f51d06a9416926a7daa2b8062165

**Hunyuan screen refuses an abusive prompt before any quote**

- the safety screen refused this prompt: asks the agent to read and send out the provider's keys

**buyer: xorv run --json (Qwen routes, x402 pays, qwen adapter answers)**

- job job_CNUk81G6_g-q completed in 2.1s; paid in 0x2af1193810646b3e43782dcd006dba7cab2fcd8112d1ee3d3a58ebea9380b260

**Kimi verifies the result and writes ERC-8004 feedback**

- score 92/100 by kimi-k3; giveFeedback 0x0f63842634cdbc52fc92828f0dc12e18dcac18a01116c04fce15ab3f942978ec

**buyer rates the job through the broker API (EIP-712, gasless)**

- rateJob relayed in 0xa86c93e84943200047e49ba0c6df0443ac6effffb1c65ba8f697136e62a64d1d

**agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job)**

- job job_4tpjDXx5ssuY
- Relayed on-chain: https://testnet.monadscan.com/tx/0xec3da39dc23a72a0b01cbbfab0370ea7f03af14c0ec05b668806243356111653

**private job through the broker API (sealed to the buyer's inbox key)**

- job job_B8uQEHV2trsw completed; settlement 0xb9a17166bd6e375119086821ce153822ffb9dfcf0228f10801b5572bcc703e5b
- receipt 0x7cf7ee3d6749db6b39c87ba7a79a830b06da9c8156ecb095407bfc12f688abb5

**on-chain: x402 settlements (real USDC, facilitator pays gas)**

- cli: 0x2af1193810646b3e43782dcd006dba7cab2fcd8112d1ee3d3a58ebea9380b260 — 40000 0x7F883811A53d7E7EB5BE3E4dDF6115473696e861→0xf116e8b0E1c1e828dc97D28048ff9c7C9a61A6c3; gas 102828
- mcp: 0x91ecd970a28971bec64e0ca0d158e1f208d47e5c95d90ace5c43bf9cfd86dbe0 — 1000 0x7F883811A53d7E7EB5BE3E4dDF6115473696e861→0xf116e8b0E1c1e828dc97D28048ff9c7C9a61A6c3; gas 85740
- private: 0xb9a17166bd6e375119086821ce153822ffb9dfcf0228f10801b5572bcc703e5b — 40000 0x7F883811A53d7E7EB5BE3E4dDF6115473696e861→0xf116e8b0E1c1e828dc97D28048ff9c7C9a61A6c3; gas 85720

**on-chain: XorvLedger events**

- 1 ProviderRegistered, 1 ProviderHeartbeat, 3 JobRecorded, 2 JobRated

**on-chain: ERC-8004 reputation (canonical Reputation Registry)**

- xorv-verified/qwen 92 from 0xA6B8dd1060b38B3a3aFc0771021f17EF2f9D1FF4 (0x0f63842634cdbc52fc92828f0dc12e18dcac18a01116c04fce15ab3f942978ec); starred/qwen 87 from 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (0xa86c93e84943200047e49ba0c6df0443ac6effffb1c65ba8f697136e62a64d1d); xorv-verified/echo 92 from 0xA6B8dd1060b38B3a3aFc0771021f17EF2f9D1FF4 (0x4f023b79704c48acfdcc34b652051fde41e89fec6ef7c371b134fcc0de54603e); starred/echo 64 from 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (0xec3da39dc23a72a0b01cbbfab0370ea7f03af14c0ec05b668806243356111653)

**the broker's own views agree with the chain**

- /api/ledger?kind=receipts: 3 receipts from rpc
