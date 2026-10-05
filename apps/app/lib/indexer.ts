/**
 * Reads from the Envio HyperIndex GraphQL API (`indexer/`).
 *
 * Monad's public RPC answers at most 100 blocks per eth_getLogs, so history —
 * every job, every provider's on-chain record, daily totals — comes from the
 * index, not the chain directly. Optional: without NEXT_PUBLIC_XORV_INDEXER_URL
 * the app simply doesn't show the indexed history.
 */

export const INDEXER_URL = process.env.NEXT_PUBLIC_XORV_INDEXER_URL?.trim().replace(/\/+$/, "") || null;

/** Hasura serializes BigInt (and numeric) columns as strings. */
type Num = string | number;

export interface IndexedNetwork {
  jobsFunded: number;
  jobsReleased: number;
  jobsRefunded: number;
  refundsAtFault: number;
  volume: Num;
  paidToProviders: Num;
  refunded: Num;
  providers: number;
  buyers: number;
  receipts: number;
  meanSecondsToSettle: Num;
  settledCount: number;
}

export interface IndexedProvider {
  id: string;
  registered: boolean;
  active: boolean;
  completed: Num;
  failed: Num;
  scoreBps: number;
  earned: Num;
  jobsAssigned: number;
  refundsAtFault: number;
  lastHeartbeat: Num | null;
}

export interface IndexedDay {
  day: string;
  jobsFunded: number;
  jobsReleased: number;
  jobsRefunded: number;
  volume: Num;
  activeProviders: number;
}

export interface IndexedHistory {
  network: IndexedNetwork | null;
  providers: IndexedProvider[];
  days: IndexedDay[];
}

const HISTORY = `{
  Network { jobsFunded jobsReleased jobsRefunded refundsAtFault volume paidToProviders refunded providers buyers receipts meanSecondsToSettle settledCount }
  Provider(order_by: [{ scoreBps: desc }, { earned: desc }], limit: 10) { id registered active completed failed scoreBps earned jobsAssigned refundsAtFault lastHeartbeat }
  DailyStat(order_by: { day: desc }, limit: 7) { day jobsFunded jobsReleased jobsRefunded volume activeProviders }
}`;

export async function fetchHistory(signal?: AbortSignal): Promise<IndexedHistory> {
  if (!INDEXER_URL) throw new Error("no indexer configured");
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: HISTORY }),
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`indexer answered ${res.status}`);
  const body = (await res.json()) as {
    data?: { Network?: IndexedNetwork[]; Provider?: IndexedProvider[]; DailyStat?: IndexedDay[] };
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) throw new Error(body.errors[0]?.message ?? "indexer query failed");
  return {
    network: body.data?.Network?.[0] ?? null,
    providers: body.data?.Provider ?? [],
    days: body.data?.DailyStat ?? [],
  };
}

/** Stablecoin units (6 decimals) as dollars. */
export function unitsToUsd(units: Num): string {
  const n = Number(units) / 1_000_000;
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`;
}
