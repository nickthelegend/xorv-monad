/**
 * The ledger writer's queue: batching, splitting and fallbacks.
 *
 * The broadcast step is replaced (`submit`), so nothing here touches an RPC —
 * what is under test is which receipts go out together, what happens when a
 * batch reverts, and that failures stay out of the request path.
 */

import { describe, expect, it, vi } from "vitest";
import { ContractFunctionRevertedError, encodeErrorResult, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NO_AGENT, XORV_LEDGER_ABI, jobIdHash, providerIdHash, type JobReceiptStruct } from "@xorv/protocol";
import {
  LedgerWriter,
  UnconfirmedWrite,
  revertName,
  type LedgerReads,
  type PublishResult,
  type ReceiptInput,
} from "../src/chain.js";

const LEDGER = "0x00000000000000000000000000000000000000Aa" as const;
const PAYEE = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";

type Call = { fn: string; args: readonly unknown[] };

function writer(opts: {
  batchMs?: number;
  batchMax?: number;
  submit?: (fn: string, args: readonly unknown[]) => Promise<PublishResult>;
  ledger?: boolean;
  account?: boolean;
  reads?: LedgerReads;
}) {
  const calls: Call[] = [];
  let n = 0;
  const submit =
    opts.submit ??
    (async (fn: string, args: readonly unknown[]): Promise<PublishResult> => {
      n += 1;
      return { contract: LEDGER, txHash: `0x${String(n).padStart(64, "0")}`, explorerUrl: "x", blockNumber: "1" };
    });
  const logs: string[] = [];
  const w = new LedgerWriter({
    network: "eip155:10143",
    ledgerAddress: opts.ledger === false ? null : LEDGER,
    account: opts.account === false ? null : privateKeyToAccount(generatePrivateKey()),
    batchMs: opts.batchMs ?? 20,
    batchMax: opts.batchMax ?? 20,
    submit: async (fn, args) => {
      calls.push({ fn, args });
      return submit(fn, args);
    },
    reads: opts.reads,
    log: (line) => logs.push(line),
  });
  return { w, calls, logs };
}

function receipt(jobId: string, over: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    jobId,
    agentId: null,
    buyer: BUYER,
    payTo: PAYEE,
    amount: "1000",
    paymentTx: `0x${"ab".repeat(32)}`,
    prompt: "p",
    result: "r",
    durationMs: 10,
    ok: true,
    ...over,
  };
}

function revert(errorName: string, args: readonly unknown[]): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({
    abi: XORV_LEDGER_ABI,
    functionName: "recordJobs",
    data: encodeErrorResult({ abi: XORV_LEDGER_ABI, errorName, args } as never),
  });
}

const batchOf = (call: Call) => call.args[0] as JobReceiptStruct[];

describe("modes", () => {
  it("is a silent no-op without a ledger", async () => {
    const { w, calls } = writer({ ledger: false });
    expect(w.mode()).toBe("off");
    expect(await w.recordJob(receipt("job_a"))).toBeNull();
    expect(await w.heartbeat({ providerId: "prv_a", activeJobs: 0, capacity: 1, uptimeSeconds: 1 })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(w.lastPublishError()).toBeNull();
  });

  it("is read-only without an operator key, and refuses to relay ratings", async () => {
    const { w, calls } = writer({ account: false });
    expect(w.mode()).toBe("read-only");
    expect(w.writerAddress).toBeNull();
    expect(await w.recordJob(receipt("job_a"))).toBeNull();
    await expect(w.rateJob({} as never, "0x")).rejects.toThrow(/read-only/);
    expect(calls).toHaveLength(0);
  });
});

describe("receipt batching", () => {
  it("sends receipts that arrive together as one recordJobs call", async () => {
    const { w, calls } = writer({ batchMs: 30 });
    const results = await Promise.all([w.recordJob(receipt("job_a")), w.recordJob(receipt("job_b")), w.recordJob(receipt("job_c"))]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("recordJobs");
    expect(batchOf(calls[0]!).map((r) => r.jobId)).toEqual([jobIdHash("job_a"), jobIdHash("job_b"), jobIdHash("job_c")]);
    // Everyone in the batch gets the same transaction back.
    expect(new Set(results.map((r) => r?.txHash)).size).toBe(1);
    expect(w.counts().receipts).toBe(3);
    expect(w.pendingReceipts()).toBe(0);
  });

  it("waits for company, but not forever", async () => {
    vi.useFakeTimers();
    try {
      const { w, calls } = writer({ batchMs: 4_000 });
      const pending = w.recordJob(receipt("job_a"));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(calls).toHaveLength(0);
      expect(w.pendingReceipts()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).not.toBeNull();
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes as soon as the batch is full, without waiting for the timer", async () => {
    const { w, calls } = writer({ batchMs: 60_000, batchMax: 2 });
    const a = w.recordJob(receipt("job_a"));
    const b = w.recordJob(receipt("job_b"));
    await Promise.all([a, b]);
    expect(calls).toHaveLength(1);
    expect(batchOf(calls[0]!)).toHaveLength(2);
    const c = w.recordJob(receipt("job_c"));
    expect(w.pendingReceipts()).toBe(1);
    await w.flush();
    expect(await c).not.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("hashes the prompt and result, and never ships the text", async () => {
    const { w, calls } = writer({});
    await w.recordJob(receipt("job_a", { prompt: "secret prompt", result: "secret result" }));
    const [struct] = batchOf(calls[0]!);
    expect(JSON.stringify(struct, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("secret");
    expect(struct!.agentId).toBe(NO_AGENT);
  });

  it("isolates a reverting receipt by splitting the batch", async () => {
    const bad = jobIdHash("job_dup");
    const { w, calls } = writer({
      batchMs: 20,
      submit: async (_fn, args) => {
        const batch = args[0] as JobReceiptStruct[];
        if (batch.some((r) => r.jobId === bad)) throw revert("DuplicateJob", [bad]);
        return { contract: LEDGER, txHash: `0x${"11".repeat(32)}`, explorerUrl: "x", blockNumber: "1" };
      },
    });
    const results = await Promise.all(["job_a", "job_dup", "job_b", "job_c"].map((id) => w.recordJob(receipt(id))));
    expect(results.map((r) => r !== null)).toEqual([true, false, true, true]);
    expect(w.counts().receipts).toBe(3);
    expect(w.lastPublishError()).toMatch(/DuplicateJob/);
    // The honest receipts still went out, in fewer calls than one-per-receipt.
    expect(calls.length).toBeGreaterThan(1);
  });

  describe("a receipt that already landed", () => {
    const ORIGINAL = `0x${"33".repeat(32)}` as Hex;
    const dupSubmit = (dup: Hex) => async (_fn: string, args: readonly unknown[]): Promise<PublishResult> => {
      const batch = args[0] as JobReceiptStruct[];
      if (batch.some((r) => r.jobId === dup)) throw revert("DuplicateJob", [dup]);
      return { contract: LEDGER, txHash: `0x${"11".repeat(32)}`, explorerUrl: "x", blockNumber: "1" };
    };
    const reads = (over: Partial<LedgerReads> = {}): LedgerReads => ({
      txStatus: async () => ({ status: "unknown" }),
      recordedJob: async () => ({ buyer: BUYER, agentId: 0n }),
      findRecorded: async () => ({ txHash: ORIGINAL, blockNumber: 5n }),
      ...over,
    });

    it("is a success carrying the original transaction, not a failure", async () => {
      // A retry after a restart or a timed-out wait: the ledger already holds
      // this broker's receipt. Treating DuplicateJob as failure left the job
      // without receiptTxHash forever, so it could never be rated.
      const dup = jobIdHash("job_dup");
      const { w } = writer({ submit: dupSubmit(dup), reads: reads() });
      const [a, again] = await Promise.all([w.recordJob(receipt("job_a")), w.recordJob(receipt("job_dup"))]);
      expect(a?.txHash).toBe(`0x${"11".repeat(32)}`);
      expect(again).toMatchObject({ txHash: ORIGINAL, alreadyRecorded: true, blockNumber: "5" });
    });

    it("still counts as recorded when the original transaction is out of the search window", async () => {
      const dup = jobIdHash("job_dup");
      const { w } = writer({ submit: dupSubmit(dup), reads: reads({ findRecorded: async () => null }) });
      expect(await w.recordJob(receipt("job_dup"))).toMatchObject({ txHash: "", alreadyRecorded: true });
    });

    it("says so when the receipt already recorded carries no agent", async () => {
      const dup = jobIdHash("job_dup");
      const { w } = writer({ submit: dupSubmit(dup), reads: reads({ recordedJob: async () => ({ buyer: BUYER, agentId: NO_AGENT }) }) });
      expect(await w.recordJob(receipt("job_dup", { agentId: "7" }))).toMatchObject({ alreadyRecorded: true, withoutAgent: true });
    });

    it("stays a failure when the recorded receipt names another buyer", async () => {
      const dup = jobIdHash("job_dup");
      const other = "0x3333333333333333333333333333333333333333";
      const { w } = writer({ submit: dupSubmit(dup), reads: reads({ recordedJob: async () => ({ buyer: other, agentId: 0n }) }) });
      expect(await w.recordJob(receipt("job_dup"))).toBeNull();
      expect(w.lastPublishError()).toMatch(/DuplicateJob/);
    });
  });

  it("checks an unconfirmed batch before sending its receipts again", async () => {
    const SENT = `0x${"44".repeat(32)}` as Hex;
    let status: "pending" | "success" | "unknown" = "pending";
    let failNext = true;
    const { w, calls } = writer({
      submit: async () => {
        if (failNext) {
          failNext = false;
          throw new UnconfirmedWrite(SENT, new Error("timed out waiting for the receipt"));
        }
        return { contract: LEDGER, txHash: `0x${"55".repeat(32)}`, explorerUrl: "x", blockNumber: "9" };
      },
      reads: {
        txStatus: async () => (status === "success" ? { status, blockNumber: 7n } : { status }),
        recordedJob: async () => ({ buyer: BUYER, agentId: 0n }),
        findRecorded: async () => null,
      },
    });
    expect(await w.recordJob(receipt("job_a"))).toBeNull();
    expect(calls).toHaveLength(1);
    // Still pending: no second transaction on top of the first.
    expect(await w.recordJob(receipt("job_a"))).toBeNull();
    expect(calls).toHaveLength(1);
    // It landed: that is the receipt.
    status = "success";
    expect(await w.recordJob(receipt("job_a"))).toMatchObject({ txHash: SENT, blockNumber: "7" });
    expect(calls).toHaveLength(1);
    // Dropped for good: send it again.
    failNext = true;
    expect(await w.recordJob(receipt("job_b"))).toBeNull();
    status = "unknown";
    expect(await w.recordJob(receipt("job_b"))).toMatchObject({ txHash: `0x${"55".repeat(32)}` });
    expect(calls).toHaveLength(3);
  });

  it("records a receipt without its agent when the agent wallet no longer matches the payee", async () => {
    const { w, calls, logs } = writer({
      submit: async (_fn, args) => {
        const [r] = args[0] as JobReceiptStruct[];
        if (r!.agentId !== NO_AGENT) throw revert("PayToNotAgentWallet", [r!.agentId, r!.payTo, BUYER]);
        return { contract: LEDGER, txHash: `0x${"22".repeat(32)}`, explorerUrl: "x", blockNumber: "1" };
      },
    });
    const result = await w.recordJob(receipt("job_a", { agentId: "7" }));
    expect(result).not.toBeNull();
    // The caller is told, so the job stops offering a rating the ledger refuses.
    expect(result!.withoutAgent).toBe(true);
    expect(calls).toHaveLength(2);
    expect(batchOf(calls[1]!)[0]!.agentId).toBe(NO_AGENT);
    expect(logs.join("\n")).toMatch(/without an agent/);
  });

  it("fails a whole batch on a non-revert error rather than multiplying it", async () => {
    const { w, calls } = writer({
      submit: async () => {
        throw new Error("fetch failed: ECONNREFUSED");
      },
    });
    const results = await Promise.all([w.recordJob(receipt("job_a")), w.recordJob(receipt("job_b"))]);
    expect(results).toEqual([null, null]);
    expect(calls).toHaveLength(1);
    expect(w.lastPublishError()).toMatch(/ECONNREFUSED/);
  });

  it("refuses a malformed receipt on its own instead of poisoning the batch", async () => {
    const { w, calls } = writer({});
    const [bad, good] = await Promise.all([
      w.recordJob(receipt("job_bad", { payTo: "not-an-address" })),
      w.recordJob(receipt("job_good")),
    ]);
    expect(bad).toBeNull();
    expect(good).not.toBeNull();
    expect(batchOf(calls[0]!)).toHaveLength(1);
  });
});

describe("other writes", () => {
  it("registers a provider under its hashed id with the compact capability string", async () => {
    const { w, calls } = writer({});
    await w.registerProvider({
      id: "prv_x",
      label: "node",
      address: PAYEE,
      agentId: "12",
      endpoint: "",
      capabilities: [{ id: "c", adapter: "claude-code", displayName: "C", priceUsdMicros: 10_000, maxConcurrency: 1 }],
      status: "online",
      activeJobs: 0,
      lastHeartbeatAt: 0,
      registeredAt: 0,
      version: "1",
      stats: { jobsCompleted: 0, jobsFailed: 0, earnedUsdcMicros: 0, avgDurationMs: 0 },
    });
    expect(calls[0]!.fn).toBe("registerProvider");
    expect(calls[0]!.args).toEqual([providerIdHash("prv_x"), PAYEE, 12n, "node", "claude-code:10000"]);
    expect(w.counts().registrations).toBe(1);
  });

  it("clamps heartbeat numbers to uint32", async () => {
    const { w, calls } = writer({});
    await w.heartbeat({ providerId: "prv_x", activeJobs: -1, capacity: 4, uptimeSeconds: 2 ** 40 });
    expect(calls[0]!.args).toEqual([providerIdHash("prv_x"), 0, 4, 0xffff_ffff]);
  });

  it("surfaces a rating revert to the caller by name", async () => {
    const { w } = writer({
      submit: async () => {
        throw revert("AlreadyRated", [jobIdHash("job_a")]);
      },
    });
    await expect(w.rateJob({} as never, "0x" as Hex)).rejects.toThrow(/AlreadyRated/);
    expect(w.counts().ratings).toBe(0);
  });

  it("names the custom error a failed write reverted with", () => {
    expect(revertName(revert("NotBroker", []))).toBe("NotBroker");
    expect(revertName(new Error("plain"))).toBeNull();
  });
});
