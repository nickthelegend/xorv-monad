import { NetworkView } from "@/components/network-view";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Network" };
export const dynamic = "force-dynamic";

export default function NetworkPage() {
  return (
    <>
      <PageHeader
        title="Network"
        sub="The broker keeps its working state in its own database. What it claims can be checked on Monad instead: every payment is an on-chain transfer, and the contracts this deployment uses are listed below — anyone can read them."
      />
      <NetworkView />
    </>
  );
}
