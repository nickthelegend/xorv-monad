import { NetworkView } from "@/components/network-view";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Network" };
export const dynamic = "force-dynamic";

export default function NetworkPage() {
  return (
    <>
      <PageHeader
        title="Network"
        sub="Xorv keeps its operational state in memory and its record on Hedera. These are the topics anyone can read to check what the broker says is true."
      />
      <NetworkView />
    </>
  );
}
