import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { STAKING_PRECOMPILE, readStaking } from "../src/staking.js";

function client() {
  const calls: string[] = [];
  const c = {
    readContract: async ({ address, functionName, args }: { address: string; functionName: string; args: unknown[] }) => {
      expect(address).toBe(STAKING_PRECOMPILE);
      calls.push(`${functionName}(${args.join(",")})`);
      switch (functionName) {
        case "getEpoch":
          return [1381n, false];
        case "getProposerValId":
          return 172n;
        case "getConsensusValidatorSet":
          // Two pages: 150 then 49 validators.
          return args[0] === 0 ? [false, 150, Array.from({ length: 150 }, (_, i) => BigInt(i))] : [true, 199, Array.from({ length: 49 }, (_, i) => BigInt(i))];
        case "getValidator":
          return ["0xbB8EE00846BF924F34Ba4f8a86d690Ff11Eed7cA", 0n, 11_000_000n * 10n ** 18n, 0n, 10n ** 17n, 0n, 11_000_000n * 10n ** 18n, 0n, 0n, 0n, "0x", "0x"];
        default:
          throw new Error(functionName);
      }
    },
  } as unknown as PublicClient;
  return { c, calls };
}

describe("readStaking", () => {
  it("reads the epoch, the current proposer's stake and commission, and the consensus set size from 0x1000", async () => {
    const { c, calls } = client();
    const s = await readStaking(c);
    expect(s).toMatchObject({
      epoch: 1381,
      inEpochDelayPeriod: false,
      consensusSetSize: 199,
      proposer: { id: 172, stake: (11_000_000n * 10n ** 18n).toString(), commission: (10n ** 17n).toString() },
    });
    expect(calls).toContain("getValidator(172)");
    expect(calls).toContain("getConsensusValidatorSet(150)");
  });
});
