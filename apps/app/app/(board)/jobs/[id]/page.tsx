import { JobView } from "@/components/job-view";
import { PageHeader } from "@/components/ui";
import { api, type Job } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Fetched server-side so the page has content on first paint even if the
  // event stream never connects; the client takes over from there.
  let initial: Job | null = null;
  let loadError: "not_found" | "unreachable" | null = null;
  try {
    initial = await api.job(id);
  } catch (err) {
    // `get` throws "<path> → <status>" when the broker answered. A 404 is a
    // job that doesn't exist; anything else — a refused connection, a timeout,
    // the tunnel's own 502/530 — means we never heard from the broker at all.
    loadError = err instanceof Error && / → 404\b/.test(err.message) ? "not_found" : "unreachable";
  }

  return (
    <>
      <PageHeader title="Job" sub={initial?.providerLabel ? `Matched to ${initial.providerLabel}.` : undefined} />
      <JobView jobId={id} initial={initial} loadError={loadError} />
    </>
  );
}
