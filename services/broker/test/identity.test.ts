/**
 * Cleanverse CVI in the broker: with an identity gate on the escrow, providers
 * without an active A-Pass are never quoted, and a freeze takes them out of
 * matching at the next sweep.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MemoryEscrow } from "../src/escrow.js";
import { IdentityBook, type GateInfo, type IdentitySource } from "../src/identity.js";
import { boot, connectProvider, quote, type Harness } from "./harness.js";

const CHEAP = "0x0000000000000000000000000000000000000c01";
const DEAR = "0x0000000000000000000000000000000000000c02";
const GATE: GateInfo = {
  address: "0x00000000000000000000000000000000000Ca7e5",
  kind: "cleanverse",
  apass: "0xbA82D189540CaC9DC6FF46B6837CaC1BFdEC58B9",
  validator: "0xaC7e5179C2C7f03f209136886c172eb34F161792",
  pool: null,
};

/** Cleanverse's A-Pass, as far as the broker can see it. */
class MemoryAPass implements IdentitySource {
  readonly valid = new Set<string>();
  gateOn = true;
  async gate() {
    return this.gateOn ? GATE : null;
  }
  async verified(addresses: string[]) {
    return addresses.map((a) => this.valid.has(a.toLowerCase()));
  }
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

async function providerIdentity(harness: Harness, address: string) {
  const { providers } = (await (await fetch(`${harness.base}/api/providers`)).json()) as {
    providers: Array<{ address: string; identity: { verified: boolean } | null }>;
  };
  return providers.find((p) => p.address.toLowerCase() === address.toLowerCase())?.identity;
}

describe("Cleanverse identity gate", () => {
  it("quotes the cheapest verified provider, not the cheapest one", async () => {
    const apass = new MemoryAPass();
    apass.valid.add(DEAR);
    h = await boot({ escrow: new MemoryEscrow(), clientScheme: "escrow", identity: apass });
    const cheap = await connectProvider(h, { label: "cheap", address: CHEAP, price: 1_000, nodeId: "n-cheap" });
    const dear = await connectProvider(h, { label: "dear", address: DEAR, price: 5_000, nodeId: "n-dear" });
    await identityRead(h, 2);

    expect(await providerIdentity(h, CHEAP)).toMatchObject({ verified: false });
    expect(await providerIdentity(h, DEAR)).toMatchObject({ verified: true });

    const { status, body } = await quote(h);
    expect(status).toBe(200);
    expect((body as { provider: { address: string } }).provider.address.toLowerCase()).toBe(DEAR);

    const net = (await (await fetch(`${h.base}/api/network`)).json()) as { escrow: { identityGate: GateInfo | null } };
    expect(net.escrow.identityGate).toEqual(GATE);
    cheap.close();
    dear.close();
  });

  it("says why when no provider online is verified", async () => {
    h = await boot({ escrow: new MemoryEscrow(), clientScheme: "escrow", identity: new MemoryAPass() });
    const node = await connectProvider(h, { address: CHEAP });
    await identityRead(h, 1);
    const { status, body } = await quote(h);
    expect(status).toBe(422);
    expect((body as { error: string }).error).toMatch(/no provider online holds an active Cleanverse A-Pass/);
    node.close();
  });

  it("drops a provider at the next sweep once Cleanverse freezes it", async () => {
    const apass = new MemoryAPass();
    apass.valid.add(CHEAP);
    h = await boot({ escrow: new MemoryEscrow(), clientScheme: "escrow", identity: apass });
    const node = await connectProvider(h, { address: CHEAP });
    await identityRead(h, 1);
    expect((await quote(h)).status).toBe(200);

    apass.valid.delete(CHEAP); // frozen
    h.sweep();
    for (let i = 0; i < 100 && (await providerIdentity(h, CHEAP))?.verified !== false; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await providerIdentity(h, CHEAP)).toMatchObject({ verified: false });
    expect((await quote(h)).status).toBe(422);
    node.close();
  });
});

/** Wait until the broker has read the standing of `count` providers. */
async function identityRead(harness: Harness, count: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { providers } = (await (await fetch(`${harness.base}/api/providers`)).json()) as {
      providers: Array<{ identity: unknown }>;
    };
    if (providers.length >= count && providers.every((p) => p.identity !== null)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the broker never read the providers' identity");
}

describe("IdentityBook", () => {
  it("blocks nobody without a gate, and only known-unverified addresses with one", async () => {
    const apass = new MemoryAPass();
    apass.gateOn = false;
    const book = new IdentityBook(apass);
    await book.refresh([CHEAP]);
    expect(book.gate()).toBeNull();
    expect(book.blocked(CHEAP)).toBe(false);

    apass.gateOn = true;
    await book.load();
    expect(book.blocked(CHEAP)).toBe(false); // not read yet: the facilitator still checks
    await book.refresh([CHEAP]);
    expect(book.blocked(CHEAP)).toBe(true);
  });
});
