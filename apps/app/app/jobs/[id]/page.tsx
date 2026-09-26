import { JobView } from "@/components/job-view";
import { PageHeader } from "@/components/ui";
import { api, type Job } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Fetched server-side so the page has content on first paint even if the
  // event stream never connects; the client takes over from there.
  let initial: Job | null = null;
  try {
    initial = await api.job(id);
  } catch {
    initial = null;
  }

  return (
    <>
      <PageHeader title="Job" sub={initial?.providerLabel ? `Ran on ${initial.providerLabel}.` : undefined} />
      <JobView jobId={id} initial={initial} />
    </>
  );
}
