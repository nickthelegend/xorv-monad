/**
 * History entries that couldn't be saved yet — held in memory, per vault.
 *
 * When a private job's history write fails (broker unreachable right after
 * the payment), the entry, plaintext prompt included, waits in memory so a
 * retry doesn't depend on the buyer remembering their own prompt. That makes
 * it as sensitive as the decrypted history, so it follows the same rules:
 *
 *  - each entry belongs to the vault it was being saved to, and is only ever
 *    shown or retried while that same vault is unlocked — never into another
 *    passkey's vault, never on a locked page;
 *  - Lock, the auto-lock and creating a new passkey drop all of it, the same
 *    way they drop the decrypted history (components/private-keys.tsx).
 *
 * Pure functions over an immutable list, so the rules are testable without
 * rendering anything.
 */

import type { PrivateJobEntry } from "@xorv/protocol/web";

export interface PendingEntry {
  /** The vault the entry was being written to. */
  vaultId: string;
  entry: PrivateJobEntry;
}

/** Hold `entry` for `vaultId`, replacing an earlier copy of the same job. */
export function holdPending(list: readonly PendingEntry[], vaultId: string, entry: PrivateJobEntry): PendingEntry[] {
  return [...list.filter((p) => !(p.vaultId === vaultId && p.entry.jobId === entry.jobId)), { vaultId, entry }];
}

/** Forget `jobIds` for `vaultId` (they were saved). */
export function releasePending(list: readonly PendingEntry[], vaultId: string, jobIds: Iterable<string>): PendingEntry[] {
  const saved = new Set(jobIds);
  return list.filter((p) => !(p.vaultId === vaultId && saved.has(p.entry.jobId)));
}

/** The entries the unlocked vault may see: none when no vault is open. */
export function pendingFor(list: readonly PendingEntry[], openVaultId: string | null): PrivateJobEntry[] {
  if (!openVaultId) return [];
  return list.filter((p) => p.vaultId === openVaultId).map((p) => p.entry);
}
