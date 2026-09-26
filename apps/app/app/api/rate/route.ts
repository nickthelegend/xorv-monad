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
 * someone else's purchase is not something a shared key should ever do.
 */

import { NextResponse } from "next/server";
import type { NetworkInfo, PublicJob } from "@xorv/protocol/web";
import { sameAddress } from "@xorv/protocol/web";
import { loadDemoPayer } from "@/lib/server/demo-payer";
import { RatingError, rateJob } from "@/lib/rating";
import { errorMessage } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function brokerJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

export async function POST(request: Request): Promise<NextResponse> {
  const loaded = loadDemoPayer();
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  const { account, network, brokerUrl } = loaded.payer;

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
    const receipt = await rateJob({
      brokerUrl,
      jobId,
      value,
      network,
      ledger: info?.ledger?.address ?? null,
      signer: account,
    });
    return NextResponse.json({ ...receipt, demo: true });
  } catch (err) {
    const status = err instanceof RatingError ? 409 : 502;
    return NextResponse.json({ error: errorMessage(err) }, { status });
  }
}
