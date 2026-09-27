import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PrivateJobEntry } from "@xorv/protocol/web";
import { holdPending, pendingFor, releasePending } from "@/lib/private/pending";

/*
 * An unsaved history entry carries the buyer's plaintext prompt. Before this,
 * `pending` was one flat list: it survived Lock and the auto-lock, the job
 * page showed it on a locked tab ("from your encrypted history"), and
 * "Save now" wrote it into whichever passkey's vault was unlocked next.
 */

const VAULT_A = "a".repeat(64);
const VAULT_B = "b".repeat(64);
const entry = (jobId: string, prompt = `secret prompt for ${jobId}`): PrivateJobEntry => ({
  jobId,
  title: null,
  prompt,
  createdAt: 1,
});

describe("unsaved history entries", () => {
  it("are visible only while the vault they belong to is unlocked", () => {
    const held = holdPending([], VAULT_A, entry("job_1"));
    expect(pendingFor(held, VAULT_A).map((e) => e.jobId)).toEqual(["job_1"]);
    // Locked: nothing, so a locked job page can't show the prompt.
    expect(pendingFor(held, null)).toEqual([]);
    // Another passkey's vault: nothing, so "Save now" can't write it there.
    expect(pendingFor(held, VAULT_B)).toEqual([]);
  });

  it("replace an earlier copy of the same job, and are released per vault once saved", () => {
    let held = holdPending([], VAULT_A, entry("job_1", "first"));
    held = holdPending(held, VAULT_A, entry("job_1", "second"));
    held = holdPending(held, VAULT_B, entry("job_1", "b's own"));
    expect(pendingFor(held, VAULT_A).map((e) => e.prompt)).toEqual(["second"]);
    held = releasePending(held, VAULT_A, ["job_1"]);
    expect(pendingFor(held, VAULT_A)).toEqual([]);
    expect(pendingFor(held, VAULT_B).map((e) => e.prompt)).toEqual(["b's own"]);
  });

  it("are dropped by Lock, the auto-lock and a new passkey, like the decrypted history", () => {
    // The provider's three ways out of a session must each clear what it holds.
    const source = fs.readFileSync(path.resolve(__dirname, "../components/private-keys.tsx"), "utf8");
    const lockBody = /const lock = useCallback\(\(\) => \{([\s\S]*?)\}, \[/.exec(source)?.[1] ?? "";
    const autoLockBody = /lockTimer\.current = setTimeout\(\(\) => \{([\s\S]*?)\}, AUTO_LOCK_MS\)/.exec(source)?.[1] ?? "";
    const createBody = /await keyring\.create\(\);([\s\S]*?)return true;/.exec(source)?.[1] ?? "";
    for (const body of [lockBody, autoLockBody, createBody]) {
      expect(body).toContain("setHistory(null)");
      expect(body).toContain("setHeld([])");
    }
  });
});
