import { ProviderView } from "@/components/provider-view";
import { PageHeader } from "@/components/ui";
import { api, type Provider } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function ProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Fetched server-side so a visitor arriving from an agent file sees the
  // provider on first paint; the client keeps it fresh from there.
  let initial: Provider | null = null;
  try {
    initial = await api.provider(id);
  } catch {
    initial = null;
  }

  return (
    <>
      <PageHeader
        title={initial?.label ?? "Provider"}
        sub={
          initial
            ? `Sells ${initial.capabilities.map((c) => c.displayName).join(", ") || "AI capacity"} on Xorv, paid per job in USDC over x402 on Monad.`
            : undefined
        }
      />
      <ProviderView id={id} initial={initial} />
    </>
  );
}
