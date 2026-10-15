import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { readTxStatus } from "../src/tx-status.js";

const HASH = "0x579205fe205b8069682f147377efd6d9a6ca404e2c1c6ea95312853a921202d7" as const;

function client(opts: {
  receipt?: { blockNumber: bigint; status: "success" | "reverted" } | null;
  heads?: { latest: number; safe: number; finalized: number };
  pool?: unknown;
  poolError?: { code?: number; message: string };
}) {
  const heads = opts.heads ?? { latest: 100, safe: 99, finalized: 98 };
  return {
    getTransactionReceipt: async () => {
      if (!opts.receipt) throw new Error("not found");
      return opts.receipt;
    },
    getBlockNumber: async () => BigInt(heads.latest),
    getBlock: async ({ blockTag }: { blockTag: "safe" | "finalized" }) => ({ number: BigInt(heads[blockTag]) }),
    request: async () => {
      if (opts.poolError) throw Object.assign(new Error(opts.poolError.message), opts.poolError);
      return opts.pool;
    },
  } as unknown as PublicClient;
}

describe("readTxStatus", () => {
  it("places a mined transaction in Monad's consensus pipeline from the latest/safe/finalized heads", async () => {
    const at = async (block: number) => (await readTxStatus(client({ receipt: { blockNumber: BigInt(block), status: "success" } }), HASH)).state;
    expect(await at(100)).toBe("proposed");
    expect(await at(99)).toBe("voted");
    expect(await at(98)).toBe("finalized");
    expect(await at(50)).toBe("finalized");
    const reverted = await readTxStatus(client({ receipt: { blockNumber: 50n, status: "reverted" } }), HASH);
    expect(reverted).toMatchObject({ state: "reverted", blockNumber: 50, heads: { latest: 100, safe: 99, finalized: 98 } });
  });

  it("asks Monad's txpool about a transaction that isn't in a block yet", async () => {
    expect(await readTxStatus(client({ receipt: null, pool: { status: "Pending" } }), HASH)).toMatchObject({ state: "pending", pool: { status: "Pending" } });
    expect((await readTxStatus(client({ receipt: null, pool: { status: "Dropped", reason: "nonce too low" } }), HASH)).state).toBe("dropped");
    expect((await readTxStatus(client({ receipt: null, poolError: { code: -32000, message: "Unknown tx hash" } }), HASH)).state).toBe("unknown");
  });

  it("reads 'unknown' with no pool status on a node without the method (a local fork)", async () => {
    const s = await readTxStatus(client({ receipt: null, poolError: { code: -32601, message: "Method not found" } }), HASH);
    expect(s).toMatchObject({ state: "unknown", pool: null });
  });
});
