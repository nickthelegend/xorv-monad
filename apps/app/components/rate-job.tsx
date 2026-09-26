"use client";

import { useState } from "react";
import { explorerAgent, explorerTx, sameAddress, shortHex } from "@xorv/protocol/web";
import { asRatingSigner, useWallet } from "@/components/wallet-provider";
import { BROKER_URL, type Job, type JobRating } from "@/lib/api";
import { useDemoPayer, useNetworkInfo } from "@/lib/hooks";
import { NETWORK } from "@/lib/network";
import { RATING_STARS, RatingError, rateJob, starsToValue, valueToStars, type RatingReceipt } from "@/lib/rating";
import { errorMessage } from "@/lib/errors";
import { Panel } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Rate the job — one signature, no gas, straight into ERC-8004.
 *
 * The buyer picks 1–5 stars (20–100 on the ERC-8004 scale), signs an EIP-712
 * `Rating` in the same wallet that paid, and the broker relays it:
 * `XorvLedger.rateJob` checks the signature against the recorded buyer and
 * calls the Reputation Registry's `giveFeedback` for the provider's agent. The
 * result is a portable, on-chain reputation entry any other marketplace can
 * read — paid for by the relay, signed by the person who actually bought the
 * work.
 *
 * Only the buyer can rate. When the demo account paid, the demo account
 * signs (server-side, /api/rate); when someone else's wallet paid, this says
 * so instead of offering a button that can only fail.
 */
export function RateJob({ job, onRated }: { job: Job; onRated: (rating: JobRating) => void }) {
  const wallet = useWallet();
  const demo = useDemoPayer();
  const info = useNetworkInfo();
  const [stars, setStars] = useState(0);
  const [hover, setHover] = useState(0);
  const [busy, setBusy] = useState<"signing" | "relaying" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<RatingReceipt | null>(null);

  const agentId = job.providerAgentId;
  const rated: JobRating | null =
    job.rating ?? (receipt ? { value: receipt.value, txHash: receipt.txHash ?? "", feedbackURI: receipt.feedbackURI ?? "" } : null);

  if (rated) {
    return (
      <Panel className="border-[var(--line-2)] p-4">
        <h2 className="text-[13px] font-medium text-fg">Buyer rating</h2>
        <Stars value={valueToStars(rated.value)} className="mt-2" />
        <p className="mt-1 text-[12px] text-fg-3">
          <span className="tnum">{rated.value}</span>/100, recorded as ERC-8004 feedback
          {agentId ? ` for agent #${agentId}` : ""}.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
          {rated.txHash ? <Link href={explorerTx(NETWORK, rated.txHash)}>Relay tx ↗</Link> : null}
          {agentId ? <Link href={explorerAgent(NETWORK, agentId)}>ERC-8004 feedback ↗</Link> : null}
          {rated.feedbackURI ? <Link href={rated.feedbackURI}>Feedback file ↗</Link> : null}
        </div>
      </Panel>
    );
  }

  if (job.status !== "completed" || !job.payment) return null;

  const payer = job.payment.payer;
  const byWallet = Boolean(wallet.address && sameAddress(wallet.address, payer));
  const byDemo = !byWallet && Boolean(demo?.configured && sameAddress(demo.address, payer));

  let blocker: React.ReactNode = null;
  if (!agentId) {
    blocker = "This provider has no ERC-8004 identity yet, so there is no on-chain reputation to rate.";
  } else if (!byWallet && !byDemo) {
    blocker = wallet.address ? (
      <>
        Only the wallet that paid (<span className="mono">{shortHex(payer)}</span>) can rate this job.
      </>
    ) : (
      <>
        {wallet.available ? (
          <button type="button" onClick={wallet.login} className="text-fg-2 underline underline-offset-2 hover:text-fg">
            {wallet.mode === "privy" ? "Log in" : "Connect"}
          </button>
        ) : (
          "Connect"
        )}{" "}
        as the buyer (<span className="mono">{shortHex(payer)}</span>) to rate this job.
      </>
    );
  }

  async function submit(): Promise<void> {
    if (!stars) return;
    const value = starsToValue(stars);
    setError(null);
    try {
      let result: RatingReceipt;
      if (byWallet) {
        setBusy("signing");
        const signer = asRatingSigner(await wallet.getSigner());
        result = await rateJob({
          brokerUrl: BROKER_URL,
          jobId: job.id,
          value,
          network: NETWORK,
          ledger: info?.ledger?.address ?? null,
          signer: {
            address: signer.address,
            signTypedData: async (typedData) => {
              const signature = await signer.signTypedData(typedData);
              setBusy("relaying");
              return signature;
            },
          },
        });
      } else {
        setBusy("relaying");
        const res = await fetch("/api/rate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: job.id, value }),
        });
        const body = (await res.json().catch(() => ({}))) as RatingReceipt & { error?: string };
        if (!res.ok) throw new RatingError(body.error ?? `Rating failed (${res.status}).`);
        result = body;
      }
      setReceipt(result);
      onRated({ value: result.value, txHash: result.txHash ?? "", feedbackURI: result.feedbackURI ?? "" });
    } catch (err) {
      setError(err instanceof RatingError && err.rejected ? err.message : errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel className="p-4">
      <h2 className="text-[13px] font-medium text-fg">Rate this job</h2>
      <p className="mt-1.5 text-[12px] leading-relaxed text-fg-3">
        Your rating becomes ERC-8004 reputation for the provider. You sign it; the broker relays it and pays
        the gas.
      </p>

      {blocker ? (
        <p className="mt-3 text-[12px] leading-relaxed text-fg-4">{blocker}</p>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-1" onMouseLeave={() => setHover(0)} role="radiogroup" aria-label="Rating">
            {Array.from({ length: RATING_STARS }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={stars === n}
                aria-label={`${n} star${n === 1 ? "" : "s"} (${starsToValue(n)}/100)`}
                disabled={busy !== null}
                onMouseEnter={() => setHover(n)}
                onClick={() => setStars(n)}
                className={cn(
                  "text-[22px] leading-none transition-colors",
                  n <= (hover || stars) ? "text-fg" : "text-fg-4 hover:text-fg-3",
                )}
              >
                ★
              </button>
            ))}
            {stars ? <span className="tnum ml-2 text-[12px] text-fg-3">{starsToValue(stars)}/100</span> : null}
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!stars || busy !== null}
            className="mt-3 w-full rounded-lg bg-white px-4 py-2 text-[13px] font-medium text-black transition-all hover:bg-white/90 active:scale-[0.985] disabled:opacity-40"
          >
            {busy === "signing"
              ? "Approve the rating in your wallet…"
              : busy === "relaying"
                ? "Relaying to ERC-8004…"
                : byDemo
                  ? "Rate as the demo account — free"
                  : "Sign rating — free"}
          </button>
        </>
      )}

      {error ? <p className="mt-2.5 text-[12px] leading-relaxed text-fail">{error}</p> : null}
    </Panel>
  );
}

function Stars({ value, className }: { value: number; className?: string }) {
  return (
    <p className={cn("text-[18px] leading-none", className)} aria-label={`${value} of ${RATING_STARS} stars`}>
      {Array.from({ length: RATING_STARS }, (_, i) => (
        <span key={i} className={i < value ? "text-fg" : "text-fg-4"}>
          ★
        </span>
      ))}
    </p>
  );
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-fg-2 underline underline-offset-2 transition-colors hover:text-fg">
      {children}
    </a>
  );
}
