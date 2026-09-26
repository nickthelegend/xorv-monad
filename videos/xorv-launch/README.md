# xorv-launch: the Hedera-era trailer (pre-existing work)

> **This trailer is from the Hedera prototype, not the Monad Metropolis build.** It was made on
> 2026-07-31 for the Hedera x402 bounty, and it came into this repository unchanged with the
> imported prototype (commit `321b563`). Its script and every value on screen are Hedera: a Hedera
> transaction id, `0.0.x` accounts, Hedera's USDC token and an HCS receipt topic. It is **not** the
> Metropolis demo video and shows no Monad integration. For that, see [RECORDING.md](../../RECORDING.md) and the demo link in the
> [README](../../README.md).

What is here: a 60-second, 1080p HyperFrames composition (`index.html` plus eight frames in
`compositions/frames/`), its brief, storyboard and voiceover script (`BRIEF.md`, `STORYBOARD.md`,
`SCRIPT.md`), and the rendered file at `renders/video.mp4`. It re-renders with
`npx hyperframes render`.

It is kept as a record of the prototype and as a starting point for a Monad version, which would
need a new script and new on-screen values (Monad transactions, XorvLedger receipts, ERC-8004
agents).
