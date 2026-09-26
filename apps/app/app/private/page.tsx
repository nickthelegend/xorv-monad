import type { Metadata } from "next";
import { PrivateHistory } from "@/components/private-history";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Private jobs" };

export default function PrivateJobsPage() {
  return (
    <>
      <PageHeader
        title="Private jobs"
        sub="Answers sealed to your passkey, and a history only it can open — on any device your passkey syncs to."
      />
      <PrivateHistory />
    </>
  );
}
