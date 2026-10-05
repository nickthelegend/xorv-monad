import { redirect } from "next/navigation";

/** Token links share the address view, which already shows name, symbol and supply. */
export default async function TokenPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  redirect(`/chain/address/${address}`);
}
