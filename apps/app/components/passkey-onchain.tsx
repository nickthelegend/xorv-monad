"use client";

import { useEffect, useState } from "react";
import { shortHex } from "@xorv/protocol/web";
import { loadRegistry, verifyOnMonad, type OnChainCheck, type PasskeyKeyRecord } from "@/lib/private/passkey-onchain";
import { NETWORK_LABEL } from "@/lib/network";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * This passkey, checked by Monad: its registered P-256 public key, and
 * whether its newest unlock verifies under that key on Monad's P256VERIFY
 * precompile (0x0100), a read-only eth_call on the real network.
 */
export function PasskeyOnChain({ credentialId }: { credentialId: string | null }) {
  const [record, setRecord] = useState<PasskeyKeyRecord | null>(null);
  const [check, setCheck] = useState<OnChainCheck | null>(null);
  const [state, setState] = useState<"idle" | "checking" | "failed">("idle");

  useEffect(() => {
    if (!credentialId) return;
    const read = (): void => setRecord(loadRegistry()[credentialId] ?? null);
    read();
    window.addEventListener("xorv-passkey-keys", read);
    return () => window.removeEventListener("xorv-passkey-keys", read);
  }, [credentialId]);

  if (!credentialId) return null;
  const known = Boolean(record?.x && record?.y);

  const run = async (): Promise<void> => {
    if (!record) return;
    setState("checking");
    try {
      setCheck(await verifyOnMonad(record));
      setState("idle");
    } catch {
      setState("failed");
    }
  };

  return (
    <div className="mt-3.5 border-t border-[var(--line)] pt-3" data-testid="passkey-onchain">
      <p className="text-[12px] text-fg-2">Checked by Monad</p>
      {known ? (
        <p className="mono mt-1 break-all text-[10.5px] leading-relaxed text-fg-4">
          P-256 key {shortHex(record!.x!)}…{record!.y!.slice(-6)} ·{" "}
          {record!.source === "created" ? "kept when this passkey was created" : "recovered from two of its unlocks"}
        </p>
      ) : (
        <p className="mt-1 text-[11.5px] leading-relaxed text-fg-4">
          {record?.last
            ? "One more unlock and the passkey's public key can be recovered from its signatures."
            : "Unlock once or twice and the passkey's public key is kept here, so Monad can check its signatures."}
        </p>
      )}
      {known && record?.last ? (
        <>
          <Button variant="secondary" onClick={() => void run()} disabled={state === "checking"} className="mt-2 w-full">
            {state === "checking" ? "Asking Monad…" : "Verify my last unlock on Monad"}
          </Button>
          {check ? (
            <p className={cn("mt-2 text-[11.5px] leading-relaxed", check.ok ? "text-live" : "text-fail")} data-verified={check.ok}>
              {check.ok
                ? `✓ Monad's P256 precompile (0x0100) verified this passkey's signature · ${NETWORK_LABEL} block #${check.blockNumber.toLocaleString("en-US")}`
                : "✕ Monad's P256 precompile rejected the signature under this key"}
            </p>
          ) : null}
          {state === "failed" ? <p className="mt-2 text-[11.5px] text-fg-3">Couldn&rsquo;t reach Monad&rsquo;s RPC; try again.</p> : null}
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-4">
            A read-only eth_call to {NETWORK_LABEL}: no transaction, no gas. Any contract on Monad can run the same check.
          </p>
        </>
      ) : null}
    </div>
  );
}
