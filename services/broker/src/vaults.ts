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
 * Vaults are few and small, so they live in memory and write through to the
 * same durable store as jobs, like everything else the broker must not lose.
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

export class VaultStore {
  private readonly vaults = new Map<string, VaultRecord>();

  constructor(
    private readonly persistence: Persistence = new MemoryPersistence(),
    private readonly maxVaults = MAX_VAULTS,
  ) {
    for (const record of persistence.loadVaults?.() ?? []) this.vaults.set(record.id, record);
  }

  get size(): number {
    return this.vaults.size;
  }

  get(id: string): VaultRecord | undefined {
    return this.vaults.get(id);
  }

  /** The version a write must carry next: 1 for a vault that doesn't exist yet. */
  nextVersion(id: string): number {
    return (this.vaults.get(id)?.version ?? 0) + 1;
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
    const existing = this.vaults.get(id);
    const current = existing?.version ?? 0;
    if (write.version !== current + 1) return { ok: false, reason: "conflict", current };
    if (!existing && this.vaults.size >= this.maxVaults) return { ok: false, reason: "full" };

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
    this.vaults.set(id, record);
    try {
      this.persistence.saveVault?.(record);
    } catch (err) {
      // Held in memory either way; a disk problem must not turn an accepted,
      // signed write into an error the client would retry against itself.
      console.error("[broker] failed to persist vault:", err instanceof Error ? err.message : err);
    }
    return { ok: true, record };
  }
}
