/**
 * Cleanverse CVI, as the broker sees it.
 *
 * The rule itself lives on chain: with an identity gate set, XorvEscrow
 * refuses to fund a job unless both parties hold an active Cleanverse A-Pass,
 * and refuses to pay a provider whose A-Pass has since been frozen or revoked.
 * The broker only keeps that from surprising anyone. It reads the gate off the
 * escrow, caches each provider's standing, and leaves unverified providers out
 * of matching, because a buyer quoted one of them could never pay.
 */
import { IDENTITY_GATE_ABI, identityVerified, publicClientFor, readIdentityGate } from "@xorv/protocol";
import { getAddress, type Address, type PublicClient } from "viem";

export interface GateInfo {
  address: string;
  kind: "cleanverse";
  /** The A-Pass contract the gate defers to. */
  apass: string | null;
  validator: string | null;
  /** Validator pool whose compliance rules also apply; null for the A-Pass alone. */
  pool: string | null;
}

export interface IdentitySource {
  /** The escrow's gate, or null when anyone may transact. */
  gate(): Promise<GateInfo | null>;
  verified(addresses: string[]): Promise<boolean[]>;
}

const ZERO = /^0x0{40}$/i;

export function chainIdentity(network: string, escrow: string): IdentitySource {
  const pub = publicClientFor(network) as PublicClient;
  let gateAddress: Address | null | undefined;
  return {
    async gate() {
      gateAddress = await readIdentityGate(pub, getAddress(escrow));
      if (!gateAddress) return null;
      const view = (functionName: "apass" | "validator" | "pool") =>
        (pub.readContract({ address: gateAddress!, abi: IDENTITY_GATE_ABI, functionName }) as Promise<string>)
          .then((a) => (ZERO.test(a) ? null : a))
          .catch(() => null);
      const [apass, validator, pool] = await Promise.all([view("apass"), view("validator"), view("pool")]);
      return { address: gateAddress, kind: "cleanverse", apass, validator, pool };
    },
    async verified(addresses) {
      if (gateAddress === undefined) await this.gate();
      if (!gateAddress) return addresses.map(() => true);
      return identityVerified(pub, gateAddress, addresses.map((a) => getAddress(a)));
    },
  };
}

export interface Standing {
  verified: boolean;
  checkedAt: number;
}

/** The gate and each address's standing, refreshed in the background. */
export class IdentityBook {
  private info: GateInfo | null = null;
  private loaded = false;
  private readonly standing = new Map<string, Standing>();

  constructor(
    private readonly source: IdentitySource,
    private readonly opts: { log?: (msg: string) => void; now?: () => number } = {},
  ) {}

  /** Re-read the gate (the owner can set or clear it at any time). */
  async load(): Promise<GateInfo | null> {
    try {
      this.info = await this.source.gate();
      this.loaded = true;
    } catch (err) {
      this.opts.log?.(`identity gate read failed: ${(err as Error).message}`);
    }
    return this.info;
  }

  gate(): GateInfo | null {
    return this.info;
  }

  /** Standing for an address; null when there's no gate or it hasn't been read yet. */
  get(address: string): Standing | null {
    if (!this.info) return null;
    return this.standing.get(address.toLowerCase()) ?? null;
  }

  async refresh(addresses: string[]): Promise<void> {
    if (!this.loaded) await this.load();
    if (!this.info || addresses.length === 0) return;
    try {
      const results = await this.source.verified(addresses);
      const at = this.opts.now?.() ?? Date.now();
      addresses.forEach((a, i) => this.standing.set(a.toLowerCase(), { verified: results[i] ?? false, checkedAt: at }));
    } catch (err) {
      this.opts.log?.(`identity read failed: ${(err as Error).message}`);
    }
  }

  /**
   * True only when the gate is on and this address is known to be unverified.
   * An address not yet read is let through: the facilitator checks again
   * before anything is signed, and the escrow has the last word.
   */
  blocked(address: string): boolean {
    return this.get(address)?.verified === false;
  }
}
