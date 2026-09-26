"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { formatAgo } from "@xorv/protocol/web";
import { PasskeyPanel, LockGlyph } from "@/components/passkey-panel";
import { usePrivateKeys } from "@/components/private-keys";
import { Button, Empty, Panel } from "@/components/ui";
import { BROKER_URL, formatUsd } from "@/lib/api";

/**
 * "My private jobs": the encrypted history vault, opened.
 *
 * The list is fetched from the broker as ciphertext and decrypted here with
 * the vault key; the vault id it is fetched by is the hash of the vault-auth
 * key. Both come from the passkey, so this page works the same on a device
 * that has never seen Xorv before — which is the point of the cross-device
 * panel beside it.
 */
export function PrivateHistory() {
  const keys = usePrivateKeys();
  const vaultOpen = Boolean(keys.snapshot.vault && keys.snapshot.vaultAuth);
  const { history, loadHistory, historyError } = keys;
  const [refreshing, setRefreshing] = useState(false);
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => "");

  // The first load happens as soon as the vault is open; `loading` is derived
  // from "open but nothing decrypted yet" rather than tracked separately.
  useEffect(() => {
    if (vaultOpen && !history) void loadHistory();
  }, [vaultOpen, history, loadHistory]);
  const loading = refreshing || (vaultOpen && !history && !historyError);

  const refresh = (): void => {
    setRefreshing(true);
    void loadHistory().finally(() => setRefreshing(false));
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="min-w-0 space-y-4">
        {!vaultOpen ? (
          <Panel className="p-6 text-center">
            <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-full border border-[var(--line-2)] text-fg-2">
              <LockGlyph className="h-3.5 w-3.5" />
            </span>
            <p className="mt-3 text-[14px] font-medium text-fg">Your private history is locked</p>
            <p className="measure mx-auto mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
              It is stored on the broker as ciphertext. Unlocking derives the vault key and the vault&rsquo;s id from your
              passkey — two confirmations — and decrypts it in this tab.
            </p>
            <Button
              onClick={() => void keys.unlock(["vault", "vaultAuth"])}
              disabled={keys.snapshot.pending !== null}
              className="mt-4"
            >
              {keys.snapshot.pending ? "Waiting for your passkey…" : "Unlock my history"}
            </Button>
            {keys.error ? (
              <p role="alert" className="mt-3 text-[12px] leading-relaxed text-fg-3">
                {keys.error.message}
              </p>
            ) : null}
          </Panel>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[13px] font-medium text-fg">
                History{history ? ` · ${history.vault.entries.length} job${history.vault.entries.length === 1 ? "" : "s"}` : ""}
              </h2>
              <span className="flex items-center gap-3 text-[11.5px] text-fg-4">
                {history ? (
                  <span className="mono">
                    vault v{history.version}
                    {history.updatedAt ? ` · updated ${formatAgo(history.updatedAt)}` : " · nothing saved yet"}
                  </span>
                ) : null}
                <button type="button" onClick={refresh} disabled={loading} className="text-fg-3 hover:text-fg disabled:opacity-40">
                  {loading ? "Decrypting…" : "Refresh"}
                </button>
              </span>
            </div>

            {keys.pending.length > 0 ? (
              <Panel className="flex flex-wrap items-center justify-between gap-3 border-warn/25 p-3.5">
                <p className="text-[12.5px] text-fg-2">
                  {keys.pending.length} private job{keys.pending.length === 1 ? "" : "s"} not yet saved to your vault (held in
                  this tab only).
                </p>
                <Button variant="secondary" onClick={() => void keys.retryPending()}>
                  Save now
                </Button>
              </Panel>
            ) : null}

            {historyError ? (
              <p role="alert" className="text-[12.5px] leading-relaxed text-fail">
                {historyError}
              </p>
            ) : null}

            {history && history.vault.entries.length === 0 ? (
              <Empty
                title="No private jobs yet"
                hint="Switch on “Private job” in the composer. Each one you buy is added here, encrypted before it leaves this tab."
              />
            ) : null}

            {history && history.vault.entries.length > 0 ? (
              <ul className="border-t border-[var(--line)]">
                {history.vault.entries.map((entry) => (
                  <li key={entry.jobId} className="border-b border-[var(--line)]">
                    <Link
                      href={`/jobs/${encodeURIComponent(entry.jobId)}`}
                      className="flex items-start justify-between gap-4 py-4 transition-opacity hover:opacity-70"
                    >
                      <div className="min-w-0">
                        <p className="mono truncate text-[11.5px] text-fg-4">{entry.jobId}</p>
                        <p className="mt-1.5 line-clamp-2 text-[13.5px] leading-relaxed text-fg-2">
                          {entry.title ?? entry.prompt}
                        </p>
                        <p className="mt-1 truncate text-[11.5px] text-fg-4">
                          {entry.providerLabel ?? "provider"} · {formatAgo(entry.createdAt)}
                        </p>
                      </div>
                      <span className="tnum shrink-0 text-[14px] font-medium text-fg">{formatUsd(entry.priceUsdMicros)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}

        <Panel className="p-4">
          <h2 className="text-[13px] font-medium text-fg">What each party can see</h2>
          <dl className="mt-2.5 space-y-2 text-[12.5px] leading-relaxed">
            <Seen who="The provider" what="Your prompt and the answer — they ran the job. The answer is encrypted on their machine before it is reported." />
            <Seen who="The broker" what="Your prompt (screening and routing need it). The answer only as a sealed envelope; your history only as ciphertext." />
            <Seen who="The public" what="That a private job happened, its price and provider. No prompt, no answer." />
            <Seen who="Monad" what="The receipt: keccak256 of the sealed envelope, never the answer." />
          </dl>
        </Panel>
      </div>

      <div className="space-y-6">
        <PasskeyPanel />

        <Panel className="p-4">
          <h2 className="text-[13px] font-medium text-fg">Check it on a second device</h2>
          <ol className="mt-2.5 list-decimal space-y-1.5 pl-4 text-[12.5px] leading-relaxed text-fg-3">
            <li>Unlock here and note the three fingerprints.</li>
            <li>
              On another device, or a fresh browser profile signed in to the same passkey manager, open{" "}
              <span className="mono break-all text-fg-2">{origin ? `${origin}/private` : "/private"}</span>.
            </li>
            <li>
              Choose <span className="text-fg-2">Unlock with my passkey</span> and pick the same passkey. The fingerprints match,
              this history decrypts, and every private result opens.
            </li>
          </ol>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-fg-4">
            Nothing crosses between the devices but the passkey (synced by your passkey manager) and ciphertext from{" "}
            <span className="mono">{BROKER_URL.replace(/^https?:\/\//, "")}</span>.
          </p>
        </Panel>
      </div>
    </div>
  );
}

function noSubscribe(): () => void {
  return () => {};
}

function Seen({ who, what }: { who: string; what: string }) {
  return (
    <div className="grid grid-cols-[92px_1fr] gap-3">
      <dt className="text-fg-2">{who}</dt>
      <dd className="text-fg-3">{what}</dd>
    </div>
  );
}
