"use client";

import { useEffect, useState } from "react";
import { createPublicClient, formatEther, http, type PublicClient } from "viem";
import { explorerAddress, readStaking, shortHex, viemChain, type StakingSnapshot } from "@xorv/protocol/web";
import { CHAIN_CONFIG, IS_LOCAL_CHAIN, NETWORK, NETWORK_LABEL } from "@/lib/network";
import { Ext, Panel, Row } from "@/components/ui";

/**
 * Who secures the payments: Monad's validator set, read live from the staking
 * precompile (0x1000) on the real network every 30 seconds while the tab is
 * visible. A fork has no code at 0x1000, so this always reads Monad itself.
 * Xorv holds no MON to delegate, so this is read-only.
 */
export function StakingPanel() {
  const [snap, setSnap] = useState<StakingSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // The network's own public RPC, never a fork's: staking lives only on Monad.
    const client = createPublicClient({ chain: viemChain(NETWORK), transport: http(CHAIN_CONFIG.rpcUrl) }) as PublicClient;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async (): Promise<void> => {
      if (document.visibilityState === "visible") {
        try {
          const next = await readStaking(client);
          if (!alive) return;
          setSnap(next);
          setFailed(false);
        } catch {
          if (alive) setFailed(true);
        }
      }
      if (alive) timer = setTimeout(load, 30_000);
    };
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const mon = (wei: string) => `${Math.round(Number(formatEther(BigInt(wei)))).toLocaleString("en-US")} MON`;

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium text-fg">Who secures the payments: Monad&rsquo;s validators</h2>
        <span className="text-[11.5px] text-fg-4">live · staking precompile 0x1000 on {NETWORK_LABEL}</span>
      </div>
      <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
        Every settlement and escrow release is final once Monad&rsquo;s validators finalize its block. This is the set
        doing it right now, read straight from the chain&rsquo;s staking precompile.
        {IS_LOCAL_CHAIN ? " (The payments in this deployment run on a local fork; the validator set is the real network's.)" : ""}
      </p>
      <div className="mt-4 border-t border-[var(--line)] pt-1">
        {snap ? (
          <>
            <Row label="epoch">
              <span className="tnum">
                {snap.epoch.toLocaleString("en-US")}
                {snap.inEpochDelayPeriod ? " · in the epoch delay period (changes now take effect in n+2)" : ""}
              </span>
            </Row>
            <Row label="validators in consensus">
              <span className="tnum">{snap.consensusSetSize}</span>
            </Row>
            {snap.proposer ? (
              <>
                <Row label="proposing now">
                  <span className="tnum">
                    validator #{snap.proposer.id} ·{" "}
                    <Ext live href={explorerAddress(NETWORK, snap.proposer.authAddress)}>
                      {shortHex(snap.proposer.authAddress)}
                    </Ext>
                  </span>
                </Row>
                <Row label="its stake">
                  <span className="tnum">
                    {mon(snap.proposer.stake)} · {(Number(BigInt(snap.proposer.commission) / 10n ** 14n) / 100).toFixed(0)}% commission
                  </span>
                </Row>
              </>
            ) : null}
          </>
        ) : (
          <p className="py-2 text-[12.5px] text-fg-4">{failed ? "Couldn't reach Monad's RPC; retrying." : "Reading the staking precompile…"}</p>
        )}
      </div>
    </Panel>
  );
}
