# Security

Xorv runs untrusted prompts on volunteers' machines and moves real money on Monad. This document
says what is protected, what isn't, and where the line is, because a security page that only lists
reassurances is worse than none.

---

## Reporting

Email **niveshgajengi@gmail.com**. Please don't open a public issue for something exploitable.

---

## The provider risk, stated plainly

**A Xorv provider executes prompts written by strangers, on their own machine, against their own
paid AI subscription or API key.** That is the product, and it is the risk.

### What Xorv does

**Before the job is sold.** When the broker runs the screen (on whenever `TOKENHUB_API_KEY` is set),
Hunyuan hy4 checks every quote request **before any provider sees the prompt**. It looks for
credential or key exfiltration, malware, destructive commands, sandbox escape and prompt injection
aimed at the node, and a block is a 422 with no quote. The quote freezes the screened request, so it
cannot be swapped afterwards. The screen is a filter, not a boundary: by default it fails *open*
(`XORV_SCREENER_FAIL=open`, recorded on the job as "not screened"), and a model can be talked past.
The sandbox below is the boundary.

**While the job runs.** Every job is spawned through `packages/cli/src/sandbox.ts`, which applies the
strongest containment the host can provide. `xorv doctor` names the active tier instead of just
saying "sandboxed".

| Tier | Where | What it enforces |
|---|---|---|
| `seatbelt` | macOS | Credential paths unreadable; writes confined to the job dir |
| `bwrap` | Linux with bubblewrap | Read-only root, private home, writes confined to the job dir |
| `container` | opt-in, any host | Full isolation: the job never sees the host filesystem |
| `limits` / `env` | fallback (and Windows) | Resource caps and a scrubbed environment; **no filesystem boundary** |

On every tier:

- **The environment is an allowlist, not the operator's shell.** A job receives `PATH`, `HOME`,
  locale and proxy settings. It does not receive `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, the
  sponsor-model keys (`DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY`, `TOKENHUB_API_KEY`), or a variable some
  vendor invents next year. The `qwen`, `kimi` and `hunyuan` adapters read their keys in-process and
  spawn nothing. `qwen-code` gets the Qwen key as `OPENAI_*` in its own child environment only, never
  on argv.
- **Resource limits** cap CPU seconds, file size and process count.
- **A fresh directory per job**, deleted when the job ends. Job ids are sanitised before being used
  as path components.
- **`XORV_SAFE_MODE=1`** disables tools entirely and leaves pure text generation.
- **Timeouts kill the process group**, not just the direct child.

Under `seatbelt` and `bwrap`, a job cannot read **the Xorv home wherever `XORV_HOME` points** (plus
`~/.xorv`, where an older key may sit), `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.npmrc`,
`~/.docker`, `~/.kube`, the macOS Keychain or browser profiles. Writes outside the job directory
fail.

#### The keychain, and why the node reads it for you

Claude Code authenticates by shelling out to `/usr/bin/security`. The obvious profile, letting the
agent reach its own credentials, leaves the Keychain readable, and a readable Keychain is not one
secret but all of them. So the node reads the agent's own token once at startup, outside the sandbox,
and injects only that token into each job (`packages/cli/src/credentials.ts`). The job runs with the
Keychain denied outright.

### What Xorv does not do

**A job can still read the agent session it is running.** The token is in the job's environment
because the agent needs it. That is the capacity being rented, not a boundary that can be closed
while the product works.

**Below `seatbelt`/`bwrap` there is no filesystem boundary at all.** On Windows, and on a Linux host
without bubblewrap, `doctor` reports `limits` or `env` and warns. For a real boundary on any host:

```bash
XORV_SANDBOX=container xorv start
```

The threat model to hold in your head is "someone I have never met gets to run code as me, for a
tenth of a cent".

### Address-only providers: nothing worth stealing

A provider never signs anything to get paid: the buyer signs, and the facilitator submits. So
`xorv init` can take **just a payout address** (for example the Privy wallet from the web app, or a
hardware wallet) and store no key at all. A prompt that escapes the sandbox on an address-only node
finds no payout key. Such a node loses only `xorv run` and `xorv identity register`, which need a key.

### Terms of service

Most consumer AI subscriptions are licensed to an individual, and reselling that capacity may breach
them. Xorv is infrastructure and does not decide this for you. The `qwen`, `kimi` and `hunyuan`
adapters use pay-as-you-go API keys, and `openai-compatible` can serve your own local models.

---

## Keys

| Key | Where it lives | What it can do | Notes |
|---|---|---|---|
| Provider payout key | `~/.xorv/config.json` (mode `0600`, dir `0700`), or `XORV_PRIVATE_KEY`; **optional** | Receives payments; registers the ERC-8004 identity | A hot key if present: it must work with no human there. Prefer address-only. Rotate with `xorv wallet new`. The CLI never prints it, and `xorv config --json` redacts it. |
| Buyer key for `xorv run` | `XORV_PAYER_KEY` / `XORV_PRIVATE_KEY` | Signs USDC authorizations | Never taken as a flag (argv shows up in `ps`). Use a different key from the payout key. |
| Broker operator key | `.env` / environment (`XORV_OPERATOR_KEY`) | XorvLedger writes (it is the ledger's `broker`), rating relays, and by default the verifier's feedback | Needs MON above Monad's ~10 MON reserve. Unset = read-only ledger. A leak lets someone forge receipts until the ledger owner rotates the broker (`setBroker`). Ratings still need the buyer's signature. |
| Facilitator key | `XORV_FACILITATOR_KEY` (defaults to the operator key) | Submits buyers' authorizations and pays their gas | Holds MON, never USDC. It cannot redirect a payment: the signed authorization fixes `to` and `value`. A separate key keeps settlements from queueing behind ledger writes. |
| Verifier key | `XORV_VERIFIER_KEY` (defaults to the operator key) | Writes Kimi's ERC-8004 feedback | Must never own or operate a provider's agent NFT (the registry refuses self-feedback). The broker checks `isAuthorizedOrOwner` first and keeps the feedback off-chain, with the reason, when an agent has authorized it. If separate, list it in the indexer's `ENVIO_XORV_VERIFIER_ADDRESSES`. |
| Ledger deployer | `XORV_DEPLOYER_KEY` (environment or Hardhat keystore), else the operator key | Pays for the deployment | Holds no role on the ledger afterwards. |
| Ledger owner | An address named at deploy time (`XORV_LEDGER_OWNER`); ideally a hardware or multisig wallet | Rotates the broker (`setBroker`), transfers ownership | Cannot touch receipts or ratings. The deploy script refuses, on Monad networks, an owner that is the broker or the operator key: whoever leaked that key could take ownership first, and the ledger could never be recovered. Keep it offline. |
| App demo payer | `apps/app/.env.local`, server-only (`XORV_DEMO_PAYER_KEY`) | Pays for visitors without a wallet, and signs ratings for jobs it paid | Testnet only (refused on mainnet), never `NEXT_PUBLIC_`. Capped per job (`XORV_DEMO_MAX_USDC_UNITS`) and per rolling 24 h (`XORV_DEMO_DAILY_USDC_UNITS`, default $5), rate-limited per IP and per deployment, one payment attempt per quote, and it rates only for the browser that paid (an HttpOnly, HMAC-signed demo receipt, 30 minutes, once per job). The counters are per server instance. |
| Sponsor-model API keys | broker and provider environment | Call Qwen, Kimi, Hunyuan | Sent only to each preset's own base URL, and scrubbed from any error text before it is logged or served (`services/broker/src/ai/client.ts`). |
| Privy app secret | MCP server environment | Drives the Privy server wallet | With `privy:setup --owner-key`, the secret alone can neither sign nor loosen the policy (see below). |

### Wallets that sign for buyers, and the policies around them

- **Privy embedded wallet (web app).** The key lives with Privy, and each signature shows Privy's
  confirmation. It signs only typed data here, because the facilitator and the rating relay pay all
  gas. The app hands the wallet on as a typed-data signer only.
- **Privy server wallet (MCP agent buyer).** The key never exists on the MCP host. `pnpm privy:setup`
  attaches a policy that Privy evaluates in its enclave on every request. It allows **only**
  `eth_signTypedData_v4` for USDC `TransferWithAuthorization` on this chain with `value ≤ cap`
  (optionally only to listed payees), plus typed data for the XorvLedger domain (ratings). Anything
  else is denied, including transactions, other tokens and other chains, even if the MCP host is
  compromised. **Limit:** Privy's typed-data policies cap *each signature*. Its rolling spend limits
  apply to transactions, not EIP-712. So the cumulative bound is enforced by the MCP server
  (`XORV_MAX_PRICE` per job, `XORV_SESSION_BUDGET_USD` per process, reserved before signing), and a
  compromised host could collect many in-policy signatures. Keep the cap small.
- **MetaMask Agent Wallet (`mm xorv`).** The plugin never sees a key, session or seed phrase. It
  asks `ctx.walletExecutor` for typed-data signatures with a readable intent, so MetaMask's own
  policy, Guard Mode allowlists, threat scanning and 2FA apply on top of the plugin's checks. It
  declares `wallet-submit` only on the two commands that sign, and never submits a transaction.
  **Limit:** the plugin checks the signer with plain ECDSA recovery, so ERC-1271 smart-contract
  wallets fail with `XORV_SIGNER_MISMATCH`.

---

## Payment safety

On EVM an x402 payment is an **EIP-3009 authorization**: a signature that lets whoever holds it
execute `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce)` on USDC once.
Everything below follows from that.

- **Replay.** Each authorization carries a random 32-byte `nonce`. The USDC contract records it
  (`authorizationState`) and refuses a second use, so a captured payment header cannot be settled
  twice. On the broker, a quote is single-use (`409 this quote has already been paid`), and a
  `paying` guard stops two concurrent payments for one quote from both settling.
- **Expiry.** `validBefore = now + 300 s`, the same window as the quote's TTL. An authorization
  that is never used expires unspent.
- **Interception only pays the intended provider.** The authorization fixes `to` and `value`, so
  whoever submits it can only move the quoted amount to the quoted provider. That is also why the
  facilitator key, hosted or self-hosted, cannot redirect funds.
- **Quote pinning, checked before signing.** A quote freezes the provider, address, agent and USDC
  amount, and both x402 requirement lookups read from it. Every Xorv buyer (web app, `xorv run`, MCP,
  `mm xorv`) refuses a 402 whose payee, amount, asset or network differs from the quote
  (`quoteMatchPolicy`), caps each payment, and pays at the broker URL it was configured with, never
  at a URL the broker returns. The CLI, MCP and MetaMask plugin also refuse to pay the buyer's own
  address.
- **Self-payment is refused by the broker and the ledger, not only by the clients.** A payment whose
  payer is the quoted provider's `payTo` gets 403 `self_payment` before anything settles (and an
  `onBeforeSettle` hook refuses it again). `XorvLedger` reverts `SelfDealing` on such a receipt,
  whoever writes it. It would otherwise mint a paid receipt and rating eligibility for the price of
  gas.
- **A provider that can't be reached is never paid.** The paid route answers 409 before payment when
  the quoted provider holds no control socket.
- **The broker is never the payee.** `payTo` is the provider's own address. A compromised broker
  could quote a different provider, but it cannot redirect money to itself without the buyer's
  client noticing the `payTo` it is signing for.
- **The facilitator checks before it broadcasts**: the scheme and network, the signature (ECDSA or
  ERC-1271), `to == payTo`, `value == amount` and the validity window. Monad's gas-limit billing is
  handled with `estimateGas` + 15% on every settlement.
- **Upfront settlement.** The payment lands on Monad before the job is created or dispatched, so a
  provider never works for a payment that fails to settle.

### What payment safety does *not* cover

Settlement happens **before** the job runs, so a provider can take the money and fail. The
mitigation is network-level: the job is reassigned to another provider at no extra charge (up to
three in total), and the failure counts against the original provider's success rate. **There is no
refund path.** A buyer's cancel stops the work and frees the slot, but the money has already moved.

---

## The on-chain record, and how far to trust it

- **XorvLedger's broker is the only writer** of registrations, heartbeats and receipts. A receipt
  is the broker's attestation, backed by a settlement transaction that anyone can check. The
  identity binding (`payTo == agentWallet`) and the one-rating-per-job rule are enforced by the
  contract, not asserted by the broker.
- **Ratings are payment-backed**: one per recorded job, signed by the wallet that paid (ECDSA, then
  ERC-1271), relayed with `clientAddress == XorvLedger`. The ledger refuses a rating from the agent's
  own wallet, owner or operators (`SelfDealing`), and the broker refuses to relay one between wallets
  Nansen links (one funded the other, a shared non-exchange funder, related wallets).
  **Self-dealing is still possible** from a second wallet with no traceable link, and the Nansen check
  binds only what the broker relays: `rateJob` stays open to the buyer directly. Faking a rating
  costs the price of a job. Weigh scores by distinct paying buyers (the indexer has every receipt's
  buyer).
- **Verifier scores are a separate signal** (`xorv-verified`, from the verifier EOA). They are an
  AI's opinion of a result, and the prompt and result are fenced as untrusted data so the result
  cannot instruct the grader.
- **ERC-8004 registries are upgradeable** by their maintainers' key. Xorv binds to the canonical
  deployments and does not control them.
- **Everything on-chain is public and permanent.** Receipts carry `keccak256` hashes of the prompt
  and the result, never the text. `requestHash` is unsalted, so a short, guessable prompt can be
  confirmed by guessing.

## Private jobs

A private job's result is sealed on the provider's machine to a key derived from the buyer's passkey
(Mera PRF), and the broker stores only the envelope. **The prompt is not private from the network**:
the broker, the Hunyuan screen, the Qwen router and the provider all read it. Public views withhold
the router's and screener's free-text reasons, because they paraphrase the prompt. Script running
on the app's origin can read keys while they are unlocked. A broker could serve an older genuine
version of the history vault. PRF support and an https domain are required. The full threat model, and the
tests that enforce each property, are in [docs/PRIVATE_JOBS.md §5](docs/PRIVATE_JOBS.md#5-threat-model).

## What the AI roles see

Hunyuan and Qwen read the buyer's prompt (Qwen at most its first 6,000 characters). Kimi reads the
prompt and the result of **non-private** jobs. Nothing else leaves the broker. Each role is off
unless its key is configured, and `GET /api/network` says which ones are on.

---

## Broker exposure

The broker is designed to face the internet:

- **Per-IP rate limits** on the free endpoints: quotes 30/min (a quote reserves a provider and costs
  nothing), registrations 10/min, rating relays 10/min (each costs the operator gas), vault writes
  20/min, and 10 new vaults per client per hour.
- A 256 KB body limit is applied before parsing, and a body without `Content-Length` (chunked) is
  counted as it streams. Prompts are capped at 20k characters. Expired quotes are pruned by the
  sweep, and at 10,000 open quotes new ones get 503.
- Proxy headers (`X-Forwarded-For`) are trusted **only** when `XORV_TRUST_PROXY=1`, and then the
  client address is read `XORV_TRUSTED_HOPS` entries from the right (default 1): the entries a
  client writes itself are never the ones used.
- **Registration cannot hijack a node.** Re-registering a node id whose session is live needs that
  session's bearer token (409 `node_live` otherwise), and an existing token is never returned to a
  caller who did not present it. Node ids never go on-chain (agent URIs name the provider id).
- Provider callbacks are authenticated by bearer token **and** checked against job ownership, so one
  provider cannot post results or heartbeats for another. Bearer tokens never appear in a public
  response. Every WebSocket frame a node sends is validated before it is handled, frames are capped
  at 8 MiB, and a handler that throws is caught, so a malformed frame cannot exit the broker.
- **Nansen spend is bound to connected providers.** A provider's wallet signal is bought when its node
  opens the control socket, not on the free registration, and 30% of the daily Nansen budget is
  reserved for the wash-rating guard. A guard check that can't run for lack of budget defers the
  rating (503 `trust_budget_spent`) instead of relaying it unchecked.
- **Vaults are bounded on disk.** Vault ciphertext lives in the store, not the heap: at most 176 KiB
  per vault and 1 GiB across all vaults (128 MiB when running without a durable store), after which
  new vaults get 507 while existing ones can still be rewritten.
- **Cancelling needs the buyer's one-time cancel token**, which is returned only in the payment
  response and stored as a hash. Job ids are public, so they are not capabilities.
- A rating is verified in the broker before any gas is spent, and an in-flight guard stops a
  double-submit from burning a second relay.
- CORS allows exactly the x402 request headers (including `PAYMENT-SIGNATURE`) and exposes
  `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`, for the configured origins.
- The node's own HTTP face (what an optional tunnel exposes) is read-only and binds to loopback.

### Known limitations

- **Public jobs are public.** `/api/jobs` serves the prompt and result of every non-private job.
  Use a private job for the answer; nothing hides the prompt from the network.
- **Rate limiting is per-process.** Running more than one broker needs shared state. The app's demo
  routes count per server instance too: a best-effort bound on a testnet float.
- **Success rate is computed from provider-reported outcomes.** A provider that returns garbage
  quickly still "succeeds". Kimi's verification and buyer ratings exist to catch this, but both are
  opt-in signals.
- **Registration without identity is allowed.** Anyone can register a label and a payout address.
  Only providers with a verified ERC-8004 agent get receipts and ratings bound to an identity.
- **The screen fails open by default.** Set `XORV_SCREENER_FAIL=closed` to refuse unscreened quotes.

These are acceptable for a testnet network. Each would need addressing before a mainnet deployment
with real money at stake.
