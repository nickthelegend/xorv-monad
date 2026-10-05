import { ProviderList } from "@/components/live-lists";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Providers" };

export default function ProvidersPage() {
  return (
    <>
      <PageHeader
        title="Providers"
        sub="Every node here is proving liveness by heartbeat. Where this deployment has an audit log, each registration is also written to it on chain — see Network."
      />
      <ProviderList />
    </>
  );
}
