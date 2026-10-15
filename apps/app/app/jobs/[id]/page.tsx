import Link from "next/link";
import { JobView } from "@/components/job-view";
import { PageHeader } from "@/components/ui";
import { api, type Job } from "@/lib/api";

export const dynamic = "force-dynamic";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tx?: string | string[] }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);

  // Fetched server-side so the page has content on first paint even if the
  // event stream never connects; the client takes over from there.
  let initial: Job | null = null;
  try {
    initial = await api.job(id);
  } catch {
    initial = null;
  }

  // The composer passes the settlement hash its x402 client got back. It is a
  // public transaction id, not a secret; only a well-formed hash is linked.
  const tx = typeof query.tx === "string" && TX_HASH.test(query.tx) ? query.tx : null;

  return (
    <>
      <PageHeader title="Job" sub={initial?.providerLabel ? `Ran on ${initial.providerLabel}.` : undefined} />
      {initial?.agent ? (
        <p className="-mt-5 mb-6 text-[12.5px] text-fg-3">
          Bought by an AI agent:{" "}
          <Link href={`/agents/${initial.agent.session}`} className="text-fg-2 underline-offset-4 hover:text-fg hover:underline">
            {initial.agent.name}
          </Link>{" "}
          ({initial.agent.client.toUpperCase()} session)
        </p>
      ) : null}
      <JobView jobId={id} initial={initial} settlementTx={tx} />
    </>
  );
}
