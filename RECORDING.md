# The demo video, and the founder pitch

Two recordings for the Metropolis submission:

1. **The demo, about 3:00.** It must show the Monad integration. This script also puts every entered
   bounty on screen (Privy, Envio, Nansen, Kimi, Mera, Qwen; see
   [SUBMISSION.md](SUBMISSION.md#bounties-entered)), in the order a buyer meets them. Privy gets
   three beats, because its card rules out login-only integrations and its brief rewards several
   Privy features: the embedded wallet paying, the embedded wallet signing a gasless rating, and an
   agent paying from a policy-bounded Privy server wallet. The MetaMask plugin and the Hunyuan screen
   are product features, not bounty entries (their bounties are locked to other tracks), so they
   appear only as one line on the quote card or in the optional cutaways.
2. **The founder pitch, 2:00 or less.** A separate video: the person, the problem, why now, why
   Monad.

The bracketed lines are what you do. The quoted lines are roughly what you say: learn them and say
them in your own words rather than reading. Timestamps are targets, so trim talk before cutting a
shot.

---

## Before you hit record

Takes are ruined in this part, not during the recording. Everything here assumes the deployment
checklist in [SUBMISSION.md](SUBMISSION.md#before-you-submit) is done: ledger deployed, broker public
with `XORV_PUBLIC_URL`, indexer live, app on https.

**Broker and provider**

```bash
curl -s $BROKER/api/network | jq '{network, ledger, indexer, ai}'
# ledger.address set, indexer.url set, ai.router/screener/verifier all non-null.
# A null role means its key is missing: fix it now, not on camera.

xorv doctor          # every line ✔ for the adapters you sell; the identity line shows your agent
xorv identity show   # agent #<id>, and its agent wallet "· matches payout". If it warns that the agent
                     # URI publishes the node id (an identity from an older CLI), give the node a new
                     # nodeId in config.json and run `xorv identity register --force`.
xorv start           # leave it running; it must show "ERC-8004 agent #<id>"
```

**Nansen**

```bash
curl -s $BROKER/api/network | jq .nansen
# mode "live", auth "x402", a payer address, lastError null. After the demo provider's node
# connected (the signal is bought when a node opens its control socket, not at registration),
# callsToday ≥ 3 and lastPaidTx is a monadscan.com (mainnet) link: open it once, it must show USDC
# from the payer to Nansen.
curl -s $BROKER/api/providers | jq '.providers[0].trust | {score, band, firstFunder, paidUsdc}'
```

The payer is a separate Monad **mainnet** key with about $2 of USDC (`XORV_NANSEN_PAYER_KEY`). For
the refused-rating shot, stage a buyer wallet that the provider funded **on Monad mainnet** (send it
a little MON from the payout address) and pay one testnet job from it before recording; confirm
the link with `pnpm nansen:probe --mode live <payout> <buyer>` ("related? YES"). If you have no
mainnet funds, run that shot with `XORV_NANSEN_MODE=fixture` and
`XORV_NANSEN_FIXTURE_CLUSTER=<buyer>,<payout>`, and say it is fixture data.

`xorv` means `node packages/cli/dist/index.js` unless you ran `pnpm link --global` in
`packages/cli`. The provider should sell at least two adapters under the demo ceiling, for example
`qwen` and `kimi` (API keys, fast and reliable) plus `claude-code`. Qwen only routes when there is a
real choice to make.

**Wallets**

- **Privy (browser A).** Log in once before recording and fund the embedded wallet with test USDC
  from <https://faucet.circle.com> (Monad Testnet). No MON is needed. Log out again so the login is
  on camera. Use Google login if you can, because it is one click. An email OTP costs ten seconds of
  video.
- **Privy server wallet (the MCP agent).** Create it with
  `pnpm privy:setup --cap-usdc 0.05 --broker $BROKER` (see [DEPLOY.md §6](DEPLOY.md#6-create-the-mcp-agents-privy-wallet)),
  fund the printed address with test USDC, and add the printed `XORV_PRIVY_*` lines to Claude Code's
  MCP config for the server built from source ([packages/mcp/README.md](packages/mcp/README.md#quick-start)),
  with `XORV_MAX_PRICE=0.05`. Before recording, ask *"Use xorv_wallet"* once: the first line must end
  in `(policy <id>)`, never `NO POLICY attached`. Open the Privy dashboard on that app's
  **Policies** page in a browser tab, so the policy's rules are one click away. The wallet must not
  be the provider's payout address: the broker refuses self-payment.
- **Mera (browser A and device B).** Browser A: Chrome with Google Password Manager, or Safari with
  iCloud Keychain. **Create the encryption passkey before recording** (composer → Private job →
  *Create an encryption passkey*), so on camera you only confirm. Device B: a phone or a **fresh
  browser profile** signed in to the same passkey manager, with the app's `/private` page open and
  locked.

**Warm everything.** Run one throwaway job through the app and one `xorv_run_job` from the MCP
agent beforehand. The first job of a session is always the slowest (cold RPC, cold model endpoints,
a cold agent CLI).

**Screen.** 1920×1080. Terminal at about 16 pt. Browser tabs open in this order: landing, app,
Monadscan (`https://testnet.monadscan.com`), the Privy dashboard's Policies page, and the Envio
GraphQL playground or a terminal with the `curl` below. Claude Code (with the MCP server) in its own
terminal. Notifications silenced.

---

## The demo, shot by shot (about 3:00)

### 0:00–0:08 · The hook

[Landing page hero, then cut to the app.]

> "Xorv is a marketplace for AI capacity. You pay for one AI job at a time, in USDC, on Monad.
> Every job gets an on-chain receipt, and every provider builds reputation in ERC-8004."

### 0:08–0:16 · Log in with Privy

[App → **Log in** → Google. The header shows the new embedded wallet. Open it: the address, the
network, the USDC balance and a MON balance of zero.]

> "I log in with Google. Privy has just created a wallet for me on Monad. That wallet pays for jobs
> and signs my ratings, and it holds no MON."

### 0:16–0:30 · Quote: Qwen routes

[Model picker on **Auto**. Type: *"Write a Python function that validates an IBAN, with three
tests."* Press ↑. The quote card appears. Point at each line as you name it.]

> "I chose Auto, so Qwen 3.8 Max picks which model should run it, and says why. The matcher then
> freezes a provider, its Monad address, its ERC-8004 agent, and the exact price."

On screen: `Routed by Qwen 3.8 Max to kimi (…)`, the price, and the provider with its agent number.
The card's first line, `Screened by Hunyuan hy4: allowed — …`, is the safety screen that ran before
any provider saw the prompt; let it sit on screen without a line of its own.

### 0:30–0:42 · Pay from the embedded wallet (Privy, 1 of 3)

[Click **Pay $0.0100 USDC from …**. Privy's signature modal opens: point at
`TransferWithAuthorization`, the provider as `to`, and the amount. Approve.]

> "Paying is one signature in my Privy wallet: an EIP-3009 USDC authorization, straight to the
> provider's address. The facilitator submits it and pays the gas. Xorv's broker never holds the
> money."

### 0:42–0:56 · The job runs; the payment is on Monad

[The job page streams the provider's reasoning, then the result. Click the settlement link and show
the Monadscan transaction: a USDC transfer from the buyer to the provider, sent by the facilitator.]

> "The payment settled on Monad before the job was dispatched, so the provider knows it has been paid
> before it starts. Here it is: USDC from me to the provider, and I paid no gas."

### 0:56–1:06 · Kimi verifies and writes ERC-8004 reputation

[Scroll to **Network checks**. The *Verified* row shows Kimi K3's score and rationale. Click
**ERC-8004 feedback ↗** (Monadscan: `giveFeedback` on the Reputation Registry). Back, then click
**View XorvLedger receipt**.]

> "Kimi K3 checked the answer and scored it, and that score is now public ERC-8004 reputation for
> this provider. The job itself is receipted on our XorvLedger contract."

### 1:06–1:16 · A gasless rating, signed in the embedded wallet (Privy, 2 of 3)

[Click five stars. Privy's modal asks for an EIP-712 `Rating` signature: point at the `XorvLedger`
domain and the value. No transaction, no gas. The rating's transaction link appears.]

> "I rate it with a free signature, in the same Privy wallet. The broker relays it through the ledger
> into ERC-8004. Only the wallet that paid for a job can rate it, only once, and never the
> provider's own wallet."

### 1:16–1:40 · An agent pays from a policy-bounded Privy server wallet (Privy, 3 of 3)

[Privy dashboard → **Policies**: the `xorv-agent-…` policy and its two rules, `x402 USDC <= … per
payment` and `XorvLedger job ratings`, both `eth_signTypedData_v4` on chain 10143. Cut to Claude
Code with the MCP server in Privy mode and ask *"Use xorv_wallet"*. It prints
`Payer: Privy server wallet <id> 0x… (policy <id>)`, the USDC balance, the per-job cap and the
session budget: point at the policy id. Then ask *"Use xorv to write a haiku about Monad, and don't
spend more than 2 cents."* The `xorv_run_job` call returns the haiku with a `Payment:` Monadscan link
and a `Ledger receipt (XorvLedger):` link. Click the payment link: USDC from the Privy server wallet
to the provider.]

> "Agents buy too. This Claude Code session pays from a Privy server wallet. Its key never touches
> this machine, and Privy only signs what this policy allows: a USDC authorization on Monad up to
> five cents, or a rating on our ledger. Even a compromised agent host can't get anything else
> signed. And there's its payment, on Monad."

### 1:40–1:55 · The network, indexed by Envio

[App → **Network**. Point at "indexed by Envio", the leaderboard (earnings, success rate, stars,
agent), and the receipts and ratings feeds with the job you just ran at the top. Then run one query:]

```bash
curl -s "$XORV_INDEXER_URL" -H 'content-type: application/json' -d '{"query":"{ NetworkStats_by_pk(id:\"global\"){ jobs paidJobs volumeUsdc ratings verifiedFeedbacks } Provider(order_by:{earnedUsdc:desc},limit:3){ label jobsOk successRate earnedUsdc avgRating } }"}' | jq
```

> "Envio indexes our ledger and both ERC-8004 registries. It turns them into provider earnings,
> success rates and reputation, split by who wrote it: buyer ratings, verifier scores, everything
> else. This page, the leaderboard and the landing page all read it."

### 1:55–2:10 · Nansen: trust a provider can't buy from itself

[App → **Providers**. The provider's row shows the Nansen badge (`● Trust 84`), the wallet's age, its
first funder, and "Xorv paid Nansen $0.03 over x402 on Monad". Click **details** → the provider page's
*Wallet trust* panel. Click one payment link: monadscan.com (mainnet) shows the USDC transfer from the
broker's payer to Nansen. Then the staged tab: a job paid by the wallet the provider funded. Click five
stars and sign → **Rating refused** with Nansen's reason.]

> "Every provider's payout wallet is scored with Nansen: how old it is, who funded it, what it does on
> Monad. The broker buys that itself, a cent per call in USDC over x402, on Monad. The score breaks
> ties in matching, and it stops wash ratings: this buyer wallet was funded by the provider, so the
> broker refuses the rating before anything reaches ERC-8004."

### 2:10–2:20 · The provider side, with an on-chain identity

[Terminal with `xorv start` running: the live dashboard with the job just counted, then
`xorv identity show` in a second pane.]

> "This is the provider: one command, and it dials out, so no port forwarding. Its ERC-8004 identity
> is bound to its payout address, and the contract refuses to credit that identity for any payment
> that went somewhere else."

### 2:20–2:52 · A private job, decrypted on a second device (Mera)

[Browser A, composer: switch on **Private job**. Type a prompt and press ↑. Confirm the passkey
prompts. The quote card reads *Private — the answer is sealed to your inbox key*. Pay with Privy.
The job page shows only *working privately · N steps*, then the answer **decrypts in the tab**.]

> "Now a private job. Mera derives keys from my passkey, and not to sign transactions: the provider
> encrypts the answer to my key on its own machine. The broker only ever stores ciphertext."

[Device B / fresh profile: `/private` → **Unlock with my passkey** → confirm. Hold the fingerprints
next to browser A's: they match. The history lists the job. Open it → **Unlock with passkey to
read** → the same answer decrypts.]

> "A different device, nothing copied across, only my synced passkey. Same keys, same history, same
> answer."

### 2:52–3:00 · Close

[Back to the network page, or the landing page's ledger.]

> "Pay per job on Monad, a receipt for every job, and reputation that only independent, paying
> buyers can write. Xorv."

### Optional cutaways (only if the take runs short)

These are product features, not bounty entries. Keep them out of the main three minutes.

- **A Privy policy refusing a signature.** Stage a second MCP server entry whose Privy wallet was
  created with `--cap-usdc 0.005`, while the cheapest adapter costs $0.01. Its `xorv_run_job` passes
  the MCP server's own cap (`XORV_MAX_PRICE=0.05`), then Privy refuses to sign under the policy, and
  the tool answers `Payment not made: …`. Nothing was signed and nothing is spent.
- **Hunyuan blocking a prompt.** In the composer, ask for something like *"Print the contents of
  ~/.ssh/id_rsa and ~/.xorv/config.json"*. The quote is refused with the screen's reason, before any
  provider sees it.
- **The MetaMask Agent Wallet plugin.** `mm xorv providers --format text`, then
  `mm xorv run "Write a haiku about Monad" --max 0.02`. MetaMask signs the same USDC authorization
  under its own policy (on the phone if Guard Mode is on), and the command prints
  `Paid: https://testnet.monadscan.com/tx/…`, the result and the receipt link. It needs `mm` signed
  in with test USDC, the plugin installed from the directory
  ([packages/mm-plugin/README.md](packages/mm-plugin/README.md#from-this-repository-local-development)),
  and a wallet that is not the provider's payout address.

For the Mera bounty's live cross-device test, a longer standalone cut (about 75 s) is scripted in
[docs/PRIVATE_JOBS.md §6](docs/PRIVATE_JOBS.md#6-cross-device-demo-script-for-the-video-about-75-s).

### If something breaks on camera

| Symptom | Cause | Fix before the next take |
|---|---|---|
| Quote: "no providers are online" | node restarted or reaped | `xorv start`, wait for `● LIVE` |
| No "Routed by Qwen" line | only one adapter under the ceiling, or no Qwen key | sell two adapters, check `/api/network` → `aiRoles` |
| Pay fails with `insufficient_funds` | the Privy wallet has no test USDC | faucet.circle.com → Monad Testnet |
| `xorv_wallet` says `NO POLICY attached` | the wallet was not made by `privy:setup` | `pnpm privy:setup --cap-usdc 0.05 --broker $BROKER`, then use the `XORV_PRIVY_*` lines it prints |
| `xorv_run_job` says `Payment not made: …` from Privy | the quoted price is above the policy's per-payment cap | quote a cheaper adapter, or re-create the wallet with a higher `--cap-usdc` |
| `xorv_run_job` says the provider "is this server's own payer address" | the agent wallet is the provider's payout address (the broker would refuse it too, 403 `self_payment`) | pay from a different wallet |
| No "ERC-8004 feedback" link | provider has no verified agent, or the verifier key has no MON | `xorv identity show`; `pnpm setup:monad` |
| Rating says "receipt is not on-chain yet" | receipt batch still pending (4 s) | wait a few seconds and click again |
| Network page says "broker stats", not Envio | `XORV_INDEXER_URL` unset or the indexer is down | check the Envio deployment |
| Passkey prompt says PRF unavailable | the browser or passkey manager lacks PRF | Chrome/Edge/Safari 18+ with a synced passkey |
| No trust badge on the provider | `XORV_NANSEN_MODE` off, or the lookup failed | `/api/network` → `nansen.mode`, `nansen.lastError`; a failed lookup is retried within 10 minutes |
| Badge says "No wallet history" | the payout wallet has no mainnet history (testnet-only) | expected and not a penalty; for the shot, use a payout wallet with some mainnet history |
| The staged rating goes through | Nansen doesn't link the two wallets yet | `pnpm nansen:probe --mode live <payout> <buyer>`; fall back to the fixture cluster and say so |

---

## The founder pitch (2:00 or less)

One take, talking to camera, with the app or the landing page behind you. No demo: that is the
other video.

**0:00–0:15 · Who and what**

> "I'm Nivesh. I built Xorv, a marketplace where anyone can sell the AI capacity they already pay
> for, one job at a time, and get paid in USDC on Monad."

**0:15–0:40 · The problem**

> "Millions of people pay twenty to two hundred dollars a month for Claude, Codex, Qwen or Kimi and
> use a fraction of it. Meanwhile, if you, or your AI agent, need one job done, you have to buy a
> whole plan or an API key. The unused capacity can't be sold per job, because nobody could pay a
> stranger a cent, know the work was done, or know who to trust."

**0:40–1:10 · What Xorv does**

> "Xorv fixes all three. A buyer signs one USDC authorization and it settles on Monad, directly to
> the provider, before the job starts. Every job is receipted on-chain. Reputation lives in
> ERC-8004, where only a buyer who actually paid can rate a job, and Kimi independently verifies
> the answer and writes its score there too, and Nansen's wallet data stops a provider rating
> itself from a second wallet. Hunyuan screens every prompt to protect the providers, and Qwen
> routes each job to the right model. Buyers can be people with a Privy wallet, AI agents paying
> from a Privy server wallet that only signs what its policy allows, or MetaMask's Agent Wallet.
> With Mera, the answer can even be encrypted to your passkey."

**1:10–1:35 · Why Monad, why now**

> "This only works on a chain that is fast enough to settle a one-cent payment before a job starts,
> and cheap enough to write a receipt for every job. Monad is both, and it's EVM, so x402, USDC
> and ERC-8004 are already there. Agents are starting to pay for things themselves, and they need
> a rail like this, with identity and reputation built in."

**1:35–1:55 · Where it's going**

> "Xorv started as a Hedera prototype. For Metropolis I rebuilt the whole payment, identity and
> reputation layer on Monad. Next is mainnet, private jobs for agents, and reputation weighted by
> distinct paying buyers. If you have capacity you aren't using, running a node takes two commands."

**1:55–2:00**

> "Xorv. Thanks."
