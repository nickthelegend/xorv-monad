import Link from "next/link";
import { Empty, PageHeader, Panel, Row } from "@/components/ui";
import { readTransaction } from "@/lib/chain-reader";
import { XORV_CHAIN } from "@/lib/chains";

export const dynamic = "force-dynamic";

/**
 * One transaction, read from the node and decoded against every contract the
 * stack deploys — the escrow's JobFunded / JobReleased, the registry's
 * OutcomeRecorded, token transfers. The links a job page shows land here when
 * the chain has no public explorer.
 */
export default async function TxPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return <Empty title="Not a transaction hash" hint="Expected 0x followed by 64 hex characters." />;
  }
  let tx: Awaited<ReturnType<typeof readTransaction>>;
  try {
    tx = await readTransaction(hash as `0x${string}`);
  } catch {
    return <Empty title="Transaction not found" hint={`${XORV_CHAIN.name} has no transaction ${hash}.`} />;
  }
  return (
    <>
      <PageHeader title="Transaction" sub={`${XORV_CHAIN.name} · read directly from the node`} />
      {/* min-w-0 on the panels: a grid item won't shrink below its content by
          default, and an address in a truncating row is wide content — the
          page scrolled sideways on a phone. */}
      <div className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
        <Panel className="min-w-0 p-4">
          <p className="mono break-all text-[12px] text-fg-2">{tx.hash}</p>
          <div className="mt-3 border-t border-[var(--line)] pt-1">
            <Row label="status">
              <span className={tx.status === "success" ? "text-live" : "text-fail"}>{tx.status}</span>
            </Row>
            <Row label="block">
              <span className="tnum">{tx.blockNumber}</span>
            </Row>
            <Row label="time">{new Date(tx.timestamp).toISOString().replace("T", " ").slice(0, 19)} UTC</Row>
            <Row label="from">
              <AddressLink address={tx.from} />
            </Row>
            <Row label={tx.created ? "created" : "to"}>
              {tx.to ? <AddressLink address={tx.to} /> : "—"}
            </Row>
            <Row label="value">
              <span className="tnum">{tx.value} ETH</span>
            </Row>
            <Row label="gas used">
              <span className="tnum">{tx.gasUsed}</span>
            </Row>
          </div>
        </Panel>
        <Panel className="min-w-0 p-4">
          <h2 className="text-[13px] font-medium text-fg">Events ({tx.events.length})</h2>
          <ul className="mt-3 space-y-3">
            {tx.events.map((e, i) => (
              <li key={i} className="rounded-lg border border-[var(--line)] p-3">
                <p className="text-[13px] text-fg">
                  {e.source}.<span className="font-medium">{e.name}</span>
                </p>
                <p className="mono mt-0.5 truncate text-[11px] text-fg-4">
                  <AddressLink address={e.address} />
                </p>
                {e.args.length ? (
                  <dl className="mt-2 space-y-1">
                    {e.args.map(([k, v]) => (
                      <div key={k} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2 text-[11.5px]">
                        <dt className="text-fg-4">{k}</dt>
                        <dd className="mono break-all text-fg-2">{v}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}

function AddressLink({ address }: { address: string }) {
  return (
    <Link href={`/chain/address/${address}`} className="mono break-all underline-offset-4 hover:underline">
      {address}
    </Link>
  );
}
