# Kimi K3 holds the escrow key: build notes from Xorv

Xorv is a pay-per-job AI marketplace on Monad testnet. People pay $20–200 a month for AI subscriptions and use a fraction of them; Xorv lets them sell that spare capacity one job at a time. A buyer, either a person in the browser or an agent over MCP, pays USDC over x402 into **XorvEscrow**. The money waits there until someone decides whether the work was any good.

That someone is Kimi K3. Here is how we use it, what we measured, and where it falls short.

## Three jobs for one model

**1. The verifier.** When a job completes, the broker sends the prompt and the result to `kimi-k3` (`services/broker/src/ai/verifier.ts`). Kimi returns a score from 0 to 100, a pass or fail, a short rationale and a list of flags. The result comes from a stranger who wants to be paid, so prompt and result are fenced as untrusted data. A result that Kimi flags as `prompt_injection` never passes, whatever score it got.

**2. The escrow gate.** On the hosted broker, `XORV_RELEASE_ON_VERDICT=on`. A pass releases the escrow to the provider, and a fail refunds the buyer. The order matters: since 20:25 IST on 13 Oct (commit `b1888e4`), the broker waits until Kimi's verdict is on chain before it releases the money. A judge can check the order from the block numbers alone.

**3. Reputation.** Each verdict becomes ERC-8004 feedback. The broker's verifier wallet calls `giveFeedback(agentId, score, 0, "xorv-verified", …)` on the canonical Reputation Registry. The full verdict is served at `/verifications/<jobId>.json`, and its keccak256 is the on-chain `feedbackHash`. Every paid job leaves a second signal next to the buyer's rating, readable by any marketplace.

Kimi is also a seller. A hosted provider node, registered as ERC-8004 **agent #2252**, sells Kimi K3 answers for $0.02 a job, through the same `kimi` adapter that any provider can run (`packages/cli/src/adapters/hosted.ts`).

## Why Kimi

The verifier runs on every job, so it must return reliable JSON, judge whether an answer fits its question, and stay fast and cheap enough for the payment path. Kimi K3 always reasons. With `reasoning_effort: "low"` it stays at a few seconds: in our first live call, it scored a test haiku 92/100 in 4.8 s. The verifier has a 20 s timeout and caps output at 1,200 tokens.

It also fits the story: the people Xorv is for already pay for models like Kimi, so the judge is the same kind of capacity the marketplace trades.

## What we measured

From live jobs on Monad testnet, as recorded in the repo's README and SUBMISSION files:

- **A browser buyer with no login**, `job_qYHL9A_f9aGZ`: paid $0.02 into escrow ([`0x8922a3…28dd`](https://testnet.monadvision.com/tx/0x8922a3a27429753fc04634bbbbed437ec7711f4a3fef6af9dde16c798a9628dd)). The payment was final in **1.02 s**, Kimi passed the work at **95/100**, and the escrow released to agent #2252. Its feedback [`0x09cee4…`](https://testnet.monadvision.com/tx/0x09cee4297af7ad725b3b2798a0647b87f1e50f936542c76755a20ae2ecefacf8) and release [`0x158573…`](https://testnet.monadvision.com/tx/0x158573fcda43ab596c4f4acf3691d90afbbd14e062400c96b65bfdb284747e78) are in the same block, 70663304, at tx index 1 and then 2.
- **Under the final rule**, `job_uqr20Kqph7WA` (a team-seeded buyer): Kimi's feedback [`0xb994cf…`](https://testnet.monadvision.com/tx/0xb994cfc891684bd29459c8d437ec9743f2f1bf87371076d483e6852430f02604) landed in block 70723392, and the release [`0x8a16b6…`](https://testnet.monadvision.com/tx/0x8a16b6f52df91dcda3229aaa8af77956749834f777c70e009edd629b7995c72b) in block 70723395.
- **On camera** in the demo video, `job_2pu9KhyvMlUX`: the verdict [`0xb9d4c6…`](https://testnet.monadvision.com/tx/0xb9d4c6012128c7883a23691a81857c85709941ad4dff99e137ab20c65fb74749) is in block 70750655 and the release [`0x62e327…`](https://testnet.monadvision.com/tx/0x62e32773a577b4c0ec053eeada6099bc38e219e8c273606ef24c37c09988af30) in block 70750656. Its payment was final in 1.08 s.
- **Gated release speed**, `job_4o0BmILtuvz5`: held until Kimi's 95/100 pass, then released 3.9 s after delivery ([`0x8ab899…`](https://testnet.monadvision.com/tx/0x8ab89925367b418d559959e845ffbd8f1e4e1917e1bcf7a13ce262b3286b1e2b)).

Monad makes this ordering affordable: a payment final in about a second leaves room for a few-second verdict and an on-chain write.

## Keeping the bill bounded

Testnet USDC is free and Kimi credit is not, so two guards stop junk jobs draining the budget:

- **A content cache.** The verifier keys verdicts by a SHA-256 hash of the title, prompt and result. The same work is never scored, or paid for, twice. The cache is bounded at 500 entries, and the oldest entry goes first.
- **A persisted daily cap** on the hosted provider: 40 jobs and 120k tokens per UTC day. It serves one job at a time, caps each reply at 4,000 tokens, and the cap survives redeploys.

## Limits, honestly

- **The gate is the broker's rule, not the contract's.** XorvEscrow's `attester()` is the broker's own wallet. The contract enforces who can be paid, and lets anyone refund a job after its deadline. But "release only on Kimi's pass" is enforced off chain, and the ordering is something you check, not something the contract guarantees.
- **Older jobs predate the gate.** Before 16:15 IST on 13 Oct there was no gate: `job_5lI4IqeDWek9` scored 25/100 and was still paid. Between 16:15 and 20:25, release waited for the verdict, but the feedback write could land a block after it. All of this is public in `/api/jobs`.
- **One judge.** A single model's score is an opinion, not a proof. Private jobs are never verified, because the broker only holds their ciphertext. On-chain feedback also needs the provider to have an ERC-8004 identity.
- **Our own traffic.** Every buyer so far, and the one provider, are the team's; seeded demo activity is labelled as such.

## What's next

First, move the trust off our server: have the escrow check something only the verifier can produce, such as a signed verdict or an ERC-8004 validation-registry entry. Then a second verifier for disputed scores, and outside providers whose reputation is built from Kimi's verdicts.

---

*Xorv is MIT-licensed. Live app: <https://xorv-monad-app.vercel.app>.*
