import { BlockView } from "@/components/chain-view";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Block" };

export default async function BlockPage({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  return (
    <>
      <PageHeader title="Block" />
      <BlockView number={number} />
    </>
  );
}
