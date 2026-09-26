"use client";

import { useEffect, useState } from "react";
import { Reveal } from "@/components/ui/reveal";
import { LiveDot, Section, SectionHeading } from "@/components/ui/kit";
import { CHAIN, explorer, shortHex } from "@/lib/chain";
import {
  formatUsdMicros,
  formatUsdcUnits,
  parseLeaderboard,
  parseNetwork,
  parseReceipts,
  type LeaderboardFeed,
  type NetworkSnapshot,
  type ReceiptRow,
  type ReceiptsFeed,
} from "@/lib/feeds";
import { BROKER_URL } from "@/lib/links";
import { cn } from "@/lib/utils";

/**
 * The public ledger.
 *
 * Deliberately not four big numbers in four boxes. That template says "we have
 * metrics" without saying anything true, and on a network this young the honest
 * numbers are small — which is fine, because the argument here is *verifiable*,
 * not *large*. So: the real receipts, read from XorvLedger events on Monad
 * (through the broker, which asks Envio's indexer first and the RPC second),
 * each one a link you can open.
 *
 * Three feeds, fetched independently. A broker whose leaderboard query times
 * out still shows its receipts, and a ledger read that fails does not blank
 * the network stats — one `Promise.all` used to make any failure look like
 * the whole broker was down.
 *
 * When the broker isn't reachable the section still renders its permanent
 * facts — the contract addresses — and says the feed is offline rather than
 * inventing rows.
 */

interface Feed<T> {
  /** The last good read, kept through a transient failure. */
  data: T | null;
  /** The most recent read failed (unreachable, timed out, or non-2xx). */
  failed: boolean;
}

const POLL_MS = 20_000;
const TIMEOUT_MS = 8_000;

// Module-level so the hook's effect sees a stable function and doesn't refetch
// on every render.
const readReceipts = (body: unknown): ReceiptsFeed => parseReceipts(body, 6);
const readLeaders = (body: unknown): LeaderboardFeed => parseLeaderboard(body, 5);

function useFeed<T>(path: string, parse: (body: unknown) => T): Feed<T> {
  const [feed, setFeed] = useState<Feed<T>>({ data: null, failed: false });

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`${BROKER_URL}${path}`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = parse(await res.json());
        if (alive) setFeed({ data, failed: false });
      } catch {
        if (alive) setFeed((prev) => ({ data: prev.data, failed: true }));
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path, parse]);

  return feed;
}

export function Ledger() {
  const network = useFeed("/api/network", parseNetwork);
  const receipts = useFeed("/api/receipts", readReceipts);
  const leaders = useFeed("/api/leaderboard", readLeaders);

  return (
    <Section id="ledger" className="border-t border-[var(--line)]">
      <Reveal>
        <SectionHeading
          title="Every job leaves a receipt"
          sub="Payments settle in USDC on Monad, and every paid job is recorded as an event on XorvLedger — public, ordered and indexed by Envio. You don't have to trust the broker's database; read the contract yourself."
        />
      </Reveal>

      {/* Permanent facts first: these are true whether or not a broker answers. */}
      <Reveal delay={0.06}>
        <Facts network={network.data} />
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mx-auto mt-10 max-w-3xl">
          <StatusLine network={network} />
          <Receipts feed={receipts} />
        </div>
      </Reveal>

      <Reveal delay={0.14}>
        <Leaderboard feed={leaders} />
      </Reveal>
    </Section>
  );
}

/* --------------------------------------------------------------------------
   Contract addresses
-------------------------------------------------------------------------- */

function Facts({ network }: { network: NetworkSnapshot | null }) {
  // The broker's own config wins once it answers: it is the one that actually
  // settles payments, so its addresses and explorer are the ones that matter.
  const base = network?.explorerUrl?.replace(/\/+$/, "") ?? null;
  const addressUrl = (address: string): string => (base ? `${base}/address/${address}` : explorer.address(address));
  const ledger = network?.ledger ?? (CHAIN.ledger ? { address: CHAIN.ledger, url: null } : null);
  const usdc = network?.usdc?.address ?? CHAIN.usdc;
  const identity = network?.erc8004.identity ?? CHAIN.erc8004.identity;
  const reputation = network?.erc8004.reputation ?? CHAIN.erc8004.reputation;

  const rows: Array<[label: string, value: string | null, href: string | null]> = [
    ["XorvLedger", ledger?.address ?? null, ledger ? (ledger.url ?? addressUrl(ledger.address)) : null],
    ["USDC", usdc, network?.usdc?.url ?? (base ? `${base}/token/${usdc}` : explorer.token(usdc))],
    ["ERC-8004 identity", identity, addressUrl(identity)],
    ["ERC-8004 reputation", reputation, addressUrl(reputation)],
  ];

  return (
    <dl className="mx-auto mt-14 max-w-3xl divide-y divide-[var(--line)] border-y border-[var(--line)]">
      <div className="flex items-center justify-between gap-4 py-3.5">
        <dt className="text-[13.5px] text-fg-2">Network</dt>
        <dd className="mono text-[12.5px] text-fg-3">
          {CHAIN.name} · {network?.network ?? CHAIN.network}
        </dd>
      </div>
      {rows.map(([label, value, href]) => (
        <div key={label} className="flex items-center justify-between gap-4 py-3.5">
          <dt className="text-[13.5px] text-fg-2">{label}</dt>
          <dd className="min-w-0">
            {value && href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                title={value}
                className="mono text-[12.5px] text-fg-3 underline-offset-4 transition-colors hover:text-fg hover:underline"
              >
                <span className="sm:hidden">{shortHex(value)}</span>
                <span className="hidden sm:inline">{value}</span>
              </a>
            ) : (
              <span className="text-[12.5px] text-fg-4">
                {network ? "this broker isn't writing to a ledger yet" : "address comes from the broker"}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* --------------------------------------------------------------------------
   Network stats
-------------------------------------------------------------------------- */

function StatusLine({ network }: { network: Feed<NetworkSnapshot | null> }) {
  const stats = network.data?.stats ?? null;

  if (network.failed && !stats) {
    return (
      <div className="mb-4 flex items-center gap-2.5">
        <span className="h-1.5 w-1.5 rounded-full bg-fg-4" />
        <span className="text-[12.5px] text-fg-4">
          live feed offline — the contracts above are still readable on the explorer
        </span>
      </div>
    );
  }

  return (
    <div className="mb-4 flex items-center gap-2.5">
      {network.failed ? <span className="h-1.5 w-1.5 rounded-full bg-fg-4" /> : <LiveDot />}
      <span className="text-[12.5px] text-fg-3">
        {stats ? (
          <>
            <span className="tnum text-fg-2">{stats.providersLive}</span> live ·{" "}
            <span className="tnum text-fg-2">{stats.jobsCompleted}</span> completed ·{" "}
            <span className="tnum text-fg-2">${formatUsdMicros(stats.paidUsdMicros)}</span> paid to
            providers
            {network.failed ? <span className="text-fg-4"> · last read, reconnecting</span> : null}
          </>
        ) : network.data ? (
          "broker online"
        ) : (
          "reading the network…"
        )}
      </span>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Receipts
-------------------------------------------------------------------------- */

function Receipts({ feed }: { feed: Feed<ReceiptsFeed> }) {
  const data = feed.data;

  if (!data) {
    return (
      <p className="border-t border-[var(--line)] py-8 text-center text-[13px] text-fg-4">
        {feed.failed ? "The receipts feed is unreachable right now." : "Reading the ledger…"}
      </p>
    );
  }

  if (data.receipts.length === 0) {
    return (
      <p className="border-t border-[var(--line)] py-8 text-center text-[13px] text-fg-4">
        {data.configured
          ? "No receipts yet. The first paid job will appear here."
          : "This broker isn't writing to a ledger yet, so there are no receipts to show."}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
      {data.receipts.map((receipt) => (
        <ReceiptItem key={receipt.id} receipt={receipt} />
      ))}
    </ul>
  );
}

function ReceiptItem({ receipt }: { receipt: ReceiptRow }) {
  const job = receipt.jobId ? (receipt.jobId.startsWith("0x") ? shortHex(receipt.jobId, 10, 6) : receipt.jobId) : "—";
  return (
    <li className="grid gap-x-4 gap-y-1 py-3.5 sm:grid-cols-[1fr_auto] sm:items-baseline">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="inline-flex items-baseline gap-2">
          <span aria-hidden className={cn("text-[11px]", receipt.ok === false ? "text-fail" : "text-fg-3")}>
            {receipt.ok === false ? "✕" : "✓"}
          </span>
          <span className="sr-only">{receipt.ok === false ? "Failed job" : "Completed job"}</span>
          <span className="mono text-[12.5px] text-fg">{job}</span>
        </span>
        <span className="mono text-[12px] text-fg-4">
          {receipt.buyer ? shortHex(receipt.buyer) : "—"} → {receipt.payTo ? shortHex(receipt.payTo) : "—"}
        </span>
      </div>

      <div className="flex items-baseline gap-4 sm:justify-end">
        <span className="mono tnum text-[12.5px] text-fg-2">
          {receipt.amountUnits ? `${formatUsdcUnits(receipt.amountUnits)} USDC` : "—"}
        </span>
        {receipt.paymentUrl ? (
          <ExternalLink href={receipt.paymentUrl}>payment</ExternalLink>
        ) : (
          <span className="text-[11.5px] text-fg-4">unpaid</span>
        )}
        {receipt.explorerUrl ? <ExternalLink href={receipt.explorerUrl}>receipt</ExternalLink> : null}
      </div>
    </li>
  );
}

/* --------------------------------------------------------------------------
   Leaderboard
-------------------------------------------------------------------------- */

function Leaderboard({ feed }: { feed: Feed<LeaderboardFeed> }) {
  const data = feed.data;
  const providers = data?.providers ?? [];
  // Say where the ranking comes from. Envio's view is the chain's; the
  // fallback is one broker's own counters, which is narrower and should read so.
  const source =
    data?.source === "indexer"
      ? "indexed by Envio from XorvLedger and ERC-8004 events"
      : data?.source === "memory"
        ? "from this broker's own counters"
        : null;

  return (
    <div className="mx-auto mt-14 max-w-3xl">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-medium tracking-[-0.01em] text-fg">Top providers</h3>
        {source ? <span className="text-[12px] text-fg-4">{source}</span> : null}
      </div>

      {providers.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left">
            <thead>
              <tr className="border-b border-[var(--line)]">
                {["#", "Provider", "Jobs", "Success", "Rating", "Earned"].map((h, i) => (
                  <th
                    key={h}
                    scope="col"
                    className={cn("pb-3 text-[12px] font-medium text-fg-4", i >= 2 && "text-right")}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={`${p.rank}-${p.address ?? p.label}`} className="border-b border-[var(--line)]">
                  <td className="mono tnum py-3.5 pr-4 text-[12px] text-fg-4">{p.rank}</td>
                  <td className="py-3.5 pr-4">
                    <span className="inline-flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                      {p.live ? <LiveDot className="self-center" /> : null}
                      {p.addressUrl ? (
                        <a
                          href={p.addressUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[13.5px] font-medium text-fg underline-offset-4 hover:underline"
                        >
                          {p.label.startsWith("0x") ? shortHex(p.label) : p.label}
                        </a>
                      ) : (
                        <span className="text-[13.5px] font-medium text-fg">{p.label}</span>
                      )}
                      {p.agentId ? (
                        p.agentUrl ? (
                          <ExternalLink href={p.agentUrl}>{`agent #${p.agentId}`}</ExternalLink>
                        ) : (
                          <span className="mono text-[11.5px] text-fg-4">agent #{p.agentId}</span>
                        )
                      ) : null}
                    </span>
                  </td>
                  <td className="mono tnum py-3.5 pr-4 text-right text-[12.5px] text-fg-2">
                    {p.jobsOk}/{p.jobsTotal}
                  </td>
                  <td className="mono tnum py-3.5 pr-4 text-right text-[12.5px] text-fg-2">
                    {p.successRate === null ? "—" : `${Math.round(p.successRate * 100)}%`}
                  </td>
                  <td className="mono tnum py-3.5 pr-4 text-right text-[12.5px] text-fg-2">
                    {p.avgRating === null ? "—" : `${Math.round(p.avgRating)}/100`}
                    {p.ratingsCount > 0 ? <span className="text-fg-4"> ·{p.ratingsCount}</span> : null}
                  </td>
                  <td className="mono tnum py-3.5 text-right text-[12.5px] text-fg">
                    ${formatUsdMicros(p.earnedUsdMicros)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="border-t border-[var(--line)] py-8 text-center text-[13px] text-fg-4">
          {data
            ? "No provider has completed a paid job yet."
            : feed.failed
              ? "The leaderboard is unreachable right now."
              : "Reading the leaderboard…"}
        </p>
      )}
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[11.5px] text-fg-3 underline-offset-4 transition-colors hover:text-fg hover:underline"
    >
      {children} ↗
    </a>
  );
}
