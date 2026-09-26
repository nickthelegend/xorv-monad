import Link from "next/link";
import { shortHex } from "@xorv/protocol/web";
import { Ext, Panel, Row } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  NANSEN_ATTRIBUTION,
  NANSEN_URL,
  endpointName,
  funderText,
  paidLine,
  riskFlagText,
  sourceNote,
  trustLabel,
  walletAge,
  warningFlags,
  type NansenStatus,
  type TrustBand,
  type TrustSignal,
} from "@/lib/trust";

/* ---------------------------------------------------------------------------
   Nansen trust, on screen.

   Colour follows the app's rule — it reports state and nothing else: a
   well-established wallet gets the live dot, a weak one the warning dot, a
   wallet with no history a neutral one (no history is not a bad sign; most
   provider wallets are testnet-only). Every surface carries Nansen's
   attribution, and the payments that bought the data link to Monadscan.
--------------------------------------------------------------------------- */

const DOT: Record<TrustBand, string> = {
  high: "bg-live",
  medium: "bg-fg-3",
  low: "bg-warn",
  unknown: "bg-fg-4",
};

export function PoweredByNansen({ className }: { className?: string }) {
  return (
    <span className={cn("text-[11px] text-fg-4", className)}>
      <Ext href={NANSEN_URL}>{NANSEN_ATTRIBUTION}</Ext>
    </span>
  );
}

/** "● Trust 78" — the compact badge for a list row. */
export function TrustBadge({ trust, className }: { trust: TrustSignal; className?: string }) {
  const flagged = warningFlags(trust).length > 0;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-[11.5px]", flagged ? "text-fail" : "text-fg-3", className)}
      title={`Nansen trust score for the payout wallet (${NANSEN_ATTRIBUTION})`}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", flagged ? "bg-fail" : DOT[trust.band])} />
      <span className="tnum">{trustLabel(trust)}</span>
    </span>
  );
}

/** What each paid call bought, as explorer links. */
function PaidLinks({ trust }: { trust: TrustSignal }) {
  const line = paidLine(trust);
  if (!line) return null;
  return (
    <span>
      {line}
      {trust.paidTx.map((tx, i) => (
        <span key={tx.txHash}>
          {i === 0 ? " — " : " · "}
          <Ext href={tx.url}>{endpointName(tx.endpoint) || shortHex(tx.txHash)} ↗</Ext>
        </span>
      ))}
    </span>
  );
}

/** One or two lines under a provider in the detailed list. */
export function TrustSummary({ trust, providerHref }: { trust: TrustSignal; providerHref?: string }) {
  const age = walletAge(trust.walletAgeDays);
  const funder = funderText(trust);
  const flags = warningFlags(trust);
  const note = sourceNote(trust);
  return (
    <div className="mt-1.5 space-y-0.5 text-[11.5px] leading-relaxed text-fg-4">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <TrustBadge trust={trust} />
        {age ? <span>wallet {age} old</span> : null}
        {funder ? <span>· funded by {funder}</span> : null}
        {trust.txCount > 0 ? (
          <span className="tnum">
            · {trust.txCount}
            {trust.txCountCapped ? "+" : ""} Monad txs
          </span>
        ) : null}
        {note ? <span>· {note}</span> : null}
        {providerHref ? (
          <Link href={providerHref} className="underline-offset-4 hover:text-fg hover:underline">
            · details
          </Link>
        ) : null}
      </p>
      {flags.length ? <p className="text-fail">{flags.map(riskFlagText).join(" · ")}</p> : null}
      <p className="flex flex-wrap gap-x-2">
        <PaidLinks trust={trust} />
        <PoweredByNansen />
      </p>
    </div>
  );
}

/** The full panel on a provider's page. */
export function TrustPanel({ trust }: { trust: TrustSignal | null }) {
  return (
    <Panel className="p-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[13px] font-medium text-fg">Wallet trust</h2>
        <PoweredByNansen />
      </div>
      <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
        The broker looks this provider&rsquo;s payout wallet up on Nansen — how old it is, who first funded it, what it
        has done on Monad — and uses it to break ties between equally priced providers and to refuse ratings between
        related wallets. Missing history is never held against a provider.
      </p>
      {!trust ? (
        <p className="mt-4 border-t border-[var(--line)] pt-3 text-[12.5px] text-fg-4">
          No trust signal yet — the broker has Nansen off, or the lookup is still running.
        </p>
      ) : (
        <div className="mt-4 border-t border-[var(--line)] pt-1">
          <Row label="score">
            <span className="inline-flex items-center gap-2">
              <TrustBadge trust={trust} />
              {trust.band !== "unknown" ? <span className="text-fg-4">/ 100 · {trust.band}</span> : null}
            </span>
          </Row>
          <Row label="first seen">
            {trust.firstSeen ? `${trust.firstSeen.slice(0, 10)} · ${walletAge(trust.walletAgeDays) ?? ""}` : "no record"}
          </Row>
          <Row label="first funder">
            {trust.firstFunder ? (
              trust.firstFunder.url ? (
                <Ext href={trust.firstFunder.url}>{funderText(trust)} ↗</Ext>
              ) : (
                funderText(trust)
              )
            ) : (
              "none on record"
            )}
            {trust.firstFunder?.chain ? <span className="text-fg-4"> · {trust.firstFunder.chain}</span> : null}
          </Row>
          <Row label="monad activity">
            <span className="tnum">
              {trust.txCount}
              {trust.txCountCapped ? "+" : ""}
            </span>{" "}
            txs in 90 days
          </Row>
          <Row label="linked wallets">
            <span className="tnum">{trust.relatedWalletCount}</span>
          </Row>
          {trust.labels.length ? <Row label="labels">{trust.labels.join(" · ")}</Row> : null}
          <Row label="risk flags">
            {warningFlags(trust).length ? (
              <span className="text-fail">{warningFlags(trust).map(riskFlagText).join(" · ")}</span>
            ) : (
              "none"
            )}
          </Row>
          <Row label="source">
            {trust.mode === "fixture" ? "fixture data (no network)" : trust.paidTx.length ? "Nansen API, paid over x402" : "Nansen API"}
            {trust.degraded ? " · partial" : ""}
          </Row>
        </div>
      )}
      {trust && trust.paidTx.length ? (
        <div className="mt-3 border-t border-[var(--line)] pt-3 text-[12px] leading-relaxed text-fg-3">
          <p>{paidLine(trust)}:</p>
          <ul className="mt-1 space-y-0.5">
            {trust.paidTx.map((tx) => (
              <li key={tx.txHash} className="mono text-[11.5px] text-fg-4">
                ${tx.amountUsdc} · {endpointName(tx.endpoint)} · <Ext href={tx.url}>{shortHex(tx.txHash)} ↗</Ext>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

/** The network page's account of what the broker bought from Nansen today. */
export function NansenPanel({ status }: { status: NansenStatus }) {
  const how =
    status.mode === "off"
      ? "off"
      : status.mode === "fixture"
        ? "fixture data — no network, no payments"
        : status.auth === "api-key"
          ? "live, API key"
          : "live, paid per call over x402";
  return (
    <Panel className="p-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[13px] font-medium text-fg">Wallet intelligence</h2>
        <PoweredByNansen />
      </div>
      <p className="measure mt-1.5 text-[12.5px] leading-relaxed text-fg-3">
        The broker is itself a paying agent: it buys Nansen wallet data per call — $0.01 in USDC on Monad mainnet,
        over x402 — to score provider wallets, break matching ties and refuse ratings between related wallets.
      </p>
      <div className="mt-4 border-t border-[var(--line)] pt-1">
        <Row label="mode">{how}</Row>
        {status.payer ? (
          <Row label="payer">
            <Ext href={status.payer.url}>{shortHex(status.payer.address)} ↗</Ext>
            <span className="text-fg-4"> · Monad mainnet</span>
          </Row>
        ) : null}
        <Row label="calls today">
          <span className="tnum">
            {status.callsToday}
            {status.paidCallsToday ? ` · ${status.paidCallsToday} paid` : ""}
          </span>
        </Row>
        <Row label="spent today">
          <span className="tnum">
            ${status.spentTodayUsdc} of ${status.budgetUsdc}
          </span>
          <span className="text-fg-4"> · ≤ ${status.perCallCapUsdc}/call</span>
        </Row>
        <Row label="last payment">
          {status.lastPaidTx ? (
            <Ext href={status.lastPaidTx.url}>
              ${status.lastPaidTx.amountUsdc} · {endpointName(status.lastPaidTx.endpoint)} · {shortHex(status.lastPaidTx.txHash)} ↗
            </Ext>
          ) : (
            "none yet"
          )}
        </Row>
        <Row label="wallets scored">
          <span className="tnum">{status.walletsScored}</span>
        </Row>
        <Row label="rating guard">
          {status.ratingGuard ? (
            <span className="tnum">
              on · {status.ratingChecks} checked · {status.ratingsRefused} refused
            </span>
          ) : (
            "off"
          )}
        </Row>
      </div>
      {status.lastError && status.mode !== "off" ? (
        <p className="mt-3 break-words text-[12px] leading-relaxed text-fg-4">Last lookup error: {status.lastError}</p>
      ) : null}
    </Panel>
  );
}
