"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatEther, type Hex, type PublicClient } from "viem";
import { ERC20_ABI, formatUsdc, publicClientFor, shortHex } from "@xorv/protocol/web";
import { api, formatAgo, type Job, type NetworkInfo } from "@/lib/api";
import { decodeLogs, type DecodedLog } from "@/lib/chain-viewer";
import { useNetworkInfo } from "@/lib/hooks";
import { IS_LOCAL_CHAIN, NETWORK, NETWORK_LABEL, PUBLIC_RPC_URL } from "@/lib/network";
import { Empty, Panel, Row, Skeleton } from "@/components/ui";
import { TxBadge } from "@/components/tx-badge";
import { cn } from "@/lib/utils";

/**
 * Xorv's own chain viewer. It reads the app's RPC, so it shows a local fork's
 * transactions, which no public explorer has ever seen. On a Monad network the
 * app links to MonadVision instead, but these pages work there too.
 */

function useClient(): PublicClient {
  return useMemo(() => publicClientFor(NETWORK, { rpcUrl: PUBLIC_RPC_URL }) as unknown as PublicClient, []);
}

/** Known addresses → names, from the broker's own description of its contracts. */
function labelsFrom(info: NetworkInfo | null): Record<string, string> {
  if (!info) return {};
  const out: Record<string, string> = {};
  const add = (address: string | null | undefined, name: string) => {
    if (address) out[address.toLowerCase()] = name;
  };
  add(info.usdc?.address, "USDC");
  add(info.escrow?.address, "XorvEscrow");
  add(info.ledger?.address, "XorvLedger");
  add(info.erc8004?.identity, "ERC-8004 identity");
  add(info.erc8004?.reputation, "ERC-8004 reputation");
  add(info.facilitator?.address, "Xorv facilitator");
  add((info as NetworkInfo & { operator?: { address: string } | null }).operator?.address, "Xorv operator");
  return out;
}

function Addr({ address, labels }: { address: string | null | undefined; labels: Record<string, string> }) {
  if (!address) return <>—</>;
  const name = labels[address.toLowerCase()];
  return (
    <Link href={`/chain/address/${address}`} className="mono underline-offset-4 hover:text-fg hover:underline">
      {name ? `${name} · ` : ""}
      {shortHex(address)}
    </Link>
  );
}

function Where() {
  return (
    <p className="mb-5 text-[12px] text-fg-4">
      Read from {IS_LOCAL_CHAIN ? "this deployment's local fork of Monad testnet" : NETWORK_LABEL} at{" "}
      <span className="mono">{PUBLIC_RPC_URL}</span>
      {IS_LOCAL_CHAIN ? ". No public explorer has these transactions; this is the only place to see them." : "."}
    </p>
  );
}

// ---------------------------------------------------------------------------

export function TxView({ hash }: { hash: string }) {
  const client = useClient();
  const info = useNetworkInfo();
  const labels = labelsFrom(info);
  const [data, setData] = useState<{
    tx: Awaited<ReturnType<PublicClient["getTransaction"]>>;
    receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>> | null;
    timestamp: number | null;
  } | null>(null);
  const [missing, setMissing] = useState(false);
  const valid = /^0x[0-9a-fA-F]{64}$/.test(hash);

  useEffect(() => {
    if (!valid) return;
    let alive = true;
    void (async () => {
      try {
        const tx = await client.getTransaction({ hash: hash as Hex });
        const receipt = await client.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
        const block = receipt ? await client.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null) : null;
        if (alive) setData({ tx, receipt, timestamp: block ? Number(block.timestamp) * 1000 : null });
      } catch {
        if (alive) setMissing(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, hash, valid]);

  if (!valid) return <Empty title="Not a transaction hash" hint="A transaction hash is 0x followed by 64 hex characters." />;
  if (missing) return <Empty title="Transaction not found" hint="Not a transaction this chain knows. On a fork, only transactions made since it started exist." />;
  if (!data) return <Skeleton rows={3} />;
  const { tx, receipt } = data;
  const logs: DecodedLog[] = receipt ? decodeLogs(receipt.logs, labels) : [];
  const charged = receipt ? receipt.gasUsed * receipt.effectiveGasPrice : null;
  const limitCost = receipt ? tx.gas * receipt.effectiveGasPrice : null;

  return (
    <div className="space-y-6">
      <Where />
      <Panel className="p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[13px] font-medium text-fg">Transaction</h2>
          <span className="text-[12px]">
            <span className={receipt?.status === "success" ? "text-live" : receipt ? "text-fail" : "text-fg-3"}>
              {receipt ? receipt.status : "pending"}
            </span>
            <TxBadge hash={hash} />
          </span>
        </div>
        <p className="mono mt-2 break-all text-[11.5px] text-fg-3">{hash}</p>
        <div className="mt-3 border-t border-[var(--line)] pt-1">
          <Row label="block">
            {receipt ? <Link href={`/chain/block/${receipt.blockNumber}`} className="mono hover:text-fg hover:underline">#{receipt.blockNumber.toString()}</Link> : "—"}
          </Row>
          {data.timestamp ? <Row label="time">{new Date(data.timestamp).toLocaleString()}</Row> : null}
          <Row label="from"><Addr address={tx.from} labels={labels} /></Row>
          <Row label="to"><Addr address={tx.to} labels={labels} /></Row>
          <Row label="value"><span className="tnum">{formatEther(tx.value)} MON</span></Row>
          <Row label="gas">
            <span className="tnum">
              {receipt ? `${receipt.gasUsed.toLocaleString("en-US")} used of ${tx.gas.toLocaleString("en-US")} limit` : `${tx.gas.toLocaleString("en-US")} limit`}
            </span>
          </Row>
          {charged !== null && limitCost !== null ? (
            <Row label="fee">
              <span className="tnum">
                {IS_LOCAL_CHAIN
                  ? `${formatEther(charged)} MON (anvil charges gas used; Monad would charge the limit: ${formatEther(limitCost)} MON)`
                  : `${formatEther(limitCost)} MON (Monad charges the gas limit)`}
              </span>
            </Row>
          ) : null}
        </div>
      </Panel>

      <section>
        <h2 className="mb-2.5 text-[13px] font-medium text-fg">Events ({logs.length})</h2>
        {logs.length === 0 ? (
          <p className="text-[12.5px] text-fg-4">No events.</p>
        ) : (
          <ul className="space-y-2">
            {logs.map((log) => (
              <li key={log.index}>
                <Panel className="p-4">
                  <p className="text-[12.5px] text-fg">
                    {log.event ?? "unknown event"}{" "}
                    <span className="text-fg-4">
                      · <Addr address={log.address} labels={labels} />
                    </span>
                  </p>
                  {Object.keys(log.args).length ? (
                    <dl className="mono mt-2 space-y-0.5 text-[11px]">
                      {Object.entries(log.args).map(([k, v]) => (
                        <div key={k} className="flex gap-2">
                          <dt className="shrink-0 text-fg-4">{k}</dt>
                          <dd className="min-w-0 break-all text-fg-2">
                            {/^0x[0-9a-fA-F]{40}$/.test(v) ? <Addr address={v} labels={labels} /> : v}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {log.raw ? <p className="mono mt-2 break-all text-[10.5px] text-fg-4">topic0 {log.raw.topics[0]}</p> : null}
                </Panel>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function AddressView({ address }: { address: string }) {
  const client = useClient();
  const info = useNetworkInfo();
  const labels = labelsFrom(info);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address);
  const [state, setState] = useState<{ mon: bigint; usdc: bigint | null; code: boolean } | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);

  const usdcAddress = info?.usdc?.address ?? null;
  useEffect(() => {
    if (!valid) return;
    let alive = true;
    const a = address as Hex;
    void Promise.all([
      client.getBalance({ address: a }),
      client.getCode({ address: a }).then((c) => Boolean(c && c !== "0x")),
      usdcAddress
        ? (client.readContract({ address: usdcAddress as Hex, abi: ERC20_ABI, functionName: "balanceOf", args: [a] }) as Promise<bigint>).catch(() => null)
        : Promise.resolve(null),
    ]).then(([mon, code, usdc]) => {
      if (alive) setState({ mon, usdc, code });
    });
    return () => {
      alive = false;
    };
  }, [address, client, usdcAddress, valid]);

  useEffect(() => {
    if (!valid) return;
    let alive = true;
    void api.jobs(500).then(
      (all) => alive && setJobs(all.filter((j) => [j.payment?.payer, j.payment?.payTo, j.payment?.escrow?.address].some((x) => x?.toLowerCase() === address.toLowerCase()))),
      () => alive && setJobs([]),
    );
    return () => {
      alive = false;
    };
  }, [address, valid]);

  if (!valid) return <Empty title="Not an address" hint="An address is 0x followed by 40 hex characters." />;
  const name = labels[address.toLowerCase()];

  return (
    <div className="space-y-6">
      <Where />
      <Panel className="p-5">
        <h2 className="text-[13px] font-medium text-fg">{name ?? (state?.code ? "Contract" : "Account")}</h2>
        <p className="mono mt-2 break-all text-[11.5px] text-fg-3">{address}</p>
        <div className="mt-3 border-t border-[var(--line)] pt-1">
          <Row label="kind">{state ? (state.code ? "contract" : "account (EOA)") : "…"}</Row>
          <Row label="MON">{state ? <span className="tnum">{formatEther(state.mon)}</span> : "…"}</Row>
          <Row label="USDC">{state && state.usdc !== null ? <span className="tnum">{formatUsdc(state.usdc)}</span> : "—"}</Row>
        </div>
      </Panel>
      <section>
        <h2 className="mb-2.5 text-[13px] font-medium text-fg">Xorv jobs that paid from or to it</h2>
        {jobs === null ? (
          <Skeleton rows={2} />
        ) : jobs.length === 0 ? (
          <p className="text-[12.5px] text-fg-4">None in the broker&rsquo;s recent jobs.</p>
        ) : (
          <ul className="border-t border-[var(--line)]">
            {jobs.slice(0, 25).map((j) => (
              <li key={j.id} className="flex items-baseline justify-between gap-3 border-b border-[var(--line)] py-2.5 text-[12.5px]">
                <Link href={`/jobs/${j.id}`} className="min-w-0 truncate text-fg-2 hover:text-fg">
                  {j.private ? "Private job" : j.prompt}
                </Link>
                <span className="shrink-0 text-fg-4">
                  {j.payment?.payer?.toLowerCase() === address.toLowerCase() ? "paid" : "received"} · {formatAgo(j.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function BlockView({ number }: { number: string }) {
  const client = useClient();
  const [block, setBlock] = useState<Awaited<ReturnType<PublicClient["getBlock"]>> | null>(null);
  const [missing, setMissing] = useState(false);
  const valid = /^\d+$/.test(number);

  useEffect(() => {
    if (!valid) return;
    let alive = true;
    client.getBlock({ blockNumber: BigInt(number) }).then(
      (b) => alive && setBlock(b),
      () => alive && setMissing(true),
    );
    return () => {
      alive = false;
    };
  }, [client, number, valid]);

  if (!valid) return <Empty title="Not a block number" />;
  if (missing) return <Empty title="Block not found" hint="Not a block this chain has." />;
  if (!block) return <Skeleton rows={2} />;
  return (
    <div className="space-y-6">
      <Where />
      <Panel className="p-5">
        <h2 className="text-[13px] font-medium text-fg">Block #{block.number?.toString()}</h2>
        <div className="mt-3 border-t border-[var(--line)] pt-1">
          <Row label="hash"><span className="mono">{shortHex(block.hash ?? "")}</span></Row>
          <Row label="time">{new Date(Number(block.timestamp) * 1000).toLocaleString()}</Row>
          <Row label="gas used"><span className="tnum">{block.gasUsed.toLocaleString("en-US")} of {block.gasLimit.toLocaleString("en-US")}</span></Row>
          <Row label="transactions"><span className="tnum">{block.transactions.length}</span></Row>
        </div>
      </Panel>
      {block.transactions.length ? (
        <ul className="border-t border-[var(--line)]">
          {(block.transactions as Hex[]).map((h) => (
            <li key={h} className="border-b border-[var(--line)] py-2">
              <Link href={`/chain/tx/${h}`} className="mono text-[12px] text-fg-2 hover:text-fg hover:underline">
                {h}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The viewer's front page: look up a hash, an address or a block number. */
export function ChainLookup() {
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const go = (): void => {
    const v = q.trim();
    const path = /^0x[0-9a-fA-F]{64}$/.test(v)
      ? `/chain/tx/${v}`
      : /^0x[0-9a-fA-F]{40}$/.test(v)
        ? `/chain/address/${v}`
        : /^\d+$/.test(v)
          ? `/chain/block/${v}`
          : null;
    if (!path) {
      setError("A transaction hash (0x + 64 hex), an address (0x + 40 hex) or a block number.");
      return;
    }
    window.location.assign(path);
  };
  return (
    <div className="space-y-4">
      <Where />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
        className="flex gap-2"
      >
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setError(null);
          }}
          placeholder="Transaction hash, address or block number"
          aria-label="Look up on chain"
          className={cn("mono w-full rounded-lg border bg-surface px-3.5 py-2.5 text-[13px] text-fg placeholder:text-fg-4 focus:outline-none", error ? "border-fail/50" : "border-[var(--line)] focus:border-[var(--line-3)]")}
        />
      </form>
      {error ? <p className="text-[12px] text-fail">{error}</p> : null}
    </div>
  );
}
