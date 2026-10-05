/**
 * On-chain reputation in the broker: sponsored registration, ranking, and the
 * refresh after a settlement moves a provider's numbers.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { OnchainReputation } from "@xorv/protocol";
import { MemoryEscrow } from "../src/escrow.js";
import type { ReputationSource } from "../src/reputation.js";
import { boot, connectProvider, quote, waitFor, type Harness } from "./harness.js";

/** XorvRegistry's state machine in memory, including the escrow's writes. */
class MemoryRegistry implements ReputationSource {
  readonly address = "0x000000000000000000000000000000000000Aaaa";
  readonly records = new Map<string, OnchainReputation>();
  readonly sponsored: string[] = [];
  reads = 0;

  private rec(a: string): OnchainReputation {
    const key = a.toLowerCase();
    let r = this.records.get(key);
    if (!r) {
      r = { registered: false, active: false, completed: 0, failed: 0, earnedUnits: "0", score: 5000, registeredAt: 0 };
      this.records.set(key, r);
    }
    return r;
  }
  outcome(a: string, success: boolean, amount = 0n): void {
    const r = this.rec(a);
    if (success) {
      r.completed += 1;
      r.earnedUnits = (BigInt(r.earnedUnits) + amount).toString();
    } else r.failed += 1;
    r.score = Math.floor(((r.completed + 1) * 10_000) / (r.completed + r.failed + 2));
  }
  async read(a: string) {
    this.reads += 1;
    return { ...this.rec(a) };
  }
  async sponsor(a: string) {
    this.sponsored.push(a);
    Object.assign(this.rec(a), { registered: true, active: true, registeredAt: 1 });
    return `0x${"ab".repeat(32)}`;
  }
}

const A1 = "0x0000000000000000000000000000000000000001";
const A2 = "0x0000000000000000000000000000000000000002";

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

async function providers(harness: Harness) {
  return ((await (await fetch(`${harness.base}/api/providers`)).json()) as {
    providers: Array<{ address: string; onchain: OnchainReputation & { sponsorTx?: string } | null }>;
    registry: { address: string } | null;
  });
}

describe("on-chain reputation", () => {
  it("sponsors a new provider's registration, so joining needs no ETH", async () => {
    const reg = new MemoryRegistry();
    h = await boot({ reputation: reg });
    const p = await connectProvider(h, { address: A1 });
    await waitFor(() => (reg.sponsored.length ? true : undefined));
    expect(reg.sponsored).toEqual([A1]);

    const listed = await waitFor(async () => {
      const l = await providers(h!);
      return l.providers[0]?.onchain?.sponsorTx ? l : undefined;
    });
    expect(listed.registry?.address).toBe(reg.address);
    expect(listed.providers[0]!.onchain).toMatchObject({ registered: true, active: true, score: 5000 });
    p.close();
  });

  it("does not re-sponsor a provider the registry already knows", async () => {
    const reg = new MemoryRegistry();
    await reg.sponsor(A1);
    reg.sponsored.length = 0;
    h = await boot({ reputation: reg });
    const p = await connectProvider(h, { address: A1 });
    await waitFor(() => (reg.reads > 0 ? true : undefined));
    await new Promise((r) => setTimeout(r, 100));
    expect(reg.sponsored).toEqual([]);
    p.close();
  });

  it("ranks equal-priced providers by on-chain score, not the broker's own counters", async () => {
    const reg = new MemoryRegistry();
    // A1: one success, three failures. A2: four successes.
    reg.outcome(A1, true);
    for (let i = 0; i < 3; i++) reg.outcome(A1, false);
    for (let i = 0; i < 4; i++) reg.outcome(A2, true);
    h = await boot({ reputation: reg });
    const bad = await connectProvider(h, { label: "bad", nodeId: "n1", address: A1, price: 1_000 });
    const good = await connectProvider(h, { label: "good", nodeId: "n2", address: A2, price: 1_000 });
    await waitFor(async () => {
      const l = await providers(h!);
      return l.providers.every((p) => p.onchain) ? true : undefined;
    });
    const { body } = await quote(h);
    expect(body.provider.label).toBe("good");
    bad.close();
    good.close();
  });

  it("re-reads a provider's record after the escrow pays them", async () => {
    const reg = new MemoryRegistry();
    const escrow = new MemoryEscrow();
    h = await boot({ reputation: reg, escrow, clientScheme: "escrow" });
    const p = await connectProvider(h, { address: A1 });
    const { body } = await quote(h);
    const res = await h.paidFetch(`${h.base}/api/jobs/${body.quoteId}`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);

    // What XorvEscrow.release does to the registry, inside the same transaction.
    const realRelease = escrow.release.bind(escrow);
    escrow.release = async (jobId, hash) => {
      reg.outcome(A1, true, BigInt(body.accepts[0].amount));
      return realRelease(jobId, hash);
    };
    await p.completeNextJob();

    const listed = await waitFor(async () => {
      const l = await providers(h!);
      return l.providers[0]?.onchain?.completed === 1 ? l : undefined;
    });
    expect(listed.providers[0]!.onchain).toMatchObject({
      completed: 1,
      failed: 0,
      earnedUnits: body.accepts[0].amount,
      score: 6666,
    });
    p.close();
  });
});
