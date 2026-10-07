import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { MULTICALL3, readBatch } from "../src/evm.js";
import { viemChain } from "../src/chains.js";

const call = (functionName: string) => ({ address: "0x534b2f3A21130d7a60830c2Df862319e593943A3" as const, abi: [], functionName });

function client(opts: { multicall3: boolean; multicallFails?: boolean }) {
  const seen = { multicall: 0, reads: 0 };
  const c = {
    chain: opts.multicall3 ? { contracts: { multicall3: { address: MULTICALL3 } } } : { contracts: {} },
    multicall: async ({ contracts }: { contracts: unknown[] }) => {
      seen.multicall += 1;
      if (opts.multicallFails) throw new Error("returned no data");
      return contracts.map((_, i) => `batched-${i}`);
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      seen.reads += 1;
      return `single-${functionName}`;
    },
  } as unknown as PublicClient;
  return { c, seen };
}

describe("readBatch", () => {
  it("sends several reads as one Multicall3 eth_call", async () => {
    const { c, seen } = client({ multicall3: true });
    expect(await readBatch(c, [call("a"), call("b"), call("c"), call("d")])).toEqual(["batched-0", "batched-1", "batched-2", "batched-3"]);
    expect(seen).toEqual({ multicall: 1, reads: 0 });
  });

  it("reads one by one on a chain without Multicall3, or when the batch fails", async () => {
    const bare = client({ multicall3: false });
    expect(await readBatch(bare.c, [call("a"), call("b")])).toEqual(["single-a", "single-b"]);
    expect(bare.seen).toEqual({ multicall: 0, reads: 2 });
    const broken = client({ multicall3: true, multicallFails: true });
    expect(await readBatch(broken.c, [call("a"), call("b")])).toEqual(["single-a", "single-b"]);
  });

  it("knows Multicall3's canonical address on Monad, without viem's pre-reset creation block", () => {
    const mc = viemChain("eip155:10143").contracts?.multicall3 as { address: string; blockCreated?: number };
    expect(mc.address).toBe(MULTICALL3);
    expect(mc.blockCreated).toBeUndefined();
  });
});
