/**
 * The broker's escrow path, end to end.
 *
 * Same harness as the integration suite — real HTTP server, real x402 resource
 * server, real WebSocket hub, a fake provider that speaks the CLI's protocol —
 * with the chain replaced by `MemoryEscrow`, which enforces the contract's
 * state machine. So every settlement decision the broker makes is checked
 * against what XorvEscrow would actually accept.
 */

import { afterEach, describe, expect, it } from "vitest";
import { escrowJobId } from "@xorv/protocol";
import { MemoryEscrow } from "../src/escrow.js";
import { boot, connectProvider, quote, waitFor, type Harness } from "./harness.js";

const P1 = "0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B";
const P2 = "0x0000000000000000000000000000000000000002";

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

async function pay(harness: Harness, quoteId: string) {
  const res = await harness.paidFetch(`${harness.base}/api/jobs/${quoteId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return { status: res.status, body: (await res.json()) as { jobId: string } };
}

async function jobOf(harness: Harness, jobId: string) {
  const res = await fetch(`${harness.base}/api/jobs/${jobId}`);
  return ((await res.json()) as { job: Record<string, any> }).job;
}

describe("escrow: the 402", () => {
  it("offers escrow first, paid to the escrow contract, with the quote's job terms", async () => {
    const escrow = new MemoryEscrow();
    h = await boot({ escrow, clientScheme: "escrow" });
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    expect(body.escrow).toMatchObject({ address: escrow.address, jobId: escrowJobId(body.quoteId) });

    const res = await fetch(`${h.base}/api/jobs/${body.quoteId}`, { method: "POST", body: "{}" });
    expect(res.status).toBe(402);
    const accepts = JSON.parse(
      Buffer.from(res.headers.get("payment-required")!, "base64").toString("utf8"),
    ).accepts as Array<Record<string, any>>;

    // escrow × {USDG, USDC}, then exact × {USDG, USDC}
    expect(accepts.map((a) => a.scheme)).toEqual(["escrow", "escrow", "exact", "exact"]);
    expect(accepts[0]!.payTo).toBe(escrow.address);
    expect(accepts[0]!.extra).toMatchObject({
      name: "Global Dollar",
      version: "1",
      escrow: escrow.address,
      jobId: escrowJobId(body.quoteId),
      deadline: body.escrow.deadline,
      provider: P1,
    });
    // The fallback still pays the provider directly.
    expect(accepts[2]!.payTo).toBe(P1);
    provider.close();
  });

  it("freezes the deadline, so both 402 passes agree", async () => {
    h = await boot({ escrow: new MemoryEscrow(), clientScheme: "escrow" });
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    const read = async () =>
      JSON.parse(
        Buffer.from(
          (await fetch(`${h!.base}/api/jobs/${body.quoteId}`, { method: "POST", body: "{}" })).headers.get(
            "payment-required",
          )!,
          "base64",
        ).toString("utf8"),
      ).accepts[0].extra;
    const first = await read();
    await new Promise((r) => setTimeout(r, 1100));
    expect(await read()).toEqual(first);
    provider.close();
  });
});

describe("escrow: settlement follows the job", () => {
  it("funds on payment and releases to the provider with the result's hash", async () => {
    const escrow = new MemoryEscrow();
    h = await boot({ escrow, clientScheme: "escrow" });
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    const paid = await pay(h, body.quoteId);
    expect(paid.status).toBe(200);
    expect(h.settled[0]!.scheme).toBe("escrow");

    await provider.completeNextJob("forty-two");
    const job = await waitFor(async () => {
      const j = await jobOf(h!, paid.body.jobId);
      return j.payment?.escrow?.state === "released" ? j : undefined;
    }).catch(async () => jobOf(h!, paid.body.jobId));

    expect(job.payment.scheme).toBe("escrow");
    expect(job.payment.payTo).toBe(escrow.address);
    expect(job.payment.escrow).toMatchObject({
      state: "released",
      jobId: escrowJobId(body.quoteId),
      provider: P1,
      resultHash: job.resultHash,
    });
    expect(job.payment.escrow.releaseTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(escrow.calls).toEqual([
      { op: "release", jobId: escrowJobId(body.quoteId), arg: job.resultHash },
    ]);
    provider.close();
  });

  it("refunds the buyer when the provider fails and nobody else can take it", async () => {
    const escrow = new MemoryEscrow();
    h = await boot({ escrow, clientScheme: "escrow" });
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    const paid = await pay(h, body.quoteId);
    await provider.failNextJob("adapter crashed");

    await waitForState(h, paid.body.jobId, "refunded");
    expect(escrow.calls.map((c) => c.op)).toEqual(["refund"]);
    // A refunded job paid no provider, so it must not count as paid out.
    const net = (await (await fetch(`${h.base}/api/network`)).json()) as {
      stats: { paidUsdMicros: number; jobsSettled: number };
    };
    expect(net.stats.paidUsdMicros).toBe(0);
    expect(net.stats.jobsSettled).toBe(0);
    const job = await jobOf(h, paid.body.jobId);
    expect(job.status).toBe("failed");
    expect(job.payment.escrow.refundTx).toMatch(/^0x/);
    provider.close();
  });

  it("moves the payee on reassignment, then pays the provider that delivered", async () => {
    const escrow = new MemoryEscrow();
    h = await boot({ escrow, clientScheme: "escrow" });
    const first = await connectProvider(h, { label: "first", nodeId: "n1", address: P1, price: 1_000 });
    const { body } = await quote(h);
    const second = await connectProvider(h, { label: "second", nodeId: "n2", address: P2, price: 2_000 });
    const paid = await pay(h, body.quoteId);

    await first.failNextJob("node went away");
    await second.completeNextJob("done by the second node");

    await waitForState(h, paid.body.jobId, "released");
    expect(escrow.calls.map((c) => [c.op, c.arg && c.op === "reassign" ? c.arg : undefined])).toEqual([
      ["reassign", P2],
      ["release", undefined],
    ]);
    const job = await jobOf(h, paid.body.jobId);
    expect(job.providerAddress).toBe(P2);
    expect(job.payment.escrow.provider).toBe(P2);
    expect(job.payment.escrow.reassignTxs).toHaveLength(1);
    expect((await escrow.read(escrowJobId(body.quoteId) as `0x${string}`)).provider).toBe(P2);
    first.close();
    second.close();
  });

  it("refunds when the buyer cancels", async () => {
    const escrow = new MemoryEscrow();
    h = await boot({ escrow, clientScheme: "escrow" });
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    const paid = await pay(h, body.quoteId);
    await waitFor(() => provider.dispatched[0]);

    const res = await fetch(`${h.base}/api/jobs/${paid.body.jobId}/cancel`, { method: "POST" });
    expect(await res.json()).toMatchObject({ ok: true, refunded: true });
    await waitForState(h, paid.body.jobId, "refunded");
    // The no-blame path: a buyer's cancel must not mark the provider as failed —
    // not on chain, and not in the broker's own record either.
    expect(escrow.calls.map((c) => c.op)).toEqual(["cancel"]);
    const node = h.registry.get(provider.providerId)!;
    expect(node.stats.jobsFailed).toBe(0);
    expect(node.activeJobs).toBe(0);
    provider.close();
  });

  it("never lets a quote outlive the escrow time it promises the job", async () => {
    // A quote paid late used to fund an escrow already near or past its
    // deadline (refundable at once, or refused by XorvEscrow's one-minute floor).
    for (const [deadlineSeconds, ttl] of [[180, 60], [1800, 300]] as const) {
      const escrow = new MemoryEscrow();
      h = await boot({ escrow, clientScheme: "escrow", deadlineSeconds });
      const provider = await connectProvider(h);
      const { body } = await quote(h);
      expect(Math.round((body.expiresAt - Date.now()) / 1000)).toBeGreaterThanOrEqual(ttl - 2);
      expect(Math.round((body.expiresAt - Date.now()) / 1000)).toBeLessThanOrEqual(ttl);
      expect(body.escrow.deadline * 1000 - body.expiresAt).toBeGreaterThanOrEqual(119_000);
      provider.close();
      await h.stop();
      h = undefined;
    }
  });

  it("pays a quote once when Pay is pressed three times at once", async () => {
    // Found live with a triple-clicked Pay: every attempt passed verification
    // before any settled, each created a job, two ran unpaid.
    const escrow = new MemoryEscrow();
    h = await boot({ escrow, clientScheme: "escrow", verifyDelayMs: 150 });
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    const attempts = await Promise.all([pay(h, body.quoteId), pay(h, body.quoteId), pay(h, body.quoteId)]);
    const statuses = attempts.map((a) => a.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    const jobs = h.jobs.list({ limit: 50 }).filter((j) => j.quoteId === body.quoteId);
    expect(jobs).toHaveLength(1);
    expect(h.settled).toHaveLength(1);
    expect(provider.dispatched).toHaveLength(1);
    provider.close();
  });

  it("publishes the receipt only once the escrow settles, saying where the money went", async () => {
    // Found live: the receipt went out at funding time naming the provider as
    // payee, so a job that was then refunded sat in the public log looking paid.
    const escrow = new MemoryEscrow();
    h = await boot({ escrow, clientScheme: "escrow" });
    const provider = await connectProvider(h);
    const receipts = () =>
      h!.chain.published.filter((p) => p.kind === "receipts").map((p) => p.data as Record<string, any>);

    const done = await pay(h, (await quote(h)).body.quoteId);
    await provider.completeNextJob("forty-two");
    const released = await waitFor(() => receipts().find((r) => r.jobId === done.body.jobId));
    const doneJob = await jobOf(h, done.body.jobId);
    expect(released).toMatchObject({
      ok: true,
      settlement: {
        escrow: escrow.address,
        state: "released",
        paidTo: P1,
        transactionHash: doneJob.payment.escrow.releaseTx,
      },
    });

    const stopped = await pay(h, (await quote(h)).body.quoteId);
    await waitFor(() => provider.dispatched[1]);
    await fetch(`${h.base}/api/jobs/${stopped.body.jobId}/cancel`, { method: "POST" });
    const refunded = await waitFor(() => receipts().find((r) => r.jobId === stopped.body.jobId));
    const stoppedJob = await jobOf(h, stopped.body.jobId);
    expect(refunded).toMatchObject({
      ok: false,
      settlement: {
        state: "refunded",
        paidTo: stoppedJob.payment.payer,
        transactionHash: stoppedJob.payment.escrow.refundTx,
      },
    });
    expect(receipts()).toHaveLength(2);
    provider.close();
  });

  it("a late result after a refund does not try to release", async () => {
    const escrow = new MemoryEscrow();
    h = await boot({ escrow, clientScheme: "escrow" });
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    const paid = await pay(h, body.quoteId);
    await waitFor(() => provider.dispatched[0]);
    await fetch(`${h.base}/api/jobs/${paid.body.jobId}/cancel`, { method: "POST" });
    await waitForState(h, paid.body.jobId, "refunded");

    await provider.completeNextJob("too late");
    await new Promise((r) => setTimeout(r, 300));
    expect(escrow.calls.map((c) => c.op)).toEqual(["cancel"]);
    provider.close();
  });
});

describe("escrow: failure modes", () => {
  it("stops the job when the payment fails to settle", async () => {
    h = await boot({ escrow: new MemoryEscrow(), clientScheme: "escrow", failSettle: true });
    const provider = await connectProvider(h);
    const cancels: string[] = [];
    provider.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; jobId?: string };
      if (msg.type === "job.cancel" && msg.jobId) cancels.push(msg.jobId);
    });
    const { body } = await quote(h);
    const paid = await pay(h, body.quoteId);
    expect(paid.status).not.toBe(200);

    const jobId = await waitFor(() => provider.dispatched[0]?.jobId);
    await waitFor(() => cancels[0]);
    const job = await jobOf(h, jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/payment did not settle/);
    expect(job.payment).toBeNull();
    provider.close();
  });

  it("a stock client that only speaks `exact` still pays, straight to the provider", async () => {
    const escrow = new MemoryEscrow();
    h = await boot({ escrow, clientScheme: "exact" });
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    const paid = await pay(h, body.quoteId);
    expect(paid.status).toBe(200);
    expect(h.settled[0]!.scheme).toBe("exact");
    expect(h.settled[0]!.payTo).toBe(P1);

    await provider.completeNextJob();
    await new Promise((r) => setTimeout(r, 300));
    const job = await jobOf(h, paid.body.jobId);
    expect(job.payment.scheme).toBe("exact");
    expect(job.payment.escrow).toBeUndefined();
    expect(escrow.calls).toEqual([]);
    provider.close();
  });
});

describe("escrow: a node that vanishes between quote and payment", () => {
  it("refunds at once, without blame, instead of leaving the money held until the deadline", async () => {
    const escrow = new MemoryEscrow();
    h = await boot({ escrow, clientScheme: "escrow" });
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    provider.ws.close();
    await new Promise((r) => setTimeout(r, 150));

    const paid = await pay(h, body.quoteId);
    expect(paid.status).toBe(200);
    const job = await waitForState(h, paid.body.jobId, "refunded");
    expect(job.status).toBe("failed");
    expect(escrow.calls.map((c) => c.op)).toEqual(["cancel"]);
  });

  it("never quotes a node whose control channel is closed", async () => {
    h = await boot({ escrow: new MemoryEscrow(), clientScheme: "escrow" });
    const provider = await connectProvider(h);
    provider.ws.close();
    await new Promise((r) => setTimeout(r, 150));
    const { status } = await quote(h);
    expect(status).not.toBe(200);
  });
});

describe("escrow: reconciling with the chain", () => {
  it("records a refund someone else made on chain, with their transaction", async () => {
    const escrow = new MemoryEscrow();
    h = await boot({ escrow, clientScheme: "escrow" });
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    const paid = await pay(h, body.quoteId);
    await waitFor(() => provider.dispatched[0]);
    // A keeper refunds the buyer on chain after the deadline — not the broker.
    const keeper = "0x000000000000000000000000000000000000bEEF";
    const tx = escrow.refundExternally(escrowJobId(body.quoteId), keeper);

    h.sweep();
    const job = await waitForState(h, paid.body.jobId, "refunded");
    expect(job.payment.escrow.refundTx).toBe(tx);
    expect(job.status).toBe("failed");
    expect(job.events.some((e: { text: string }) => e.text.includes(keeper))).toBe(true);
    // The broker never sent a refund itself.
    expect(escrow.calls.map((c) => c.op)).toEqual([]);
    // Nobody will pay for the work now: the node is told to stop, its slot is
    // freed, and the stopped job is not counted as a completion.
    await waitFor(() => provider.cancelled.includes(paid.body.jobId) || undefined);
    const node = h.registry.get(provider.providerId)!;
    expect(node.activeJobs).toBe(0);
    expect(node.stats.jobsCompleted).toBe(0);
    provider.close();
  });

  it("refunds without blame a job left funded past its deadline", async () => {
    const escrow = new MemoryEscrow();
    h = await boot({ escrow, clientScheme: "escrow", deadlineSeconds: 1 });
    const provider = await connectProvider(h);
    const { body } = await quote(h);
    const paid = await pay(h, body.quoteId);
    await waitFor(() => provider.dispatched[0]);
    // The provider never answers and the broker never settles: the deadline
    // passes (1s + the 30s grace, simulated by moving the clock).
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      h.sweep();
      const job = await waitForState(h, paid.body.jobId, "refunded");
      expect(job.error).toMatch(/not settled before the escrow deadline/);
      expect(escrow.calls.map((c) => c.op)).toEqual(["cancel"]);
    } finally {
      Date.now = realNow;
    }
    provider.close();
  });
});

async function waitForState(harness: Harness, jobId: string, state: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = await jobOf(harness, jobId);
    if (job.payment?.escrow?.state === state) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  const job = await jobOf(harness, jobId);
  throw new Error(`escrow never reached ${state}: ${JSON.stringify(job.payment)}`);
}
