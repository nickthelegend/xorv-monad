---
format: 1920x1080
duration: 60s
message: "The AI subscription you already pay for can earn while you're not using it"
arc: "Hook → Problem → Become a provider → Buy a job → Settlement (the USP) → Proof on Hedera → What makes it safe → CTA"
audience: "developers and AI power users who pay for Claude / Codex / Grok"
mode: autonomous
music: minimal electronic, premium fintech, restrained
---

## Frame 1 — Idle

- status: outline
- src: compositions/frames/01-idle.html
- duration: 4.6s
- transition_in: cut
- scene: "Kinetic type: your subscription is idle most of the day."
- voiceover: "You pay for Claude every month. Most of the day, it sits idle."
- blueprint: kinetic-type-beats (Adapt)
- focal: none — type is the subject
- roles: hairline grid = background · clock = supporting
- asset_candidates: none — pure type
- sfx: none
- poster: 4

Open on black and almost nothing. A single hairline rule and a monospace clock
ticking through a working day. The word **idle** lands on the accent, alone —
the first and, for a while, only colour in the video.

The restraint here is the point: a launch video that opens loud has nowhere to
go. This one opens like the product does, as an instrument at rest.

Adapt: keep the beat-slam spine, but slam three short phrases rather than a full array — this frame is a breath, not a barrage.

Scene 1 (0.0–1.6s): black. One horizontal hairline at the optical third; a mono clock reads `09:14` in muted grey, upper-left. The rule draws itself left→right (SVG self-draw). Nothing else exists yet. Full-width strip, 3 depth layers.
Scene 2 (1.6–3.4s): on "you pay for Claude every month", `$200 / MONTH` sets in mono at the left third and holds; the clock runs the working day in an in-place token cycle — `09:14 → 13:02 → 17:41`. Rule-of-thirds; the clock is the only motion.
Scene 3 (3.4–5.0s): on "it sits idle", **IDLE** hard-cuts in at display scale, centered, in accent — the first colour in the video. A usage bar beneath fills to 8% and stops (bars / progress). Centered, primary ~45% of canvas.
Scene 4 (5.0–6.0s): holds STILL. The bar sits at 8%, IDLE reads. Subtle jitter on the clock digits only; no camera move.

---

## Frame 2 — The mismatch

- status: outline
- src: compositions/frames/02-mismatch.html
- duration: 5.2s
- transition_in: cut
- scene: "Split: you use a fraction of a plan; someone else needs one job and must buy a whole one."
- voiceover: "Someone else needs one job run — and has to buy a whole plan to get it."
- blueprint: comparison-split (Reproduce)
- focal: none — two type blocks
- roles: divider = supporting · meters = supporting
- asset_candidates: none — type + hairline meters
- sfx: click-soft
- poster: 5

A hard vertical hairline splits the frame. Left: a usage meter barely off its
floor, `$200/mo`. Right: one job, priced at a whole plan. The absurdity is the
argument, so the frame states it and gets out.

Scene 1 (0.0–1.4s): the accent IDLE is still centred, then a vertical hairline wipes down through it, splitting the canvas 50/50 — the signature move. Split-screen; the divider is the only motion.
Scene 2 (1.4–3.6s): left resolves on "someone else needs one job run" — `YOU`, a usage meter at 8%, `$200 / MONTH` in mono. All grey; nothing here is live, so nothing is coloured.
Scene 3 (3.6–5.8s): right resolves on "a whole plan" — `THEM`, one job token, and the same `$200 / MONTH`. Both price strings land at the same y, so the eye compares them unprompted.
Scene 4 (5.8–7.0s): both hold. A marker circle draws around the right-hand price (highlight / circle), then stillness.

---

## Frame 3 — One command

- status: outline
- src: compositions/frames/03-provider.html
- duration: 8.2s
- transition_in: cut
- scene: "The real CLI: install, start, and doctor reporting what's actually ready."
- voiceover: "One command turns your machine into a provider. Xorv checks what's installed, what's signed in, and what's safe to run."
- blueprint: typewriter-reveal (Adapt)
- focal: none — the terminal is the subject
- roles: terminal surface = cutout · grid = background
- asset_candidates: none — the terminal is rebuilt in the design system
- sfx: key-press, click-soft
- poster: 6

The terminal, rebuilt — not a screenshot. `npm i -g @xorv/cli`, then real
`xorv doctor` lines resolving one at a time in accent:

    ✔ sandbox      macOS seatbelt — credentials unreadable
    ✔ claude-code  Claude Code · signed in · selling
    ✔ usdc         associated with 0.0.429274

These are the actual strings the product prints. The check marks land on the
voiceover's beats, not all at once.

Adapt: keep the type-on-with-caret signature, but the payoff is the three checks resolving underneath, not the typed line.

Scene 1 (0.0–1.8s): the split collapses inward; a terminal surface (`#0a0a0a`, 1px hairline, no shadow, no radius) rises to fill the centre 70%. A mono `$` blinks. Centered.
Scene 2 (1.8–3.2s): on "one command", `npm i -g @xorv/cli` types on with caret, then `xorv start`. Key-tick rides the typing, low.
Scene 3 (3.2–5.0s): on "what's installed", `✔ sandbox  macOS seatbelt — credentials unreadable` resolves, ✔ in accent. One soft click.
Scene 4 (5.0–6.6s): on "what's signed in", `✔ claude-code  Claude Code · signed in · selling` lands the same way — a list building, not a dump.
Scene 5 (6.6–8.0s): on "safe to run", `✔ usdc  associated with 0.0.429274` lands; terminal holds STILL. Three accent checks, nothing else coloured.

---

## Frame 4 — Terms before money

- status: outline
- src: compositions/frames/04-quote.html
- duration: 8.8s
- transition_in: cut
- scene: "A prompt typed into the app, answered by HTTP 402 with machine-readable terms."
- voiceover: "A buyer describes the work. Before any money moves, the network answers with terms — who will run it, and exactly what it costs."
- blueprint: prompt-type-submit-generate (Reproduce)
- focal: none — the composer is the subject
- roles: composer = cutout · quote panel = cutout · grid = background
- asset_candidates: none — the composer is rebuilt in the design system
- sfx: click-soft
- poster: 6

The app's own composer. A prompt types itself, the model picker shows the real
vendor marks, and the response is the thing this whole protocol is named after:
**402**. The quote panel resolves — provider, price, and `pays → 0.0.9848438` —
with `nothing has been paid` still legible underneath.

`402` is set large in mono and holds the frame for a beat. It is the one number
in the video that deserves to be a character.

Scene 1 (0.0–1.6s): the terminal scale-swaps for the app's composer — same centre, same hairline language, so the surface reads continuous. Placeholder `Tell the network what to build…`. Centered, ~65%.
Scene 2 (1.6–3.4s): on "a buyer describes the work", a prompt types on with caret; the model picker sits closed beside it showing the real Claude mark in ink.
Scene 3 (3.4–4.4s): on the submit beat the ↑ button presses (press-release-spring), one click. The composer dims to ~40%.
Scene 4 (4.4–6.4s): **the signature beat.** `402` hard-cuts in at display scale in mono, centred over the dimmed composer, `PAYMENT REQUIRED` tracked small beneath. It holds alone for a full beat — this is the protocol the video is about.
Scene 5 (6.4–9.0s): `402` shrinks into a label; the quote panel resolves under it on "who will run it, and exactly what it costs" — `nivesh-macbook`, `Claude Code · 17 done`, `pays → 0.0.9848438`, `$0.2500` at size. `nothing has been paid` sits muted at the foot. Asymmetric 60/40.

---

## Frame 5 — Settled, and no gas

- status: outline
- src: compositions/frames/05-settlement.html
- duration: 12s
- transition_in: cut
- scene: "USDC moves buyer → provider in ~3s; the gas line resolves to the facilitator, not the buyer."
- voiceover: "They sign. It settles in about three seconds, straight to the provider. And the buyer never touched HBAR — Hedera's facilitator pays the gas for them."
- blueprint: dataviz-countup (Adapt)
- focal: none — the ledger axis is the subject
- roles: axis = cutout · account nodes = supporting · grid = background
- asset_candidates: none — ledger diagram in hairlines
- sfx: chime
- poster: 7

**The USP frame, and it gets the most time in the video.** Two accounts on a
hairline axis. `0.2500 USDC` travels buyer → provider along the rule while a
three-second counter runs beneath it.

Then the beat the video is built around: a third line labelled `gas` reaches for
the buyer, stops, and re-anchors to `facilitator 0.0.9842030`. The buyer's HBAR
balance stays struck through at `0.0000 ℏ`.

Held on screen after the money lands: **buyer paid zero gas**. That sentence is
the reason a normal person's payment goes through here and fails elsewhere.

Adapt: keep the count-up signature, but the number that matters is a transfer travelling a rule — and the back half is a line that reaches for the buyer and is refused.

Scene 1 (0.0–1.6s): the quote's `pays →` extends into a full-width hairline axis. Two mono nodes: `0.0.9848440 BUYER` left, `0.0.9848438 PROVIDER` right. Full-width strip, 3 depth layers.
Scene 2 (1.6–3.4s): on "they sign", a `0.2500 USDC` token departs the buyer and travels the rule; beneath it a counter runs `0.0s → 3.0s` (value-scaled counter), pacing the travel.
Scene 3 (3.4–5.0s): the token lands; the provider node fills accent, `SETTLED` sets beside it, one low confirm tone, and the balance counts `+0.2500`.
Scene 4 (5.0–7.6s): **the USP beat.** On "the buyer never touched HBAR", a third line labelled `gas` draws from the transaction toward BUYER — stops short, reverses, and re-anchors to `facilitator 0.0.9842030`, which fills accent. The buyer's `0.0000 ℏ` sets struck through. This re-anchoring is the most important motion in the video; give it room to be read.
Scene 5 (7.6–10.0s): holds. **BUYER PAID ZERO GAS** sets in Inter across the lower third — the only sentence at that weight. STILL: no drift, no push.

---

## Frame 6 — On Hedera testnet

- status: outline
- src: compositions/frames/06-proof.html
- duration: 8.8s
- transition_in: cut
- scene: "The real transaction id and the HCS receipts topic — public, ordered, permanent."
- voiceover: "Every job leaves a receipt on Hedera testnet. Public, ordered, permanent — the payment, the provider, and a hash of the result."
- blueprint: transcript-scroll-artifact-reveal (Adapt)
- focal: none — the receipt is the subject
- roles: receipt card = cutout · topic rows = supporting
- asset_candidates: none — receipt rendered in mono
- sfx: click-soft
- poster: 6

Real ids, no placeholders. The transaction
`0.0.9842030@1785527147.476758713` sets in mono and locks. Beneath it the
receipts topic `0.0.9848247` with consensus-ordered rows scrolling past.

`HEDERA TESTNET` sits as a small mono label in the corner, stated rather than
shouted — it is a fact about the video, not a claim.

Adapt: keep the scrolling-record-into-artifact spine; the artifact is a real transaction id, not a document.

Scene 1 (0.0–1.6s): the axis lifts away; `HEDERA TESTNET` sets small in mono upper-right and stays there for the frame. A receipt card rises centre, ~60%.
Scene 2 (1.6–3.6s): on "every job leaves a receipt", the real id `0.0.9842030@1785527147.476758713` decodes character by character (3D char flip-decode) and locks with one low tick. Its length is the proof.
Scene 3 (3.6–5.8s): on "public, ordered, permanent", rows resolve one per word: `payment 0.2500 USDC`, `provider 0.0.9848438`, `result sha256 88dd9f84…`. Mono, each on its own beat.
Scene 4 (5.8–8.0s): the card slides left to 40%; the receipts topic `0.0.9848247` reveals right with consensus-ordered rows scrolling behind a fade mask. Asymmetric 60/40 — the scroll continues under the hold, because the subject is doing something.

---

## Frame 7 — Safe to run

- status: outline
- src: compositions/frames/07-safety.html
- duration: 9.3s
- transition_in: cut
- scene: "A hostile prompt hits the sandbox and is refused; agents buy capacity over MCP."
- voiceover: "Jobs run sandboxed, so a stranger's prompt can't reach your keys. And agents can buy capacity too, over MCP."
- blueprint: comparison-split (Adapt)
- focal: none — denial left, MCP right
- roles: terminal = cutout · mcp panel = supporting
- asset_candidates: none — terminal denial + MCP call
- sfx: error
- poster: 5

The objection everybody raises, answered with the real transcript rather than a
claim:

    $ cat ~/.xorv/config.json
    ✖ Operation not permitted

The denial is the only place in the video the failure colour appears, and it
appears once. Right of the hairline, an MCP `xorv_run_job` call returns — the
machine-to-machine case, stated in one line.

Adapt: the split is asymmetric and the halves are unequal — left is the objection being answered, right is a one-line aside.

Scene 1 (0.0–1.4s): a vertical hairline splits 60/40. Left a terminal surface, right an MCP panel outline.
Scene 2 (1.4–3.6s): on "can't reach your keys", the terminal types `$ cat ~/.xorv/config.json` — then the reply hard-cuts: `✖ Operation not permitted`, ✖ in `#f87171`. One dull thunk. The only failure colour in the video.
Scene 3 (3.6–5.0s): beneath, muted, `~/.ssh  ~/.aws  keychain` each take a small ✖ in sequence — refused the same way, stated without narration.
Scene 4 (5.0–7.0s): on "agents can buy capacity too", the right panel resolves — `xorv_run_job` in mono with a returned result, `MCP` labelled small. Both halves hold STILL.

---

## Frame 8 — Lockup

- status: outline
- src: compositions/frames/08-cta.html
- duration: 5.5s
- transition_in: cut
- scene: "Wordmark, install command, URL, live-on-testnet dot."
- voiceover: "Xorv. Idle quota, turned into income. Live on Hedera testnet."
- blueprint: logo-assemble-lockup (Reproduce)
- focal: assets/xorv-logo.svg
- roles: wordmark = cutout · grid = background
- asset_candidates: assets/xorv-logo.svg — the wordmark, rendered flat in ink
- sfx: none
- poster: 3

The wordmark assembles from the hairline grid the whole video has been drawn on.
Under it, in mono: `npm i -g @xorv/cli` and `xorv.vercel.app`. A single accent
dot pulses once beside `live on hedera testnet`, then everything holds.

Ends on held type, not a fade — the product doesn't oversell and neither does
the last frame.

Scene 1 (0.0–1.4s): the hairlines from Frame 7 rotate and converge into the grid the video was drawn on; the Xorv wordmark assembles from those lines (SVG self-draw), flat in ink `#fafafa` — never the source gradient. Centered, ~40%.
Scene 2 (1.4–2.8s): under it, in mono, `npm i -g @xorv/cli` resolves, then `xorv.vercel.app`.
Scene 3 (2.8–4.0s): a single accent dot appears left of `live on hedera testnet` and pulses exactly once (live SVG internals) — the last colour in the video.
Scene 4 (4.0–5.0s): everything holds absolutely still on black. No fade, no push. The video ends on held type.

---

## Video direction

**The one idea.** Every frame serves the USP: a real payment, on a public
ledger, per job, where the buyer never needed the gas token. Frames 1–4 exist to
make frame 5 land. Frames 6–7 exist to make it credible.

**Colour is a state, not a decoration.** The product's stylesheet says it
outright — *if it isn't reporting state, it isn't coloured*. The video obeys it:
`#4ade80` marks live things, settled money, and the single active word in the
subtitles. Nothing else is ever coloured, except one appearance of `#f87171` on
the sandbox denial in frame 7. A frame with no state to report is black, white,
and hairline grey.

**Type does the work.** Inter for anything a person says; `ui-monospace` for
anything a machine says — ids, amounts, transaction hashes, CLI output. That
split is load-bearing: it is how the viewer knows, without being told, which
things are real.

**Motion is kinetic but never idle.** Elements cut, snap, count and resolve.
Nothing floats, drifts, breathes, pulses decoratively, or drops shadow. No
gradients anywhere — the brand rejected them. Transitions are hard cuts; the
grid is the only thing that persists across them, so the whole video reads as
one continuous surface being written on.

**Silence is a tool.** BGM sits at 5% — present, never leading. SFX at 20%, and
only on a transition or a state change: a click, a switch, a confirm tone.
Frames 1 and 8 carry no SFX at all, so the piece opens and closes on breath.

**Subtitles.** Karaoke, one active word at a time — dark ink on an accent block,
never white on accent. Bottom band, keep-out honoured by every frame's layout.
