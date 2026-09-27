"use client";

/**
 * Private-job keys for the whole app, in memory.
 *
 * One keyring (lib/private/keyring.ts) per tab, held at the root so it
 * survives client-side navigation — unlock on the composer, read the result
 * on the job page, browse the history — and dies with the tab. Nothing is
 * written anywhere: a reload is a lock, and a second device needs nothing but
 * the synced passkey.
 *
 * It also keeps the decrypted history once loaded, and any history entry that
 * couldn't be saved yet (the broker was unreachable right after a payment), so
 * a retry doesn't depend on the buyer remembering their own prompt. Those
 * unsaved entries carry plaintext prompts, so they are as private as the
 * history: tied to the vault they were meant for (lib/private/pending.ts),
 * visible only while it is unlocked, and dropped on Lock, auto-lock and a new
 * passkey, exactly like the history.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { addVaultEntry, type PrfNamespace, type PrivateJobEntry } from "@xorv/protocol/web";
import { BROKER_URL } from "@/lib/api";
import { PrivateKeyring, type KeyringSnapshot } from "@/lib/private/keyring";
import { browserPasskeyEnv, describePasskeyError, detectPrfSupport, type PasskeyFailure } from "@/lib/private/passkey";
import { VaultClient, type VaultState } from "@/lib/private/vault-client";
import { holdPending, pendingFor, releasePending, type PendingEntry } from "@/lib/private/pending";

/** Keys are dropped this long after the last unlock, like a password manager's timeout. */
const AUTO_LOCK_MS = 30 * 60_000;

const LOCKED: KeyringSnapshot = { credentialId: null, inbox: null, vault: null, vaultAuth: null, pending: null };

export interface PrivateKeysValue {
  keyring: PrivateKeyring;
  snapshot: KeyringSnapshot;
  support: "checking" | "supported" | "unsupported" | "unknown";
  error: { kind: PasskeyFailure; message: string } | null;
  clearError: () => void;
  /** Create a new encryption passkey (unlocks the inbox). Resolves false on failure, with `error` set. */
  create: () => Promise<boolean>;
  /** Unlock namespaces (default: all three), one passkey confirmation each. */
  unlock: (namespaces?: readonly PrfNamespace[]) => Promise<boolean>;
  lock: () => void;
  /** All three namespaces are open. */
  ready: boolean;
  history: VaultState | null;
  historyError: string | null;
  loadHistory: () => Promise<VaultState | null>;
  /** Save a private job to the vault; on failure it is kept (in memory) for `retryPending`. */
  saveToHistory: (entry: PrivateJobEntry) => Promise<boolean>;
  /** Unsaved entries for the vault that is unlocked right now — none while locked. */
  pending: PrivateJobEntry[];
  retryPending: () => Promise<boolean>;
}

const Ctx = createContext<PrivateKeysValue | null>(null);

export function PrivateKeysProvider({ children }: { children: ReactNode }) {
  const [keyring] = useState(() => new PrivateKeyring(browserPasskeyEnv));
  const snapshot = useSyncExternalStore(keyring.subscribe, keyring.getSnapshot, () => LOCKED);
  const [support, setSupport] = useState<PrivateKeysValue["support"]>("checking");
  const [error, setError] = useState<PrivateKeysValue["error"]>(null);
  const [history, setHistory] = useState<VaultState | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [held, setHeld] = useState<PendingEntry[]>([]);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const vault = useMemo(() => new VaultClient(BROKER_URL, keyring), [keyring]);

  useEffect(() => {
    let alive = true;
    void detectPrfSupport().then((result) => {
      if (alive) setSupport(result);
    });
    return () => {
      alive = false;
      keyring.lock();
    };
  }, [keyring]);

  const armAutoLock = useCallback(() => {
    if (lockTimer.current) clearTimeout(lockTimer.current);
    lockTimer.current = setTimeout(() => {
      keyring.lock();
      setHistory(null);
      setHeld([]);
    }, AUTO_LOCK_MS);
  }, [keyring]);

  const create = useCallback(async () => {
    setError(null);
    try {
      await keyring.create();
      setHistory(null);
      setHeld([]);
      armAutoLock();
      return true;
    } catch (err) {
      setError(describePasskeyError(err));
      return false;
    }
  }, [keyring, armAutoLock]);

  const unlock = useCallback(
    async (namespaces?: readonly PrfNamespace[]) => {
      setError(null);
      try {
        await keyring.unlock(namespaces);
        armAutoLock();
        return true;
      } catch (err) {
        setError(describePasskeyError(err));
        return false;
      }
    },
    [keyring, armAutoLock],
  );

  const lock = useCallback(() => {
    keyring.lock();
    setHistory(null);
    setHistoryError(null);
    setHeld([]);
    if (lockTimer.current) clearTimeout(lockTimer.current);
  }, [keyring]);

  const loadHistory = useCallback(async () => {
    if (!keyring.isUnlocked("vault") || !keyring.isUnlocked("vaultAuth")) return null;
    try {
      const state = await vault.load();
      setHistory(state);
      setHistoryError(null);
      return state;
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [keyring, vault]);

  const saveToHistory = useCallback(
    async (entry: PrivateJobEntry) => {
      // The vault this entry is for: a later retry may only ever write it there.
      const vaultId = keyring.isUnlocked("vaultAuth") ? keyring.vaultId() : null;
      try {
        const state = await vault.add(entry);
        setHistory(state);
        if (vaultId) setHeld((prev) => releasePending(prev, vaultId, [entry.jobId]));
        return true;
      } catch (err) {
        // Locked mid-save: there is no vault it could safely wait for.
        if (vaultId) setHeld((prev) => holdPending(prev, vaultId, entry));
        setHistoryError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [keyring, vault],
  );

  const openVaultId = snapshot.vault && snapshot.vaultAuth ? snapshot.vaultAuth.vaultId : null;
  const pending = useMemo(() => pendingFor(held, openVaultId), [held, openVaultId]);

  const retryPending = useCallback(async () => {
    if (!openVaultId || pending.length === 0) return true;
    const entries = pending;
    try {
      const state = await vault.write((current) => entries.reduce(addVaultEntry, current));
      setHistory(state);
      setHeld((prev) => releasePending(prev, openVaultId, entries.map((e) => e.jobId)));
      setHistoryError(null);
      return true;
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [openVaultId, pending, vault]);

  const value: PrivateKeysValue = {
    keyring,
    snapshot,
    support,
    error,
    clearError: () => setError(null),
    create,
    unlock,
    lock,
    ready: Boolean(snapshot.inbox && snapshot.vault && snapshot.vaultAuth),
    history,
    historyError,
    loadHistory,
    saveToHistory,
    pending,
    retryPending,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrivateKeys(): PrivateKeysValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("usePrivateKeys must be used inside <PrivateKeysProvider>");
  return value;
}
