/**
 * XorvEscrow handlers: an EscrowJob from funding to release or refund, the provider it
 * pays following reassignments, and nothing moving a job once it is settled.
 */

import { describe, expect, it } from "vitest";
import { ESCROW, Sim, T0, addr, escrow, hash32, id32 } from "./harness.js";

const BUYER = addr(0xb1);
const FIRST = addr(0x01);
const SECOND = addr(0x02);

describe("XorvEscrow", () => {
  it("records a funding, follows a reassignment, and closes on release", async () => {
    const sim = new Sim();
    const jobId = id32("qte_1");
    const fundTx = await sim.run(escrow.funded({ jobId, buyer: BUYER, provider: FIRST, deadline: T0 + 1800 }));
    expect(await sim.indexer.EscrowJob.getOrThrow(jobId)).toMatchObject({
      escrow: ESCROW,
      status: "Funded",
      buyer: BUYER,
      provider: FIRST,
      amount: 250_000n,
      deadline: BigInt(T0 + 1800),
      fundTx,
      reassignments: 0,
    });

    await sim.run(escrow.reassigned(jobId, FIRST, SECOND));
    const releaseTx = await sim.run(escrow.released(jobId, SECOND, hash32(7)));
    expect(await sim.indexer.EscrowJob.getOrThrow(jobId)).toMatchObject({
      status: "Released",
      provider: SECOND,
      reassignments: 1,
      settleTx: releaseTx,
      resultHash: hash32(7),
    });
  });

  it("records who was at fault on a refund, and ignores anything after settlement", async () => {
    const sim = new Sim();
    const jobId = id32("qte_2");
    await sim.run(escrow.funded({ jobId, buyer: BUYER, provider: FIRST, deadline: T0 + 1800 }));
    await sim.run(escrow.refunded(jobId, BUYER, false)); // a keeper's refund after the deadline
    await sim.run(escrow.released(jobId, FIRST, hash32(9)));
    await sim.run(escrow.reassigned(jobId, FIRST, SECOND));
    expect(await sim.indexer.EscrowJob.getOrThrow(jobId)).toMatchObject({
      status: "Refunded",
      providerAtFault: false,
      provider: FIRST,
      reassignments: 0,
      resultHash: undefined,
    });
  });
});
