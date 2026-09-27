import { describe, expect, it } from "vitest";
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET, jobIdHash, networkConfig, ratingTypedData } from "@xorv/protocol/web";
import { jsonSafeSigner, toWalletTypedData, type TypedDataInput } from "@/lib/typed-data";
import { payQuote, type PaymentSigner } from "@/lib/x402-pay";

/*
 * Privy's embedded wallet hands the typed data it is given to its sign modal,
 * which renders it with a bare `JSON.stringify(typedData, null, 2)` — so a
 * payload carrying bigints throws mid-render and takes the whole app down.
 *
 * `fakePrivy` below does exactly what that path does: stringify with no
 * replacer (the modal), then sign what comes out the other side of the JSON
 * boundary (the wallet). The raw x402 and rating payloads make it throw; the
 * JSON-safe form signs, and its signature is byte-for-byte viem's signature
 * over the original.
 */

const NETWORK = MONAD_TESTNET;
const cfg = networkConfig(NETWORK);
const BROKER = "http://broker.test";
const LEDGER = "0x1111111111111111111111111111111111111111";
const buyer = privateKeyToAccount(generatePrivateKey());
const PROVIDER = privateKeyToAccount(generatePrivateKey()).address;

const DOMAIN_FIELD_TYPES: Record<string, string> = {
  name: "string",
  version: "string",
  chainId: "uint256",
  verifyingContract: "address",
  salt: "bytes32",
};

/**
 * Privy's embedded path, step for step: fill in `EIP712Domain` from the
 * domain's own key order when the payload has none, render the payload with a
 * bare JSON.stringify (the sign modal), then sign what comes back out of JSON.
 */
function fakePrivy(account = buyer) {
  return async (input: unknown): Promise<Hex> => {
    const typedData = input as { domain: Record<string, unknown>; types: Record<string, unknown> };
    const EIP712Domain =
      typedData.types.EIP712Domain ??
      Object.entries(typedData.domain)
        .filter(([key, value]) => value != null && key in DOMAIN_FIELD_TYPES)
        .map(([key]) => ({ name: key, type: DOMAIN_FIELD_TYPES[key] }));
    const shown = JSON.stringify({ ...typedData, types: { ...typedData.types, EIP712Domain } }, null, 2);
    return account.signTypedData(JSON.parse(shown) as never);
  };
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

/** Capture the exact typed data @x402/evm asks a signer to sign for a quote. */
async function x402TypedData(): Promise<TypedDataInput> {
  let captured: TypedDataInput | null = null;
  const capture: PaymentSigner = {
    address: buyer.address,
    signTypedData: async (message) => {
      captured = message as unknown as TypedDataInput;
      return buyer.signTypedData(message as never);
    },
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.headers.get("PAYMENT-SIGNATURE")) {
      const offer = {
        scheme: "exact",
        network: NETWORK,
        asset: cfg.usdc.address,
        amount: "10000",
        payTo: PROVIDER,
        maxTimeoutSeconds: 300,
        extra: { name: cfg.usdc.name, version: cfg.usdc.version },
      };
      return new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": b64({ x402Version: 2, error: "Payment required", resource: { url: request.url }, accepts: [offer] }),
        },
      });
    }
    return new Response(JSON.stringify({ jobId: "job_1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  await payQuote({
    quote: { quoteId: "qte_1", network: NETWORK, usdcAmount: "10000", payTo: PROVIDER },
    signer: capture,
    network: NETWORK,
    brokerUrl: BROKER,
    fetch: fetchImpl,
  });
  if (!captured) throw new Error("x402 never asked for a signature");
  return captured;
}

function ratingPayload(): TypedDataInput {
  return ratingTypedData({
    network: NETWORK,
    ledger: LEDGER,
    rating: {
      jobId: jobIdHash("job_1"),
      value: 80,
      tag2: "claude-code",
      endpoint: "",
      feedbackURI: "https://broker.test/feedback/job_1.json",
      feedbackHash: `0x${"ab".repeat(32)}`,
      deadline: 1_900_000_000,
    },
  }) as unknown as TypedDataInput;
}

describe("toWalletTypedData (Privy signing)", () => {
  it("the raw payloads carry bigints and crash a JSON.stringify-ing wallet UI", async () => {
    const x402 = await x402TypedData();
    expect(typeof x402.message.value).toBe("bigint");
    await expect(fakePrivy()(x402)).rejects.toThrow(/BigInt/);
    await expect(fakePrivy()(ratingPayload())).rejects.toThrow(/BigInt/);
  });

  it("x402 TransferWithAuthorization: the JSON-safe form signs to viem's exact signature", async () => {
    const original = await x402TypedData();
    const expected = await buyer.signTypedData(original as never);

    const signature = await jsonSafeSigner(fakePrivy())(original);
    expect(signature).toBe(expected);
    expect(hashTypedData(JSON.parse(JSON.stringify(toWalletTypedData(original))) as never)).toBe(hashTypedData(original as never));
    expect(await recoverTypedDataAddress({ ...(original as unknown as Record<string, unknown>), signature } as never)).toBe(buyer.address);
  });

  it("XorvLedger Rating (int128 value, uint256 deadline): same signature too", async () => {
    const original = ratingPayload();
    const expected = await buyer.signTypedData(original as never);
    expect(await jsonSafeSigner(fakePrivy())(original)).toBe(expected);
  });

  it("keeps chainId a number and spells out EIP712Domain in canonical order", () => {
    const safe = toWalletTypedData(ratingPayload());
    expect(safe.domain.chainId).toBe(cfg.chainId);
    expect(safe.types.EIP712Domain.map((f) => f.name)).toEqual(["name", "version", "chainId", "verifyingContract"]);
    expect(safe.message.value).toBe("80");
    expect(safe.message.deadline).toBe("1900000000");
    // A bigint chainId (some callers build domains that way) becomes a number, not a string.
    const withBigChain = toWalletTypedData({ ...ratingPayload(), domain: { ...ratingPayload().domain, chainId: BigInt(cfg.chainId) } });
    expect(withBigChain.domain.chainId).toBe(cfg.chainId);
  });

  it("a domain built in a different key order still hashes the same (Privy derives the type from insertion order)", async () => {
    const original = ratingPayload();
    const { name, version, chainId, verifyingContract } = original.domain;
    const shuffled = { ...original, domain: { verifyingContract, chainId, version, name } };
    const expected = await buyer.signTypedData(original as never);
    expect(await jsonSafeSigner(fakePrivy())(shuffled)).toBe(expected);
    // Without the explicit domain type, the same payload signs a different digest.
    const { domain, types, primaryType, message } = toWalletTypedData(shuffled);
    const withoutDomainType = Object.fromEntries(Object.entries(types).filter(([name]) => name !== "EIP712Domain"));
    expect(await fakePrivy()({ domain, types: withoutDomainType, primaryType, message })).not.toBe(expected);
  });
});
