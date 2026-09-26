"use client";

import { useEffect, useState } from "react";
import { Reveal } from "@/components/ui/reveal";
import { LiveDot, Section, SectionHeading } from "@/components/ui/kit";
import { BROKER_URL, CHAIN } from "@/lib/links";

/**
 * The public ledger.
 *
 * Deliberately not four big numbers in four boxes. That template says "we have
 * metrics" without saying anything true, and on a network this young the honest
 * numbers are small — which is fine, because the argument here is *verifiable*,
 * not *large*. So: the real receipts, read from a Hedera mirror node, each one
 * a link you can open.
 *
 * When the broker isn't reachable the section still renders its permanent
 * facts — the topic ids — and says the feed is offline rather than inventing
 * rows.
 */

interface Receipt {
  consensusAt: string;
  sequence: number;
  payload: {
    at?: number;
    data?: {
      jobId?: string;
      payer?: string;
      providerAccountId?: string;
      amount?: string;
      asset?: string;
      transactionId?: string;
      durationMs?: number;
      ok?: boolean;
    };
  } | null;
}

interface Network {
  network: string;
  stats: { providersLive: number; jobsCompleted: number; paidUsdMicros: number };
}

const HBAR = "0.0.0";

export function Ledger() {
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [network, setNetwork] = useState<Network | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const [r, n] = await Promise.all([
          fetch(`${BROKER_URL}/api/receipts`, { signal: AbortSignal.timeout(8_000) }),
          fetch(`${BROKER_URL}/api/network`, { signal: AbortSignal.timeout(8_000) }),
        ]);
        if (!r.ok || !n.ok) throw new Error("unreachable");
        const body = (await r.json()) as { receipts: Receipt[] };
        if (!alive) return;
        setReceipts(body.receipts.slice(0, 6));
        setNetwork((await n.json()) as Network);
        setOffline(false);
      } catch {
        if (alive) setOffline(true);
      }
    };
    void load();
    const timer = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <Section id="ledger" className="border-t border-[var(--line)]">
      <Reveal>
        <SectionHeading
          title="Every job leaves a receipt"
          sub="Registrations, liveness and settlements are written to Hedera Consensus Service — public, ordered and append-only. You don't have to trust the broker's database; read the topics yourself."
        />
      </Reveal>

      {/* Permanent facts first: these are true whether or not a broker answers. */}
      <Reveal delay={0.06}>
        <dl className="mx-auto mt-14 max-w-3xl divide-y divide-[var(--line)] border-y border-[var(--line)]">
          {(
            [
              ["Registry", CHAIN.topics.registry],
              ["Heartbeat", CHAIN.topics.heartbeat],
              ["Receipts", CHAIN.topics.receipts],
              ["USDC", CHAIN.usdc],
            ] as const
          ).map(([label, id]) => (
            <div key={label} className="flex items-center justify-between gap-4 py-3.5">
              <dt className="text-[13.5px] text-fg-2">{label}</dt>
              <dd>
                <a
                  href={
                    label === "USDC" ? CHAIN.usdcUrl : CHAIN.topicUrl(id)
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mono text-[12.5px] text-fg-3 underline-offset-4 transition-colors hover:text-fg hover:underline"
                >
                  {id}
                </a>
              </dd>
            </div>
          ))}
        </dl>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mx-auto mt-10 max-w-3xl">
          <div className="mb-4 flex items-center gap-2.5">
            {offline ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-fg-4" />
                <span className="text-[12.5px] text-fg-4">
                  live feed offline — the topics above are still readable on HashScan
                </span>
              </>
            ) : (
              <>
                <LiveDot />
                <span className="text-[12.5px] text-fg-3">
                  {network ? (
                    <>
                      <span className="tnum text-fg-2">{network.stats.providersLive}</span> live ·{" "}
                      <span className="tnum text-fg-2">{network.stats.jobsCompleted}</span> settled ·{" "}
                      <span className="tnum text-fg-2">
                        ${(network.stats.paidUsdMicros / 1_000_000).toFixed(4)}
                      </span>{" "}
                      paid to providers
                    </>
                  ) : (
                    "reading the network…"
                  )}
                </span>
              </>
            )}
          </div>

          {receipts && receipts.length > 0 ? (
            <ul className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
              {receipts.map((receipt) => {
                const d = receipt.payload?.data ?? {};
                const isHbar = d.asset === HBAR;
                return (
                  <li key={receipt.sequence} className="py-3.5">
                    <a
                      href={
                        d.transactionId
                          ? `https://hashscan.io/testnet/transaction/${d.transactionId
                              .replace("@", "-")
                              .replace(/\.(\d+)$/, "-$1")}`
                          : CHAIN.topicUrl(CHAIN.topics.receipts)
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 transition-opacity hover:opacity-70"
                    >
                      <span className="mono text-[12.5px] text-fg">{d.jobId ?? "—"}</span>
                      <span className="mono text-[12px] text-fg-4">
                        {d.payer} → {d.providerAccountId}
                      </span>
                      <span className="mono tnum text-[12.5px] text-fg-2">
                        {d.amount} {isHbar ? "tℏ" : "µUSDC"}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : !offline ? (
            <p className="border-t border-[var(--line)] py-8 text-center text-[13px] text-fg-4">
              No receipts on the topic yet.
            </p>
          ) : null}
        </div>
      </Reveal>
    </Section>
  );
}
