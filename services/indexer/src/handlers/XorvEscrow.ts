/**
 * XorvEscrow handlers: one EscrowJob per escrowed payment, from funding to release or
 * refund. Every transition is the contract's own (only a Funded job can move), so these
 * only record it; a settled job ignores anything that arrives after.
 */

import { indexer } from "envio";
import { lower } from "../lib/util.js";

indexer.onEvent(
  { contract: "XorvEscrow", event: "JobFunded", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    const id = lower(event.params.jobId);
    if (await context.EscrowJob.get(id)) return; // a job id is funded once, ever
    context.EscrowJob.set({
      id,
      escrow: lower(event.srcAddress),
      status: "Funded",
      buyer: lower(event.params.buyer),
      provider: lower(event.params.provider),
      token: lower(event.params.token),
      amount: event.params.amount,
      deadline: BigInt(event.params.deadline),
      fundedAt: event.block.timestamp,
      fundTx: lower(event.transaction.hash),
      settledAt: undefined,
      settleTx: undefined,
      resultHash: undefined,
      providerAtFault: undefined,
      reassignments: 0,
    });
  },
);

indexer.onEvent(
  { contract: "XorvEscrow", event: "JobReleased", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    const job = await context.EscrowJob.get(lower(event.params.jobId));
    if (!job || job.status !== "Funded") return;
    context.EscrowJob.set({
      ...job,
      status: "Released",
      provider: lower(event.params.provider),
      settledAt: event.block.timestamp,
      settleTx: lower(event.transaction.hash),
      resultHash: lower(event.params.resultHash),
    });
  },
);

indexer.onEvent(
  { contract: "XorvEscrow", event: "JobRefunded", fields: { block: ["timestamp"], transaction: ["hash"] } },
  async ({ event, context }) => {
    const job = await context.EscrowJob.get(lower(event.params.jobId));
    if (!job || job.status !== "Funded") return;
    context.EscrowJob.set({
      ...job,
      status: "Refunded",
      settledAt: event.block.timestamp,
      settleTx: lower(event.transaction.hash),
      providerAtFault: event.params.providerAtFault,
    });
  },
);

indexer.onEvent({ contract: "XorvEscrow", event: "JobReassigned" }, async ({ event, context }) => {
  const job = await context.EscrowJob.get(lower(event.params.jobId));
  if (!job || job.status !== "Funded") return;
  context.EscrowJob.set({ ...job, provider: lower(event.params.newProvider), reassignments: job.reassignments + 1 });
});
