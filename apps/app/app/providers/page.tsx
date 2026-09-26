import { ProviderList } from "@/components/live-lists";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Providers" };

export default function ProvidersPage() {
  return (
    <>
      <PageHeader
        title="Providers"
        sub="Every node here is proving liveness by heartbeat, and every registration is recorded on a Hedera Consensus Service topic you can read yourself."
      />
      <ProviderList />
    </>
  );
}
