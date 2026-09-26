/**
 * The history vault, as the browser talks to it.
 *
 * Read: `GET /api/vaults/:id` → ciphertext → decrypt with the vault key.
 * Write: merge the new entry into the latest history, encrypt it as the next
 * version, sign the write with the vault-auth key, `PUT` it. The broker
 * accepts exactly `version + 1`; a 409 means another device wrote in between,
 * so the client re-reads, merges (union by job id — nothing is lost) and tries
 * again.
 *
 * The keys are behind the `VaultKeys` seam: the app hands in the keyring
 * (Mera signing session, keys in memory), the tests hand in the same keyring
 * driven by a fake authenticator.
 */

import {
  addVaultEntry,
  emptyVault,
  mergeVaults,
  parseVaultContents,
  type PrivateJobEntry,
  type PrivateVault,
  type VaultCiphertext,
  type VaultWrite,
} from "@xorv/protocol/web";

export interface VaultKeys {
  vaultId(): string;
  encryptVault(plaintext: string, version: number): VaultCiphertext;
  decryptVault(blob: VaultCiphertext): string;
  signVaultWrite(blob: VaultCiphertext): Promise<VaultWrite>;
}

export class VaultError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "rollback" | "rejected" | "conflict",
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export interface VaultState {
  vault: PrivateVault;
  /** 0 when the broker has no vault for this id yet. */
  version: number;
  updatedAt: number | null;
}

const MAX_ATTEMPTS = 4;

export class VaultClient {
  private readonly fetch: typeof fetch;
  /**
   * The newest version this client has seen. A broker can't forge a vault,
   * but it could serve an older genuine one; within a session that is caught
   * here. (Across sessions nothing is remembered, by design — see
   * docs/PRIVATE_JOBS.md.)
   */
  private highestSeen = 0;

  constructor(
    private readonly brokerUrl: string,
    private readonly keys: VaultKeys,
    fetchImpl?: typeof fetch,
  ) {
    this.fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  private url(): string {
    return `${this.brokerUrl}/api/vaults/${this.keys.vaultId()}`;
  }

  /** Fetch and decrypt the history. An empty history when the vault doesn't exist yet. */
  async load(): Promise<VaultState> {
    let res: Response;
    try {
      res = await this.fetch(this.url(), { cache: "no-store" });
    } catch (err) {
      throw new VaultError(`couldn't reach the broker: ${err instanceof Error ? err.message : err}`, "network");
    }
    if (res.status === 404) {
      if (this.highestSeen > 0) throw new VaultError("the broker no longer has this vault", "rollback");
      return { vault: emptyVault(), version: 0, updatedAt: null };
    }
    if (!res.ok) throw new VaultError(`the broker answered ${res.status}`, "network");
    const blob = (await res.json()) as VaultCiphertext & { updatedAt?: number };
    if (blob.version < this.highestSeen) {
      throw new VaultError(
        `the broker served version ${blob.version} after this device saw ${this.highestSeen}`,
        "rollback",
      );
    }
    // Throws SealedError DECRYPT_FAILED for a vault this passkey didn't write.
    const vault = parseVaultContents(this.keys.decryptVault(blob));
    this.highestSeen = blob.version;
    return { vault, version: blob.version, updatedAt: blob.updatedAt ?? null };
  }

  /** Add one private job to the history, merging with whatever is already there. */
  async add(entry: PrivateJobEntry): Promise<VaultState> {
    return this.write((vault) => addVaultEntry(vault, entry));
  }

  /** Apply `change` to the latest history and store it as the next version, retrying on conflict. */
  async write(change: (vault: PrivateVault) => PrivateVault): Promise<VaultState> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = await this.load();
      const next = mergeVaults(change(current.vault), current.vault);
      const version = current.version + 1;
      const write = await this.keys.signVaultWrite(this.keys.encryptVault(JSON.stringify(next), version));

      let res: Response;
      try {
        res = await this.fetch(this.url(), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(write),
        });
      } catch (err) {
        throw new VaultError(`couldn't reach the broker: ${err instanceof Error ? err.message : err}`, "network");
      }
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { updatedAt?: number };
        this.highestSeen = version;
        return { vault: next, version, updatedAt: body.updatedAt ?? Date.now() };
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 409) {
        // Another device (or tab) wrote first. Re-read, merge, go again.
        lastError = new VaultError(body.error ?? "version conflict", "conflict");
        continue;
      }
      throw new VaultError(body.error ?? `the broker refused the write (${res.status})`, "rejected");
    }
    throw lastError instanceof Error ? lastError : new VaultError("too many conflicting writes", "conflict");
  }
}
