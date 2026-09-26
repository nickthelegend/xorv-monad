/**
 * The keyring: every key private jobs use, in memory only.
 *
 * Three namespaces, each unlocked by its own passkey ceremony (see
 * lib/private/passkey.ts) and derived by `@xorv/protocol`:
 *
 *   inbox      X25519 keypair   — `encryptTo` for new jobs; opens sealed results
 *   vault      AES-256-GCM key  — encrypts and decrypts the history vault
 *   vaultAuth  Ed25519 key      — its hash is the vault id; signs vault writes
 *                                 (held in a Mera signing session, which
 *                                 zeroes its copy of the key when it ends)
 *
 * Nothing here touches localStorage, sessionStorage, IndexedDB or cookies —
 * not the keys, not the PRF outputs, not even the credential id. The PRF
 * output is zeroed the moment its key is derived, and `lock()` zeroes the
 * keys. A reload is a lock. That is what makes the cross-device story honest:
 * the second device has nothing but the synced passkey, and needs nothing
 * else. (test/private-keyring.test.ts scans this directory to keep it so.)
 */

import { createEd25519SigningSession, type Ed25519SigningSession } from "@category-labs/mera";
import {
  PRF_NAMESPACE_ORDER,
  decryptVault,
  deriveInboxKeys,
  deriveVaultAuth,
  deriveVaultKey,
  encryptVault,
  keyFingerprint,
  openResult,
  openResultWithContentKey,
  resultContentKey,
  toBase64Url,
  vaultWriteMessage,
  type InboxKeys,
  type PrfNamespace,
  type VaultCiphertext,
  type VaultWrite,
} from "@xorv/protocol/web";
import {
  createKeyPasskey,
  evaluateNamespace,
  type PasskeyCredentialMetadata,
  type PasskeyEnv,
} from "@/lib/private/passkey";

/** What the UI may know: public keys, fingerprints and which namespaces are open. Never a secret. */
export interface KeyringSnapshot {
  /** The passkey the unlocked namespaces came from, once one answered. */
  credentialId: string | null;
  inbox: { encryptTo: string; fingerprint: string } | null;
  vault: { fingerprint: string } | null;
  vaultAuth: { vaultId: string; fingerprint: string } | null;
  /** The namespace whose ceremony is running right now. */
  pending: PrfNamespace | null;
}

export class KeyringLockedError extends Error {
  constructor(readonly namespace: PrfNamespace) {
    super(`unlock the ${namespace} key with your passkey first`);
    this.name = "KeyringLockedError";
  }
}

export class PrivateKeyring {
  private credential: PasskeyCredentialMetadata | null = null;
  private inbox: InboxKeys | null = null;
  private vaultKey: Uint8Array | null = null;
  private auth: { session: Ed25519SigningSession; vaultId: string; publicKey: Uint8Array } | null = null;
  private pending: PrfNamespace | null = null;
  private listeners = new Set<() => void>();
  private cached: KeyringSnapshot | null = null;
  /** Ceremonies run one at a time; a second click joins the first. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly env: PasskeyEnv) {}

  // -- observation (useSyncExternalStore-shaped) ------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): KeyringSnapshot => {
    this.cached ??= {
      credentialId: this.credential?.credentialId ?? null,
      inbox: this.inbox
        ? { encryptTo: this.inbox.encryptTo, fingerprint: keyFingerprint(this.inbox.publicKey) }
        : null,
      // The vault key is symmetric, so what's shown is a key check value: a
      // domain-separated one-way hash — enough to compare two devices, useless
      // to anyone else.
      vault: this.vaultKey ? { fingerprint: keyFingerprint(keyCheckInput(this.vaultKey)) } : null,
      vaultAuth: this.auth ? { vaultId: this.auth.vaultId, fingerprint: keyFingerprint(this.auth.publicKey) } : null,
      pending: this.pending,
    };
    return this.cached;
  };

  private changed(): void {
    this.cached = null;
    for (const listener of this.listeners) listener();
  }

  isUnlocked(namespace: PrfNamespace): boolean {
    return namespace === "inbox" ? this.inbox !== null : namespace === "vault" ? this.vaultKey !== null : this.auth !== null;
  }

  // -- unlocking ---------------------------------------------------------------

  /** Create a new encryption passkey; its creation ceremony also unlocks the inbox. */
  create(): Promise<void> {
    return this.serial(async () => {
      this.setPending("inbox");
      try {
        const { credential, prfOutput } = await createKeyPasskey(this.env);
        // A new passkey means a new identity: nothing from an old one may linger.
        this.lock();
        this.credential = credential;
        this.install("inbox", prfOutput);
      } finally {
        this.setPending(null);
      }
    });
  }

  /**
   * Unlock the given namespaces, one passkey ceremony each, skipping any that
   * are already open. The first ceremony may let the browser pick any passkey
   * for this site; every later one is pinned to that same credential, so the
   * namespaces can never come from two different passkeys.
   */
  unlock(namespaces: readonly PrfNamespace[] = PRF_NAMESPACE_ORDER): Promise<void> {
    return this.serial(async () => {
      for (const namespace of PRF_NAMESPACE_ORDER.filter((ns) => namespaces.includes(ns))) {
        if (this.isUnlocked(namespace)) continue;
        this.setPending(namespace);
        try {
          const { credential, prfOutput } = await evaluateNamespace(this.env, namespace, this.credential);
          this.credential = credential;
          this.install(namespace, prfOutput);
        } finally {
          this.setPending(null);
        }
      }
    });
  }

  /** Zero every key and end the signing session. Also what a reload does, by construction. */
  lock(): void {
    this.inbox?.secretKey.fill(0);
    this.vaultKey?.fill(0);
    this.auth?.session.end();
    this.inbox = null;
    this.vaultKey = null;
    this.auth = null;
    this.credential = null;
    this.changed();
  }

  private install(namespace: PrfNamespace, prfOutput: Uint8Array): void {
    try {
      if (namespace === "inbox") {
        this.inbox = deriveInboxKeys(prfOutput);
      } else if (namespace === "vault") {
        this.vaultKey = deriveVaultKey(prfOutput);
      } else {
        const derived = deriveVaultAuth(prfOutput);
        // Mera copies the seed into a session it can zero; ours is zeroed now.
        const session = createEd25519SigningSession({ privateKey: derived.seed });
        derived.seed.fill(0);
        this.auth = { session, vaultId: derived.vaultId, publicKey: derived.publicKey };
      }
    } finally {
      prfOutput.fill(0);
    }
    this.changed();
  }

  private setPending(namespace: PrfNamespace | null): void {
    this.pending = namespace;
    this.changed();
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  // -- using the keys ----------------------------------------------------------

  /** The `encryptTo` for a new private job. */
  encryptTo(): string {
    if (!this.inbox) throw new KeyringLockedError("inbox");
    return this.inbox.encryptTo;
  }

  /** Open a sealed result. Throws `SealedError` DECRYPT_FAILED if it was sealed to another passkey. */
  openResult(envelope: unknown, jobId: string): string {
    if (!this.inbox) throw new KeyringLockedError("inbox");
    return openResult(this.inbox.secretKey, envelope, jobId);
  }

  /** The disclosable key for one result (see `resultContentKey`), as base64url. */
  shareKey(envelope: unknown, jobId: string): string {
    if (!this.inbox) throw new KeyringLockedError("inbox");
    const key = resultContentKey(this.inbox.secretKey, envelope, jobId);
    try {
      return toBase64Url(key);
    } finally {
      key.fill(0);
    }
  }

  vaultId(): string {
    if (!this.auth) throw new KeyringLockedError("vaultAuth");
    return this.auth.vaultId;
  }

  encryptVault(plaintext: string, version: number): VaultCiphertext {
    if (!this.vaultKey) throw new KeyringLockedError("vault");
    return encryptVault(this.vaultKey, plaintext, this.vaultId(), version);
  }

  decryptVault(blob: VaultCiphertext): string {
    if (!this.vaultKey) throw new KeyringLockedError("vault");
    return decryptVault(this.vaultKey, blob, this.vaultId());
  }

  /** Sign a vault write with the Mera Ed25519 session. */
  async signVaultWrite(blob: VaultCiphertext): Promise<VaultWrite> {
    if (!this.auth) throw new KeyringLockedError("vaultAuth");
    const message = vaultWriteMessage({ vaultId: this.auth.vaultId, ...blob });
    const signature = await this.auth.session.signMessage(message);
    return { ...blob, signature: toBase64Url(signature), publicKey: toBase64Url(this.auth.publicKey) };
  }
}

function keyCheckInput(key: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode("xorv:vault-kcv:v1\u0000");
  const out = new Uint8Array(label.length + key.length);
  out.set(label);
  out.set(key, label.length);
  return out;
}

/** Open a result with a key someone shared in a link — no passkey involved. */
export function openSharedResult(contentKey: string, envelope: unknown, jobId: string): string {
  return openResultWithContentKey(contentKey, envelope, jobId);
}
