# @xorv/broker — AI roles

Three sponsor models take a turn on every Xorv job. They are part of the broker's
core loop, not optional adapters a buyer has to go looking for:

```
POST /api/quotes ─► Hunyuan screens the prompt ─► Qwen routes "Auto" ─► matcher ─► frozen quote
job completed    ─► Kimi scores the result ─► ERC-8004 giveFeedback from the verifier EOA
```

| Role | Model | Runs | What it decides | Where you see it |
|---|---|---|---|---|
| Screener | Tencent Hunyuan `hy4-preview` (TokenHub) | every quote, before a provider can see the prompt | `allow` / `block` + category + reason. A block is **HTTP 422** and no quote is issued | quote `screening`, job page "Screened by", `/api/network` |
| Router | Alibaba Qwen 3.8 Max `qwen3.8-max` (Model Studio, thinking off) | quotes with no adapter or `"auto"`, when at least two adapters are live under the ceiling | which adapter runs the job, why, and how hard it is | quote `routing` ("Routed by Qwen 3.8 Max: …"), composer's **Auto** option, job page |
| Verifier | Moonshot Kimi K3 `kimi-k3` (`reasoning_effort: "low"`) | every completed job that isn't private | score 0–100, pass, rationale, flags | job `verification`, the provider's ERC-8004 reputation, `/verifications/<jobId>.json` |

## How each role is kept honest

- **Screener** (`src/ai/screener.ts`) protects provider machines: credential or key
  exfiltration, malware, destructive commands, sandbox escape, prompt injection
  against the node. The quote freezes the screened request and the paid route only
  runs the quoted request, so a prompt can't be swapped after screening. If Hunyuan
  can't answer, `XORV_SCREENER_FAIL=open` (default) quotes anyway and the record
  says *"not screened: … allowed because XORV_SCREENER_FAIL=open"*; `closed`
  refuses to quote (503) until the screen is back.
- **Router** (`src/ai/router.ts`) sees the prompt and a compact table of the live
  candidates under the buyer's ceiling — adapter, model, price, success rate,
  mean buyer rating, mean Kimi score, ERC-8004 identity — and answers
  `{adapter, reason, difficulty}`. The pick must be one of those candidates; the
  price matcher still picks the node for it, so the router can never steer a job
  to a particular provider or above the ceiling. Timeout, provider error, bad JSON
  or an off-table pick → the deterministic matcher, recorded as
  `routing.fallback` with the reason ("… matched on price instead").
- **Verifier** (`src/ai/verifier.ts`) runs after the buyer already has the result
  and never blocks the job. Private jobs (`request.encryptTo`) are skipped — the
  broker only holds their ciphertext. Prompt and result are fenced as untrusted
  data; a result the model flags as `prompt_injection` never passes.

All three share `src/ai/client.ts`: one call over the protocol's `chatJson`
(OpenAI-compatible, JSON mode), a hard per-role deadline (screen 5 s, route 6 s,
verify 20 s) raced against the request, strict validation, per-role latency and
failure counters, and key hygiene — keys go only to each preset's base URL and are
scrubbed from any error text before it is logged or served.

## The verifier's on-chain feedback (ERC-8004)

When the provider holds a verified ERC-8004 agent (and did the work it was paid
for) and the broker has a verifier key, the score is written to the Reputation
Registry from the verifier EOA (`src/ai/feedback.ts`, called from `src/app.ts`):

```
giveFeedback(agentId, score, 0, "xorv-verified", <adapter>, <XORV_PUBLIC_URL>/api/quotes,
             <XORV_PUBLIC_URL>/verifications/<jobId>.json, keccak256(file))
```

- The file at `GET /verifications/<jobId>.json` is canonical JSON with the model,
  score, rationale, flags, the job's request and result hashes and the x402
  `proofOfPayment`; its keccak256 is the committed `feedbackHash`. It is rebuilt
  from facts frozen when the job was scored, so it keeps hashing to what went
  on-chain. Its hash is stored on the job before the transaction is sent.
- Buyer ratings go through XorvLedger under tag `starred`; verifier scores come
  from a different client address under `xorv-verified`, so the two signals stay
  separable in the registry.
- Gas: ~280k per first feedback (~0.03 MON), billed on the gas *limit* on Monad, so
  the write carries `estimateGas` + 15% and goes through the protocol's
  per-address signer lock — the same queue as the ledger writer and facilitator.
  The estimate doubles as a free preflight for a feedback the registry would refuse.
- `XORV_VERIFIER_KEY` defaults to `XORV_OPERATOR_KEY`. It **must never own or
  operate a provider's agent NFT** (the registry rejects self-feedback). If it is
  a separate key, add its address to the indexer's `ENVIO_XORV_VERIFIER_ADDRESSES`
  so Envio classifies its feedback as `XORV_VERIFIED` (it trusts only the ledger's
  broker EOA by default).
- Best-effort: a failed write is stored on the job as `verification.feedbackError`
  and counted in `/api/network`; the job itself is never touched.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `XORV_SCREENER` / `XORV_ROUTER` / `XORV_VERIFIER` | `auto` | `auto` = on exactly when the key is set; the provider name = on, warn at boot if the key is missing; `off` |
| `XORV_SCREENER_FAIL` | `open` | what a quote does when the screen can't answer |
| `XORV_VERIFIER_KEY` | operator key | signs the verifier's `giveFeedback`; unset and no operator key = scores stay off-chain |
| `TOKENHUB_API_KEY` / `XORV_HUNYUAN_API_KEY` | — | Hunyuan (screener) |
| `DASHSCOPE_API_KEY` / `XORV_QWEN_API_KEY` | — | Qwen (router); keys are region-bound, default endpoint is the international one |
| `MOONSHOT_API_KEY` / `XORV_KIMI_API_KEY` | — | Kimi (verifier) |
| `XORV_{HUNYUAN,QWEN,KIMI}_BASE_URL`, `_MODEL` | preset defaults | endpoint and model overrides |

A missing key never stops the broker: the role is off and says why.
`pnpm --filter @xorv/broker setup` and the boot banner list each role;
`GET /api/network` reports enabled roles under `ai` (the protocol's `AiRoleInfo`,
`null` when off) and every role's full state under `aiRoles` — enabled, provider,
model, the reason it's off, latency, the screen's fail mode, and where verifier
feedback goes. Prometheus: `xorv_ai_screen_total`, `xorv_ai_route_total`,
`xorv_ai_verify_total`, `xorv_ai_feedback_total`, `xorv_ai_latency_ms{role}`.

What the models see: Hunyuan and Qwen read the buyer's prompt (Qwen at most its
first 6,000 characters); Kimi reads the prompt and the result of non-private jobs.
Nothing else leaves the broker.

## Tests

`test/ai.test.ts` (each role against a stubbed provider: happy path, malformed
JSON, timeouts — including a `fetch` that ignores its abort signal — HTTP errors,
off-table router picks, out-of-range scores, key redaction, the feedback file and
its hash, and a real viem broadcast of `giveFeedback` against a stub RPC checking
the `estimateGas` + 15% limit and the calldata) and the "AI roles" block in
`test/integration.test.ts` (the real quote and completion paths). No network, no
keys: `pnpm --filter @xorv/broker test`.
