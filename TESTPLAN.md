# Test plan — Xorv on Arbitrum

Every component and every flow, each with an exact definition of correct. Executed in Claude in Chrome
against the running product; the console and network tab are checked on every item, and any error fails it.

**Environments**

- **L (local stack)** — `scripts/local-stack.sh` + `scripts/local-stack-run.sh`: a Nitro dev node (Arbitrum's
  node software, Stylus on) with Circle's production FiatTokenV2_2 (USDC), XorvRegistry (Stylus),
  XorvEscrow, XorvLog; the real broker (:8402), a provider node selling **Claude Code and Codex** (no echo),
  the app (:3302), the landing (:3300). Real signatures, real transactions, real models.
- **P (public)** — https://xorv-arbitrum.vercel.app, https://xorv-arbitrum-app.vercel.app,
  https://broker-production-38c5.up.railway.app on Arbitrum Sepolia, with XorvEscrow
  `0x383F5153db8Bb18c7c25157Fb3493645A465EeF3`, XorvRegistry (Stylus) `0x38b65014fee7c87d5e13afbc555388f612a7a2a1`
  and XorvLog `0x135738387e4bEC5573914F1A2A812728b9b268C8` (deployed 2026-10-02).

**Wallet items (E, C10)** use `apps/app/scripts/test-wallet.mjs`: the signing half of an EIP-1193 wallet,
holding a freshly generated key, transacting only on the local dev node. The page gets a `window.ethereum`
that forwards to it and announces itself with `ethereum#initialized`. Its network behaviour follows
MetaMask's — one active chain, 4902 for a chain it doesn't know until it is added, `chainChanged`, and a
refusal to sign typed data for any chain but the active one — and it can play the user switching network
or pressing Reject. Signatures and transactions are real; what it does not exercise is an extension's popup.

Status key: PASS · FAIL (→ fixed, re-run) · UNTESTED (reason).

**Final run: 2026-09-29, from the top, on a freshly deployed stack** (new contracts, new keys, empty
database) after every fix below — then again top to bottom after each later round of fixes, most recently
on 2026-09-30 after the wallet fixes, and finally on 2026-10-01 on a freshly deployed stack (new node,
contracts and keys, empty database) with the final code: every local item, 407 TypeScript, 54 Solidity and
47 Rust tests. Console errors: 0 on every page. Failed requests: 0 (the 422/400/402/409
responses are the items that test them).

---

## A. Landing page (L and P)

| # | Item | Correct means | Status |
|---|---|---|---|
| A1 | Load `/` | 200; hero headline, "Live on …" pill, CTA to the app; **0 console errors, 0 failed requests** | PASS |
| A2 | Nav anchors | Each nav item (How it works, Contracts, The network, Earn, Adapters, Receipts, Security, FAQ) scrolls to a section with that id | PASS |
| A3 | How it works | Six steps; step 04–06 describe escrow, release/refund, Stylus reputation | PASS |
| A4 | Contracts section | XorvEscrow verbs table (fund/release/reassign/refund), guarantees list, verbatim Rust excerpt; links go to the deployed contract (L: `/chain/address/<escrow>` resolving to a contract) or source (P) | PASS |
| A5 | Live network strip | Shows the broker's live numbers (providers live, jobs, paid) read from `/api/network` — no hard-coded figures | PASS |
| A6 | Receipts / ledger | Contract rows (escrow, registry, log, token) link to real addresses; receipts list is read from the chain (empty state if none) and says where each payment went (released / refunded to the buyer) | PASS |
| A7 | FAQ | Every question expands/collapses; answers describe escrow (not direct payment) | PASS |
| A8 | Footer links | Every on-chain link resolves (L: viewer page shows a contract; P: Arbiscan URL) | PASS |
| A9 | Mobile 375px | No horizontal scroll; no clipped content | PASS |
| A10 | "Open app" CTA | Goes to the app URL configured for that deployment | PASS |

## B. App — home / composer (L)

| # | Item | Correct means | Status |
|---|---|---|---|
| B1 | Load `/` | Headline says "held in escrow" (broker has escrow); recent jobs + live providers panels load from the broker; 0 console errors | PASS |
| B2 | Empty prompt | Quote button does nothing / explains; **no request** sent | PASS |
| B3 | Invalid budget (0, negative, letters) | Clear error, no quote | PASS |
| B4 | Budget below every price ($0.01) | Broker's reason shown: "no online provider under $0.0100 — the cheapest is $0.2000"; with the only node mid-job, "every provider selling codex is busy" (not "nobody sells it") | PASS |
| B5 | Valid quote (Codex, $0.50) | Quote card: provider `local-stack-node`, price $0.20, token USDC, escrow as payee + refund deadline; `POST /api/quotes` 200 | PASS |
| B6 | Model picker → Claude Code | This node's Claude Code login has expired, so it is marked unavailable and correct is a refusal naming it: "no online provider is selling claude-code right now" (422) — never a quote that would fail | PASS |
| B7 | Pay without a wallet (demo) | `POST /api/pay` → broker demo payer pays **through escrow**; redirected to job page; job id in URL | PASS |
| B8 | Start over / reset | "Cancel — nothing has been paid" removes the quote, keeps the prompt | PASS |
| B9 | Broker offline | App: "Can't reach the broker … nothing you've paid for is affected", headline makes no escrow/direct claim; landing: "broker unreachable — no live data to show"; no crash, 0 console errors | PASS |

## C. App — job page (L)

| # | Item | Correct means | Status |
|---|---|---|---|
| C1 | Live run | SSE events stream in (status, messages, tool calls) while the real model runs | PASS |
| C2 | Completed | Result rendered as markdown; status completed; duration | PASS |
| C3 | Receipt panel | Amount, payer (demo buyer), paid to = **escrow contract**, network | PASS |
| C4 | Escrow section | State goes funded → **released**; release tx link; contract link | PASS |
| C5 | Links | Deposit, release and receipt txs each open `/chain/tx/<hash>` showing **status success** and the decoded events (JobFunded / JobReleased + OutcomeRecorded / XorvLog Entry whose payload records `settlement: released → provider`) | PASS |
| C6 | On-chain effect | Provider's USDC balance = price; escrow balance 0; buyer −price; buyer ETH 0 | PASS |
| C7 | Cancel a running job | Status failed "cancelled by the buyer"; escrow **refunded** with `providerAtFault=false`; buyer balance restored; registry and broker stats record no failure | PASS |
| C8 | Failed job with no other provider | Provider killed mid-job → after 60 s grace, refunded with `providerAtFault=true`, registry failed +1, buyer restored, UI shows refunded | PASS |
| C9 | Unknown job id | "Job not found" empty state | PASS |
| C10 | Refund button after deadline | A wallet-paid job held funded past its deadline shows "refundable now, by anyone"; declining the refund in the wallet says the money is still in escrow; the button then sends `refund` from the wallet (tx success, wallet made whole); the broker reconciles it with that tx, stops the job on the node and frees its slot | PASS |

## D. App — other pages (L)

| # | Item | Correct means | Status |
|---|---|---|---|
| D1 | `/providers` | Lists the live node with capabilities, prices, **on-chain record** (registered; score/completed after jobs) | PASS |
| D2 | `/network` | Settlement panel; Contracts panel (escrow, registry links); audit log counts (or "no audit log configured"); receipts read from chain with their outcome | PASS |
| D3 | `/chain/tx/<hash>` | Status, block, from/to, gas, decoded events | PASS |
| D4 | `/chain/address/<addr>` | Kind (contract/account), ETH, USDC balance; token shows name/symbol/supply | PASS |
| D5 | Bad hash / bad address | "Not a transaction hash" / "Not an address"; a well-formed unknown hash says "Transaction not found" | PASS |
| D6 | 404 route | not-found page | PASS |

## E. Wallet (L)

| # | Item | Correct means | Status |
|---|---|---|---|
| E1 | Connect injected wallet | Address shown; balances read from the chain (5.00 USDC, 0.05 ETH) | PASS |
| E1a | …wallet on another network | Connect switches it to the Xorv chain before showing the address | PASS |
| E1b | …user switches network after connecting | Header shows "Switch to Nitro dev node"; one click puts the wallet back | PASS |
| E1c | …wallet has never heard of the chain | `wallet_switchEthereumChain` → 4902 → the app adds the network (`wallet_addEthereumChain`) and connects | PASS |
| E1d | Pay while the wallet is on the wrong network | The app switches before asking for the signature; job paid and opened | FAIL → fixed → PASS |
| E1e | User declines the payment signature | "You declined the signature … nothing was paid"; quote stays; paying again works; wallet balance shows only the paid attempt | FAIL → fixed → PASS |
| E2 | Pay with wallet | Wallet signs `ReceiveWithAuthorization` (escrow scheme); job funded from the wallet's address; wallet pays no gas | PASS |
| E3 | Privy email login | — | UNTESTED — needs the Privy dashboard to allow this origin |

## F. Broker API (L)

| # | Item | Correct means | Status |
|---|---|---|---|
| F1 | `GET /health` | `{ok:true}` | PASS |
| F2 | `GET /api/network` | network 412346, escrow + registry addresses, stablecoin USDC, explorer | PASS |
| F3 | `POST /api/quotes` invalid | 400 with reason | PASS |
| F4 | `POST /api/jobs/:quote` unpaid | 402; `payment-required` header decodes to escrow (first, payee XorvEscrow) + exact options | PASS |
| F5 | Replay a paid quote | 409 "this quote has already been paid" with the job id | PASS |
| F6 | `/api/receipts`, `/api/log/:kind` | Entries read from XorvLog | PASS |
| F7 | `/metrics` | Prometheus text incl. escrow counters | PASS |
| F8 | Quote while the only node for a model is mid-job | 422 "every provider selling codex is busy with another job" — not "nobody sells it" | PASS |
| F9 | Quote in the seconds after a node restarts (registered, channel not yet open) | 422 "the provider selling codex is reconnecting" until the channel opens, then a normal quote — never "nothing under $0.50, the cheapest is $0.20" | PASS |

## G. CLI + MCP (L)

| # | Item | Correct means | Status |
|---|---|---|---|
| G1 | `xorv run --json` (Codex) | Paid through escrow, completed, `escrow.state=released`, receipt tx in the JSON, buyer 0 ETH | PASS |
| G2 | MCP `xorv_quote` + `xorv_run_job` | Quote describes the escrow; answer + escrowed + released + receipt links | PASS |
| G3 | `xorv doctor` / `wallet` | Runs, reports balances for the local stack; flags Claude Code as signed out | PASS |

## H. Contracts on a real node (L)

| # | Item | Correct means | Status |
|---|---|---|---|
| H1 | Registry after jobs | `getProvider(provider)`: completed 4 / failed 1 match the jobs (no-blame refunds don't count); `earned` 800000 = sum released | PASS |
| H2 | Solidity suite | `forge test`: 54 pass (48 unit/fuzz, 4 invariants, 2 fork) | PASS |
| H3 | Rust suite | `cargo test`: 47 pass | PASS |
| H4 | Fork vs real USDG | `MODE=fork scripts/e2e-local.sh`: all 9 checks pass — also when run from a shell that has local-stack variables loaded | FAIL → fixed → PASS |

## J. Provider sandbox (L)

| # | Item | Correct means | Status |
|---|---|---|---|
| J1 | Hostile prompt as a real paid job | Paid, runs; reading the payout key and `~/.ssh` gives "Operation not permitted", writing outside the job dir is denied, writing inside works; the key never appears in the result | PASS |

## I. Public deployment (P)

| # | Item | Correct means | Status |
|---|---|---|---|
| I1 | Landing loads | 200, 0 console errors; live provider, settled count and on-chain receipts read from Arbitrum Sepolia; contract links to Arbiscan; no mobile overflow | PASS |
| I2 | App loads | 200, 0 console errors; broker reachable (CORS) | PASS |
| I3 | Broker `/api/network` | Arbitrum Sepolia, USDG + USDC | PASS |
| I4 | Paid job on Arbitrum Sepolia | From the CLI and from the public app's demo button: paid in Paxos USDG through XorvEscrow, Codex ran, released to the provider; release tx carries the Stylus registry's OutcomeRecorded; receipt in XorvLog; buyer 0 ETH; balances move by exactly the price | PASS |

## K. Judge-style abuse (L, and P without spending)

| # | Item | Correct means | Status |
|---|---|---|---|
| K1 | Triple-click the quote button | One quote request | FAIL → fixed → PASS |
| K2 | Triple-click Pay | One payment attempt, one job, one charge | FAIL → fixed → PASS |
| K3 | Back, forward and refresh while a job runs | Home shows a clean composer and the job in Recent; the job page resumes its stream and finishes on its own | PASS |
| K4 | Pay a quote that is already paid | 409 with the job id; the app opens that job | FAIL → fixed → PASS |
| K5 | Leave a quote open past its expiry | The card says it expired, nothing was paid, and offers a fresh quote | FAIL → fixed → PASS |
| K6 | A quote never outlives its escrow time | Quote lifetime ≤ escrow deadline − 2 min | FAIL → fixed → PASS |
| K7 | 25k / 200k-character prompt | Refused in the browser with a counter; nothing uploaded | FAIL → fixed → PASS |
| K8 | Job page left open across a deadline refund | Shows failed, refunded and the receipt without a reload | PASS |
| K9 | Wallet panel Send with bad input (address, amount, decimals, balance) | Plain message before the wallet is asked; a valid send goes through | FAIL → fixed → PASS |
| K10 | Forget the wallet with a quote open | Button switches to the demo account | PASS |
| K11 | Empty wallet pays (browser and CLI) | Refused before signing with the balance and what to do; nothing signed, nothing spent (checked on Arbitrum Sepolia: operator ETH unchanged) | FAIL → fixed → PASS |
| K12 | No providers online | Buyer-facing message; home sidebar links to Providers | FAIL → fixed → PASS |
| K13 | Every page at 375px | No horizontal scroll (the transaction viewer scrolled 43px) | FAIL → fixed → PASS |
| K14 | "Settled" counts | Counts only paid-and-released jobs, matching the paid total and the chain | FAIL → fixed → PASS |

## Not covered by this plan

- **Real Claude Code jobs** — UNTESTED: Claude Code's login on this machine has expired (`xorv doctor`: "signed
  out"). Every paid job in this run used Codex, a real model on a real subscription.

---

## Found and fixed in the final re-run

| Found | Fix |
|---|---|
| An escrowed job's on-chain receipt went out at funding time naming the provider as payee, so refunded jobs sat in the public log looking paid | Receipts wait for the release or refund and record `settlement` (state, paidTo, tx); app and landing render the outcome; regression test |
| Escrow settled from outside (buyer refund after the deadline) or missed its deadline: job marked failed, but the node kept working on it unpaid, in its only slot | Broker sends `job.cancel` and frees the slot on both paths; regression test; verified live (node logged the cancel, Codex process gone) |
| A payment that failed to settle counted the stopped job as **completed** in public provider stats | `Registry.jobAbandoned` frees the slot without scoring |
| A buyer's cancel counted as a provider **failure** in broker stats, though the on-chain cancel carries no mark | Same; regression test |
| A node killed mid-job left the buyer's job directory (prompt, outputs) on disk | `xorv start` sweeps leftover `job_*` directories; unit test; verified live |
| Browser-side chain reads (wallet balances) failed on the local stack: the Nitro node sent no CORS headers | `--http.corsdomain` for the app/landing origins |
| A wallet that injects after page load stayed behind "No wallet found" | Listen for `ethereum#initialized` |
| App headline claimed direct payment whenever the broker was unreachable | Tri-state: no claim until the broker answers |
| Landing said payment goes "from the buyer's account to yours in a single transfer … Xorv is never the payee" — false with escrow | Rewritten |
| MCP tool text told agents payment goes "directly" to the provider "with an Arbiscan link" | Describes the escrow; quote shows escrow address and refund deadline |
| Titles/copy said USDG on a USDC deployment; "51" tests; "state in memory"; "broker restarted"; "Ran on" for running jobs; /providers and /network asserted an audit log on a broker with none | Each derived from config or reworded |
| `xorv run --json` omitted the receipt | Added `receiptTransaction` / `receiptUrl` |
| Paying while the wallet had moved to another network did nothing: the signature was requested for a chain the wallet wasn't on, it refused (as MetaMask does), and nothing was shown | Payment signing now switches the wallet to the domain's chain first, as sending and refunding already did; unit tests; verified live |
| A declined signature or refund showed x402's raw "Failed to create payment payload: MetaMask Tx Signature: User denied…" | Plain words: nothing was paid / the money is still in escrow |
| The fork e2e (H4) inherited `XORV_*` variables from the calling shell, so after local-stack testing the buyer read balances from the wrong chain's token and every check failed | The script clears inherited `XORV_*` variables and sets its own |
| Deploying to Arbitrum Sepolia: Arbitrum's public RPC refuses Stylus activation, and the deploy script exited silently (set -e / pipefail) instead of saying so | Arbitrum Sepolia defaults to publicnode's RPC; every step prints its error |
| The public broker ran with no persistence ("unable to open database file" — the Railway image runs as non-root, the volume is root-owned), so jobs and earnings would vanish on restart | `RAILWAY_RUN_UID=0` per Railway's docs; verified `storage /data/xorv.db` |
| `vercel env add` hung on an interactive prompt despite `--yes` | `--no-sensitive` and no stdin, in go-live.sh |
| Right after a provider restarted (registered, job channel not yet open), a Codex quote was refused with "no online provider selling codex under $0.5000 — the cheapest is $0.2000" | Refusal reasons count only nodes the broker can reach, say "reconnecting" for the rest, and never quote a price within budget; regression test; verified live across a provider restart |
| Agent failures kept only the last 400 characters of stderr — for a Node spawn error that is the `spawnargs` array, so a failed Codex launch reported "n/bin/codex', path: …" with its cause cut off | `stderrSummary` keeps the error headline plus its `code`/`syscall`, skipping the noise agents always print; unit tests |
| With the only Codex node mid-job, a Codex quote was refused as "no online provider is selling codex" — the node was selling it, just busy | The broker counts its own in-flight jobs per capability and says "every provider selling codex is busy"; regression test; verified live |
| The broker-offline hint rendered as "http://localhost:8402isn't answering" (the JSX space was dropped) | Explicit `{" "}` |
| Forge broadcast logs from **forked** runs were committed under chain 421614, recording "deployments" that don't exist on Sepolia | Untracked and ignored; `deployments/<network>.json` is the record |
