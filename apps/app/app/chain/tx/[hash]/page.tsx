import { TxView } from "@/components/chain-view";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Transaction" };

export default async function TxPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  return (
    <>
      <PageHeader title="Transaction" />
      <TxView hash={hash} />
    </>
  );
}
