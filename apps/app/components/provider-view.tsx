"use client";

import { useCallback } from "react";
import { explorerAddress, explorerAgent, explorerTx, formatUsdc, shortHex } from "@xorv/protocol/web";
import { api, formatAgo, formatDuration, formatUsd, type Provider } from "@/lib/api";
import { usePoll } from "@/lib/hooks";
import { NETWORK } from "@/lib/network";
import { readTrust } from "@/lib/trust";
import { Empty, Ext, Panel, Row, Status } from "@/components/ui";
import { TrustPanel } from "@/components/trust";

/**
 * One provider: what it sells, what it has done, and how much its payout
 * wallet can be trusted. This is the page every provider's ERC-8004 agent
 * file points at (its `web` service), so it has to stand on its own for a
 * visitor arriving from an explorer.
 */
export function ProviderView({ id, initial }: { id: string; initial: Provider | null }) {
  const { data, error } = usePoll<Provider>(useCallback(() => api.provider(id), [id]), 10_000);
  const provider = data ?? initial;

  if (!provider) {
    return error ? (
      <Empty title="Unknown provider" hint="It may have gone offline long enough to be forgotten, or the link is wrong." />
    ) : (
      <Empty title="Loading…" />
    );
  }

  const trust = readTrust(provider.trust);
  const jobs = provider.stats.jobsCompleted + provider.stats.jobsFailed;

  return (
    <div className="space-y-8">
      <Panel className="p-5">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[13px] font-medium text-fg">Provider</h2>
          <Status status={provider.status} />
        </div>
        <div className="mt-4 border-t border-[var(--line)] pt-1">
          <Row label="payout wallet">
            <Ext href={provider.addressUrl || explorerAddress(NETWORK, provider.address)}>{shortHex(provider.address)} ↗</Ext>
          </Row>
          <Row label="ERC-8004 identity">
            {provider.agentId ? (
              <Ext href={provider.agentUrl || explorerAgent(NETWORK, provider.agentId)}>agent #{provider.agentId} ↗</Ext>
            ) : (
              "none yet"
            )}
          </Row>
          <Row label="registered on-chain">
            {provider.registryTxHash ? (
              <Ext href={explorerTx(NETWORK, provider.registryTxHash)}>{shortHex(provider.registryTxHash)} ↗</Ext>
            ) : (
              "not yet"
            )}
          </Row>
          <Row label="last heartbeat">{formatAgo(provider.lastHeartbeatAt)}</Row>
          <Row label="jobs">
            <span className="tnum">
              {provider.stats.jobsCompleted} done
              {provider.stats.jobsFailed ? ` · ${provider.stats.jobsFailed} failed` : ""}
              {jobs > 0 ? ` · ${Math.round((provider.stats.jobsCompleted / jobs) * 100)}% success` : ""}
            </span>
          </Row>
          {provider.stats.avgDurationMs ? <Row label="typical job">{formatDuration(provider.stats.avgDurationMs)}</Row> : null}
          <Row label="earned">
            <span className="tnum">{formatUsdc(provider.stats.earnedUsdcMicros)}</span>
          </Row>
          {provider.region ? <Row label="region">{provider.region}</Row> : null}
          <Row label="version">{provider.version}</Row>
        </div>
      </Panel>

      <TrustPanel trust={trust} />

      <section>
        <h2 className="mb-3 text-[13px] font-medium text-fg">Capabilities</h2>
        <ul className="border-t border-[var(--line)]">
          {provider.capabilities.map((cap) => (
            <li key={cap.id} className="flex items-baseline justify-between gap-4 border-b border-[var(--line)] py-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] text-fg-2">{cap.displayName}</p>
                <p className="mono mt-0.5 truncate text-[11.5px] text-fg-4">
                  {cap.adapter}
                  {cap.model ? ` · ${cap.model}` : ""} · up to {Math.max(1, cap.maxConcurrency)} at once
                </p>
              </div>
              <span className="tnum shrink-0 text-[13px] font-medium text-fg">{formatUsd(cap.priceUsdMicros)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
