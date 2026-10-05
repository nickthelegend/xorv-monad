import Link from "next/link";
import { redirect } from "next/navigation";
import { Empty, PageHeader, Panel, Row } from "@/components/ui";
import { chainClient } from "@/lib/chain-reader";
import { XORV_CHAIN } from "@/lib/chains";

export const dynamic = "force-dynamic";
export const metadata = { title: "Chain" };

/** The deployment's contracts, as the app was built against them. */
const CONTRACTS: Array<[string, string | undefined]> = [
  ["XorvEscrow", process.env.NEXT_PUBLIC_XORV_ESCROW_ADDRESS],
  ["XorvRegistry", process.env.NEXT_PUBLIC_XORV_REGISTRY_ADDRESS],
  ["XorvLog", process.env.NEXT_PUBLIC_XORV_LOG_ADDRESS],
  [process.env.NEXT_PUBLIC_XORV_STABLECOIN_SYMBOL?.trim() || "Stablecoin", process.env.NEXT_PUBLIC_XORV_STABLECOIN],
];

/**
 * The chain viewer's front page: where the chain is, what this deployment runs
 * on it, and a lookup. On a local node there is no public explorer, so this is
 * the one; on Monad testnet the links go to Monadscan instead.
 */
export default async function ChainPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = (await searchParams).q?.trim() ?? "";
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) redirect(`/chain/tx/${q}`);
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) redirect(`/chain/address/${q}`);

  let head: { number: bigint; timestamp: bigint } | null = null;
  try {
    head = await chainClient.getBlock();
  } catch {
    return <Empty title="Can't reach the chain" hint={`The ${XORV_CHAIN.name} RPC didn't answer.`} />;
  }
  const contracts = CONTRACTS.filter((c): c is [string, string] => Boolean(c[1]?.trim()));

  return (
    <>
      <PageHeader title="Chain" sub={`${XORV_CHAIN.name} · read directly from the node`} />
      <div className="max-w-2xl space-y-6">
        <Panel className="p-4">
          <form action="/chain" className="flex gap-2">
            <label htmlFor="chain-q" className="sr-only">
              Transaction hash or address
            </label>
            <input
              id="chain-q"
              name="q"
              defaultValue={q}
              placeholder="Transaction hash or address"
              className="mono min-w-0 flex-1 rounded-md border border-[var(--line)] bg-transparent px-3 py-2 text-[12.5px] text-fg outline-none focus:border-[var(--line-2)]"
            />
            <button type="submit" className="rounded-md border border-[var(--line)] px-3 py-2 text-[12.5px] text-fg-2 hover:text-fg">
              Look up
            </button>
          </form>
          {q ? (
            <p role="alert" className="mt-2 text-[12px] text-fail">
              &ldquo;{q.slice(0, 80)}&rdquo; is neither a transaction hash (0x + 64 hex) nor an address (0x + 40 hex).
            </p>
          ) : null}
          <div className="mt-3 border-t border-[var(--line)] pt-1">
            <Row label="chain id">
              <span className="tnum">{XORV_CHAIN.id}</span>
            </Row>
            <Row label="latest block">
              <span className="tnum">{head.number.toString()}</span>
            </Row>
            <Row label="block time">{new Date(Number(head.timestamp) * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC</Row>
          </div>
        </Panel>
        <Panel className="p-4">
          <h2 className="text-[13px] font-medium text-fg">This deployment</h2>
          {contracts.length ? (
            <div className="mt-2 border-t border-[var(--line)] pt-1">
              {contracts.map(([name, address]) => (
                <Row key={name} label={name}>
                  <Link href={`/chain/address/${address}`} className="mono underline-offset-4 hover:text-fg hover:underline">
                    {address}
                  </Link>
                </Row>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[12.5px] text-fg-3">No contract addresses were configured when this app was built.</p>
          )}
        </Panel>
      </div>
    </>
  );
}
