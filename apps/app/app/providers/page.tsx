import { ProviderList } from "@/components/live-lists";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Providers" };

export default function ProvidersPage() {
  return (
    <>
      <PageHeader
        title="Providers"
        sub="Every node here proves liveness by heartbeat, is registered on the XorvLedger contract, and earns its reputation as ERC-8004 feedback from the buyers it served."
      />
      <ProviderList detailed />
    </>
  );
}
