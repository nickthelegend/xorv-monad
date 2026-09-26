# Hedera x402 bounty — submission

**Xorv turns idle AI subscription quota into a paid marketplace, settled per job
in USDC over x402 on Hedera.**

You pay for Claude, Codex or Grok. You use a fraction of it. Someone else needs
one job done and has to buy a whole plan to get it. Xorv is the rail between
them, and the rail is a real Hedera transaction every time.

---

## Live right now

| | |
|---|---|
| **Landing** | https://xorv.vercel.app |
| **App** | https://xorv-app.vercel.app |
| **Repo** | [nickthelegend/xorv](https://github.com/nickthelegend/xorv) · MIT |
| **CLI** | `npm i -g @xorv/cli` — [on npm](https://www.npmjs.com/package/@xorv/cli) |
| **Packages** | [`@xorv/protocol`](https://www.npmjs.com/package/@xorv/protocol) · [`@xorv/mcp`](https://www.npmjs.com/package/@xorv/mcp) |

The broker runs on the demo machine behind a Cloudflare tunnel — it holds
WebSocket connections to provider nodes and live registry state, so it is not a
serverless workload. `docker compose up` runs the whole stack anywhere.

---

## Requirements

| Requirement | Status |
|---|---|
| Public open-source GitHub repo | ✅ MIT |
| Demo video under 5 minutes | ⬜ **record it — script below** |
| HashScan links proving testnet transactions | ✅ below |
| Completed submission form | ⬜ **submit it** |

---

## The 5-minute demo, shot by shot

Timings are deliberate: the payment proof gets the most screen time, because
that is what the bounty is judging. Have the broker warm and a provider node
already registered before you hit record, or you will spend a fifth of the
video watching things start.

### 0:00 – 0:25 · The problem, on the landing page

Open **https://xorv.vercel.app**. Read the headline out loud — *your AI
subscription is idle most of the day* — and scroll once through the hero.

> "I pay for Claude Code. I use maybe two hours of it a day. Someone else wants
> one job run and has to buy a whole plan. Xorv connects those two people and
> settles it per job, in USDC, on Hedera."

Scroll to **How it works** and let the five numbered steps sit on screen for a
beat. Don't read them; they're there so the viewer knows the sequence is real.

### 0:25 – 1:10 · Become a provider

Terminal. This is the whole onboarding:

```bash
npm i -g @xorv/cli && xorv init
```

Then show the diagnostic — it is the most convincing single screen in the CLI:

```bash
xorv doctor
```

Point at three lines as they scroll past:

- `sandbox: macOS seatbelt — credentials unreadable, writes confined to the job dir`
- `claude-code   Claude Code · signed in · selling`
- the closing line: **`nothing broken · 3 things not set up`**

> "It checks whether the agent CLI is actually signed in, not just installed —
> a signed-out CLI answers `--version` cheerfully and then fails every paid job."

Now start earning:

```bash
xorv start
```

Show the registration landing on HCS and the live dashboard: label, heartbeat,
earnings, capabilities.

### 1:10 – 2:30 · Buy a job, on the deployed app

Switch to **https://xorv-app.vercel.app**. Type a real prompt into the composer.

**Stop on the quote.** This is the x402 moment and it deserves the pause:

> "Before any money moves, I get told exactly who will run this and what it
> costs. That's HTTP 402 with machine-readable terms — a status code nobody
> used, doing real work."

Pay. Then watch the log stream live while the job runs on the provider machine,
and the answer arrives.

### 2:30 – 3:30 · Prove it on-chain

Open the HashScan link from the receipt. Point at **two specific things**:

1. **The token moved buyer → provider directly.** The broker never takes
   custody. It is not an escrow, it is a rail.
2. **Every HBAR fee came from the facilitator, not the buyer.** Scroll to the
   fee section and show it.

> "The buyer holds no HBAR. They never had to. On most chains, 'buy the gas
> token before you can spend the stablecoin' is where a normal person's crypto
> payment dies — Hedera's native fee-payer model removes that step, and this
> transaction is the proof."

Then open the **receipts topic** on HashScan and scroll it. Every settled job:
id, both accounts, amount, transaction id, and a SHA-256 of the result — so the
record is verifiable without the payload ever being public.

### 3:30 – 4:15 · The part that makes it safe to run

Back to the landing page, scroll to **Security**. The transcript on screen is
real output from a paid job that tried to steal credentials:

```
$ cat ~/.xorv/config.json
✖ Operation not permitted     ← the payout private key
$ security find-internet-password -w
✖ SecKeychainSearchCopyNext
```

> "A provider runs prompts written by strangers. That first file holds the key
> that receives every payment they earn, so it's the first thing a hostile
> prompt asks for — and the sandbox refuses. Every job runs inside macOS
> seatbelt, Linux bubblewrap, or a container."

If you have 15 spare seconds, this lands hard — post a job whose prompt is the
attack and let the agent report back that it was blocked.

### 4:15 – 4:45 · The agent case

```bash
xorv-mcp
```

Show `xorv_run_job` being called from an MCP client. An agent discovers
capacity, pays for it, and gets its answer.

> "No human, no account, no card. This is what x402 is actually for — machines
> paying machines for compute, per request."

### 4:45 – 5:00 · Close

```bash
pnpm test
```

**272 tests, no credentials, no network.** Let the green scroll and end there.

---

## On-chain proof (testnet)

| | |
|---|---|
| **Bought in the browser, on the deployed app** | [`0.0.9842030@1785527147.476758713`](https://hashscan.io/testnet/transaction/0.0.9842030-1785527147-476758713) — typed a prompt at xorv-app.vercel.app, took the quote, paid, watched it run, got the answer. [`job_LOqvjZ2Pj3u7`](https://xorv-app.vercel.app/jobs/job_LOqvjZ2Pj3u7) |
| Paid through the deployed app's API | [`0.0.9842030@1785526598.292531686`](https://hashscan.io/testnet/transaction/0.0.9842030-1785526598-292531686) — Vercel → tunnel → broker → settlement → Claude Code job → result |
| **Circle USDC settlement** | [`0.0.9842030@1785516412.478664506`](https://hashscan.io/testnet/transaction/0.0.9842030-1785516412-478664506) — buyer `0.0.9848440` −0.2500 USDC, provider `0.0.9848438` +0.2500, **buyer paid zero gas** |
| Real Claude Code job under the sandbox | [`0.0.9842030@1785524175.571243822`](https://hashscan.io/testnet/transaction/0.0.9842030-1785524175-571243822) |
| Its HCS receipt | [`0.0.9842030@1785524183.472025433`](https://hashscan.io/testnet/transaction/0.0.9842030-1785524183-472025433) |
| Registry topic | [`0.0.9848245`](https://hashscan.io/testnet/topic/0.0.9848245) |
| Heartbeat topic | [`0.0.9848246`](https://hashscan.io/testnet/topic/0.0.9848246) |
| Receipts topic | [`0.0.9848247`](https://hashscan.io/testnet/topic/0.0.9848247) |

---

## Judging criteria

**A functional end-to-end payment flow.** Post a job → 402 with machine-readable
terms → sign → settle → the job runs on a stranger's machine → result returns →
receipt goes on-chain. Provable in one command: `xorv run "…"`, or in the
browser at the deployed app.

**Legitimate on-chain payments through x402.** The official `@x402/hedera` v2
`exact` scheme, partially-signed `TransferTransaction`, verified and settled by
a facilitator Xorv runs itself. Every payment listed above is a real ledger
transaction.

**Effective use of Hedera's infrastructure.** Three things, each chosen because
Hedera does it and other chains don't:

- **Native fee-payer model** — the facilitator co-signs and pays, so a buyer
  holding only a stablecoin can transact. This is the single biggest reason a
  normal person's crypto payment fails, and Hedera removes it.
- **Consensus Service** — an ordered, public, append-only audit log of
  registrations, liveness and receipts, with no contract deployed.
- **Token Service** — sub-cent settlement at a fixed, predictable fee. A $0.001
  job is not viable where gas floats.

---

## Stated plainly: what is not proven

A judge will find these anyway, and finding them undisclosed is worse than
reading them here.

- ~~**The wallet click is unverified.**~~ **Closed.** Privy was replaced with
  HashPack over WalletConnect (HIP-820), because Privy signs EVM RLP
  transactions and Hedera's x402 scheme settles a *native* protobuf transfer —
  no chain config bridges those. A browser wallet now pays end to end, verified
  on-chain: [`0.0.9842030@1785583332.923427914`](https://hashscan.io/testnet/transaction/0.0.9842030-1785583332-923427914)
  moved 0.2500 USDC from the wallet `0.0.9862584` to the provider while the
  facilitator paid the fee and the wallet's HBAR balance moved by exactly zero.
  Getting there needed one real fix a local key could never expose: a default
  freeze offers several candidate nodes, HashPack signs only the first one's
  body, and the library merges that single signature into all of them — so the
  transfer is now pinned to one node account. Needs a free
  `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`.
- **A job can read the agent session it runs on.** The sandbox denies the payout
  key, SSH keys, cloud credentials and the keychain, and confines writes to the
  job directory. But the agent's own token is in the job's environment, because
  the agent needs it to work. `XORV_SANDBOX=container` closes that too. On a
  host with neither seatbelt nor bubblewrap there is no filesystem boundary at
  all, and `xorv doctor` says so rather than printing the word "sandboxed".
- ~~**The Docker image is unbuilt.**~~ **Closed.** Built and run (2.08GB,
  `Up (healthy)`), and a containerised broker settled a real job end to end:
  [`0.0.9842030@1785993131.634335318`](https://hashscan.io/testnet/transaction/0.0.9842030-1785993131-634335318).
  Building it found a real bug that no amount of review would have: the broker
  advertises its control-channel URL from its own `publicUrl`, which is wrong
  behind any port map, tunnel or proxy — and the failure is silent, because
  HTTP heartbeats keep working so the registry still reports the node `online`
  while every dispatched job dies. The node now derives that URL from the
  address it actually reached the broker on.
- **The broker is not on Vercel.** It holds WebSocket connections and live
  registry state. For the demo it runs on the provider machine behind a
  Cloudflare tunnel; the tunnel URL changes on restart, so a redeploy of the app
  is needed if the broker is restarted.

---

## Before you submit

- [ ] **Rotate every credential** — the GitHub token, Privy app secret, MongoDB
      password, npm token and the Hedera demo payer key have all been pasted
      into a chat session and should be considered burned.
- [ ] Record the video (script above)
- [ ] Submit the form
