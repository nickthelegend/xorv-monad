import { ChainLookup } from "@/components/chain-view";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Chain" };

export default function ChainPage() {
  return (
    <>
      <PageHeader title="Chain" sub="Xorv's own view of the chain it settles on: every transaction, address and block, decoded against Xorv's contracts." />
      <ChainLookup />
    </>
  );
}
