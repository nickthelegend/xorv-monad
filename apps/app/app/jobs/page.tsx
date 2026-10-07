import { JobBrowser } from "@/components/job-browser";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Browse jobs" };

export default function BrowseJobsPage() {
  return (
    <>
      <PageHeader
        title="Browse jobs"
        sub="Every job on the network, with how its money moved: released to the provider, refunded to the buyer, or still held in escrow."
      />
      <JobBrowser />
    </>
  );
}
