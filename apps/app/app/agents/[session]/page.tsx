import { AgentView } from "@/components/agent-view";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Agent session" };

export default async function AgentSessionPage({ params }: { params: Promise<{ session: string }> }) {
  const { session } = await params;
  return (
    <>
      <PageHeader title="Agent session" />
      <AgentView session={session} />
    </>
  );
}
