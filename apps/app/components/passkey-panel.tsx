"use client";

import type { PrfNamespace } from "@xorv/protocol/web";
import { PRF_NAMESPACES } from "@xorv/protocol/web";
import { usePrivateKeys } from "@/components/private-keys";
import { Button, Panel } from "@/components/ui";
import { cn } from "@/lib/utils";
import { PasskeyOnChain } from "@/components/passkey-onchain";

/**
 * The passkey keyring, made visible.
 *
 * One passkey, three namespaces, three different kinds of key. Showing each
 * one — its salt label, what primitive it becomes, whether it is open, and its
 * fingerprint — is not decoration: the fingerprints are how a person checks,
 * on a second device, that the same passkey produced the same keys.
 *
 * The copy is careful about one thing above all: this passkey is not a
 * wallet. It cannot sign a transaction or move money; Privy does that.
 */

const NAMESPACES: Array<{ ns: PrfNamespace; name: string; primitive: string; role: string }> = [
  { ns: "inbox", name: "Inbox", primitive: "X25519", role: "Providers seal results to its public key" },
  { ns: "vault", name: "Vault", primitive: "AES-256-GCM", role: "Encrypts your private-job history" },
  { ns: "vaultAuth", name: "Vault auth", primitive: "Ed25519", role: "Names your vault and signs its updates" },
];

export function PasskeyPanel({ className }: { className?: string }) {
  const keys = usePrivateKeys();
  const { snapshot, support, error } = keys;
  const open = { inbox: snapshot.inbox, vault: snapshot.vault, vaultAuth: snapshot.vaultAuth };
  const anyOpen = Boolean(open.inbox || open.vault || open.vaultAuth);
  const busy = snapshot.pending !== null;

  return (
    <Panel className={cn("p-4", className)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-medium text-fg">Passkey keys</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-fg-3">
            One passkey, three keys. Derived in this tab, never stored — reload and they&rsquo;re gone.
          </p>
        </div>
        {anyOpen ? (
          <button
            type="button"
            onClick={keys.lock}
            className="shrink-0 rounded-md px-2 py-1 text-[12px] text-fg-3 transition-colors hover:bg-white/[0.05] hover:text-fg"
          >
            Lock
          </button>
        ) : null}
      </div>

      <ul className="mt-3 divide-y divide-[var(--line)] border-y border-[var(--line)]">
        {NAMESPACES.map(({ ns, name, primitive, role }) => {
          const state = open[ns];
          const pending = snapshot.pending === ns;
          return (
            <li key={ns} className="py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[12.5px] text-fg-2">
                  {name} <span className="mono text-[11px] text-fg-4">{primitive}</span>
                </p>
                <span
                  className={cn(
                    "mono shrink-0 text-[11.5px]",
                    state ? "text-fg" : pending ? "text-fg-2" : "text-fg-4",
                  )}
                >
                  {state ? state.fingerprint : pending ? "confirm with passkey…" : "locked"}
                </span>
              </div>
              <p className="mt-0.5 flex items-baseline justify-between gap-3 text-[11.5px] text-fg-4">
                <span>{role}</span>
                <span className="mono shrink-0">{PRF_NAMESPACES[ns]}</span>
              </p>
            </li>
          );
        })}
      </ul>

      {snapshot.vaultAuth ? (
        <p className="mono mt-2.5 break-all text-[10.5px] leading-relaxed text-fg-4">vault {snapshot.vaultAuth.vaultId}</p>
      ) : null}

      <div className="mt-3.5 space-y-2">
        {!keys.ready ? (
          <Button onClick={() => void keys.unlock()} disabled={busy} className="w-full">
            {busy ? "Waiting for your passkey…" : anyOpen ? "Unlock the rest" : "Unlock with my passkey"}
          </Button>
        ) : null}
        {!anyOpen ? (
          <Button
            variant="secondary"
            onClick={() => void keys.create().then((ok) => (ok ? keys.unlock() : false))}
            disabled={busy}
            className="w-full"
          >
            Create an encryption passkey
          </Button>
        ) : null}
      </div>

      <PasskeyOnChain credentialId={snapshot.credentialId} />

      {error ? (
        <p role="alert" className={cn("mt-3 text-[12px] leading-relaxed", error.kind === "cancelled" ? "text-fg-3" : "text-fail")}>
          {error.message}
        </p>
      ) : null}
      {support === "unsupported" ? (
        <p className="mt-3 text-[12px] leading-relaxed text-warn">
          This browser reports no passkey PRF support, which private jobs need. Chrome, Edge or Safari 18+ with a synced
          passkey manager work; you can still try.
        </p>
      ) : null}

      <p className="mt-3 text-[11.5px] leading-relaxed text-fg-4">
        Not a wallet: this passkey can&rsquo;t sign transactions or move money — Privy still pays. Each key is its own
        passkey confirmation, because each comes from its own PRF salt.
      </p>
    </Panel>
  );
}

/** "Private" marker for lists and headers. Monochrome, like every other label in the app. */
export function PrivateTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-[var(--line-2)] px-1.5 py-px text-[10.5px] font-medium uppercase tracking-[0.06em] text-fg-2",
        className,
      )}
    >
      <LockGlyph />
      Private
    </span>
  );
}

export function LockGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className={cn("h-2.5 w-2.5", className)} fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="5.2" width="8" height="5.6" rx="1.2" />
      <path d="M4 5.2V3.8a2 2 0 0 1 4 0v1.4" />
    </svg>
  );
}
