# Recording runbook: the ≤3-minute demo on the live app

The existing cut, [docs/demo/xorv-demo.mp4](demo/xorv-demo.mp4) (2:02), follows this path. Use this file for a fresh re-take, by hand (a person in the browser, with the no-login demo account) or automated (`node e2e/web/record-demo.mjs .env`, where an MCP agent buys the job). The shot list is the same either way.

## Before you press record (5 minutes)

1. **Check the stack is live.**
   - <https://broker-production-2d62.up.railway.app/health> returns `{"ok":true}`.
   - `/api/providers` lists "Xorv hosted · Kimi K3" as `online`, with agent `2252`.
2. **Nansen, for this take only.** Set it on the broker, then remove it after the take (100 shared credits; about 4 calls):
   ```bash
   railway variables --service broker --set XORV_NANSEN_MODE=live --set "NANSEN_API_KEY=<from metropolis-funding/keys/api-keys.env>"
   ```
   It redeploys the broker. Wait until `/api/network` shows `nansen.mode: "live"` and `walletsScored: 1`. That takes about 2 minutes; the provider reconnects by itself.
3. **Funds.** Each balance must clear its floor:
   - demo payer `0xEc48…9a3C`: at least 0.05 USDC;
   - facilitator `0xf4c4…2F79` and operator `0x43E5…0c92`: above 10.5 MON;
   - for the automated take, the MCP Privy wallet `0x6613…40fB`: at least 0.05 USDC.
4. **Screen.**
   - One Chrome window, 1920×1080, dark mode, zoom 100%, everything else closed.
   - Tabs in order: `/` (home), `/network`, and the CRE refund tx `/chain/tx/0xa85c2f69d7ccb7fea3d3d574d453f9974125b493675d626a2e037e8002decd15`.
   - Don't log in: the take uses **Pay from demo account**.

## The shots (about 2:30)

| # | Time | Click | What appears | Caption |
|---|---|---|---|---|
| 1 | 0:00–0:08 | Home tab, still | "Run a job on someone else's **Kimi K3**", the composer, Live providers | Xorv on Monad: a marketplace for AI work. Pay one job at a time in USDC, held in escrow until the work is delivered. |
| 2 | 0:08–0:22 | **Network** tab | Live block chips turning Proposed → Voted → Finalized → Verified; the medians (about 295 / 580 / 1,490 ms) | Monad testnet, live: voted in about 0.3 s and final in about 0.6 s. Xorv settles every payment on this. **Pause on the chips for 3 s.** |
| 3 | 0:22–0:28 | Scroll to "Who secures the payments" | Epoch, validators in consensus, the validator proposing now, its stake | The validator set finalizing those blocks, read live from Monad's staking precompile. |
| 4 | 0:28–0:32 | Scroll to Settlement | "usdc / usd $0.9998 · Chainlink Data Feed" | Chainlink USDC/USD guards the price: quoting pauses if USDC leaves its peg. |
| 5 | 0:32–0:45 | Home tab → type *"In one sentence: what does a judge look for in a hackathon demo?"* → ⌘↵ | Quote card: Xorv hosted · Kimi K3, $0.0200, "XorvEscrow 0x87d5…Df91 holds it → pays 0xE0f2…9B03 on delivery" | The quote freezes the provider, the price and the escrow before anything is paid. |
| 6 | 0:45–0:50 | **Pay from demo account** | The page goes to `/jobs/job_…` | One EIP-3009 signature. The buyer holds no MON: the facilitator pays the gas. |
| 7 | 0:50–1:10 | Watch, don't click | "Where the money is": **Paid into XorvEscrow (finalized)** → Running → Delivered → **Released** (green) → Receipt on XorvLedger | The USDC sits in XorvEscrow on Monad until the work is delivered. It is released only after Kimi passes it. |
| 8 | 1:10–1:22 | Point at the **Monad speed receipt** | "payment executed ~450 ms · payment final ~1.0 s"; the release row "executed … · final … · receipt in the send"; "buyer paid in gas 0 MON"; "gas in dollars ≈ $0.0009 · Chainlink MON" | **The Monad moment: pause 4 s.** Executed in under half a second, final in about one, with the receipt back in the send itself (`eth_sendRawTransactionSync`). |
| 9 | 1:22–1:34 | Scroll to **Network checks** | "Verified by Kimi kimi-k3 · 95/100 · pass" and an **ERC-8004 feedback ↗** link | Kimi checks the work. A pass releases the money, a fail refunds the buyer, and the verdict becomes ERC-8004 reputation for agent #2252. |
| 10 | 1:34–1:44 | Click the release tx hash `0x…` ↗ (in the timeline) | The in-app chain viewer: success, finalized; a USDC Transfer from XorvEscrow to the provider | Check it on chain: the release, read straight from Monad. |
| 11 | 1:44–1:58 | Click the provider name, "Xorv hosted · Kimi K3" | Provider page: Online, ERC-8004 agent #2252, earnings and per-job payouts. Scroll to **Wallet trust · Powered by Nansen** | Each payout links to its Monad transaction. Nansen profiles the payout wallet and blocks self-rating. |
| 12 | 1:58–2:16 | CRE refund tab | Transaction: Transfer from XorvEscrow back to the buyer, **JobRefunded**, **KeeperRefunded**, **ReportProcessed** from the "Chainlink forwarder (CRE simulation)" | If the work never comes, a Chainlink CRE workflow finds the expired job in the Envio index and refunds the buyer. No one at Xorv has to act. |
| 13 | 2:16–2:26 | Home tab | Recent jobs, with the new job at the top | Built on Monad with Privy, Kimi, Chainlink CRE and Data Feeds, Envio, Nansen, Agora AUSD and ERC-8004. |

**Optional shot 9b, the strongest trust beat (about 15 s, about 0.15 MON):** a fail → refund. Ask for something the verifier will fail, e.g. *"Reply with only the word banana."* to a prompt that demands an essay. Kimi scores it low, the timeline shows **"Refunded: the work failed verification"**, and the refund tx returns the USDC to the buyer. That gives a public fail → refund pair to cite.

For the **automated** re-take, run `node e2e/web/record-demo.mjs .env` from the repo root:
- shots 5–6 become "an MCP agent pays from its Privy server wallet", and the job starts by itself;
- the captions are burned in, and the MP4 and SRT land in `docs/demo/`.

It takes the heavy slot: `metropolis-funding/slots/heavy.sh acquire xorv`, then `release`.

## If something hiccups

| Symptom | Fallback |
|---|---|
| The quote says "no online provider can take a job right now: daily capacity reached" | The provider's daily cap (40 jobs) is spent. Set `XORV_DAILY_CAP_OFF=1` on the Railway `provider` service for the take, then remove it. |
| The quote says "no online provider matches" right after a broker redeploy | Wait 30 s: the provider re-registers by itself (check `railway logs --service provider` for "control channel open"). |
| "Pay from demo account" is missing, or fails with insufficient funds | Top up the demo payer `0xEc483Ae478f972475524F20922c1F7A324639a3C` with test USDC. Or use the automated take, where the MCP wallet pays. |
| Release stays on "Waiting for the verifier's verdict" | Moonshot is slow or down. It releases by itself after 2 minutes; keep rolling, or cut. |
| Network chips are empty | Reload the tab. The public WebSocket sometimes needs a second connect. |
| Nansen panel says "not configured" | Step 2 of the setup didn't apply. Skip shot 11's Nansen line, or redeploy and wait. |

## What one take consumes

| Account | Per take | Why |
|---|---|---|
| Demo payer `0xEc48…9a3C` (manual) or MCP Privy wallet `0x6613…40fB` (automated) | **0.02 USDC** | the job price, paid into escrow and released to the provider |
| Facilitator `0xf4c4…2F79` | **≈0.07 MON** | escrow fund + release: 2 txs × ≈342k gas limit × ≈102 gwei. Monad bills the limit. |
| Operator `0x43E5…0c92` | **≈0.07–0.1 MON** | the XorvLedger receipt and Kimi's ERC-8004 feedback; ≈0.035 more if the job is rated |
| CRE key `0x4d9e…DAb2` | **0** | shot 12 shows the existing refund tx. A fresh one costs ≈0.204 MON (2M gas limit) plus ≈0.035 MON from the facilitator. |
| Nansen | ≈4 calls | when it is switched on (shared 100 credits) |
| Moonshot (Kimi) | 2 calls | the provider's answer and the verdict, within the provider's daily cap |

**Three takes ≈ 0.06 USDC and ≈0.5 MON**, all within current balances, with about 4.9 MON spare above the reserve on the operator and on the facilitator. After the take, turn Nansen back off:
```bash
railway variables --service broker --set XORV_NANSEN_MODE=off
railway variable delete NANSEN_API_KEY --service broker
```
