# Private jobs — one passkey, many keys

A Xorv job normally runs in the open: the prompt, the streamed log and the answer are
visible on the job page, and the XorvLedger receipt on Monad commits to the answer's hash.
A **private job** keeps the *answer* for the buyer alone. The provider encrypts it on their
own machine, before it leaves, to a key that only the buyer's passkey can re-derive. The
broker stores and serves an envelope it cannot open, the public job list shows only that a
private job happened, and the on-chain receipt commits to the ciphertext.

The buyer's key material comes from **[Mera](https://mera.category.xyz/)**
(`@category-labs/mera`), which evaluates the WebAuthn PRF extension on a passkey. Nothing
here signs a blockchain transaction: Privy's embedded wallet still pays for the job. The
passkey is used only as a source of deterministic, device-synced key material, split into
three namespaces that each become a different kind of key:

| Namespace (PRF salt label) | Key | What it does |
|---|---|---|
| `xorv:inbox:v1` | X25519 keypair | Its public key is the job's `encryptTo`; providers seal results to it, and the buyer opens them with it. |
| `xorv:vault:v1` | AES-256-GCM key | Encrypts the buyer's private-job history (job ids, prompts, prices, timestamps). |
| `xorv:vault-auth:v1` | Ed25519 key, held in a Mera signing session | Its public key's hash *is* the history vault's id; its signatures authorize every vault write. |

The live check: open the app on a second device, or in a fresh browser profile, signed in
to the same passkey manager. Unlock with the synced passkey and the same three fingerprints
appear, the history decrypts and every private result opens. Nothing crossed between the
devices except the passkey, which the passkey manager synced, and ciphertext from the broker.

---

## 1. Key derivation

```
                                   ┌─────────────────────── one passkey (synced by the OS / password manager)
                                   │
 salt = sha256("xorv:inbox:v1")    ├─► WebAuthn PRF ─► 32 B ─► HKDF-SHA256(salt="xorv:inbox:v1",
                                   │   (ceremony 1)             info="xorv:inbox:v1/x25519")      ─► X25519 secret ─► inbox public key = encryptTo
                                   │
 salt = sha256("xorv:vault:v1")    ├─► WebAuthn PRF ─► 32 B ─► HKDF-SHA256(salt="xorv:vault:v1",
                                   │   (ceremony 2)             info="xorv:vault:v1/aes-256-gcm") ─► AES-256-GCM vault key
                                   │
 salt = sha256("xorv:vault-auth:v1")└─► WebAuthn PRF ─► 32 B ─► HKDF-SHA256(salt="xorv:vault-auth:v1",
                                       (ceremony 3)             info="xorv:vault-auth:v1/ed25519") ─► Ed25519 seed ─► Mera signing session
                                                                                                                     vaultId = sha256("xorv:vault-id:v1" ‖ 0x00 ‖ pubkey)
```

- **The salts are namespaced.** Each namespace has its own PRF salt, `sha256(utf8(label))`,
  because Mera and WebAuthn take exactly 32 bytes. WebAuthn hashes the salt again, as
  `SHA-256("WebAuthn PRF" ‖ 0x00 ‖ salt)`, before the authenticator's HMAC. The
  authenticator therefore produces three unrelated outputs. They are not one secret fanned
  out in page memory. A component that needs only the inbox, such as the job page reading a
  result, asks only for the inbox. The HKDF salt and info bind the namespace a second time,
  so feeding one output to the wrong derivation still yields an unrelated key.
- **One confirmation per namespace.** WebAuthn can evaluate two salts in one ceremony, but
  Mera exposes one, and we don't reimplement WebAuthn around it. Unlocking everything costs
  three passkey confirmations. Each flow asks only for what it needs: reading a result needs
  the inbox (one confirmation), the history needs vault and vault-auth (two), and buying a
  private job needs all three, asked up front.
- **Pinned to one passkey.** On a fresh device the first ceremony lets the browser offer any
  discoverable passkey for the site. Every later ceremony is restricted to the credential
  that answered, so the three keys can never come from two different passkeys.
- **Versioned labels.** A derivation change would orphan every existing result and vault,
  so the labels carry `v1`, and `packages/protocol/test/sealed.test.ts` pins known-answer
  vectors. Rotation means adding `xorv:inbox:v2` alongside, not editing `v1`. The history
  entries record which inbox key each job was sealed to.
- **Cross-checked.** `packages/protocol/test/vault.test.ts` recomputes each derivation with
  `node:crypto` (HKDF, X25519, Ed25519) to show that the code does what this page says.

## 2. The sealed-result envelope

The provider node seals the result the moment its adapter returns
(`packages/cli/src/node.ts` → `sealResult`):

```
esk, epk   = fresh X25519 keypair (per result)
shared     = X25519(esk, inboxPublicKey)
info       = "xorv:result:v1" ‖ 0x00 ‖ jobId
K          = HKDF-SHA256(ikm = shared, salt = epk ‖ inboxPublicKey, info, 32)
ct         = AES-256-GCM(K, iv = 12 random bytes, aad = info, plaintext)

result     = {"v":1,"alg":"x25519-hkdf-sha256-aes256gcm","epk":…,"iv":…,"ct":…}   (base64url fields)
```

- The job id sits in both the key derivation and the additional data. An envelope replayed
  as another job's result does not open.
- A wrong key, a wrong job id and a flipped byte are indistinguishable by design: GCM
  refuses them all with the same error.
- **Sharing one result.** `K` is an HKDF output, so disclosing it reveals exactly one result
  and nothing about the inbox key or any other job. The job page's "Copy a link that opens
  only this result" puts `K` in the URL *fragment* (`/jobs/<id>#k=…`), which browsers never
  send to a server. Whoever holds the link can read that result and check it against the
  on-chain hash, and no passkey is involved.
- Crypto is pure JS from the audited noble libraries (`@noble/curves`, `@noble/hashes`,
  `@noble/ciphers`). The provider (Node) and the page (browser) run the same code from
  `@xorv/protocol/web`.

## 3. The history vault

Public views redact a private job's prompt, so the buyer keeps their own record in a vault.
The record holds job id, prompt, title, price, provider, timestamp and the `encryptTo` used.

- **Stored as ciphertext on the broker:** `PUT/GET /api/vaults/:id`. The body is
  `{ciphertext, iv, version, signature, publicKey}`, and GCM additional data binds the
  ciphertext to its vault id and version.
- **Self-certifying id.** The id is `sha256("xorv:vault-id:v1" ‖ 0x00 ‖ ed25519PublicKey)`.
  No account, registration or trust-on-first-use is needed. A fresh device derives the
  same key, which gives the same id, and asks for it. Reads are unauthenticated because the
  id and the decryption key both come from the passkey.
- **Only the owner writes.** Each write is signed by the Ed25519 vault-auth key over
  `"xorv:vault-write:v1\n" id "\n" version "\n" iv "\n" hex(sha256(ciphertext))`. The broker
  checks that the key hashes to the id and that the signature verifies.
- **Only in order.** The broker accepts exactly `current + 1`. A replayed or rolled-back
  write gets 409. So does a concurrent write from another device, which re-reads, merges
  (union by job id) and retries.
- **Limits:** 176 KiB of ciphertext (≈240 KB base64url, inside the broker's 256 KB body
  limit), 10,000 vaults per broker, and 20 writes a minute per client. The responses are
  400 (malformed), 403 (wrong key or signature), 409 (stale version), 413 (too large) and
  507 (broker full).

## 4. What is persisted, and where

| Where | What | Sensitive? |
|---|---|---|
| Buyer's browser | **Nothing.** No keys, PRF outputs or credential id in localStorage, sessionStorage, IndexedDB or cookies. Keys live in a React context: the PRF output is zeroed as soon as its key is derived, `lock()` zeroes every key and ends the Mera signing session, and a reload or a 30-minute timer locks. `apps/app/test/private-keyring.test.ts` scans the private-job code to keep this true. | — |
| Passkey manager | The passkey itself, synced across the buyer's devices by the OS or password manager. | Yes, but it never leaves the authenticator. |
| Broker (SQLite / Mongo) | The job, with its prompt (screening, routing and reassignment need it), `encryptTo`, the **sealed envelope** as `result`, and coarse status events. Vaults: ciphertext, nonce, version and the vault's public key. | The prompt, yes: see §5. The result and history, no: ciphertext. |
| Public API (`/api/jobs`, SSE stream) | `private: true`, price, provider, payment and status. `prompt: ""`, `title: null`, `result` is the envelope, events are status lines only, and `encryptTo` is never served. | No. |
| Monad (XorvLedger receipt) | `resultHash = keccak256(envelope)`, `requestHash = keccak256(prompt)`, payment and provider. | No for the result, which is ciphertext. For `requestHash`, see §5. |
| Provider machine | The prompt and the answer in the operator's own live view, since they ran the job. Only the envelope is reported. | By necessity. |

## 5. Threat model

| Party | Can see | Cannot see |
|---|---|---|
| **The provider** who runs the job | The prompt and the answer. A job cannot run otherwise. | Other jobs' answers and the buyer's history. |
| **The broker** operator or a DB leak | The prompt, the buyer's payer address and inbox public key, timing, price and result *length* (AES-GCM does not hide length). | The answer, the history and any key. |
| **AI roles** (Hunyuan screen, Qwen router) | The prompt, which they need before a provider is chosen. | The answer. The Kimi **verifier is skipped** for private jobs because it would need the plaintext. |
| **The public** (job list, API, SSE) | That a private job ran, with its price, provider, status and the envelope. | The prompt, title, answer and the buyer's inbox key. Each envelope's ephemeral key is fresh, so envelopes aren't linkable by recipient. |
| **Chain observers** | The receipt: `keccak256(envelope)` and `keccak256(prompt)`. | The answer. |
| **Someone with a share link** | That one result. | Anything else. |
| **Another passkey or site** | Unrelated keys. Passkeys are bound to their relying-party id, and a different credential gives a different PRF. | This buyer's keys. |

Enforced in code (each is a test):

- A private job's result must arrive sealed. The broker **discards a plaintext result
  unstored** and fails the job over to another provider, as it would any provider failure.
  It re-serializes a sealed result from its allowlisted fields, so nothing a provider tacks
  on is stored, served or hashed (`services/broker/test/private-jobs.test.ts`).
- The node sends only a throttled step counter while a private job runs. It sends no
  reasoning, text or tool calls. The broker also drops non-status events for private jobs,
  in case an older node sends them. Provider error text is reduced to the node's coarse
  vocabulary, because adapter errors can quote the prompt (`packages/cli/test/private-jobs.test.ts`).
- The node refuses to run a private job whose `encryptTo` it cannot seal to. The broker
  refuses such a key at quote time, before anyone is reserved or paid. Low-order X25519
  points, which would seal to everyone, are rejected too.

Stated limits:

- **The prompt is not private from the network.** It is readable by the broker, the AI
  screen and router, and the provider. Only the public views hide it. `requestHash` on-chain
  is an unsalted hash, so a short, guessable prompt can be confirmed by guessing.
- **Script on the app's origin** can read PRF outputs and keys while they are unlocked. This
  is the same trust boundary as any web crypto, and Mera's
  [security model](https://mera.category.xyz/concepts/security-model/) says so. Zeroing is
  defense in depth, not a guarantee.
- **Rollback of the vault.** A broker cannot forge or relabel a vault, but it could serve an
  *older genuine* version. A device notices only if it has seen a newer one in the same
  session, because nothing is remembered across sessions by design. The broker could also
  delete a vault. The results themselves stay on each job, and the vault is an index of them.
- **PRF support** is needed. Chrome, Edge and Safari 18+ support it with platform or synced
  passkeys (Google Password Manager, iCloud Keychain, 1Password). The app detects this where
  the browser reports it, and otherwise explains a `PRF_UNAVAILABLE` from Mera.
- **Domain-bound.** Passkeys belong to the site's host (the rpId). The same deployment domain
  must be used on every device, and a domain move needs a migration path that we have not
  built.
- Only browser buyers can post private jobs today, because they hold the passkey. CLI, MCP
  and MetaMask-plugin buyers post public jobs.

## 6. Cross-device demo script (for the video, about 75 s)

**Setup.** The app is deployed on an https domain: passkeys scope to it, and `localhost` works
on one machine only. A broker is running with `NEXT_PUBLIC_XORV_BROKER_URL` pointing at it,
and at least one provider node is online (`xorv start`; the `echo` adapter is fine). Device A
is a laptop with Chrome and Google Password Manager, or Safari with iCloud Keychain. Device B
is a phone or a **fresh browser profile** signed in to the same passkey manager.

1. **Device A, the composer.** Switch on **Private job**. Read the panel aloud: *the answer is
   sealed, the prompt is not*. Click **Create an encryption passkey** and confirm. The inbox
   fingerprint appears. Point out that the passkey's name says "not a wallet".
2. Type a prompt and press **↑**. Confirm twice more, for vault and vault-auth. The quote card
   says *Private — sealed to your inbox key `a1b2·…`*.
3. **Pay** with the Privy wallet. On the job page, the execution log shows only
   *working privately · N steps*. The result arrives as an envelope and **decrypts in the
   tab**. In the receipt panel, show *✓ the sealed envelope hashes to this value*, then open
   the XorvLedger receipt on MonadScan.
4. **Show the ciphertext.** Run `curl $BROKER/api/jobs/<id> | jq .job` and show
   `private: true`, `prompt: ""` and `result` as the envelope. On the public job list, the
   job reads *Private · sealed to the buyer's passkey*.
5. **Device B, the fresh profile.** Open `/private` and click **Unlock with my passkey**. The
   browser offers the synced passkey. Confirm twice. The **fingerprints match Device A's**
   (hold them side by side). The history lists the job with its prompt. Open it, click
   **Unlock with passkey to read** and confirm once. The same answer decrypts.
6. *(Optional)* On Device A, click **Copy a link that opens only this result** and open the
   link in a private window with no passkey. It opens that one result and nothing else.
7. Close by showing `curl $BROKER/api/vaults/<vaultId>`, which returns only ciphertext, a
   nonce and a version.

## 7. Where the code is

| Piece | Path |
|---|---|
| Namespaces, HKDF derivations, sealed-result envelope, share keys | `packages/protocol/src/sealed.ts` |
| Vault key and auth, vault ciphertext, signed writes, history merge | `packages/protocol/src/vault.ts` |
| `JobRequest.encryptTo`, `DispatchedJob.encryptTo`, `PublicJob.private` | `packages/protocol/src/types.ts` |
| Protocol tests (tamper, wrong key, wrong job, determinism, namespace separation, KATs, node:crypto cross-checks) | `packages/protocol/test/sealed.test.ts`, `packages/protocol/test/vault.test.ts` |
| Provider seals before reporting, coarse events, sanitized errors | `packages/cli/src/node.ts`, `packages/cli/test/private-jobs.test.ts` |
| Broker: `encryptTo` validation, dispatch, sealed-only results, redacted public views, verifier skip | `services/broker/src/app.ts`, `services/broker/src/public.ts`, `services/broker/src/jobs.ts` |
| Broker: vault routes, storage, SQLite and Mongo persistence | `services/broker/src/app.ts` (`/api/vaults/:id`), `services/broker/src/vaults.ts`, `services/broker/src/store.ts`, `services/broker/src/store-mongo.ts` |
| Broker tests | `services/broker/test/private-jobs.test.ts` |
| Mera ceremonies (create, evaluate a namespace, PRF support, errors) | `apps/app/lib/private/passkey.ts` |
| In-memory keyring (Mera Ed25519 signing session, zeroing, pinning) | `apps/app/lib/private/keyring.ts` |
| Vault client (merge and retry on 409, rollback check) | `apps/app/lib/private/vault-client.ts` |
| Job-page decrypt decisions, share links, receipt check | `apps/app/lib/private/result.ts` |
| UI: keyring provider, passkey panel, composer switch, sealed result, history page | `apps/app/components/private-keys.tsx`, `apps/app/components/passkey-panel.tsx`, `apps/app/components/composer.tsx`, `apps/app/components/private-result.tsx`, `apps/app/components/private-history.tsx`, `apps/app/app/private/page.tsx` |
| App tests (real Mera plus a fake *synced* authenticator: the cross-device test, pinning, zeroing, 409 merge, rollback, share links, storage scan) | `apps/app/test/private-keyring.test.ts`, `apps/app/test/support/fake-authenticator.ts` |
