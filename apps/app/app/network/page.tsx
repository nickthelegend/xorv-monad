import { NetworkView } from "@/components/network-view";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Network" };
export const dynamic = "force-dynamic";

export default function NetworkPage() {
  return (
    <>
      <PageHeader
        title="Network"
        sub="Xorv keeps live state in memory and its record on Monad: payments as USDC transfers, receipts on the XorvLedger contract, reputation in ERC-8004. Everything here links to the chain, so you can check it yourself."
      />
      <NetworkView />
    </>
  );
}
