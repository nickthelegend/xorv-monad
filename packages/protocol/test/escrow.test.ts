import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, type Address, type PublicClient } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  ESCROW_SCHEME,
  EscrowClientScheme,
  EscrowFacilitatorScheme,
  FUNDING_NONCE_TYPEHASH,
  escrowJobId,
  fundingNonce,
  parseEscrowExtra,
  type EscrowPayload,
} from "../src/escrow.js";

const ESCROW = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const USDG = "0xFFC95faa3d63Cde504a05B567C600B78C0b41892" as Address;
const PROVIDER = "0xff212ecb82E3b06c0a2A7a9Ce343e0a1868c489B" as Address;
const buyer = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const NOW = 1_800_000_000_000; // ms
const DEADLINE = 1_800_001_800;

function requirements(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: ESCROW_SCHEME,
    network: "eip155:421614",
    asset: USDG,
    amount: "250000",
    payTo: ESCROW,
    maxTimeoutSeconds: 300,
    extra: {
      name: "Global Dollar",
      version: "1",
      escrow: ESCROW,
      jobId: escrowJobId("q_123"),
      deadline: DEADLINE,
      provider: PROVIDER,
    },
    ...over,
  };
}

async function signedPayload(req = requirements()): Promise<PaymentPayload> {
  const client = new EscrowClientScheme(buyer, { now: () => NOW });
  const result = await client.createPaymentPayload(2, req);
  return { x402Version: 2, accepted: req, payload: result.payload };
}

/** A public client that answers the facilitator's reads from a script. */
function fakePublic(state: {
  balance?: bigint;
  used?: boolean;
  allowed?: boolean;
  jobStatus?: number;
}): PublicClient {
  return {
    verifyTypedData: (args: Parameters<typeof verifyTypedData>[0]) => verifyTypedData(args),
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "balanceOf":
          return state.balance ?? 10_000_000n;
        case "authorizationState":
          return state.used ?? false;
        case "tokenAllowed":
          return state.allowed ?? true;
        case "getJob":
          return { status: state.jobStatus ?? 0 };
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
  } as unknown as PublicClient;
}

function facilitator(state: Parameters<typeof fakePublic>[0] = {}) {
  return new EscrowFacilitatorScheme(
    { public: fakePublic(state), wallet: { account: undefined } as never },
    { now: () => NOW },
  );
}

describe("fundingNonce", () => {
  it("matches the Solidity derivation byte for byte", () => {
    // Vector computed independently with `cast abi-encode` + `cast keccak`.
    expect(FUNDING_NONCE_TYPEHASH).toBe(
      "0xa14b469f1309f59441d2220e88466e0a08887bf463c50943f38c74f7eb456b45",
    );
    expect(escrowJobId("q_123")).toBe(
      "0x403d34b7a3fa0bc80a0ec9797fb41902c153042e27dfbc3dd7cf020fa030c063",
    );
    expect(
      fundingNonce({ chainId: 421614, escrow: ESCROW, jobId: escrowJobId("q_123"), deadline: DEADLINE }),
    ).toBe("0xcddd41b3a14cd1e1682f7f17e018c2949177ce2b51498433e7abb06ac5da2ddc");
  });

  it("changes with the chain, the job and the deadline", () => {
    const base = { chainId: 421614, escrow: ESCROW, jobId: escrowJobId("a"), deadline: DEADLINE };
    const n = fundingNonce(base);
    expect(fundingNonce({ ...base, chainId: 46630 })).not.toBe(n);
    expect(fundingNonce({ ...base, jobId: escrowJobId("b") })).not.toBe(n);
    expect(fundingNonce({ ...base, deadline: DEADLINE + 1 })).not.toBe(n);
  });
});

describe("EscrowClientScheme", () => {
  it("signs a ReceiveWithAuthorization to the escrow with the job's nonce", async () => {
    const p = await signedPayload();
    const body = p.payload as unknown as EscrowPayload;
    expect(body.authorization.to).toBe(ESCROW);
    expect(body.authorization.value).toBe("250000");
    expect(body.authorization.validBefore).toBe(String(NOW / 1000 + 300));
    expect(body.authorization.nonce).toBe(
      fundingNonce({ chainId: 421614, escrow: ESCROW, jobId: escrowJobId("q_123"), deadline: DEADLINE }),
    );
  });

  it("refuses when payTo is not the escrow named in extra", async () => {
    const client = new EscrowClientScheme(buyer, { now: () => NOW });
    await expect(
      client.createPaymentPayload(2, requirements({ payTo: PROVIDER })),
    ).rejects.toThrow(/payTo is not the escrow/);
  });

  it("refuses a job whose refund deadline has passed", async () => {
    const client = new EscrowClientScheme(buyer, { now: () => (DEADLINE + 1) * 1000 });
    await expect(client.createPaymentPayload(2, requirements())).rejects.toThrow(/deadline/);
  });

  it("ignores any nonce a server tries to supply", async () => {
    const req = requirements();
    (req.extra as Record<string, unknown>).nonce = "0x" + "11".repeat(32);
    const body = (await signedPayload(req)).payload as unknown as EscrowPayload;
    expect(body.authorization.nonce).not.toBe("0x" + "11".repeat(32));
  });
});

describe("parseEscrowExtra", () => {
  it("names the malformed field", () => {
    expect(() => parseEscrowExtra({ ...requirements().extra, jobId: "0x12" })).toThrow(/jobId/);
    expect(() => parseEscrowExtra({ ...requirements().extra, escrow: "nope" })).toThrow(/escrow/);
    expect(() => parseEscrowExtra({ ...requirements().extra, version: undefined })).toThrow(/version/);
  });
});

describe("EscrowFacilitatorScheme.verify", () => {
  it("accepts a well-formed, funded, unused authorization", async () => {
    const p = await signedPayload();
    const v = await facilitator().verify(p, requirements());
    expect(v).toEqual({ isValid: true, payer: buyer.address });
  });

  it("rejects a signature from someone else", async () => {
    const p = await signedPayload();
    const body = p.payload as unknown as EscrowPayload;
    const other = privateKeyToAccount(
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    );
    body.authorization.from = other.address;
    const v = await facilitator().verify(p, requirements());
    expect(v.invalidReason).toBe("invalid_signature");
  });

  it("rejects a payload whose nonce doesn't bind this job", async () => {
    const p = await signedPayload();
    const other = requirements();
    (other.extra as Record<string, unknown>).jobId = escrowJobId("q_other");
    const v = await facilitator().verify({ ...p, accepted: other }, other);
    expect(v.invalidReason).toBe("invalid_nonce");
  });

  it("rejects a moved refund deadline", async () => {
    const p = await signedPayload();
    const other = requirements();
    (other.extra as Record<string, unknown>).deadline = DEADLINE + 86_400;
    const v = await facilitator().verify({ ...p, accepted: other }, other);
    expect(v.invalidReason).toBe("invalid_nonce");
  });

  it("rejects an underpayment", async () => {
    const p = await signedPayload();
    const req = requirements({ amount: "500000" });
    const v = await facilitator().verify({ ...p, accepted: req }, req);
    expect(v.invalidReason).toBe("invalid_amount");
  });

  it("rejects when the buyer can't cover it", async () => {
    const v = await facilitator({ balance: 1n }).verify(await signedPayload(), requirements());
    expect(v.invalidReason).toBe("insufficient_funds");
  });

  it("rejects a job the escrow already holds", async () => {
    const v = await facilitator({ jobStatus: 1 }).verify(await signedPayload(), requirements());
    expect(v.invalidReason).toBe("job_exists");
  });

  it("rejects a used authorization", async () => {
    const v = await facilitator({ used: true }).verify(await signedPayload(), requirements());
    expect(v.invalidReason).toBe("nonce_already_used");
  });

  it("rejects a token the escrow doesn't accept", async () => {
    const v = await facilitator({ allowed: false }).verify(await signedPayload(), requirements());
    expect(v.invalidReason).toBe("asset_not_allowed");
  });

  it("rejects an expired authorization", async () => {
    const p = await signedPayload();
    const late = new EscrowFacilitatorScheme(
      { public: fakePublic({}), wallet: { account: undefined } as never },
      { now: () => NOW + 400_000 },
    );
    const v = await late.verify(p, requirements());
    expect(v.invalidReason).toBe("authorization_expired");
  });

  it("refuses to fund any escrow but the one it was configured with", async () => {
    const pinned = new EscrowFacilitatorScheme(
      { public: fakePublic({}), wallet: { account: undefined } as never },
      { now: () => NOW, escrow: "0x000000000000000000000000000000000000dEaD" },
    );
    const v = await pinned.verify(await signedPayload(), requirements());
    expect(v.invalidReason).toBe("unknown_escrow");
    const ok = new EscrowFacilitatorScheme(
      { public: fakePublic({}), wallet: { account: undefined } as never },
      { now: () => NOW, escrow: ESCROW },
    );
    expect((await ok.verify(await signedPayload(), requirements())).isValid).toBe(true);
  });

  it("rejects the exact scheme's payload shape posing as escrow", async () => {
    const p = await signedPayload();
    const v = await facilitator().verify(
      { ...p, accepted: { ...requirements(), scheme: "exact" } },
      requirements(),
    );
    expect(v.invalidReason).toBe("unsupported_scheme");
  });
});

