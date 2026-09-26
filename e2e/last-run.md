# Xorv end-to-end run

**PASS** — 189/189 checks, 22 steps, 165.1 s. Started 2026-09-26T19:51:48.300Z.

Produced by `pnpm e2e` (see [README.md](README.md)). Every value below was read back from the
forked chain or the running processes during the run; transaction hashes are local to that fork.

## Environment

| | |
|---|---|
| node | v22.21.1 |
| platform | win32 10.0.22631 |
| duration | 165.1 s |
| logs | (removed after a passing run) |

## Parties

| | |
|---|---|
| operator (broker EOA: ledger writes, rating relay, Kimi feedback) | `0x9f6CCADa976aE9e63B09DE00FD4FF77A71Ed5ACA` |
| facilitator (submits EIP-3009 authorizations, pays settlement gas) | `0x9C235fe500D2c1570dF9C27768E83da1ee0cFF78` |
| provider (payout address = ERC-8004 agent wallet) | `0x638a93cC33417Ba6bb2863a3Ed284DE2011c2A6f` |
| buyer (USDC only, no MON) | `0xf451EfD3FDb960609C8Bd900b76d56bEf371A305` |
| provider ERC-8004 agent id | 1933 |
| provider id (broker) | prv_UHvhRjXkeI1s |

## Chain

| | |
|---|---|
| fork RPC | http://127.0.0.1:34763 |
| forked from | https://testnet-rpc.monad.xyz at block 65936409 |
| chain id | 10143 |
| USDC (Circle FiatToken, forked) | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| ERC-8004 Identity Registry (forked) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation Registry (forked) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| buyer USDC funding | minted via masterMinter 0x87f2e95621D8f12b83bb4a3E9975c0eAd524D437 |
| XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| XorvLedger deploy tx | `0x06a91309e1b3877d3b161224a25372440402ba9e95128114ddc3838a56955bbe` |

## Processes

| | |
|---|---|
| broker | http://127.0.0.1:61084 |

## Jobs

| | |
|---|---|
| CLI job | job_iBJ7r7H6N6Si |
| MCP job | job_fDwGrx_KTsW2 |
| private job | job__6ueSr-FO2Il |

## Transactions

| | |
|---|---|
| cli job settlement | `0x07f52c447a469356f689f69d30b571f9b1eff4a3448fc6c15845a76e82c1be9d` |
| mcp job settlement | `0x8af6967bc1617cfc09ff825c8926c2583f95221b323511e2509806a41dd61014` |
| private job settlement | `0x1374b9894aa018093b8070ddb7533d5d3646fb8361788a0c08b6e807e1230dc2` |
| ProviderRegistered | `0xd089664608818fd1307c31d3c92eaf2e68862b3b2a05366535f3e52511bec262` |
| cli job receipt (JobRecorded) | `0xce0859c1fe8c74a53f9da1038f340018636b20f34ce24cae4fb6437c1d919e45` |
| mcp job receipt (JobRecorded) | `0x7939beebbcecb559a02480d39a515e729f047644783a7dffc07edd4991bae258` |
| private job receipt (JobRecorded) | `0xa8955b9725cd1e9de6b963d214b8c7edc64bb12ca14a4bdf5f3c17dc1b3f882e` |
| cli job rating (JobRated) | `0xe57f76646d740be62a63efd9f8d957ae0d54fd8e7a1cf8709b1ce4c971c55ec3` |
| mcp job rating (JobRated) | `0x1c3dc0888c2ca4b522974e310fc987b5269e32f724b79ae93ba1854890630fda` |
| cli job Kimi feedback (NewFeedback) | `0x995d47a0a720591da022d96c9eb8dcc7fcec26827d253a5595dc846c527559d0` |
| mcp job Kimi feedback (NewFeedback) | `0x6478bffe52da2d959a5aef450093c5852e1395157cd3be1a1447e9b51eb85580` |
| cli job rating (NewFeedback) | `0xe57f76646d740be62a63efd9f8d957ae0d54fd8e7a1cf8709b1ce4c971c55ec3` |
| mcp job rating (NewFeedback) | `0x1c3dc0888c2ca4b522974e310fc987b5269e32f724b79ae93ba1854890630fda` |

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
| 3 | fork Monad testnet (Hardhat 3 / EDR, chain id 10143) | 41.1 s | ok |
| 4 | check the forked contracts are the real ones | 5.5 s | ok |
| 5 | fund the parties | 5.3 s | ok |
| 6 | deploy XorvLedger with packages/contracts' deploy script | 16.5 s | ok |
| 7 | start the broker (services/broker, self-hosted facilitator, AI roles on the mock) | 15.8 s | ok |
| 8 | provider: register an ERC-8004 identity (xorv identity register) | 14.2 s | ok |
| 9 | provider: go live (xorv start) | 6.6 s | ok |
| 10 | Hunyuan screen refuses an abusive prompt before any quote | 0.0 s | ok |
| 11 | buyer: xorv run --json (Qwen routes, x402 pays, qwen adapter answers) | 14.7 s | ok |
| 12 | Kimi verifies the result and writes ERC-8004 feedback | 0.0 s | ok |
| 13 | buyer rates the job through the broker API (EIP-712, gasless) | 4.0 s | ok |
| 14 | agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job) | 19.9 s | ok |
| 15 | private job through the broker API (sealed to the buyer's inbox key) | 3.7 s | ok |
| 16 | on-chain: x402 settlements (real USDC, facilitator pays gas) | 0.0 s | ok |
| 17 | on-chain: XorvLedger events | 0.1 s | ok |
| 18 | on-chain: ERC-8004 reputation (canonical Reputation Registry) | 0.0 s | ok |
| 19 | the broker's own views agree with the chain | 0.0 s | ok |
| 20 | the provider's own log is a record of its jobs | 0.0 s | ok |
| 21 | provider: xorv identity show and xorv earnings agree with the chain | 13.8 s | ok |
| 22 | the private answer never touched the broker's disk | 1.1 s | ok |

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
| ✅ | ledger.broker() is the operator | `0x9f6CCADa976aE9e63B09DE00FD4FF77A71Ed5ACA` |

### Start the broker (services/broker, self-hosted facilitator, AI roles on the mock)

| | Check | Detail |
|---|---|---|
| ✅ | broker network | eip155:10143 |
| ✅ | broker chain id | 10143 |
| ✅ | broker prices in the forked USDC | `0x534b2f3A21130d7a60830c2Df862319e593943A3` |
| ✅ | facilitator is self-hosted | self |
| ✅ | facilitator EOA | `0x9C235fe500D2c1570dF9C27768E83da1ee0cFF78` |
| ✅ | payments are available | true |
| ✅ | ledger address | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | ledger mode | write |
| ✅ | screener | hunyuan |
| ✅ | router | qwen |
| ✅ | verifier | kimi |
| ✅ | verifier writes ERC-8004 feedback from the operator | `0x9f6CCADa976aE9e63B09DE00FD4FF77A71Ed5ACA` |

### Provider: register an ERC-8004 identity (xorv identity register)

| | Check | Detail |
|---|---|---|
| ✅ | agent owner is the provider's payout address | `0x638a93cC33417Ba6bb2863a3Ed284DE2011c2A6f` |
| ✅ | agent wallet is the provider's payout address | `0x638a93cC33417Ba6bb2863a3Ed284DE2011c2A6f` |
| ✅ | agentURI is the broker's registration file | http://127.0.0.1:61084/agents/e2e-node-7b6ud5tp.json |

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
| ✅ | payer is the buyer | `0xf451EfD3FDb960609C8Bd900b76d56bEf371A305` |
| ✅ | screened by Hunyuan and allowed | hunyuan:allow |
| ✅ | routed by Qwen | qwen |
| ✅ | router's pick (over the cheaper echo) is the quoted adapter | qwen/qwen |
| ✅ | quote freezes $0.04 = 40000 USDC units | 40000 |
| ✅ | payTo is the provider, not the broker | `0x638a93cC33417Ba6bb2863a3Ed284DE2011c2A6f` |
| ✅ | result came from the provider's qwen adapter (mock answer token) | ans-619e41a4111a325ff997 |
| ✅ | resultHash = keccak256(result) | `0x817a55355a00f81ef79d2fa408f2f843b046b691a13fc948890ac77c5c9a02cc` |
| ✅ | settlement tx reported | `0x07f52c447a469356f689f69d30b571f9b1eff4a3448fc6c15845a76e82c1be9d` |
| ✅ | XorvLedger receipt tx reported | `0xce0859c1fe8c74a53f9da1038f340018636b20f34ce24cae4fb6437c1d919e45` |

### Kimi verifies the result and writes ERC-8004 feedback

| | Check | Detail |
|---|---|---|
| ✅ | verified by Kimi | kimi |
| ✅ | verification score | 92 |

### Buyer rates the job through the broker API (EIP-712, gasless)

| | Check | Detail |
|---|---|---|
| ✅ | rating signer is the payer | `0xf451EfD3FDb960609C8Bd900b76d56bEf371A305` |
| ✅ | rating is for the provider's agent | 1933 |
| ✅ | typed data domain is this XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | a stranger's signature is refused | 401 |
| ✅ | served feedback file hashes to the committed feedbackHash | `0x9c68656e57daba089addc59b385e259b80ef60e8f62eff3eed7d5fc963e32a2e` |

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
| ✅ | the buyer's inbox key opens it to the provider's answer | ans-d2a7b3eb471b6bd38865 |
| ✅ | another inbox key cannot open it | DECRYPT_FAILED |
| ✅ | it is bound to its job id | DECRYPT_FAILED |
| ✅ | the plaintext answer is nowhere in the broker's API |  |
| ✅ | the plaintext answer never reached the Kimi verifier |  |
| ✅ | the private job was not verified (no readable result) |  |
| ✅ | resultHash commits to the envelope | `0xd9ada6ce33adc41b3a11f71fa16268ef9bc3b15e38e987f3e05123ee491c56c6` |

### On-chain: x402 settlements (real USDC, facilitator pays gas)

| | Check | Detail |
|---|---|---|
| ✅ | cli: settlement succeeded | success |
| ✅ | cli: sent (and gas paid) by the facilitator | `0x9C235fe500D2c1570dF9C27768E83da1ee0cFF78` |
| ✅ | cli: USDC Transfer buyer → provider for exactly 40000 | 0xf451EfD3FDb960609C8Bd900b76d56bEf371A305→0x638a93cC33417Ba6bb2863a3Ed284DE2011c2A6f 40000 |
| ✅ | cli: EIP-3009 authorization used by the buyer |  |
| ✅ | cli: job.payment.amount | 40000 |
| ✅ | mcp: settlement succeeded | success |
| ✅ | mcp: sent (and gas paid) by the facilitator | `0x9C235fe500D2c1570dF9C27768E83da1ee0cFF78` |
| ✅ | mcp: USDC Transfer buyer → provider for exactly 1000 | 0xf451EfD3FDb960609C8Bd900b76d56bEf371A305→0x638a93cC33417Ba6bb2863a3Ed284DE2011c2A6f 1000 |
| ✅ | mcp: EIP-3009 authorization used by the buyer |  |
| ✅ | mcp: job.payment.amount | 1000 |
| ✅ | private: settlement succeeded | success |
| ✅ | private: sent (and gas paid) by the facilitator | `0x9C235fe500D2c1570dF9C27768E83da1ee0cFF78` |
| ✅ | private: USDC Transfer buyer → provider for exactly 40000 | 0xf451EfD3FDb960609C8Bd900b76d56bEf371A305→0x638a93cC33417Ba6bb2863a3Ed284DE2011c2A6f 40000 |
| ✅ | private: EIP-3009 authorization used by the buyer |  |
| ✅ | private: job.payment.amount | 40000 |
| ✅ | buyer USDC balance | 4919000 |
| ✅ | provider USDC balance | 81000 |
| ✅ | buyer spent no MON (still zero) | 0 |
| ✅ | buyer never sent a transaction (nonce 0) | 0 |

### On-chain: XorvLedger events

| | Check | Detail |
|---|---|---|
| ✅ | ProviderRegistered for the provider | `0xd089664608818fd1307c31d3c92eaf2e68862b3b2a05366535f3e52511bec262` |
| ✅ | ProviderRegistered.payTo | `0x638a93cC33417Ba6bb2863a3Ed284DE2011c2A6f` |
| ✅ | ProviderRegistered.agentId | 1933 |
| ✅ | ProviderRegistered.label | e2e-provider |
| ✅ | ProviderRegistered.capabilities | echo:1000,qwen:40000 |
| ✅ | a sampled ProviderHeartbeat was published | `0x506243e83b18b8e3cbe47cf7d2f992ed711d5c2154a9a26725b571293e059f28` |
| ✅ | cli: JobRecorded | `0xce0859c1fe8c74a53f9da1038f340018636b20f34ce24cae4fb6437c1d919e45` |
| ✅ | cli: JobRecorded.agentId | 1933 |
| ✅ | cli: JobRecorded.buyer | `0xf451EfD3FDb960609C8Bd900b76d56bEf371A305` |
| ✅ | cli: JobRecorded.payTo | `0x638a93cC33417Ba6bb2863a3Ed284DE2011c2A6f` |
| ✅ | cli: JobRecorded.amount | 40000 |
| ✅ | cli: JobRecorded.paymentTx is the settlement | `0x07f52c447a469356f689f69d30b571f9b1eff4a3448fc6c15845a76e82c1be9d` |
| ✅ | cli: JobRecorded.requestHash = keccak256(prompt) | `0xda79b1e11b0c28ec9823f7c13a635afc1c3b3ff4e52f8523ad5af32685fb3de9` |
| ✅ | cli: JobRecorded.resultHash = keccak256(result) | `0x817a55355a00f81ef79d2fa408f2f843b046b691a13fc948890ac77c5c9a02cc` |
| ✅ | cli: JobRecorded.ok | true |
| ✅ | cli: the broker's receiptTxHash is that transaction | `0xce0859c1fe8c74a53f9da1038f340018636b20f34ce24cae4fb6437c1d919e45` |
| ✅ | mcp: JobRecorded | `0x7939beebbcecb559a02480d39a515e729f047644783a7dffc07edd4991bae258` |
| ✅ | mcp: JobRecorded.agentId | 1933 |
| ✅ | mcp: JobRecorded.buyer | `0xf451EfD3FDb960609C8Bd900b76d56bEf371A305` |
| ✅ | mcp: JobRecorded.payTo | `0x638a93cC33417Ba6bb2863a3Ed284DE2011c2A6f` |
| ✅ | mcp: JobRecorded.amount | 1000 |
| ✅ | mcp: JobRecorded.paymentTx is the settlement | `0x8af6967bc1617cfc09ff825c8926c2583f95221b323511e2509806a41dd61014` |
| ✅ | mcp: JobRecorded.requestHash = keccak256(prompt) | `0xcbb15b2e2360354ad1fb6476e3cb9ac96c3f88e3a9dfec2f036ce7eb87cc6fb2` |
| ✅ | mcp: JobRecorded.resultHash = keccak256(result) | `0xc3a81d34e295db5e289ec3cd90aa47750df7060da8a9cfba409bb772de7c20d4` |
| ✅ | mcp: JobRecorded.ok | true |
| ✅ | mcp: the broker's receiptTxHash is that transaction | `0x7939beebbcecb559a02480d39a515e729f047644783a7dffc07edd4991bae258` |
| ✅ | private: JobRecorded | `0xa8955b9725cd1e9de6b963d214b8c7edc64bb12ca14a4bdf5f3c17dc1b3f882e` |
| ✅ | private: JobRecorded.agentId | 1933 |
| ✅ | private: JobRecorded.buyer | `0xf451EfD3FDb960609C8Bd900b76d56bEf371A305` |
| ✅ | private: JobRecorded.payTo | `0x638a93cC33417Ba6bb2863a3Ed284DE2011c2A6f` |
| ✅ | private: JobRecorded.amount | 40000 |
| ✅ | private: JobRecorded.paymentTx is the settlement | `0x1374b9894aa018093b8070ddb7533d5d3646fb8361788a0c08b6e807e1230dc2` |
| ✅ | private: JobRecorded.requestHash = keccak256(prompt) | `0xe1c137d1514156dc6ed0488e261ed00e390f9712022e4a4ac1c8cdd2bdca073c` |
| ✅ | private: JobRecorded.resultHash = keccak256(result) | `0xd9ada6ce33adc41b3a11f71fa16268ef9bc3b15e38e987f3e05123ee491c56c6` |
| ✅ | private: JobRecorded.ok | true |
| ✅ | private: the broker's receiptTxHash is that transaction | `0xa8955b9725cd1e9de6b963d214b8c7edc64bb12ca14a4bdf5f3c17dc1b3f882e` |
| ✅ | private: the on-chain resultHash is keccak256 of the sealed envelope | `0xd9ada6ce33adc41b3a11f71fa16268ef9bc3b15e38e987f3e05123ee491c56c6` |
| ✅ | cli: JobRated | `0xe57f76646d740be62a63efd9f8d957ae0d54fd8e7a1cf8709b1ce4c971c55ec3` |
| ✅ | cli: JobRated.value | 87 |
| ✅ | cli: JobRated.buyer | `0xf451EfD3FDb960609C8Bd900b76d56bEf371A305` |
| ✅ | cli: JobRated.agentId | 1933 |
| ✅ | cli: ledger.jobs() marks it rated |  |
| ✅ | mcp: JobRated | `0x1c3dc0888c2ca4b522974e310fc987b5269e32f724b79ae93ba1854890630fda` |
| ✅ | mcp: JobRated.value | 64 |
| ✅ | mcp: JobRated.buyer | `0xf451EfD3FDb960609C8Bd900b76d56bEf371A305` |
| ✅ | mcp: JobRated.agentId | 1933 |
| ✅ | mcp: ledger.jobs() marks it rated |  |
| ✅ | cli: the relay tx the broker returned is the JobRated tx | `0xe57f76646d740be62a63efd9f8d957ae0d54fd8e7a1cf8709b1ce4c971c55ec3` |
| ✅ | private: not rated |  |

### On-chain: ERC-8004 reputation (canonical Reputation Registry)

| | Check | Detail |
|---|---|---|
| ✅ | cli: Kimi's NewFeedback (tag1 "xorv-verified") | `0x995d47a0a720591da022d96c9eb8dcc7fcec26827d253a5595dc846c527559d0` |
| ✅ | cli: verifier feedback client is the verifier EOA | `0x9f6CCADa976aE9e63B09DE00FD4FF77A71Ed5ACA` |
| ✅ | cli: verifier feedback value | 92 |
| ✅ | cli: verifier feedback tag2 is the adapter | qwen |
| ✅ | cli: verifier feedbackURI | http://127.0.0.1:61084/verifications/job_iBJ7r7H6N6Si.json |
| ✅ | cli: served verification file hashes to the on-chain feedbackHash | `0x54016d73db264f9568f11e3905a3ebc5385dbb81a4a38f43b4e1c955c17c604d` |
| ✅ | mcp: Kimi's NewFeedback (tag1 "xorv-verified") | `0x6478bffe52da2d959a5aef450093c5852e1395157cd3be1a1447e9b51eb85580` |
| ✅ | mcp: verifier feedback client is the verifier EOA | `0x9f6CCADa976aE9e63B09DE00FD4FF77A71Ed5ACA` |
| ✅ | mcp: verifier feedback value | 92 |
| ✅ | mcp: verifier feedback tag2 is the adapter | echo |
| ✅ | mcp: verifier feedbackURI | http://127.0.0.1:61084/verifications/job_fDwGrx_KTsW2.json |
| ✅ | mcp: served verification file hashes to the on-chain feedbackHash | `0xfdd6b363e00a9332de63306566ca02d2b4541b7358099a1d40e743a0c728512a` |
| ✅ | private: no verifier feedback | 2 xorv-verified entries |
| ✅ | cli: the buyer's rating as NewFeedback (tag1 "starred") | `0xe57f76646d740be62a63efd9f8d957ae0d54fd8e7a1cf8709b1ce4c971c55ec3` |
| ✅ | cli: rating feedback client is XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | cli: rating feedback value | 87 |
| ✅ | cli: rating endpoint is the broker's jobs service | http://127.0.0.1:61084/api/quotes |
| ✅ | cli: served feedback file hashes to the on-chain feedbackHash | `0x9c68656e57daba089addc59b385e259b80ef60e8f62eff3eed7d5fc963e32a2e` |
| ✅ | mcp: the buyer's rating as NewFeedback (tag1 "starred") | `0x1c3dc0888c2ca4b522974e310fc987b5269e32f724b79ae93ba1854890630fda` |
| ✅ | mcp: rating feedback client is XorvLedger | `0xC0BF43A4Ca27e0976195E6661b099742f10507e5` |
| ✅ | mcp: rating feedback value | 64 |
| ✅ | mcp: rating endpoint is the broker's jobs service | http://127.0.0.1:61084/api/quotes |
| ✅ | mcp: served feedback file hashes to the on-chain feedbackHash | `0x5ee3b0d64f906c9517b82b4fb86d8fb42b88308e54fb9e347a01851ae9b12919` |
| ✅ | cli: rating feedbackHash is what the buyer signed | `0x9c68656e57daba089addc59b385e259b80ef60e8f62eff3eed7d5fc963e32a2e` |
| ✅ | getSummary([ledger], "starred").count | 2 |
| ✅ | getSummary([ledger], "starred") is the registry's mean of those NewFeedback values | 75 (0 decimals) |
| ✅ | getSummary([verifier], "xorv-verified").count | 2 |
| ✅ | getSummary([verifier], "xorv-verified") is the registry's mean of those NewFeedback values | 92 (0 decimals) |
| ✅ | getClients lists XorvLedger and the verifier | 0x9f6CCADa976aE9e63B09DE00FD4FF77A71Ed5ACA, 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 |

### The broker's own views agree with the chain

| | Check | Detail |
|---|---|---|
| ✅ | ledger feed source (RPC scan of the fork) | rpc |
| ✅ | ledger feed links all three receipts to their jobs | job__6ueSr-FO2Il, job_fDwGrx_KTsW2, job_iBJ7r7H6N6Si |
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
| ✅ | earnings: cli carries its settlement tx | `0x07f52c447a469356f689f69d30b571f9b1eff4a3448fc6c15845a76e82c1be9d` |
| ✅ | earnings: mcp job recorded as ok | 1000 units |
| ✅ | earnings: mcp amount is the settled USDC | 1000 |
| ✅ | earnings: mcp carries its settlement tx | `0x8af6967bc1617cfc09ff825c8926c2583f95221b323511e2509806a41dd61014` |
| ✅ | earnings: private job recorded as ok | 40000 units |
| ✅ | earnings: private amount is the settled USDC | 40000 |
| ✅ | earnings: private carries its settlement tx | `0x1374b9894aa018093b8070ddb7533d5d3646fb8361788a0c08b6e807e1230dc2` |
| ✅ | earnings total is the provider's on-chain USDC balance | 81000 |

### The private answer never touched the broker's disk

| | Check | Detail |
|---|---|---|
| ✅ | broker database exists | 4096 bytes |
| ✅ | the private job is in the broker's database |  |
| ✅ | the answer is not (in the database or its WAL) |  |

## Step log

**preflight**

- run directory E:\Projects\xorv-monad-wt\cli\e2e\.runs\2026-09-26T19-51-48-312Z-83W76I
- forking https://testnet-rpc.monad.xyz at its latest block

**start the mock OpenAI-compatible model server**

- listening on http://127.0.0.1:34762 (/qwen/v1, /kimi/v1, /hunyuan/v1)

**fork Monad testnet (Hardhat 3 / EDR, chain id 10143)**

- serving http://127.0.0.1:34763, forked at block 65936409

**fund the parties**

- minted $5.00 of USDC through the token's masterMinter 0x87f2e95621D8f12b83bb4a3E9975c0eAd524D437 (configureMinter 0xde631874d1b7a05546ed82701ce5d633ed59e5782c01ef2ded026aa732fa29e0, mint 0x9ed17ec4704c4b5a023dd5a76e7c60e8ee6b9c02a69d585bb0f16035a5e67fa8)

**deploy XorvLedger with packages/contracts' deploy script**

- XorvLedger at 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (block 65936412, tx 0x06a91309e1b3877d3b161224a25372440402ba9e95128114ddc3838a56955bbe)

**start the broker (services/broker, self-hosted facilitator, AI roles on the mock)**

- listening on http://127.0.0.1:61084

**provider: register an ERC-8004 identity (xorv identity register)**

- registered as agent #1933

**provider: go live (xorv start)**

- provider prv_UHvhRjXkeI1s connected, agent #1933
- ProviderRegistered in 0xd089664608818fd1307c31d3c92eaf2e68862b3b2a05366535f3e52511bec262

**Hunyuan screen refuses an abusive prompt before any quote**

- the safety screen refused this prompt: asks the agent to read and send out the provider's keys

**buyer: xorv run --json (Qwen routes, x402 pays, qwen adapter answers)**

- job job_iBJ7r7H6N6Si completed in 5.1s; paid in 0x07f52c447a469356f689f69d30b571f9b1eff4a3448fc6c15845a76e82c1be9d

**Kimi verifies the result and writes ERC-8004 feedback**

- score 92/100 by kimi-k3; giveFeedback 0x995d47a0a720591da022d96c9eb8dcc7fcec26827d253a5595dc846c527559d0

**buyer rates the job through the broker API (EIP-712, gasless)**

- rateJob relayed in 0xe57f76646d740be62a63efd9f8d957ae0d54fd8e7a1cf8709b1ce4c971c55ec3

**agent buyer: the MCP server over stdio (xorv_run_job, xorv_rate_job)**

- job job_fDwGrx_KTsW2
- Relayed on-chain: https://testnet.monadscan.com/tx/0x1c3dc0888c2ca4b522974e310fc987b5269e32f724b79ae93ba1854890630fda

**private job through the broker API (sealed to the buyer's inbox key)**

- job job__6ueSr-FO2Il completed; settlement 0x1374b9894aa018093b8070ddb7533d5d3646fb8361788a0c08b6e807e1230dc2
- receipt 0xa8955b9725cd1e9de6b963d214b8c7edc64bb12ca14a4bdf5f3c17dc1b3f882e

**on-chain: x402 settlements (real USDC, facilitator pays gas)**

- cli: 0x07f52c447a469356f689f69d30b571f9b1eff4a3448fc6c15845a76e82c1be9d — 40000 0xf451EfD3FDb960609C8Bd900b76d56bEf371A305→0x638a93cC33417Ba6bb2863a3Ed284DE2011c2A6f; gas 102808
- mcp: 0x8af6967bc1617cfc09ff825c8926c2583f95221b323511e2509806a41dd61014 — 1000 0xf451EfD3FDb960609C8Bd900b76d56bEf371A305→0x638a93cC33417Ba6bb2863a3Ed284DE2011c2A6f; gas 85696
- private: 0x1374b9894aa018093b8070ddb7533d5d3646fb8361788a0c08b6e807e1230dc2 — 40000 0xf451EfD3FDb960609C8Bd900b76d56bEf371A305→0x638a93cC33417Ba6bb2863a3Ed284DE2011c2A6f; gas 85728

**on-chain: XorvLedger events**

- 1 ProviderRegistered, 1 ProviderHeartbeat, 3 JobRecorded, 2 JobRated

**on-chain: ERC-8004 reputation (canonical Reputation Registry)**

- xorv-verified/qwen 92 from 0x9f6CCADa976aE9e63B09DE00FD4FF77A71Ed5ACA (0x995d47a0a720591da022d96c9eb8dcc7fcec26827d253a5595dc846c527559d0); starred/qwen 87 from 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (0xe57f76646d740be62a63efd9f8d957ae0d54fd8e7a1cf8709b1ce4c971c55ec3); xorv-verified/echo 92 from 0x9f6CCADa976aE9e63B09DE00FD4FF77A71Ed5ACA (0x6478bffe52da2d959a5aef450093c5852e1395157cd3be1a1447e9b51eb85580); starred/echo 64 from 0xC0BF43A4Ca27e0976195E6661b099742f10507e5 (0x1c3dc0888c2ca4b522974e310fc987b5269e32f724b79ae93ba1854890630fda)

**the broker's own views agree with the chain**

- /api/ledger?kind=receipts: 3 receipts from rpc
