# The demo video — what to record, and what to say

The submission asks for **under 5 minutes**. This is a shot list for about
**4:40**, in the order the story actually lands, with the exact words to say.

Read it once, then record. Don't read it *while* recording — the script below
is written to be spoken from memory in your own words. The bracketed lines are
what you do; the quoted lines are roughly what you say.

---

## Before you hit record

This is the part that ruins takes. Do all of it first.

```bash
# 1. Broker up, with the tunnel so the deployed app can reach it
pnpm broker                       # terminal 1, leave running
cloudflared tunnel --url http://localhost:8402    # terminal 2, copy the URL
# ^ quick tunnels EXPIRE on their own. Start this one fresh right before you
#   record, and re-deploy both apps onto its url — an hours-old tunnel will
#   die mid-take.

# 2. A provider node, already registered and warm
xorv start                        # terminal 3, leave running

# 3. Buy from a DIFFERENT account than the one hosting
export XORV_PAYER_ID=0.0.9848440
export XORV_PAYER_KEY=<the buyer key>
```

That last step matters more than it looks. **A provider cannot buy from
itself** — if you skip it, every `xorv run` in the demo fails with a 402 and
you will not know why on camera.

Then:

- Terminal at **~16pt**, window at 1920×1080, nothing else on screen.
- Browser with **two tabs pre-opened**: `xorv.vercel.app` and
  `xorv-app.vercel.app`. Logged in already if you're showing the wallet.
- A HashScan tab open but scrolled to the top, ready to paste into.
- **Run one throwaway job before recording.** It warms the broker, the mirror
  node, and the agent CLI — the first job of a session is always the slowest,
  and you don't want that on camera.
- Silence notifications.

Sanity check, and it's the best single command to prove readiness:

```bash
xorv doctor
```

Everything should be `✔` except the adapters you're not selling. If anything
is `✖`, fix it now — that's the command telling you the demo will fail.

**The one that will catch you: `claude-code … signed out — session expired`.**
Claude Code's OAuth token expires roughly daily, and a provider node that has
been up since yesterday is still holding the old one. The failure is nasty
because the payment succeeds and *then* the job returns
`401 OAuth access token has expired` — the buyer is charged for nothing. Run
`claude` once in any terminal to refresh; the node picks it up on the next job
without a restart. Then re-run `xorv doctor` and confirm it went green.

---

## 0:00 – 0:30 · The trailer

Play `videos/xorv-launch/renders/video.mp4` full-screen. It's 62 seconds, so
**cut it after the "402" beat at about 0:30** and hard-cut into your screen.

Don't talk over it. It says the thing already, and a voice on top of a voice
reads as unfinished.

> *(after the cut, over your own desktop)*
> "That's the pitch. Here's the thing actually working."

---

## 0:30 – 1:00 · The landing page, and the one idea

**[Browser: xorv.vercel.app]** Scroll slowly through the hero.

> "Xorv is a marketplace for idle AI subscription quota. You already pay for
> Claude, or Codex, or Grok. Most of the day it sits there doing nothing.
> Someone else needs one job run, and their only option is to buy a whole plan.
>
> Xorv connects those two people, and settles it per job — in USDC, on Hedera."

Scroll to **How it works** and let the five steps sit for two seconds. Then
scroll to the **Security** section and pause on the transcript.

> "And because you're running strangers' prompts on your own machine, every job
> is sandboxed. That's a real transcript — a paid job that tried to read the
> payout key, and got refused."

---

## 1:00 – 1:45 · Become a provider

**[Terminal]**

```bash
npm i -g @xorv/cli
xorv init
```

> "One command to install. `init` asks which of your agent CLIs you want to
> sell, and what to charge per job."

Then the command that sells the whole product:

```bash
xorv doctor
```

Let it print, then point at three lines with your cursor:

> "This is the diagnostic. Three things worth pointing at.
>
> **Sandbox** — it names the actual mechanism. macOS seatbelt here. Not the
> word 'sandboxed', the mechanism, so you know what you've really got.
>
> **Claude Code, signed in, selling** — it checks whether the CLI is actually
> authenticated, not just installed. A signed-out CLI answers `--version`
> perfectly happily and then fails every paid job you take.
>
> And the last line — **nothing broken, three things not set up**. Those are
> different sentences, and most tools blur them."

Now go live:

```bash
xorv start
```

> "That's it. Registered on Hedera's Consensus Service, holding a control
> channel open, waiting for work."

Leave the dashboard visible for a beat — label, heartbeat, capabilities,
earnings.

---

## 1:45 – 2:45 · Buy a job, and watch the 402

**[Browser: xorv-app.vercel.app]**

**Connect**, top right — and this beat is now worth real screen time, because
the wallet genuinely pays.

> "This is HashPack. Hedera's x402 scheme signs a native transfer, not an EVM
> one — so a normal EVM wallet can authenticate you but can't actually pay.
> HashPack signs the real transaction, and the facilitator co-signs and covers
> the fee."

Approve the session, then buy the job below with it. The transfer is signed in
your wallet, in front of the camera. **Install HashPack and click Connect once
before recording** — the WalletConnect relay handshake is the one step that
can't be rehearsed headlessly.

Type a real prompt into the composer. **Make it use tools** — that is the
difference between a good shot and a dead one:

```
Create a file fizzbuzz.js that prints FizzBuzz for 1..20, then run it with node
and show me the output.
```

Measured on real jobs: a pure "write me a function" prompt emits **3 log
events** — session started, then silence for ~15s, then the whole answer lands
at once. The prompt above emits **8**, including `tool_call` and `file_edit`
lines that stream while you talk over them. Same price, far better footage.

It also puts the sandbox on screen for free: the paths in the log read
`/private/tmp/xorv-jobs/job_.../`, which is the per-job directory from the
security beat.

Pick **Claude Code** from the model picker (the real vendor logos are there —
worth a half-second pause).

**Stop on the quote.** This is the beat the whole bounty is about.

> "Before any money moves, I get terms back. Who's going to run this — that's a
> real machine, with a real Hedera account. What it costs. And it pays straight
> to them; the broker never touches the money.
>
> That's HTTP 402. A status code nobody ever used, doing actual work."

Pay it. Watch the log stream. Read the answer out loud, briefly.

---

## 2:45 – 3:30 · Prove it on-chain

Copy the transaction id from the receipt, open HashScan.

**Point at two things and only two things.**

> "First — the token moved buyer to provider. Directly. No escrow, no float,
> no platform in the middle taking custody.
>
> Second, and this is the one that matters —"

Scroll to the fee section.

> "— every HBAR fee came from the facilitator. Not from the buyer. The buyer's
> HBAR balance is zero and always was.
>
> On most chains, 'go buy the gas token before you can spend your stablecoin' is
> exactly where a normal person's crypto payment dies. Hedera's native
> fee-payer model removes that step, and this transaction is the proof."

Then open the **receipts topic** `0.0.9848247` and scroll it.

> "And every settled job leaves a receipt here. Job id, both accounts, the
> amount, and a SHA-256 of the result — so the record is auditable without the
> work itself ever being public."

---

## 3:30 – 4:10 · The part nobody else has: `/xorv` in Claude Code

This is your differentiator. Give it room.

**[Claude Code, in any project]**

```
/xorv Write a Postgres query that finds duplicate rows by email, keeping the newest
```

> "This is Claude Code. And this is Xorv installed as a slash command inside it.
>
> I'm sitting in one agent, and I've just asked it to send that task to a
> *different* machine — someone else's Claude subscription — and pay for it."

When the result comes back:

> "There's the answer. There's who ran it, and what it cost. And there's the
> transaction.
>
> That's an agent paying another agent for compute, per request, with no
> account, no API key, and no invoice. That's what x402 is actually for."

Then show how it got there:

```bash
xorv skills
```

> "One command installs it."

---

## 4:10 – 4:40 · What you earned, and close

**[Terminal, back on the provider machine]**

```bash
xorv earnings
```

> "And on the other side of that — this is the provider's ledger. Every job it
> ran, what it charged, and the on-chain balance underneath.
>
> That USDC is real. It's on Hedera testnet right now."

Close on:

```bash
pnpm test
```

> "272 tests. No credentials, no network."

Let the green scroll and end. **Don't add an outro.** The test output is a
better final frame than a logo.

---

## Every CLI command, and whether it earns screen time

| Command | Show it? | Why |
|---|---|---|
| `xorv doctor` | **yes, prominently** | The single most convincing screen. Sandbox tier, real sign-in detection, and the broken-vs-unconfigured distinction. |
| `xorv start` | **yes** | The "you're now a provider" moment. |
| `xorv earnings` | **yes** | Job history plus the on-chain balance. This is the payoff shot. |
| `xorv skills` | **yes** | Installs `/xorv`. Your differentiator. |
| `xorv run "…"` | **yes** | The buyer path in one line, if the browser flow feels slow. |
| `xorv status` | if time | Who's live network-wide, and at what price. |
| `xorv test` | if time | Runs a job through each adapter locally, free. Proves the node works before selling. |
| `xorv price` | mention | Change what you charge, per capability. |
| `xorv pause` / `resume` | mention | Stop taking work without going offline. |
| `xorv jobs` / `logs` | skip | Same information `earnings` already shows, less well. |
| `xorv wallet` | skip | `earnings` ends on the wallet anyway. |
| `xorv cancel` | skip | Nothing to see. |
| `xorv config` | skip | Prints your account id on camera. Don't. |

**Do not run `xorv config` or `cat ~/.xorv/config.json` on camera** — that file
holds the payout private key.

---

## If you'd rather not talk

Every line above is written to be spoken, but if you want to generate the
narration instead, the pronunciation trap is real and measured:

- **`USDC` must be written `U S D C`** in any TTS input. As one token, engines
  collapse it into a single syllable that sounds like "us-dee-see" or just
  "usd". Measured on Kokoro: `"paid in USDC"` synthesizes in 1.173s;
  `"paid in U S D C"` takes 1.707s — those extra 0.5s are the letters actually
  being spoken.
- Same for **`H bar`** (not `HBAR`) and **`M C P`** (not `MCP`).
- Xorv comes back from speech recognition as "Zorv" and Hedera as "Hetera", so
  if you auto-caption, fix those before publishing. `videos/xorv-launch/fix-captions.mjs`
  does exactly this for the trailer.

---

## The failure modes that eat takes

| Symptom on camera | Cause | Fix before recording |
|---|---|---|
| `xorv run` fails with a bare 402 | You're buying from the account that's hosting | `export XORV_PAYER_ID` / `XORV_PAYER_KEY` |
| "no online provider matches" | The node's heartbeat lapsed | Restart `xorv start`, wait 15s |
| `RECONNECTING`, and the log flaps `control channel lost — retrying` every second | **Two `xorv start` processes are running.** They register under the same label and payout account, so the broker keeps replacing one with the other and both reconnect forever | `pgrep -fl "xorv start"` — kill all but one. It is stable within seconds |
| The deployed app shows "broker offline" | **The Cloudflare quick tunnel expired.** These are ephemeral and die on their own, not just when you restart the broker — it happened to us between two takes | Restart `cloudflared tunnel --url http://localhost:8402`, take the NEW url, and re-deploy **both** apps with it. Budget 5 minutes |
| "broker offline" but pages still load | Your machine's DNS has a stale negative entry for the new tunnel host. Vercel resolves independently, so the deployment is fine | `sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder`, or just ignore it — check with `curl` from another network |
| First job takes 20+ seconds | Cold start | Run one throwaway job first |
| `doctor` says `sandbox: env` | You're on a host with no seatbelt/bubblewrap | Say so, or record on macOS |
