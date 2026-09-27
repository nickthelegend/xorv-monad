/**
 * Encrypted history vaults for private jobs.
 *
 * The broker keeps each buyer's private-job history as an opaque blob it
 * cannot read: AES-256-GCM ciphertext under a key derived from the buyer's
 * passkey (see `@xorv/protocol` vault.ts). What it *can* check is who is
 * allowed to replace a blob — the Ed25519 key whose hash is the vault id — and
 * that writes arrive in order. That is the whole job of this store:
 *
 *  - a write must be signed by the vault's own key (checked in app.ts with
 *    `verifyVaultWrite`, before it gets here);
 *  - its version must be exactly the stored version plus one, so a replayed
 *    or stale write is refused and two devices racing get a clean conflict;
 *  - only ciphertext, nonce, version and the (public) key are kept. There is
 *    no plaintext to keep: the broker never had it.
 *
 * Only each vault's metadata (id, version, key, size) lives in memory. The
 * ciphertext is read from the durable store when a vault is fetched, so the
 * worst case, MAX_VAULTS vaults at the full ciphertext cap (gigabytes), sits
 * on disk rather than in the heap, and a boot doesn't parse every blob. A
 * store that can't serve a vault back (the memory store) keeps the bodies in
 * memory instead, under a much smaller byte cap.
 */

import { MemoryPersistence, type Persistence } from "./store.js";

/** One vault as stored and served. */
export interface VaultRecord {
  /** sha-256 of the vault-auth public key (64 lowercase hex). */
  id: string;
  /** AES-256-GCM ciphertext, base64url. */
  ciphertext: string;
  /** 12-byte nonce, base64url. */
  iv: string;
  version: number;
  /** The vault-auth Ed25519 public key, base64url. Public by construction. */
  publicKey: string;
  createdAt: number;
  updatedAt: number;
}

/** What the store keeps in memory for each vault. */
export interface VaultMeta {
  id: string;
  version: number;
  publicKey: string;
  createdAt: number;
  updatedAt: number;
  /** Length of the base64url ciphertext, in characters (what counts toward the byte caps). */
  bytes: number;
}

export type VaultPutResult =
  | { ok: true; record: VaultRecord }
  | { ok: false; reason: "conflict"; current: number }
  | { ok: false; reason: "full" };

/**
 * How many vaults one broker will hold. Anyone can mint a vault key, so the
 * count is bounded as well as each vault's size; a full broker still accepts
 * writes to vaults it already has.
 */
export const MAX_VAULTS = 10_000;

/**
 * How many ciphertext characters, across all vaults, a broker takes before it
 * refuses *new* vaults (existing ones can always be rewritten). On disk when
 * the store can serve vaults back; a store that can't keeps them in memory,
 * so its cap is far lower.
 */
export const MAX_VAULT_BYTES_ON_DISK = 1024 * 1024 * 1024;
export const MAX_VAULT_BYTES_IN_MEMORY = 128 * 1024 * 1024;

export class VaultStore {
  private readonly meta = new Map<string, VaultMeta>();
  /** Bodies held in memory: all of them when the store can't serve them, else only writes it failed to take. */
  private readonly bodies = new Map<string, VaultRecord>();
  /** The durable store serves ciphertext on demand (`loadVault`). */
  private readonly lazy: boolean;
  private readonly maxBytes: number;
  private totalBytes = 0;

  constructor(
    private readonly persistence: Persistence = new MemoryPersistence(),
    private readonly maxVaults = MAX_VAULTS,
    maxBytes?: number,
  ) {
    const index = persistence.loadVaultIndex?.() ?? null;
    this.lazy = index !== null && typeof persistence.loadVault === "function";
    if (this.lazy && index) {
      for (const meta of index) this.remember(meta);
    } else {
      for (const record of persistence.loadVaults?.() ?? []) {
        this.remember(metaOf(record));
        this.bodies.set(record.id, record);
      }
    }
    this.maxBytes = maxBytes ?? (this.lazy ? MAX_VAULT_BYTES_ON_DISK : MAX_VAULT_BYTES_IN_MEMORY);
  }

  private remember(meta: VaultMeta): void {
    this.totalBytes += meta.bytes - (this.meta.get(meta.id)?.bytes ?? 0);
    this.meta.set(meta.id, meta);
  }

  get size(): number {
    return this.meta.size;
  }

  /** Ciphertext characters held across all vaults. */
  get bytes(): number {
    return this.totalBytes;
  }

  has(id: string): boolean {
    return this.meta.has(id);
  }

  get(id: string): VaultRecord | undefined {
    if (!this.meta.has(id)) return undefined;
    const held = this.bodies.get(id);
    if (held) return held;
    if (!this.lazy) return undefined;
    try {
      return this.persistence.loadVault?.(id) ?? undefined;
    } catch (err) {
      console.error("[broker] failed to read vault:", err instanceof Error ? err.message : err);
      return undefined;
    }
  }

  /** The version a write must carry next: 1 for a vault that doesn't exist yet. */
  nextVersion(id: string): number {
    return (this.meta.get(id)?.version ?? 0) + 1;
  }

  /**
   * Store a verified write if it is the next version.
   *
   * Exactly `current + 1`, not merely "greater": a gap would let a signed
   * write for version 9 skip past versions nobody has seen, and "greater"
   * alone would still let two devices both write version 2 and silently drop
   * one history. With `+1` the second writer is told the current version,
   * re-reads, merges and tries again.
   */
  put(id: string, write: { ciphertext: string; iv: string; version: number; publicKey: string }): VaultPutResult {
    const existing = this.meta.get(id);
    const current = existing?.version ?? 0;
    if (write.version !== current + 1) return { ok: false, reason: "conflict", current };
    if (!existing && this.meta.size >= this.maxVaults) return { ok: false, reason: "full" };
    if (!existing && this.totalBytes + write.ciphertext.length > this.maxBytes) return { ok: false, reason: "full" };

    const now = Date.now();
    const record: VaultRecord = {
      id,
      ciphertext: write.ciphertext,
      iv: write.iv,
      version: write.version,
      publicKey: write.publicKey,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.remember(metaOf(record));
    let saved = false;
    try {
      this.persistence.saveVault?.(record);
      saved = true;
    } catch (err) {
      // Held in memory then; a disk problem must not turn an accepted,
      // signed write into an error the client would retry against itself.
      console.error("[broker] failed to persist vault:", err instanceof Error ? err.message : err);
    }
    if (this.lazy && saved) this.bodies.delete(id);
    else this.bodies.set(id, record);
    return { ok: true, record };
  }
}

function metaOf(record: VaultRecord): VaultMeta {
  return {
    id: record.id,
    version: record.version,
    publicKey: record.publicKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    bytes: record.ciphertext.length,
  };
}
