"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePrivateKeys } from "@/components/private-keys";
import { LockGlyph } from "@/components/passkey-panel";
import { Button, Panel } from "@/components/ui";
import { ResultMarkdown } from "@/components/result-markdown";
import type { Job } from "@/lib/api";
import { envelopeSummary, readSealedResult, shareLink, sharedKeyFromHash } from "@/lib/private/result";
import { cn } from "@/lib/utils";

/**
 * A private job's result on its page.
 *
 * The broker served an envelope; this decides what the viewer can do with it.
 * With the passkey it was sealed to, it opens in this tab (one confirmation,
 * for the inbox namespace only). With a share link, the fragment's content key
 * opens this one result and nothing else. With neither, the page says what the
 * envelope is and who can open it — and the receipt panel shows that its hash
 * is the one recorded on-chain.
 */
export function SealedResultSection({ job }: { job: Job }) {
  const keys = usePrivateKeys();
  const [sharedKey, setSharedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // The fragment is read on the client only; it never reaches a server.
  useEffect(() => {
    const read = (): void => setSharedKey(sharedKeyFromHash(window.location.hash));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const inboxOpen = Boolean(keys.snapshot.inbox);
  const state = useMemo(
    () =>
      readSealedResult({
        jobId: job.id,
        result: job.result,
        keyring: inboxOpen ? keys.keyring : null,
        sharedKey,
      }),
    [job.id, job.result, inboxOpen, keys.keyring, sharedKey],
  );

  if (!job.result) {
    if (job.status === "failed" || job.status === "expired") return null;
    return (
      <section>
        <h2 className="mb-2.5 text-[13px] font-medium text-fg">Result</h2>
        <Panel className="flex items-center gap-2.5 p-4 text-[12.5px] leading-relaxed text-fg-3">
          <LockGlyph className="h-3 w-3 shrink-0 text-fg-2" />
          The answer will arrive sealed to the buyer&rsquo;s passkey — encrypted on the provider&rsquo;s machine before it leaves.
        </Panel>
      </section>
    );
  }

  if (state.kind === "not-sealed") return null;

  if (state.kind === "opened") {
    const share = (): void => {
      try {
        const link = shareLink(window.location.origin, job.id, keys.keyring.shareKey(job.result, job.id));
        void navigator.clipboard?.writeText(link).then(
          () => setCopied("Copied. Anyone with this link can read this one result — nothing else."),
          () => setCopied(link),
        );
      } catch (err) {
        setCopied(err instanceof Error ? err.message : String(err));
      }
    };
    return (
      <section>
        <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[13px] font-medium text-fg">Result</h2>
          <span className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
            <LockGlyph className="text-fg-2" />
            {state.via === "passkey"
              ? `decrypted in this tab · inbox ${keys.snapshot.inbox?.fingerprint}`
              : "opened with a share link for this result only"}
          </span>
        </div>
        <Panel className="p-4">
          <ResultMarkdown>{state.text}</ResultMarkdown>
        </Panel>
        {state.via === "passkey" ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-fg-4">
            <button type="button" onClick={share} className="text-fg-3 underline-offset-4 hover:text-fg hover:underline">
              Copy a link that opens only this result
            </button>
            {copied ? <span className="break-all">{copied}</span> : null}
          </div>
        ) : null}
      </section>
    );
  }

  const summary = safeSummary(job.result);
  const busy = keys.snapshot.pending !== null;

  return (
    <section>
      <h2 className="mb-2.5 text-[13px] font-medium text-fg">Result</h2>
      <Panel className="p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--line-2)] text-fg-2">
            <LockGlyph className="h-3 w-3" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] text-fg">
              {state.kind === "invalid" ? "This sealed result is malformed" : "Sealed to the buyer’s passkey"}
            </p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-fg-3">
              {state.kind === "invalid"
                ? `The provider returned an envelope that can't be opened with any key (${state.reason}). Nothing is wrong with your passkey; the answer itself is unreadable. The receipt below still records what was delivered.`
                : state.kind === "foreign"
                ? `This answer was sealed to a different passkey than the one unlocked here (inbox ${keys.snapshot.inbox?.fingerprint}). Lock, then unlock with the passkey you bought it with.`
                : state.kind === "bad-link"
                  ? "This share link's key doesn't open this result. If it's yours, unlock with your passkey."
                  : "Only the passkey this job was bought with can open it — on this device or any other it syncs to. Nothing to install, nothing stored."}
            </p>
            {summary ? (
              <p className="mono mt-2 text-[11px] leading-relaxed text-fg-4">
                {summary.alg} · ephemeral key {summary.ephemeralFingerprint} · {summary.ciphertextBytes} bytes
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-3.5 flex flex-wrap gap-2">
          {state.kind === "invalid" ? null : state.kind === "foreign" ? (
            <Button variant="secondary" onClick={keys.lock}>
              Lock these keys
            </Button>
          ) : (
            <Button onClick={() => void keys.unlock(["inbox"])} disabled={busy}>
              {busy ? "Waiting for your passkey…" : "Unlock with passkey to read"}
            </Button>
          )}
          <Link
            href="/private"
            className="inline-flex items-center px-3 py-2 text-[12.5px] text-fg-3 transition-colors hover:text-fg"
          >
            How private jobs work
          </Link>
        </div>
        {keys.error ? (
          <p role="alert" className={cn("mt-3 text-[12px] leading-relaxed", keys.error.kind === "cancelled" ? "text-fg-3" : "text-fail")}>
            {keys.error.message}
          </p>
        ) : null}
      </Panel>
    </section>
  );
}

/**
 * The prompt of a private job, for its buyer: public views redact it, and the
 * buyer's own copy is in their encrypted history.
 */
export function PrivatePrompt({ jobId }: { jobId: string }) {
  const keys = usePrivateKeys();
  const vaultOpen = Boolean(keys.snapshot.vault && keys.snapshot.vaultAuth);
  const { history, loadHistory } = keys;

  useEffect(() => {
    if (vaultOpen && !history) void loadHistory();
  }, [vaultOpen, history, loadHistory]);

  const entry = history?.vault.entries.find((e) => e.jobId === jobId) ?? keys.pending.find((e) => e.jobId === jobId);
  if (entry) {
    return (
      <div className="mt-3">
        <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-fg">{entry.prompt}</p>
        <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-fg-4">
          <LockGlyph /> from your encrypted history — the public view of this job shows no prompt
        </p>
      </div>
    );
  }
  return (
    <div className="mt-3 text-[13px] leading-relaxed text-fg-3">
      <p>Private job — its prompt isn&rsquo;t shown publicly.</p>
      {!vaultOpen ? (
        <button
          type="button"
          onClick={() => void keys.unlock(["vault", "vaultAuth"])}
          disabled={keys.snapshot.pending !== null}
          className="mt-1 text-[12px] text-fg-3 underline underline-offset-4 hover:text-fg disabled:opacity-40"
        >
          Yours? Unlock your history to see it
        </button>
      ) : history ? (
        <p className="mt-1 text-[12px] text-fg-4">Not in the history this passkey opens.</p>
      ) : null}
    </div>
  );
}

function safeSummary(result: string) {
  try {
    return envelopeSummary(result);
  } catch {
    return null;
  }
}
