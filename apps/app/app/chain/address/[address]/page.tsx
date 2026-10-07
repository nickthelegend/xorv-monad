import { AddressView } from "@/components/chain-view";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Address" };

export default async function AddressPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return (
    <>
      <PageHeader title="Address" />
      <AddressView address={address} />
    </>
  );
}
