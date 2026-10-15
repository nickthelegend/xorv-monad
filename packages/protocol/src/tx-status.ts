/**
 * Where one transaction stands on Monad, from a single RPC.
 *
 * Monad's `eth_getTransactionByHash` never returns a pending transaction, so
 * "has the node even seen it?" comes from Monad's own `txpool_statusByHash`.
 * Once mined, the block tags carry Monad's consensus states: `latest` is the
 * newest Proposed block, `safe` the newest Voted one, `finalized` the newest
 * Finalized one (N, N−1 and N−2 in steady state). Comparing the
 * transaction's block with them says how far through consensus it is.
 *
 * On a local fork every tag is the same block and there is no txpool method,
 * so a mined transaction reads "finalized" and an unknown one "unknown"; the
 * caller labels those as the fork's.
 */
import type { Hex, PublicClient } from "viem";

export type TxState = "pending" | "proposed" | "voted" | "finalized" | "reverted" | "dropped" | "unknown";

export interface TxStatus {
  hash: string;
  state: TxState;
  blockNumber: number | null;
  /** What `txpool_statusByHash` said, for a transaction not yet in a block; null when the node has no such method. */
  pool: { status: string; reason?: string } | null;
  /** The heads it was compared with. */
  heads: { latest: number; safe: number | null; finalized: number | null } | null;
}

/** A txpool status string that means the transaction will never land. */
const GONE = /drop|evict|reject|invalid|replac|expire/i;

/** `txpool_statusByHash`, or null when the node doesn't have it; "unknown" when it has never seen the hash. */
export async function txpoolStatus(client: PublicClient, hash: Hex): Promise<{ status: string; reason?: string } | null> {
  try {
    const raw = (await client.request({ method: "txpool_statusByHash" as never, params: [hash] as never })) as
      | { status?: unknown; reason?: unknown }
      | string
      | null;
    if (raw && typeof raw === "object" && typeof raw.status === "string") {
      return typeof raw.reason === "string" ? { status: raw.status, reason: raw.reason } : { status: raw.status };
    }
    if (typeof raw === "string") return { status: raw };
    return { status: "unknown" };
  } catch (err) {
    const e = err as { code?: number; cause?: { code?: number }; message?: string; details?: string };
    const code = e?.code ?? e?.cause?.code;
    const text = `${e?.message ?? ""} ${e?.details ?? ""}`;
    if (code === -32601 || /method not found|not supported|does not exist/i.test(text)) return null;
    if (/unknown tx|not found|unknown transaction/i.test(text)) return { status: "unknown" };
    throw err;
  }
}

export async function readTxStatus(client: PublicClient, hash: Hex): Promise<TxStatus> {
  const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt) {
    const pool = await txpoolStatus(client, hash);
    const state: TxState = !pool || pool.status === "unknown" ? "unknown" : GONE.test(pool.status) ? "dropped" : "pending";
    return { hash, state, blockNumber: null, pool, heads: null };
  }
  const blockNumber = Number(receipt.blockNumber);
  const [latest, safe, finalized] = await Promise.all([
    client.getBlockNumber({ cacheTime: 0 }).then(Number),
    client.getBlock({ blockTag: "safe" }).then((b) => Number(b.number), () => null),
    client.getBlock({ blockTag: "finalized" }).then((b) => Number(b.number), () => null),
  ]);
  const state: TxState =
    receipt.status !== "success"
      ? "reverted"
      : finalized !== null && blockNumber <= finalized
        ? "finalized"
        : safe !== null && blockNumber <= safe
          ? "voted"
          : "proposed";
  return { hash, state, blockNumber, pool: null, heads: { latest, safe, finalized } };
}
