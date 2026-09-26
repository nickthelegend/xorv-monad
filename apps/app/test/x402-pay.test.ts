import { describe, expect, it } from "vitest";
import { getAddress, verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MONAD_MAINNET, MONAD_TESTNET, networkConfig } from "@xorv/protocol/web";
import {
  PaymentError,
  classifyPaymentError,
  decodeX402Header,
  describeRefusal,
  failureFromResponse,
  payQuote,
  payableQuote,
  refusalReason,
  type PaymentSigner,
} from "@/lib/x402-pay";

/*
 * Everything here runs offline: the broker is a mocked fetch that answers the
 * way the x402 Hono middleware does, and a local viem key stands in for the
 * Privy / injected wallet. The signature it produces is real, so the tests can
 * recover the signer and check exactly what was authorized.
 */

const NETWORK = MONAD_TESTNET;
const cfg = networkConfig(NETWORK);
const BROKER = "http://broker.test";
const PROVIDER = privateKeyToAccount(generatePrivateKey()).address;
const OTHER = privateKeyToAccount(generatePrivateKey()).address;

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

function requirement(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: cfg.usdc.address,
    amount: "10000",
    payTo: PROVIDER,
    maxTimeoutSeconds: 300,
    extra: { name: cfg.usdc.name, version: cfg.usdc.version },
    ...overrides,
  };
}

function paymentRequired(accepts: unknown[], error = "Payment required") {
  return { x402Version: 2, error, resource: { url: `${BROKER}/api/jobs/qte_1`, mimeType: "application/json" }, accepts };
}

const quote = { quoteId: "qte_1", network: NETWORK, usdcAmount: "10000", payTo: PROVIDER };

interface Seen {
  calls: number;
  paymentHeader: string | null;
}

/**
 * A broker that 402s the first POST with `offer`, then answers the paid retry
 * with `second(payload)`.
 */
function mockBroker(
  offer: unknown[],
  second: (payload: Record<string, unknown>) => Response,
): { fetch: typeof fetch; seen: Seen } {
  const seen: Seen = { calls: 0, paymentHeader: null };
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    seen.calls += 1;
    expect(request.url).toBe(`${BROKER}/api/jobs/qte_1`);
    expect(request.method).toBe("POST");
    const header = request.headers.get("PAYMENT-SIGNATURE");
    if (!header) {
      return new Response(JSON.stringify({ error: "payment required" }), {
        status: 402,
        headers: { "PAYMENT-REQUIRED": b64(paymentRequired(offer)), "Content-Type": "application/json" },
      });
    }
    seen.paymentHeader = header;
    return second(JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>);
  };
  return { fetch: impl as typeof fetch, seen };
}

const settled = (tx: string, payer: string) =>
  new Response(JSON.stringify({ jobId: "job_1", status: "paid" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-RESPONSE": b64({ success: true, transaction: tx, network: NETWORK, payer }),
    },
  });

describe("decodeX402Header / refusalReason", () => {
  it("decodes base64 JSON, including the URL-safe alphabet and utf-8", () => {
    const header = b64({ error: "invalid_exact_evm_insufficient_balance", note: "ünïcode" });
    expect(decodeX402Header(header)).toEqual({ error: "invalid_exact_evm_insufficient_balance", note: "ünïcode" });
    const urlSafe = header.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeX402Header(urlSafe)?.note).toBe("ünïcode");
  });

  it("returns null for garbage rather than throwing", () => {
    expect(decodeX402Header(null)).toBeNull();
    expect(decodeX402Header("")).toBeNull();
    expect(decodeX402Header("not base64 !!")).toBeNull();
    expect(decodeX402Header(Buffer.from("[1,2]").toString("base64"))).toBeNull();
  });

  it("reads the reason from PAYMENT-REQUIRED, ignoring the generic first-402 text", () => {
    const headers = (entries: Record<string, string>) => new Headers(entries);
    expect(refusalReason(headers({ "PAYMENT-REQUIRED": b64(paymentRequired([], "Payment required")) }))).toBeNull();
    expect(refusalReason(headers({ "PAYMENT-REQUIRED": b64({ error: "invalid_exact_evm_signature" }) }))).toBe(
      "invalid_exact_evm_signature",
    );
    // `errorReason` and `invalidReason` spellings both count; a detail is appended.
    expect(refusalReason(headers({ "PAYMENT-REQUIRED": b64({ errorReason: "x_code" }) }))).toBe("x_code");
    expect(
      refusalReason(headers({ "PAYMENT-REQUIRED": b64({ invalidReason: "y_code", invalidMessage: "because" }) })),
    ).toBe("y_code: because");
  });

  it("reads a failed settlement from PAYMENT-RESPONSE, but not a successful one", () => {
    expect(
      refusalReason(new Headers({ "PAYMENT-RESPONSE": b64({ success: false, errorReason: "invalid_exact_evm_transaction_failed" }) })),
    ).toBe("invalid_exact_evm_transaction_failed");
    expect(refusalReason(new Headers({ "PAYMENT-RESPONSE": b64({ success: true, transaction: "0x1" }) }))).toBeNull();
  });
});

describe("describeRefusal / failureFromResponse / classifyPaymentError", () => {
  it("maps facilitator codes to actionable kinds", () => {
    expect(describeRefusal("invalid_exact_evm_insufficient_balance").kind).toBe("insufficient_funds");
    expect(describeRefusal("invalid_exact_evm_payload_authorization_valid_before").kind).toBe("authorization_expired");
    expect(describeRefusal("invalid_exact_evm_recipient_mismatch").kind).toBe("quote_mismatch");
    expect(describeRefusal("invalid_exact_evm_token_name_mismatch").kind).toBe("signature");
    expect(describeRefusal("invalid_exact_evm_transaction_simulation_failed").kind).toBe("settlement_failed");
    const unknown = describeRefusal("something_new");
    expect(unknown.kind).toBe("unknown");
    expect(unknown.message).toContain("something_new");
  });

  it("keeps the code in the message for debugging", () => {
    expect(describeRefusal("invalid_exact_evm_insufficient_balance").message).toContain(
      "(invalid_exact_evm_insufficient_balance)",
    );
  });

  it("classifies broker statuses when there is no x402 reason", () => {
    expect(failureFromResponse(404, { error: "quote not found or expired" }, null).kind).toBe("quote_expired");
    expect(failureFromResponse(409, { error: "this quote has already been paid" }, null).kind).toBe("already_paid");
    expect(failureFromResponse(409, { error: "the quoted provider went offline" }, null).kind).toBe("provider_offline");
    expect(failureFromResponse(500, null, null).message).toContain("500");
    // An x402 reason always wins over the status.
    expect(failureFromResponse(402, { error: "x" }, "invalid_exact_evm_insufficient_balance").kind).toBe(
      "insufficient_funds",
    );
  });

  it("recognises a declined signature through the fetch wrapper's rewrapping", () => {
    const eip1193 = Object.assign(new Error("User rejected the request."), { code: 4001 });
    expect(classifyPaymentError(eip1193).kind).toBe("rejected");
    expect(classifyPaymentError(new Error("Failed to create payment payload: User rejected the request.")).kind).toBe(
      "rejected",
    );
    const nested = new Error("outer", { cause: { name: "UserRejectedRequestError" } });
    expect(classifyPaymentError(nested).kind).toBe("rejected");
  });

  it("recognises the quote-match policy refusing to sign", () => {
    const err = new Error("Failed to create payment payload: the 402 does not match the quote (…) — refusing to sign");
    expect(classifyPaymentError(err).kind).toBe("quote_mismatch");
  });
});

describe("payableQuote", () => {
  const base = {
    quoteId: "qte_1",
    network: NETWORK,
    usdcAmount: "10000",
    provider: { address: PROVIDER } as never,
    accepts: [requirement() as never],
  };

  it("takes the payee and amount the buyer was shown", () => {
    expect(payableQuote(base)).toEqual(quote);
  });

  it("refuses a quote whose accepts disagree with its display", () => {
    expect(() => payableQuote({ ...base, accepts: [requirement({ payTo: OTHER }) as never] })).toThrow(PaymentError);
    expect(() => payableQuote({ ...base, accepts: [requirement({ amount: "20000" }) as never] })).toThrow(/inconsistent/);
  });
});

describe("payQuote", () => {
  it("signs an EIP-3009 authorization for exactly the quote and returns the settlement", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    const tx = `0x${"ab".repeat(32)}`;
    let authorized: Record<string, string> | null = null;

    const { fetch, seen } = mockBroker([requirement()], (payload) => {
      const inner = payload.payload as { authorization: Record<string, string>; signature: Hex };
      authorized = inner.authorization;
      expect(payload.x402Version).toBe(2);
      return settled(tx, buyer.address);
    });

    const result = await payQuote({ quote, signer: buyer, network: NETWORK, brokerUrl: `${BROKER}/`, fetch });

    expect(result).toEqual({
      jobId: "job_1",
      txHash: tx,
      payer: buyer.address,
      explorerUrl: `${cfg.explorerUrl}/tx/${tx}`,
    });
    expect(seen.calls).toBe(2);
    const auth = authorized as unknown as Record<string, string>;
    expect(getAddress(auth.from!)).toBe(buyer.address);
    expect(getAddress(auth.to!)).toBe(PROVIDER);
    expect(auth.value).toBe("10000");
    expect(auth.validAfter).toBe("0");
    const now = Math.floor(Date.now() / 1000);
    expect(Number(auth.validBefore)).toBeGreaterThan(now + 290);
    expect(Number(auth.validBefore)).toBeLessThanOrEqual(now + 301);
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it("produces a signature that recovers to the buyer under USDC's Monad domain", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    let payload: { authorization: Record<string, string>; signature: Hex } | null = null;
    const { fetch } = mockBroker([requirement()], (p) => {
      payload = p.payload as typeof payload;
      return settled(`0x${"cd".repeat(32)}`, buyer.address);
    });
    await payQuote({ quote, signer: buyer, network: NETWORK, brokerUrl: BROKER, fetch });

    const { authorization: a, signature } = payload!;
    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    } as const;
    const message = {
      from: getAddress(a.from!),
      to: getAddress(a.to!),
      value: BigInt(a.value!),
      validAfter: BigInt(a.validAfter!),
      validBefore: BigInt(a.validBefore!),
      nonce: a.nonce as Hex,
    };
    const domain = { name: "USDC", version: "2", chainId: 10143, verifyingContract: cfg.usdc.address };
    expect(
      await verifyTypedData({ address: buyer.address, domain, types, primaryType: "TransferWithAuthorization", message, signature }),
    ).toBe(true);
    // The wrong domain name ("USD Coin" is Circle's name elsewhere) must not verify.
    expect(
      await verifyTypedData({
        address: buyer.address,
        domain: { ...domain, name: "USD Coin" },
        types,
        primaryType: "TransferWithAuthorization",
        message,
        signature,
      }),
    ).toBe(false);
  });

  it("delegates to the signer and never needs a key", async () => {
    const real = privateKeyToAccount(generatePrivateKey());
    const calls: string[] = [];
    // What a Privy account or wallet-client adapter looks like from here.
    const signer: PaymentSigner = {
      address: real.address,
      signTypedData: async (message) => {
        calls.push(message.primaryType);
        return real.signTypedData(message as never);
      },
    };
    const { fetch } = mockBroker([requirement()], () => settled(`0x${"01".repeat(32)}`, real.address));
    await payQuote({ quote, signer, network: NETWORK, brokerUrl: BROKER, fetch });
    expect(calls).toEqual(["TransferWithAuthorization"]);
  });

  it("refuses to sign when the 402 swaps the payee", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    let signed = false;
    const signer: PaymentSigner = {
      address: buyer.address,
      signTypedData: async (m) => {
        signed = true;
        return buyer.signTypedData(m as never);
      },
    };
    const { fetch, seen } = mockBroker([requirement({ payTo: OTHER })], () => settled("0x", buyer.address));
    const err = await payQuote({ quote, signer, network: NETWORK, brokerUrl: BROKER, fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentError);
    expect((err as PaymentError).kind).toBe("quote_mismatch");
    expect(signed).toBe(false);
    expect(seen.calls).toBe(1);
  });

  it("refuses to sign when the 402 bumps the price", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    const { fetch, seen } = mockBroker([requirement({ amount: "10001" })], () => settled("0x", buyer.address));
    const err = await payQuote({ quote, signer: buyer, network: NETWORK, brokerUrl: BROKER, fetch }).catch((e: unknown) => e);
    expect((err as PaymentError).kind).toBe("quote_mismatch");
    expect(seen.calls).toBe(1);
  });

  it("surfaces the facilitator's refusal from the retried 402's header", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    const { fetch } = mockBroker(
      [requirement()],
      () =>
        new Response(JSON.stringify({ error: "payment required" }), {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": b64(paymentRequired([requirement()], "invalid_exact_evm_insufficient_balance")),
          },
        }),
    );
    const err = await payQuote({ quote, signer: buyer, network: NETWORK, brokerUrl: BROKER, fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentError);
    expect((err as PaymentError).kind).toBe("insufficient_funds");
    expect((err as PaymentError).reason).toBe("invalid_exact_evm_insufficient_balance");
  });

  it("reports a declined signature as 'rejected'", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    const signer: PaymentSigner = {
      address: buyer.address,
      signTypedData: async () => {
        throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      },
    };
    const { fetch, seen } = mockBroker([requirement()], () => settled("0x", buyer.address));
    const err = await payQuote({ quote, signer, network: NETWORK, brokerUrl: BROKER, fetch }).catch((e: unknown) => e);
    expect((err as PaymentError).kind).toBe("rejected");
    expect(seen.calls).toBe(1);
  });

  it("treats a missing settle header as paid, with no tx to show", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    const { fetch } = mockBroker([requirement()], () => new Response(JSON.stringify({ jobId: "job_9" }), { status: 200 }));
    const result = await payQuote({ quote, signer: buyer, network: NETWORK, brokerUrl: BROKER, fetch });
    expect(result).toMatchObject({ jobId: "job_9", txHash: null, explorerUrl: null, payer: buyer.address });
  });

  it("maps an expired quote to 'quote_expired' without signing", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    const fetch = (async () =>
      new Response(JSON.stringify({ error: "quote not found or expired — request a new one" }), { status: 404 })) as typeof globalThis.fetch;
    const err = await payQuote({ quote, signer: buyer, network: NETWORK, brokerUrl: BROKER, fetch }).catch((e: unknown) => e);
    expect((err as PaymentError).kind).toBe("quote_expired");
  });

  it("refuses a quote priced on another network", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    const err = await payQuote({
      quote: { ...quote, network: MONAD_MAINNET },
      signer: buyer,
      network: NETWORK,
      brokerUrl: BROKER,
      fetch: (() => {
        throw new Error("must not be called");
      }) as never,
    }).catch((e: unknown) => e);
    expect((err as PaymentError).kind).toBe("wrong_network");
  });
});
