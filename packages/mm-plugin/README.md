# @xorv/mm-plugin

A [MetaMask Agent Wallet](https://docs.metamask.io/agent-wallet/) plugin that lets an agent **buy AI work
from the Xorv network and pay for it from its MetaMask wallet**, one job at a time, in USDC over
[x402](https://www.x402.org/) on Monad.

```bash
mm xorv run "Explain EIP-3009 in two paragraphs" --max 0.05
```

That one command gets a quote from the Xorv broker and checks it. It then has **MetaMask sign** the
EIP-3009 `TransferWithAuthorization` through `ctx.walletExecutor`, so the user's MetaMask policy
decides, and retries with the x402 `PAYMENT-SIGNATURE` header. The job runs on a stranger's idle
Claude Code / Codex / Qwen / Kimi / Hunyuan capacity. The command returns the answer, the Monad
settlement link and the XorvLedger receipt. The USDC goes straight from the user's wallet to the
provider. The broker never holds it, and the wallet needs no MON because the facilitator pays the gas.

- **Commands:** `mm xorv providers`, `quote`, `run`, `job`, `rate`
- **Chains:** Monad testnet `10143` (default broker network) and Monad mainnet `143`. Both are
  preconfigured in Agent Wallet, and Transaction Shield covers mainnet.
- **Signing:** only through MetaMask's wallet executor. The plugin never sees a key, a session or a
  seed phrase.
- **Licence:** MIT

## What each command needs

The capabilities are declared per command in [`package.json#mm`](./package.json). The install consent
screen shows them.

| Command | What it does | Capabilities | Data access |
|---|---|---|---|
| `mm xorv providers [--adapter] [--all]` | Lists live providers: agent, price per job, ERC-8004 agent id, success rate and buyer ratings | none | none |
| `mm xorv quote "<task>" [--adapter] [--max]` | Prices a job without paying: provider, exact USDC amount, payee | none | none |
| `mm xorv run "<task>" [--adapter] [--max] [--chain-id] [--timeout] [--from]` | Quote → 402 → MetaMask-signed EIP-3009 → paid job → result + settlement link | `wallet-read`, `wallet-submit` | `accounts`, `balances` |
| `mm xorv job <jobId>` | Reads a job back: status, result, payment, receipt | none | none |
| `mm xorv rate <jobId> --stars 1-5` | Gasless EIP-712 rating from the payer, relayed as ERC-8004 reputation | `wallet-read`, `wallet-submit` | `accounts` |

The plugin-wide `capabilities` list is empty. `wallet-read` reads which address pays and its USDC
balance (`ctx.walletStateManager`, `ctx.publicClient(chainId)`). `wallet-submit` gives
`ctx.walletExecutor` for **typed-data signatures only**. The plugin never submits a transaction.

## How a paid job works

```
mm xorv run "<task>"
 │ 1  POST /api/quotes ─────────────────────► broker: frozen quote {provider 0x…, agentId, usdcAmount}, 5-min TTL
 │ 2  vetQuote: Monad only, price ≤ --max, amount == price, accepts row == provider+amount, not paying yourself
 │ 3  USDC balanceOf(payer) via ctx.publicClient(10143)   (skips a 2FA prompt for a payment that can't settle)
 │ 4  POST /api/jobs/:quoteId ─────────────► 402  PAYMENT-REQUIRED {exact, eip155:10143, USDC, amount, payTo: provider,
 │                                                                   extra: {name: "USDC", version: "2"}}
 │ 5  buyerX402Client policies: exact-USDC on this chain, ≤ --max, and payTo/amount == the quote
 │ 6  @x402/evm builds TransferWithAuthorization → ClientEvmSigner.signTypedData
 │        └─► ctx.walletExecutor({kind: "typed-data", chainId, typedData, intent})   ◄── MetaMask policy / 2FA
 │ 7  recover the signature, check it is the payer
 │ 8  POST /api/jobs/:quoteId + PAYMENT-SIGNATURE ─► facilitator settles on Monad (buyer → provider), job dispatched
 │ 9  GET /api/jobs/:id/stream (SSE; polling fallback) ─► result
 ▼ 10 { result, payment.explorerUrl, receiptExplorerUrl, rate: "mm xorv rate <id> --stars 5" }
```

MetaMask's x402 support covers the `exact` scheme with EIP-3009 only, and it needs the token's EIP-712
`name`/`version` in `extra`. Xorv's broker offers exactly that: Monad USDC, `name: "USDC"`,
`version: "2"`.

### The checks that keep the buyer safe

On EVM, whoever holds a signed EIP-3009 authorization can spend it. So the plugin checks everything it
can **before** MetaMask is asked. None of it is left to the broker.

1. **The quote is vetted** ([`src/lib/vet.ts`](./src/lib/vet.ts)). The chain must be one the manifest
   targets, and must match `--chain-id` if given. The price must be at or under `--max`. The frozen
   USDC amount must equal the quoted price, and the advertised `accepts` row must pay that amount to
   that provider. The provider must not be the buyer.
2. **The 402 must match the quote.** `buyerX402Client` from `@xorv/protocol` registers the exact scheme
   for one network only. It adds a USDC-only policy, a per-payment spend cap of `--max`, and
   `quoteMatchPolicy`, which refuses any requirement whose payee, amount, asset or network differs
   from the frozen quote. A broker cannot swap the payee between quote and payment.
3. **The signature is checked before sending** ([`src/lib/executor.ts`](./src/lib/executor.ts)). The
   plugin recovers the signer and compares it with the payer named in the authorization. A wrong
   active wallet, or a wallet that hashed the typed data differently, fails with
   `XORV_SIGNER_MISMATCH` instead of an unexplained 402.
4. **MetaMask's policy applies on top.** This covers Guard Mode allowlists, threat scanning and 2FA.
   The request carries a readable intent such as
   `Xorv: pay 0.0100 USDC to 0x7099… (alice-mbp, claude-code) for one AI job, quote qte_… — x402 exact, EIP-3009`,
   and that text is what the user sees when approving.

One detail makes MetaMask's signature verify: the typed data sent to the executor spells out
`EIP712Domain`. MetaMask's JSON-RPC signer (`eth-sig-util`) hashes the domain using whatever
`types.EIP712Domain` says. If the entry is missing, it hashes an empty domain, and the result is a
valid signature over the wrong digest. viem adds the entry for JSON-RPC wallets, and
`toWalletTypedData` does the same. Integer fields cross the JSON boundary as decimal strings.

### Ratings

`mm xorv rate` fetches the broker's proposed `Rating` typed data (`GET /api/jobs/:id/rating?value=`).
It then **rebuilds it locally** with `ratingTypedData` from `@xorv/protocol`, against the XorvLedger
address in `/api/network`, and checks the domain, chain, contract, job-id hash, value, deadline and
feedback file field by field. MetaMask signs the plugin's own copy, and the plugin posts
`{value, deadline, signature}` to `/api/jobs/:id/rate`. The broker relays it to
`XorvLedger.rateJob`. The contract checks that the signer is the job's payer and forwards
`giveFeedback` to the ERC-8004 Reputation Registry. One to five stars map to 20–100, the same scale
the Xorv web app uses.

## Install

Agent Wallet plugins are a beta feature. Enable them once:

```bash
mm config set experimentalPlugins true
```

### From npm

Once the package is published, install it with:

```bash
mm plugins install @xorv/mm-plugin            # shows the consent screen: commands, capabilities, chains
```

### From this repository (local development)

A local install links the package directory. Build it in the workspace first, so that `dist/`,
`oclif.manifest.json` and the `@xorv/protocol` workspace dependency are all in place:

```bash
pnpm install
pnpm --filter @xorv/protocol build
pnpm --filter @xorv/mm-plugin build          # tsc + oclif manifest

mm config set experimentalAllowUnverifiedInstalls true   # local file: installs are development-only
cd packages/mm-plugin
mm plugins install "file:$PWD" --accept-permissions      # bash / zsh
# PowerShell:  mm plugins install "file:$((Get-Location).Path)" --accept-permissions
```

Install from the directory, not from a packed tarball. That way Agent Wallet reads `package.json#mm`
and records the capability approvals. After changing the manifest, run
`mm plugins uninstall @xorv/mm-plugin` and install again, because the approval is bound to the
manifest hash.

### Publishing

`@xorv/mm-plugin` depends on `@xorv/protocol` through `workspace:*`. **Publish with pnpm, not npm**:
`pnpm publish` rewrites the workspace range to the real version, and `prepack` builds `dist/` and
`oclif.manifest.json`. Publish the protocol package first:

```bash
pnpm --filter @xorv/protocol publish --access public
pnpm --filter @xorv/mm-plugin publish --access public
```

The tarball contains `dist/`, `oclif.manifest.json` (Agent Wallet refuses a plugin without a prebuilt
manifest), `skills/`, this README and the licence. `@metamask/agent-wallet` is a **peer**
dependency, so the plugin binds to the running `mm` instead of loading a second copy. The manifest
requires Agent Wallet `^7.0.0`. The host checks `minCliVersion` with `semver.satisfies`, so the
template's `^6.2.0` would refuse every 7.x release.

## Configure

| Setting | How | Default |
|---|---|---|
| Broker | `--broker <url>` or `XORV_BROKER_URL` | `http://localhost:8402` |
| Spend ceiling per job | `--max <usd>` | `0.05` |
| Pin the chain | `--chain-id 10143` or `--chain-id 143` | whatever the broker quotes, if it is Monad |
| Wait for the job | `--timeout <seconds>` (5–3600) | `600` |
| Paying wallet | `--from <0x…>` | the selected Agent Wallet EVM wallet |

The payment URL is always built from the broker URL you configured, never from the `payUrl` the
broker returns. Test USDC is at <https://faucet.circle.com> (pick Monad Testnet). No MON is needed to
buy.

## Example session

The `providers` and `quote` output below is real, trimmed and reflowed for space. It comes from Agent Wallet 7.0.0 on Windows, with
this plugin installed from the directory, talking to a local stand-in broker. The `run` and `rate`
blocks show what the commands print against a live broker, but the hashes and job ids in them are
**placeholders**. Those two commands need a signed-in MetaMask wallet holding test USDC.

```text
$ mm xorv providers --format text
broker:    http://127.0.0.1:8402
network:   eip155:10143
count:     1
providers:
  - id: prv_alice
    label: alice-mbp
    status: online
    address: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
    agentId: 42
    agentUrl: https://testnet.monadscan.com/nft/0x8004A818BFB912233c491871b3d84c89A494BD9e/42
    from: $0.0040
    capabilities:
      - adapter: claude-code
        name: Claude Code
        price: $0.0100
      - adapter: qwen
        name: Qwen 3.8 Max
        model: qwen3.8-max
        price: $0.0040
    jobsCompleted: 9
    jobsFailed: 1
    successRate: 0.9
    reputation:
      ratingsCount: 3
      avgRating: 80
      stars: ★★★★☆

Hint: 1 provider online; cheapest $0.0040 (alice-mbp). Next: mm xorv quote "<task>"

$ mm xorv quote "Write a haiku about Monad" --max 0.02 --format text
quoteId:          qte_smoke
network:          eip155:10143
chainId:          10143
price:            $0.0100
usdcAmount:       10000
usdc:             0.0100 USDC
max:              $0.0200
expiresInSeconds: 287
provider:
  label: alice-mbp
  address: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
  agentId: 42
  adapter: claude-code
payTo:            0x70997970C51812dc3A010C7d01b50e0d17dc79C8
asset:            0x534b2f3A21130d7a60830c2Df862319e593943A3

Hint: $0.0100 (0.0100 USDC) to alice-mbp via claude-code, valid 287s. Pay and run it with: mm xorv run "<same task>" --max 0.0200

$ mm xorv quote --prompt "Write a haiku" --max 0.005 --json
{ "ok": false, "error": { "code": "XORV_QUOTE_REFUSED",
  "message": "quoted $0.0100, above your --max of $0.0050", "hint": "Raise --max if that price is acceptable." } }

$ mm xorv run "Write a haiku about Monad" --max 0.02          # placeholders below
Quote qte_Q3k…: $0.0100 to alice-mbp (claude-code, ERC-8004 agent #42) on Monad Testnet
Paying 0.0100 USDC to 0x7099…79C8 from 0x1a2B…9fE0 — approve in MetaMask if asked
[AWAITING_MFA] Approve the signature request in MetaMask Mobile          # Guard Mode only
Paid: https://testnet.monadscan.com/tx/0x5c1d…e2a7
Job job_Vb7… is assigned on alice-mbp
  › Drafting the haiku…
Done in 9.4s
jobId:   job_Vb7…
status:  completed
result:  Ten thousand lanes wide / blocks land before you blink / parallel sunrise
payment:
  txHash:      0x5c1d…e2a7
  explorerUrl: https://testnet.monadscan.com/tx/0x5c1d…e2a7
receiptExplorerUrl: https://testnet.monadscan.com/tx/0x91f0…44bc
rate:    mm xorv rate job_Vb7… --stars 5

Hint: Paid $0.0100 to alice-mbp: https://testnet.monadscan.com/tx/0x5c1d…e2a7. Rate it: mm xorv rate job_Vb7… --stars 5

$ mm xorv rate job_Vb7… --stars 5                             # placeholders below
Rated ★★★★★ — relayed to ERC-8004: https://testnet.monadscan.com/tx/0x7e22…0b19
```

With `--json`, stdout carries a single envelope, `{"ok": true, "data": {…}, "hint": "…"}`. Progress
lines are human-only, and the host drops them in structured mode. Failures print
`{"ok": false, "error": {"code", "message", "hint"}}` on stderr and exit 1.

### Error codes

| Code | When |
|---|---|
| `XORV_INVALID_INPUT` | a missing prompt or job id, a bad `--max`, `--stars`, `--chain-id`, `--timeout` or `--from` |
| `XORV_BROKER_UNREACHABLE` / `XORV_BROKER_ERROR` | no broker at the URL, or the broker refused the request (its message is included) |
| `XORV_NO_PROVIDERS` | no online provider under the ceiling |
| `XORV_UNSUPPORTED_NETWORK` | the broker is not on Monad, or not on the `--chain-id` chain |
| `XORV_QUOTE_REFUSED` | over `--max`, an inconsistent quote, an expired quote, or paying yourself |
| `XORV_NO_WALLET` | no EVM wallet in Agent Wallet |
| `XORV_INSUFFICIENT_USDC` | balance below the price (checked before signing, or reported by the facilitator) |
| `XORV_SIGNATURE_DENIED` / `XORV_SIGNATURE_PENDING` | MetaMask refused, or is still waiting for approval (a polling id is included) |
| `XORV_SIGNER_MISMATCH` | the signature is not from the payer the authorization names |
| `XORV_PAYMENT_REFUSED` | the 402 did not match the quote, or the facilitator rejected the payment (the x402 reason is included) |
| `XORV_JOB_FAILED` / `XORV_JOB_TIMEOUT` | the paid job failed after the network's free retries, or is still running (`mm xorv job <id>`) |
| `XORV_RATING_REFUSED` | the broker's proposed rating did not match what the plugin rebuilt, or the broker has no ledger |

## Companion agent skill

[`skills/xorv-metamask/SKILL.md`](./skills/xorv-metamask/SKILL.md) teaches an agent (Claude Code or any
agent that reads skills) how to use `mm xorv run` well:

- write prompts that stand alone;
- respect `--max`;
- handle the `[AWAITING_MFA]` pause;
- always report the answer, who ran it, what it cost and the settlement link;
- offer a rating.

It ships in the npm package. To install it for Claude Code, copy the folder to
`~/.claude/skills/xorv-metamask/`, or to `.claude/skills/` for one project.

## Development

```bash
pnpm --filter @xorv/mm-plugin typecheck   # src (template tsconfig) + tests
pnpm --filter @xorv/mm-plugin test        # vitest, no network
pnpm --filter @xorv/mm-plugin build       # tsc + oclif manifest
```

The tests need no credentials and no network. The broker is a scripted `fetch`, and MetaMask is a fake
executor that signs the way MetaMask's JSON-RPC signer does. That fake rejects anything that would not
survive `JSON.stringify` and hashes `EIP712Domain` literally. The command classes run on the real
`PluginCommand` base and input engine from `@metamask/agent-wallet/plugin`, with a mocked restricted
context:

| File | Covers |
|---|---|
| `test/commands.test.ts` | every command end to end on a mocked `ctx`: executor source ids, the typed data and intent sent to MetaMask, balance gating, denials, failed jobs, ratings |
| `test/executor.test.ts` | the signer adapter produces a 65-byte signature over a complete `TransferWithAuthorization` that verifies against Monad USDC's domain; a missing `EIP712Domain` and a wrong wallet are both caught |
| `test/policy.test.ts` | quotes, and 402s that swap the payee, bump the amount, change the asset or exceed `--max`, are refused, and MetaMask is never asked |
| `test/flows.test.ts` | SSE with polling fallback and timeout; a tampered rating proposal is refused; wallet selection |
| `test/manifest.test.ts` | `package.json#mm` passes MetaMask's own `PluginManifestSchema`; the ids match the command classes |

### Source map

| Path | Role |
|---|---|
| `src/commands/xorv/*.ts` | the five `PluginCommand` classes (the file path defines the id, e.g. `xorv/run.ts` → `xorv:run`) |
| `src/lib/executor.ts` | `ctx.walletExecutor` → x402 `ClientEvmSigner` + EIP-712 signing, the `EIP712Domain` and bigint handling, signer recovery |
| `src/lib/pay.ts` | the x402 payment (`buyerX402Client` + `wrapFetchWithPayment`), settlement parsing, the USDC balance check |
| `src/lib/vet.ts` | quote checks before signing |
| `src/lib/rate.ts` | rating verification and signing |
| `src/lib/flows.ts` | each command's logic, with explicit dependencies |
| `src/lib/broker.ts`, `src/lib/sse.ts`, `src/lib/job.ts` | the broker HTTP API, the SSE reader, and following a job to its end |
| `src/lib/host.ts`, `src/lib/inputs.ts` | the seam to `mm`: context adapters, `CommandError` mapping, input schema |

The plugin reuses `@xorv/protocol` for network config (`networkConfig`, USDC addresses and EIP-712
domain), the x402 buyer client and quote policy (`buyerX402Client`, `quoteMatchPolicy`), rating typed
data (`ratingTypedData`, `jobIdHash`), explorer links, money formatting and the broker's wire types. It
makes no changes to the protocol package.

## Limits

- Agent Wallet plugins are beta, and so is this plugin. A local `file:` install needs
  `experimentalAllowUnverifiedInstalls`.
- MetaMask wallets are EOAs, so the signature check uses plain ECDSA recovery. A smart-contract wallet
  (ERC-1271) would fail `XORV_SIGNER_MISMATCH` here, even though the facilitator could accept it.
- The EIP-3009 authorization is valid for the quote's `maxTimeoutSeconds`, 300 s from Xorv's broker.
  If a Guard Mode 2FA approval takes longer, the payment expires unspent. Run the command again.
- `run` always takes a fresh quote. `quote` is a preview, and its quote id cannot be paid later.
