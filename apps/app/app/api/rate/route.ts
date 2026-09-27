/**
 * Rate a job that the demo account paid for.
 *
 * `XorvLedger.rateJob` only accepts a rating signed by the job's recorded
 * buyer. For a job paid through "Pay from demo account" that buyer is the
 * deployment's key, so the visitor's own wallet cannot rate it — this route
 * signs on the demo account's behalf instead, through the same verified
 * typed-data flow the wallet path uses (lib/rating.ts), and the broker relays
 * it exactly the same way. Testnet-only, like the payer.
 *
 * It refuses any job the demo account did not pay for: signing a rating for
 * someone else's purchase is not something a shared key should ever do. And
 * because anyone can reach it, it also refuses a demo-paid job unless the
 * request carries the demo receipt `/api/pay` set in the browser that paid —
 * fresh (within 30 minutes) and used once. Without that, any visitor could
 * put a rating of their choosing on a judge's demo-paid job, or an attacker
 * could pay their own provider from the demo float and five-star it on a loop.
 * Per-IP and deployment-wide rate limits sit in front (lib/server/demo-guard.ts).
 *
 * `GET ?jobId=` answers whether this browser may rate the job as the demo
 * account, so the page only offers the button when pressing it can work.
 */

import { NextResponse } from "next/server";
import type { NetworkInfo, PublicJob } from "@xorv/protocol/web";
import { sameAddress } from "@xorv/protocol/web";
import { loadDemoPayer } from "@/lib/server/demo-payer";
import {
  clientIp,
  dailyCapUnits,
  demoGuards,
  demoReceiptCookie,
  isCookieSafeJobId,
  readCookie,
  verifyDemoReceipt,
  type DemoReceiptCheck,
} from "@/lib/server/demo-guard";
import { RatingError, isRelatedWalletRefusal, rateJob } from "@/lib/rating";
import { errorMessage } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function brokerJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

/** The demo receipt for `jobId` this request carries, checked. */
function receiptFor(request: Request, receiptSecret: Buffer, jobId: string): DemoReceiptCheck {
  if (!isCookieSafeJobId(jobId)) return { ok: false, reason: "invalid" };
  return verifyDemoReceipt(receiptSecret, jobId, readCookie(request, demoReceiptCookie(jobId)));
}

const RECEIPT_REFUSAL: Record<Exclude<DemoReceiptCheck, { ok: true }>["reason"], string> = {
  missing:
    "Only the browser that paid for this job with the demo account can rate it as the demo account.",
  invalid:
    "Only the browser that paid for this job with the demo account can rate it as the demo account.",
  expired: "Demo ratings are open for 30 minutes after the demo payment, and this one has closed.",
};

export async function GET(request: Request): Promise<NextResponse> {
  const loaded = loadDemoPayer();
  const jobId = new URL(request.url).searchParams.get("jobId")?.trim() ?? "";
  if (!loaded.ok || !jobId) return NextResponse.json({ canRate: false });
  const receipt = receiptFor(request, loaded.payer.receiptSecret, jobId);
  return NextResponse.json(
    receipt.ok ? { canRate: true } : { canRate: false, reason: receipt.reason, message: RECEIPT_REFUSAL[receipt.reason] },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const loaded = loadDemoPayer();
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const { account, network, brokerUrl, receiptSecret } = loaded.payer;
  const guards = demoGuards(dailyCapUnits() ?? 1n);

  const perIp = guards.ratePerIp.take(clientIp(request));
  const global = perIp.ok ? guards.rateGlobal.take("*") : perIp;
  if (!perIp.ok || !global.ok) {
    const retryAfterMs = !perIp.ok ? perIp.retryAfterMs : !global.ok ? global.retryAfterMs : 60_000;
    return NextResponse.json(
      { error: "Too many demo ratings right now — wait a few minutes and try again.", code: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } },
    );
  }

  let body: { jobId?: unknown; value?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
  const value = typeof body.value === "number" ? body.value : Number.NaN;
  if (!jobId || !Number.isInteger(value) || value < 0 || value > 100) {
    return NextResponse.json({ error: "jobId and an integer value from 0 to 100 are required" }, { status: 400 });
  }

  // Proof this browser is the one the demo account paid for, recently.
  const receipt = receiptFor(request, receiptSecret, jobId);
  if (!receipt.ok) {
    return NextResponse.json({ error: RECEIPT_REFUSAL[receipt.reason], code: "demo_receipt_required" }, { status: 403 });
  }
  // And once: the broker keeps one rating per job, but a second signature
  // should never even be produced.
  if (!guards.rated.claim(jobId)) {
    return NextResponse.json({ error: "This job has already been rated.", code: "already_rated" }, { status: 409 });
  }

  let keepClaim = false;
  try {
    const [{ job }, info] = await Promise.all([
      brokerJson<{ job: PublicJob }>(`${brokerUrl}/api/jobs/${encodeURIComponent(jobId)}`),
      brokerJson<NetworkInfo>(`${brokerUrl}/api/network`).catch(() => null),
    ]);
    if (!sameAddress(job.payment?.payer, account.address)) {
      return NextResponse.json(
        { error: "Only the wallet that paid for a job can rate it, and the demo account didn't pay for this one." },
        { status: 403 },
      );
    }
    const rated = await rateJob({
      brokerUrl,
      jobId,
      value,
      network,
      ledger: info?.ledger?.address ?? null,
      signer: {
        address: account.address,
        signTypedData: (typedData) => {
          // From here a signature exists: never produce a second one for this job.
          keepClaim = true;
          return account.signTypedData(typedData);
        },
      },
    });
    return NextResponse.json({ ...rated, demo: true });
  } catch (err) {
    // The broker's wash-rating guard: pass its refusal through as-is.
    if (isRelatedWalletRefusal(err)) {
      return NextResponse.json({ error: err.message, code: err.code, trustCheck: err.trustCheck }, { status: 403 });
    }
    const status = err instanceof RatingError ? 409 : 502;
    return NextResponse.json({ error: errorMessage(err) }, { status });
  } finally {
    // Failed before anything was signed (broker unreachable, not the demo's
    // job): the rightful browser may try again.
    if (!keepClaim) guards.rated.release(jobId);
  }
}
