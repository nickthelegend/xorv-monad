/**
 * Private jobs in the browser: the keyring, the vault client and the decrypt
 * path, driven through the real Mera library by a fake synced authenticator.
 *
 * The headline test is the bounty's live check, run offline: device A creates
 * the passkey, buys a private job and saves it to the vault; device B — a
 * fresh keyring with nothing but the synced passkey — reproduces the same
 * keys, loads the same history and opens the same sealed result.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MeraError } from "@category-labs/mera";
import {
  PRF_NAMESPACE_ORDER,
  SealedError,
  deriveInboxKeys,
  prfSaltFor,
  sealResult,
  verifyVaultWrite,
  type PrivateJobEntry,
  type VaultCiphertext,
} from "@xorv/protocol/web";
import { KeyringLockedError, PrivateKeyring } from "@/lib/private/keyring";
import { describePasskeyError, type PasskeyEnv } from "@/lib/private/passkey";
import { VaultClient, VaultError } from "@/lib/private/vault-client";
import {
  envelopeSummary,
  readSealedResult,
  receiptMatchesCiphertext,
  shareLink,
  sharedKeyFromHash,
} from "@/lib/private/result";
import { keccak256, stringToBytes } from "viem";
import { FakeAuthenticator } from "./support/fake-authenticator";

const BROKER = "http://broker.test";
const RP = "xorv.app";

function keyring(auth: FakeAuthenticator, rpId = RP): PrivateKeyring {
  const env: PasskeyEnv = { rpId, rpName: "Xorv", webAuthnClient: auth.client };
  return new PrivateKeyring(env);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** The broker's vault routes, in memory, with the same rules (verifyVaultWrite + next-version). */
function vaultBroker() {
  const vaults = new Map<string, VaultCiphertext & { updatedAt: number }>();
  let beforeNextPut: (() => Promise<void>) | null = null;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const id = new URL(String(input)).pathname.split("/").pop()!;
    if (!init?.method || init.method === "GET") {
      const v = vaults.get(id);
      return v ? json(200, { id, ...v }) : json(404, { error: "no vault", version: 0 });
    }
    if (beforeNextPut) {
      const hook = beforeNextPut;
      beforeNextPut = null;
      await hook();
    }
    const body = JSON.parse(String(init.body));
    const check = verifyVaultWrite(id, body);
    if (!check.ok) return json(check.forbidden ? 403 : 400, { error: check.reason });
    const current = vaults.get(id)?.version ?? 0;
    if (body.version !== current + 1) return json(409, { error: "stale", version: current });
    vaults.set(id, { ciphertext: body.ciphertext, iv: body.iv, version: body.version, updatedAt: Date.now() });
    return json(200, { ok: true, version: body.version, updatedAt: Date.now() });
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    vaults,
    onNextPut(hook: () => Promise<void>) {
      beforeNextPut = hook;
    },
  };
}

function entry(jobId: string, createdAt = Date.now()): PrivateJobEntry {
  return { jobId, title: null, prompt: `private prompt for ${jobId}`, createdAt };
}

// ---------------------------------------------------------------------------

describe("unlocking through Mera", () => {
  it("evaluates exactly one namespaced salt per ceremony, and creation unlocks the inbox", async () => {
    const auth = new FakeAuthenticator();
    const ring = keyring(auth);
    await ring.create();
    expect(ring.getSnapshot().inbox?.encryptTo).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ring.isUnlocked("vault")).toBe(false);

    await ring.unlock();
    expect(auth.ceremonies.map((c) => c.kind)).toEqual(["create", "get", "get"]);
    expect(auth.ceremonies.map((c) => c.salt)).toEqual(PRF_NAMESPACE_ORDER.map((ns) => hex(prfSaltFor(ns))));

    const snap = ring.getSnapshot();
    expect(snap.vaultAuth?.vaultId).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([snap.inbox?.fingerprint, snap.vault?.fingerprint, snap.vaultAuth?.fingerprint]).size).toBe(3);
  });

  it("asks only for what a flow needs, and never twice", async () => {
    const auth = new FakeAuthenticator();
    const ring = keyring(auth);
    await ring.create();
    await ring.unlock(["inbox"]); // already open from creation
    expect(auth.ceremonies).toHaveLength(1);
    await ring.unlock(["vault"]);
    await ring.unlock(["vault", "inbox"]);
    expect(auth.ceremonies).toHaveLength(2);
  });

  it("pins every later ceremony to the passkey that answered first", async () => {
    const auth = new FakeAuthenticator();
    await keyring(auth).create(); // passkey #1
    await keyring(auth).create(); // passkey #2 on the same authenticator
    const [, second] = auth.credentialIds;
    auth.choose = (candidates) => candidates[1];
    auth.ceremonies.length = 0;

    const ring = keyring(auth);
    await ring.unlock();
    expect(auth.ceremonies[0]?.allow).toBeNull(); // the browser's picker
    expect(auth.ceremonies.slice(1).every((c) => c.allow === second)).toBe(true);
  });

  it("zeroes the keys and ends the Mera signing session on lock", async () => {
    const ring = keyring(new FakeAuthenticator());
    await ring.create();
    await ring.unlock();
    const internals = ring as unknown as {
      inbox: { secretKey: Uint8Array };
      vaultKey: Uint8Array;
      auth: { session: { signMessage(m: Uint8Array): Promise<Uint8Array> } };
    };
    const secret = internals.inbox.secretKey;
    const vaultKey = internals.vaultKey;
    const session = internals.auth.session;

    ring.lock();
    expect(secret.every((b) => b === 0)).toBe(true);
    expect(vaultKey.every((b) => b === 0)).toBe(true);
    await expect(session.signMessage(new Uint8Array(32))).rejects.toThrow(/ended/i);
    expect(() => ring.encryptTo()).toThrow(KeyringLockedError);
    expect(ring.getSnapshot()).toMatchObject({ credentialId: null, inbox: null, vault: null, vaultAuth: null });
  });

  it("explains a browser or passkey without PRF instead of failing obscurely", async () => {
    const auth = new FakeAuthenticator();
    auth.prfSupported = false;
    const err = await keyring(auth).create().catch((e: unknown) => e);
    expect(describePasskeyError(err).kind).toBe("no-prf");
    const cancelled = new MeraError("PASSKEY_OPERATION_FAILED", "x", { cause: new DOMException("", "NotAllowedError") });
    expect(describePasskeyError(cancelled).kind).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------

describe("the cross-device test", () => {
  it("a fresh device with only the synced passkey reproduces the keys and decrypts the same history and result", async () => {
    const broker = vaultBroker();

    // Device A: create the passkey, buy a private job, save it to the vault.
    const phoneA = new FakeAuthenticator();
    const deviceA = keyring(phoneA);
    await deviceA.create();
    await deviceA.unlock();
    const jobId = "job_crossDevice1";
    // The provider seals to the encryptTo device A put in the quote.
    const envelope = sealResult(deviceA.encryptTo(), "the private answer", jobId);
    await new VaultClient(BROKER, deviceA, broker.fetch).add({ ...entry(jobId), title: "cross-device demo" });

    // Device B: a new keyring, no credential id, nothing stored — only the synced passkey.
    const deviceB = keyring(phoneA.syncedDevice());
    await deviceB.unlock();

    const a = deviceA.getSnapshot();
    const b = deviceB.getSnapshot();
    expect(b.inbox).toEqual(a.inbox);
    expect(b.vault).toEqual(a.vault);
    expect(b.vaultAuth).toEqual(a.vaultAuth);

    const history = await new VaultClient(BROKER, deviceB, broker.fetch).load();
    expect(history.version).toBe(1);
    expect(history.vault.entries.map((e) => e.jobId)).toEqual([jobId]);
    expect(history.vault.entries[0]?.title).toBe("cross-device demo");
    expect(deviceB.openResult(envelope, jobId)).toBe("the private answer");
  });

  it("a different passkey gets unrelated keys, an empty vault, and cannot open the result", async () => {
    const broker = vaultBroker();
    const owner = keyring(new FakeAuthenticator());
    await owner.create();
    await owner.unlock();
    await new VaultClient(BROKER, owner, broker.fetch).add(entry("job_owner"));
    const envelope = sealResult(owner.encryptTo(), "owner only", "job_owner");

    const stranger = keyring(new FakeAuthenticator());
    await stranger.create();
    await stranger.unlock();
    expect(stranger.vaultId()).not.toBe(owner.vaultId());
    expect((await new VaultClient(BROKER, stranger, broker.fetch).load()).vault.entries).toEqual([]);
    expect(() => stranger.openResult(envelope, "job_owner")).toThrow(SealedError);
  });

  it("the same passkey on another site (rpId) is a different key — passkeys are origin-bound", async () => {
    const auth = new FakeAuthenticator();
    const here = keyring(auth, RP);
    await here.create();
    const elsewhere = keyring(auth, "evil.example");
    await expect(elsewhere.unlock(["inbox"])).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("VaultClient", () => {
  async function unlocked(auth = new FakeAuthenticator()) {
    const ring = keyring(auth);
    await ring.create();
    await ring.unlock();
    return { ring, auth };
  }

  it("writes signed, versioned ciphertext the broker can verify but not read", async () => {
    const broker = vaultBroker();
    const { ring } = await unlocked();
    const client = new VaultClient(BROKER, ring, broker.fetch);
    await client.add(entry("job_1"));
    await client.add(entry("job_2"));
    const stored = broker.vaults.get(ring.vaultId())!;
    expect(stored.version).toBe(2);
    expect(stored.ciphertext).not.toContain("private prompt");
    expect((await client.load()).vault.entries.map((e) => e.jobId).sort()).toEqual(["job_1", "job_2"]);
  });

  it("merges when another device wrote in between (409 → re-read → retry)", async () => {
    const broker = vaultBroker();
    const { ring: a, auth } = await unlocked();
    const b = keyring(auth.syncedDevice());
    await b.unlock();
    const clientA = new VaultClient(BROKER, a, broker.fetch);
    const clientB = new VaultClient(BROKER, b, broker.fetch);
    await clientA.add(entry("job_first", 1));

    // B writes after A has read version 1 but before A's PUT lands.
    broker.onNextPut(async () => {
      await clientB.add(entry("job_from_b", 2));
    });
    const result = await clientA.add(entry("job_from_a", 3));
    expect(result.version).toBe(3);
    expect(result.vault.entries.map((e) => e.jobId)).toEqual(["job_from_a", "job_from_b", "job_first"]);
  });

  it("notices a broker serving an older version than this device already saw", async () => {
    const broker = vaultBroker();
    const { ring } = await unlocked();
    const client = new VaultClient(BROKER, ring, broker.fetch);
    await client.add(entry("job_1"));
    const v1 = { ...broker.vaults.get(ring.vaultId())! };
    await client.add(entry("job_2"));
    broker.vaults.set(ring.vaultId(), v1); // a genuine, stale copy
    await expect(client.load()).rejects.toMatchObject({ kind: "rollback" });
    expect(VaultError).toBeDefined();
  });

  it("refuses to decrypt a vault this passkey didn't write", async () => {
    const broker = vaultBroker();
    const { ring } = await unlocked();
    await new VaultClient(BROKER, ring, broker.fetch).add(entry("job_1"));
    const { ring: other } = await unlocked();
    // Serve the owner's ciphertext under the other device's id.
    broker.vaults.set(other.vaultId(), broker.vaults.get(ring.vaultId())!);
    await expect(new VaultClient(BROKER, other, broker.fetch).load()).rejects.toThrow(SealedError);
  });
});

// ---------------------------------------------------------------------------

describe("the job page's decrypt path", () => {
  it("opens with the passkey, says 'locked' before unlocking and 'foreign' for another passkey", async () => {
    const auth = new FakeAuthenticator();
    const owner = keyring(auth);
    await owner.create();
    const envelope = sealResult(owner.encryptTo(), "**markdown** answer", "job_p");

    const fresh = keyring(auth.syncedDevice());
    expect(readSealedResult({ jobId: "job_p", result: envelope, keyring: fresh })).toEqual({ kind: "locked" });
    await fresh.unlock(["inbox"]);
    expect(readSealedResult({ jobId: "job_p", result: envelope, keyring: fresh })).toEqual({
      kind: "opened",
      text: "**markdown** answer",
      via: "passkey",
    });

    const stranger = keyring(new FakeAuthenticator());
    await stranger.create();
    expect(readSealedResult({ jobId: "job_p", result: envelope, keyring: stranger })).toEqual({ kind: "foreign" });
    expect(readSealedResult({ jobId: "job_p", result: "plain text", keyring: owner })).toEqual({ kind: "not-sealed" });
  });

  it("a shared link opens exactly one result, with no passkey at all", async () => {
    const owner = keyring(new FakeAuthenticator());
    await owner.create();
    const first = sealResult(owner.encryptTo(), "shared answer", "job_a");
    const second = sealResult(owner.encryptTo(), "not shared", "job_b");
    const link = shareLink("https://xorv.app", "job_a", owner.shareKey(first, "job_a"));
    const key = sharedKeyFromHash(new URL(link).hash);
    expect(key).not.toBeNull();

    expect(readSealedResult({ jobId: "job_a", result: first, keyring: null, sharedKey: key })).toEqual({
      kind: "opened",
      text: "shared answer",
      via: "link",
    });
    expect(readSealedResult({ jobId: "job_b", result: second, keyring: null, sharedKey: key })).toEqual({ kind: "bad-link" });
    expect(sharedKeyFromHash("#k=too-short")).toBeNull();
  });

  it("summarises an envelope and checks it against the receipt hash", () => {
    const envelope = sealResult(deriveInboxKeys(new Uint8Array(32).fill(7)).encryptTo, "12345", "job_s");
    const summary = envelopeSummary(envelope);
    expect(summary.alg).toBe("x25519-hkdf-sha256-aes256gcm");
    expect(summary.ciphertextBytes).toBe(5);
    expect(summary.ephemeralFingerprint).toMatch(/·/);
    expect(receiptMatchesCiphertext(envelope, keccak256(stringToBytes(envelope)))).toBe(true);
    expect(receiptMatchesCiphertext(envelope, keccak256(stringToBytes("something else")))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("nothing sensitive is persisted", () => {
  it("no private-jobs module touches browser storage or cookies", () => {
    const root = path.resolve(__dirname, "..");
    const files = [
      ...fs.readdirSync(path.join(root, "lib/private")).map((f) => path.join(root, "lib/private", f)),
      ...fs
        .readdirSync(path.join(root, "components"))
        .filter((f) => /private|passkey/.test(f))
        .map((f) => path.join(root, "components", f)),
    ];
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      // Comments may say what is *not* used; only code counts.
      const source = fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|caches\.open/);
    }
  });
});
