import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { dayOf, laplaceBps } from "./lib.js";

const CHAIN = 10143;
const BUYER = "0x00000000000000000000000000000000000000b0";
const PROVIDER = "0x00000000000000000000000000000000000000a1";
const PROVIDER2 = "0x00000000000000000000000000000000000000a2";
const BROKER = "0x00000000000000000000000000000000000000ee";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const JOB = "0x" + "11".repeat(32);
const JOB2 = "0x" + "22".repeat(32);
const NODE = "0x" + "aa".repeat(32);
const FUND_TX = "0x" + "f1".repeat(32);
const T0 = 1_791_200_000;

/** A synthetic event as the escrow, registry or log would emit it. */
function ev(
  contract: "XorvEscrow" | "XorvRegistry" | "XorvLog",
  event: string,
  params: Record<string, unknown>,
  at: number,
  tx = "0x" + "ab".repeat(32),
) {
  return { contract, event, params, block: { timestamp: at }, transaction: { hash: tx } } as never;
}

describe("a job's whole life on Monad", () => {
  it("folds funding, reputation, release and the receipt into Job, Provider, Buyer and totals", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ev("XorvRegistry", "ProviderRegistered", { provider: PROVIDER, nodeId: NODE, metadataUri: "" }, T0),
            ev("XorvRegistry", "Heartbeat", { provider: PROVIDER, timestamp: BigInt(T0 + 5) }, T0 + 5),
            ev(
              "XorvEscrow",
              "JobFunded",
              { jobId: JOB, buyer: BUYER, provider: PROVIDER, token: AUSD, amount: 100_000n, deadline: BigInt(T0 + 1800) },
              T0 + 10,
              FUND_TX,
            ),
            ev("XorvRegistry", "OutcomeRecorded", { provider: PROVIDER, success: true, amount: 100_000n, completed: 1n, failed: 0n }, T0 + 19),
            ev(
              "XorvEscrow",
              "JobReleased",
              { jobId: JOB, provider: PROVIDER, providerAmount: 100_000n, fee: 0n, resultHash: "0x" + "cd".repeat(32), releasedBy: BROKER },
              T0 + 19,
            ),
            ev(
              "XorvLog",
              "Entry",
              {
                kind: 3n,
                subject: "0x" + "00".repeat(32),
                author: BROKER,
                seq: 7n,
                payload: JSON.stringify({
                  v: 1,
                  kind: "job.receipt",
                  at: T0 + 20,
                  data: { jobId: "job_x", providerAddress: PROVIDER, amount: "100000", transactionHash: FUND_TX, resultHash: "ab", ok: true, settlement: { state: "released" } },
                }),
              },
              T0 + 20,
            ),
          ],
        },
      },
    });

    const job = await indexer.Job.getOrThrow(JOB);
    t.expect(job.status).toBe("Released");
    t.expect(job.buyer_id).toBe(BUYER);
    t.expect(job.provider_id).toBe(PROVIDER);
    t.expect(job.fundTx).toBe(FUND_TX);
    t.expect(job.providerAmount).toBe(100_000n);
    t.expect(job.secondsToSettle).toBe(9n);

    const provider = await indexer.Provider.getOrThrow(PROVIDER);
    t.expect(provider).toMatchObject({
      registered: true,
      active: true,
      nodeId: NODE,
      heartbeats: 1,
      completed: 1n,
      failed: 0n,
      scoreBps: 6666,
      earned: 100_000n,
      jobsAssigned: 1,
    });

    const buyer = await indexer.Buyer.getOrThrow(BUYER);
    t.expect(buyer).toMatchObject({ jobs: 1, spent: 100_000n, refunded: 0n });

    const receipts = await indexer.Receipt.getAll();
    t.expect(receipts).toHaveLength(1);
    t.expect(receipts[0]!.job_id).toBe(JOB);
    t.expect(receipts[0]!.settlementState).toBe("released");

    const net = await indexer.Network.getOrThrow("monad-testnet");
    t.expect(net).toMatchObject({
      jobsFunded: 1,
      jobsReleased: 1,
      volume: 100_000n,
      paidToProviders: 100_000n,
      providers: 1,
      buyers: 1,
      receipts: 1,
      settledCount: 1,
      meanSecondsToSettle: 9n,
    });

    const day = await indexer.DailyStat.getOrThrow(dayOf(T0));
    t.expect(day).toMatchObject({ jobsFunded: 1, jobsReleased: 1, volume: 100_000n, activeProviders: 1 });
  });

  it("marks a refund at fault against the provider, and a reassignment moves the job", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ev(
              "XorvEscrow",
              "JobFunded",
              { jobId: JOB2, buyer: BUYER, provider: PROVIDER, token: AUSD, amount: 250_000n, deadline: BigInt(T0 + 1800) },
              T0,
            ),
            ev("XorvEscrow", "JobReassigned", { jobId: JOB2, previousProvider: PROVIDER, newProvider: PROVIDER2 }, T0 + 30),
            ev("XorvRegistry", "OutcomeRecorded", { provider: PROVIDER2, success: false, amount: 0n, completed: 0n, failed: 1n }, T0 + 60),
            ev("XorvEscrow", "JobRefunded", { jobId: JOB2, buyer: BUYER, amount: 250_000n, providerAtFault: true }, T0 + 60),
          ],
        },
      },
    });

    const job = await indexer.Job.getOrThrow(JOB2);
    t.expect(job).toMatchObject({ status: "Refunded", provider_id: PROVIDER2, reassignments: 1, providerAtFault: true });
    t.expect(await indexer.Provider.getOrThrow(PROVIDER2)).toMatchObject({ failed: 1n, scoreBps: 3333, refundsAtFault: 1, jobsAssigned: 1 });
    t.expect(await indexer.Buyer.getOrThrow(BUYER)).toMatchObject({ spent: 0n, refunded: 250_000n });
    t.expect(await indexer.Network.getOrThrow("monad-testnet")).toMatchObject({
      jobsRefunded: 1,
      refundsAtFault: 1,
      refunded: 250_000n,
      providers: 2,
    });
  });
});

describe("helpers", () => {
  it("scores exactly as the registry does", (t) => {
    t.expect(laplaceBps(0n, 0n)).toBe(5000);
    t.expect(laplaceBps(8n, 2n)).toBe(7500);
    t.expect(laplaceBps(1n, 0n)).toBe(6666);
  });
  it("buckets by UTC day", (t) => {
    t.expect(dayOf(0)).toBe("1970-01-01");
  });
});
