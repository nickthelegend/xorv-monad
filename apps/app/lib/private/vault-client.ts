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
 * Every write re-encrypts the whole history, and the broker keeps at most
 * `VAULT_MAX_CIPHERTEXT_BYTES` (176 KiB) per vault, answering 413 above it.
 * A history that simply grew would stop accepting writes for good, so
 * `fitVaultToBudget` trims before encrypting: oldest entries go first, the
 * entries this write adds are never the ones dropped, and only if those alone
 * are too big are their stored prompts shortened. A 413 anyway (a broker with
 * a smaller cap) trims harder and retries.
 *
 * The keys are behind the `VaultKeys` seam: the app hands in the keyring
 * (Mera signing session, keys in memory), the tests hand in the same keyring
 * driven by a fake authenticator.
 */

import {
  VAULT_MAX_CIPHERTEXT_BYTES,
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
  /** What this write gave up to fit the broker's cap, when it had to. */
  trimmed?: { dropped: number; truncated: number };
}

const MAX_ATTEMPTS = 4;

/** AES-GCM appends a 16-byte tag: ciphertext bytes = plaintext bytes + 16. */
const GCM_TAG_BYTES = 16;

/** Appended to a stored prompt that had to be shortened to fit the vault. */
export const TRUNCATION_MARK = "\n\n[… shortened to fit your history vault]";

const utf8 = new TextEncoder();
const byteLength = (text: string): number => utf8.encode(text).length;

export interface FittedVault {
  vault: PrivateVault;
  /** `JSON.stringify(vault)`: the plaintext to encrypt, already measured. */
  plaintext: string;
  /** Oldest entries dropped. */
  dropped: number;
  /** Entries whose stored prompt was shortened. */
  truncated: number;
}

/**
 * Trim a history until its ciphertext fits `maxCiphertextBytes`.
 *
 * Entries are newest first; the oldest ones not in `keep` are dropped first.
 * If what is left is still too big, the longest stored prompts are shortened
 * (and marked with {@link TRUNCATION_MARK}), so the job's id, title and
 * result link survive, which is what the history is for.
 */
export function fitVaultToBudget(
  vault: PrivateVault,
  opts: { keep?: ReadonlySet<string>; maxCiphertextBytes?: number } = {},
): FittedVault {
  const budget = (opts.maxCiphertextBytes ?? VAULT_MAX_CIPHERTEXT_BYTES) - GCM_TAG_BYTES;
  const keep = opts.keep ?? new Set<string>();
  const whole = JSON.stringify(vault);
  if (byteLength(whole) <= budget) return { vault, plaintext: whole, dropped: 0, truncated: 0 };

  // {"v":1,"entries":[e1,e2,…]}: measure each entry once, then drop by arithmetic.
  const frame = byteLength(JSON.stringify({ v: 1, entries: [] }));
  const entries = vault.entries.map((entry) => ({ entry, bytes: byteLength(JSON.stringify(entry)) }));
  const total = (): number => frame + entries.reduce((sum, e) => sum + e.bytes, 0) + Math.max(0, entries.length - 1);

  let dropped = 0;
  for (let i = entries.length - 1; i >= 0 && total() > budget; i -= 1) {
    if (keep.has(entries[i]!.entry.jobId)) continue;
    entries.splice(i, 1);
    dropped += 1;
  }

  let truncated = 0;
  while (total() > budget) {
    // The longest prompt left that hasn't already given something up.
    let longest = -1;
    for (let i = 0; i < entries.length; i += 1) {
      const prompt = entries[i]!.entry.prompt;
      if (!prompt || prompt.endsWith(TRUNCATION_MARK)) continue;
      if (longest < 0 || prompt.length > entries[longest]!.entry.prompt.length) longest = i;
    }
    if (longest < 0) break; // nothing left to shorten: the broker will refuse, and say why
    const target = entries[longest]!;
    target.entry = shortenPrompt(target.entry, Math.max(0, target.bytes - (total() - budget)));
    target.bytes = byteLength(JSON.stringify(target.entry));
    truncated += 1;
  }

  const fitted: PrivateVault = { v: 1, entries: entries.map((e) => e.entry) };
  return { vault: fitted, plaintext: JSON.stringify(fitted), dropped, truncated };
}

/** The entry with its prompt cut on a code-point boundary, so its JSON is at most `maxBytes`. */
function shortenPrompt(entry: PrivateJobEntry, maxBytes: number): PrivateJobEntry {
  const chars = Array.from(entry.prompt);
  const sized = (n: number): PrivateJobEntry => ({
    ...entry,
    prompt: n > 0 ? chars.slice(0, n).join("") + TRUNCATION_MARK : "",
  });
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(JSON.stringify(sized(mid))) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return sized(lo);
}

export class VaultClient {
  private readonly fetch: typeof fetch;
  /**
   * The newest version this client has seen, per vault id. A broker can't
   * forge a vault, but it could serve an older genuine one; within a session
   * that is caught here. (Across sessions nothing is remembered, by design —
   * see docs/PRIVATE_JOBS.md.) Keyed by id because one client outlives Lock:
   * a passkey unlocked later in the same tab is a different vault with its
   * own versions, and must not be judged against this one's.
   */
  private readonly highestSeen = new Map<string, number>();

  constructor(
    private readonly brokerUrl: string,
    private readonly keys: VaultKeys,
    fetchImpl?: typeof fetch,
  ) {
    this.fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  private url(id: string): string {
    return `${this.brokerUrl}/api/vaults/${id}`;
  }

  /** Fetch and decrypt the history. An empty history when the vault doesn't exist yet. */
  async load(): Promise<VaultState> {
    return this.loadVault(this.keys.vaultId());
  }

  private async loadVault(id: string): Promise<VaultState> {
    const seen = this.highestSeen.get(id) ?? 0;
    let res: Response;
    try {
      res = await this.fetch(this.url(id), { cache: "no-store" });
    } catch (err) {
      throw new VaultError(`couldn't reach the broker: ${err instanceof Error ? err.message : err}`, "network");
    }
    if (res.status === 404) {
      if (seen > 0) throw new VaultError("the broker no longer has this vault", "rollback");
      return { vault: emptyVault(), version: 0, updatedAt: null };
    }
    if (!res.ok) throw new VaultError(`the broker answered ${res.status}`, "network");
    const blob = (await res.json()) as VaultCiphertext & { updatedAt?: number };
    if (blob.version < seen) {
      throw new VaultError(`the broker served version ${blob.version} after this device saw ${seen}`, "rollback");
    }
    // Throws SealedError DECRYPT_FAILED for a vault this passkey didn't write.
    const vault = parseVaultContents(this.keys.decryptVault(blob));
    this.highestSeen.set(id, blob.version);
    return { vault, version: blob.version, updatedAt: blob.updatedAt ?? null };
  }

  /** Add one private job to the history, merging with whatever is already there. */
  async add(entry: PrivateJobEntry): Promise<VaultState> {
    return this.write((vault) => addVaultEntry(vault, entry));
  }

  /** Apply `change` to the latest history and store it as the next version, retrying on conflict. */
  async write(change: (vault: PrivateVault) => PrivateVault): Promise<VaultState> {
    let lastError: unknown = null;
    let budget = VAULT_MAX_CIPHERTEXT_BYTES;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const id = this.keys.vaultId();
      const current = await this.loadVault(id);
      const merged = mergeVaults(change(current.vault), current.vault);
      // What this write adds is what the buyer just did: never trim that away.
      const existing = new Set(current.vault.entries.map((e) => e.jobId));
      const keep = new Set(merged.entries.map((e) => e.jobId).filter((jobId) => !existing.has(jobId)));
      const fitted = fitVaultToBudget(merged, { keep, maxCiphertextBytes: budget });
      const version = current.version + 1;
      const write = await this.keys.signVaultWrite(this.keys.encryptVault(fitted.plaintext, version));

      let res: Response;
      try {
        res = await this.fetch(this.url(id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(write),
        });
      } catch (err) {
        throw new VaultError(`couldn't reach the broker: ${err instanceof Error ? err.message : err}`, "network");
      }
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { updatedAt?: number };
        this.highestSeen.set(id, version);
        const state: VaultState = { vault: fitted.vault, version, updatedAt: body.updatedAt ?? Date.now() };
        if (fitted.dropped || fitted.truncated) state.trimmed = { dropped: fitted.dropped, truncated: fitted.truncated };
        return state;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 409) {
        // Another device (or tab) wrote first. Re-read, merge, go again.
        lastError = new VaultError(body.error ?? "version conflict", "conflict");
        continue;
      }
      if (res.status === 413) {
        // A broker with a smaller cap than this client assumes: trim harder, go again.
        lastError = new VaultError(body.error ?? "the history is larger than the broker accepts", "rejected");
        budget = Math.floor(budget * 0.75);
        continue;
      }
      throw new VaultError(body.error ?? `the broker refused the write (${res.status})`, "rejected");
    }
    throw lastError instanceof Error ? lastError : new VaultError("too many conflicting writes", "conflict");
  }
}
