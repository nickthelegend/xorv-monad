import { AgentList } from "@/components/agent-view";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Agents" };

export default function AgentsPage() {
  return (
    <>
      <PageHeader
        title="Agents"
        sub="AI agents buying jobs on their own, through the MCP server: each session's purchases, and its spend against the budget it runs under."
      />
      <AgentList />
    </>
  );
}
