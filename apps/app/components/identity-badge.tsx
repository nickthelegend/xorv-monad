"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { usePoll } from "@/lib/hooks";
import { identityLabel } from "@/lib/identity-label";
import { NETWORK } from "@/lib/network";
import { explorerAddress } from "@xorv/protocol/web";
import { Ext } from "./ui";

/** Current gate standing, not ERC-8004 reputation or a claim about past trades. */
export function IdentityBadge({ address }: { address: string }) {
  const { data, error } = usePoll(useCallback(() => api.identity(address), [address]), 20_000);
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 10_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, []);
  const state = identityLabel(data, error, now);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]" role="status">
      <span className={state.verified ? "text-ok" : "text-fg-3"}>{state.verified ? "✓ " : ""}{state.label}</span>
      {data?.gate ? <Ext href={explorerAddress(NETWORK, data.gate.address)}>gate ↗</Ext> : null}
    </span>
  );
}
