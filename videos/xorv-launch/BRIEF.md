---
workflow: product-launch-video
flow: automation
storyboard: no
message: "The AI subscription you already pay for can earn while you're not using it"
destination: youtube
aspect: 1920x1080
language: en
length: 60s
angle: usp
---

## Intent

A launch video for **Xorv** — a decentralized AI capacity network. People rent
out the idle quota on the Claude / Codex / Grok subscription they already pay
for, and get paid per job in USDC over **x402 on Hedera testnet**.

The single job of this video is the USP, and the USP is not "an AI marketplace."
It is this: **a real payment settles on a public ledger, per job, in about three
seconds, and the buyer never needs the gas token.** That last part is what
usually kills a normal person's crypto payment, and Hedera's native fee-payer
model removes it. Everything else in the video exists to set that up or prove it.

Tone: calm, assured, low-hype. The product reads like an instrument — a terminal
and a ledger. The video should read the same way. Confident, not loud. It must
not look like generic AI-generated motion filler.

## Assets

- brand/xorv-logo.svg — the wordmark; open and close.
- brand/xorv-mark.svg — the glyph alone; use where the wordmark is too wide.

## Customizations

- **Show the real product, not mockups.** The CLI's actual output (`xorv doctor`,
  `xorv start`, `xorv run`), the app's real composer and quote panel, and a real
  HashScan transaction. Rebuild these as HTML in the project's own design system
  rather than inventing UI.
- **Karaoke subtitles**, with the active word as **dark text on an accent block**
  — never white-on-accent, which is unreadable at speed.
- **Audio mix is deliberate:** BGM at 5%, sound effects at 20%. SFX only on
  transitions — clicks, soft switches. No whooshes on every element, no risers,
  nothing decorative. Silence is allowed to carry a beat.
- Name **Hedera testnet** explicitly, on screen and in the narration.
- One accent color only, and only for the active/keyword/highlight state.

## Notes

- Brand tokens are real, taken from `apps/landing/app/globals.css`:
  canvas `#000000`, surfaces `#0a0a0a` / `#121212`, ink `#fafafa`,
  muted `#a1a1a1` / `#6e6e6e` / `#4a4a4a`, hairlines `rgba(255,255,255,0.09)`.
- **Accent is `#4ade80`** — the product's own `--live` token. In the product it
  means one thing: this is reporting state. The comment in the stylesheet reads
  "If it isn't reporting state, it isn't coloured." The video honours that: green
  appears on live things and settled money, nowhere else.
- Typeface: **Inter** for everything spoken, **ui-monospace / SF Mono** for
  anything the machine says — ids, amounts, transaction hashes, CLI output.
- **No gradients.** The user rejected them explicitly on this brand. The logo SVG
  still carries one internally; render the marks in flat ink or accent instead.
- Hairline grid, generous negative space, tight type. Motion should be kinetic
  but purposeful — nothing floats, drifts, or pulses for decoration.
- Real proof to use on screen: tx `0.0.9842030@1785527147.476758713`,
  buyer `0.0.9848440` → provider `0.0.9848438`, 0.2500 USDC, Circle USDC token
  `0.0.429274`, receipts topic `0.0.9848247`.
