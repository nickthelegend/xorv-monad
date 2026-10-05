import { Empty, PageHeader, Panel, Row } from "@/components/ui";
import { readAddress } from "@/lib/chain-reader";
import { XORV_CHAIN } from "@/lib/chains";

export const dynamic = "force-dynamic";

/** What an address is and holds, read from the node: contract or account, MON, each stablecoin. */
export default async function AddressPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return <Empty title="Not an address" hint="Expected 0x followed by 40 hex characters." />;
  }
  let info: Awaited<ReturnType<typeof readAddress>>;
  try {
    info = await readAddress(address as `0x${string}`);
  } catch {
    return <Empty title="Can't reach the chain" hint={`The ${XORV_CHAIN.name} RPC didn't answer.`} />;
  }
  return (
    <>
      <PageHeader
        title={info.token ? `${info.token.name} (${info.token.symbol})` : info.isContract ? "Contract" : "Account"}
        sub={`${XORV_CHAIN.name} · read directly from the node`}
      />
      <Panel className="max-w-2xl p-4">
        <p className="mono break-all text-[12px] text-fg-2">{info.address}</p>
        <div className="mt-3 border-t border-[var(--line)] pt-1">
          <Row label="kind">{info.isContract ? `contract · ${info.codeBytes} bytes` : "account"}</Row>
          <Row label="MON">
            <span className="tnum">{info.eth}</span>
          </Row>
          {info.balances.map((b) => (
            <Row key={b.symbol} label={b.symbol}>
              <span className="tnum">{b.amount}</span>
            </Row>
          ))}
          {info.token ? (
            <Row label="total supply">
              <span className="tnum">
                {info.token.totalSupply} {info.token.symbol}
              </span>
            </Row>
          ) : null}
        </div>
      </Panel>
    </>
  );
}
