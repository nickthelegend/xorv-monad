import { describe, expect, it } from "vitest";
import { verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET, jobIdHash, networkConfig, ratingTypedData, toJsonSafe } from "@xorv/protocol/web";
import {
  RatingError,
  fetchRatingRequest,
  rateJob,
  starsToValue,
  submitRating,
  valueToStars,
  verifyRatingRequest,
  type RatingSigner,
} from "@/lib/rating";

/*
 * The broker is a mocked fetch that proposes the typed data the way
 * `GET /api/jobs/:id/rating?value=` does; a local viem key stands in for the
 * buyer's Privy wallet. Offline, and the signatures are real.
 */

const NETWORK = MONAD_TESTNET;
const cfg = networkConfig(NETWORK);
const BROKER = "http://broker.test";
const LEDGER = privateKeyToAccount(generatePrivateKey()).address;
const JOB = "job_abc123";
const future = () => Math.floor(Date.now() / 1000) + 600;

function proposal(overrides: { value?: number; jobId?: string; deadline?: number; ledger?: string } = {}) {
  const typed = ratingTypedData({
    network: NETWORK,
    ledger: overrides.ledger ?? LEDGER,
    rating: {
      jobId: jobIdHash(overrides.jobId ?? JOB),
      value: overrides.value ?? 80,
      tag2: "claude-code",
      endpoint: "https://node.example",
      feedbackURI: `${BROKER}/feedback/${JOB}.json`,
      feedbackHash: `0x${"11".repeat(32)}`,
      deadline: overrides.deadline ?? future(),
    },
  });
  // Over the wire: bigints become decimal strings.
  return toJsonSafe(typed) as Record<string, unknown>;
}

describe("stars ↔ value", () => {
  it("maps 1–5 stars onto the ERC-8004 0–100 scale", () => {
    expect([1, 2, 3, 4, 5].map(starsToValue)).toEqual([20, 40, 60, 80, 100]);
    expect(valueToStars(100)).toBe(5);
    expect(valueToStars(80)).toBe(4);
    expect(valueToStars(0)).toBe(0);
  });

  it("rejects out-of-range stars", () => {
    expect(() => starsToValue(0)).toThrow();
    expect(() => starsToValue(6)).toThrow();
    expect(() => starsToValue(Number.NaN)).toThrow();
  });
});

describe("verifyRatingRequest", () => {
  const expectFor = { jobId: JOB, value: 80, network: NETWORK, ledger: LEDGER };

  it("accepts the broker's proposal and rebuilds it canonically", () => {
    const { typedData, deadline } = verifyRatingRequest({ typedData: proposal() }, expectFor);
    expect(typedData.domain).toEqual({ name: "XorvLedger", version: "1", chainId: cfg.chainId, verifyingContract: LEDGER });
    expect(typedData.primaryType).toBe("Rating");
    expect(typedData.message.value).toBe(80n);
    expect(typedData.message.jobId).toBe(jobIdHash(JOB));
    expect(deadline).toBe(typedData.message.deadline.toString());
  });

  it("accepts a bare typed-data body and the raw {ledger, rating} form", () => {
    expect(() => verifyRatingRequest(proposal(), expectFor)).not.toThrow();
    const typed = proposal();
    expect(() => verifyRatingRequest({ ledger: LEDGER, rating: typed.message }, expectFor)).not.toThrow();
  });

  it("refuses someone else's job", () => {
    expect(() => verifyRatingRequest(proposal({ jobId: "job_other" }), expectFor)).toThrow(/different job/);
  });

  it("refuses a different score than the buyer chose", () => {
    expect(() => verifyRatingRequest(proposal({ value: 100 }), expectFor)).toThrow(/you chose 80/);
  });

  it("refuses another chain and another ledger", () => {
    const wrongChain = proposal();
    (wrongChain.domain as Record<string, unknown>).chainId = 143;
    expect(() => verifyRatingRequest(wrongChain, expectFor)).toThrow(/chain 143/);
    const other = privateKeyToAccount(generatePrivateKey()).address;
    expect(() => verifyRatingRequest(proposal({ ledger: other }), expectFor)).toThrow(/network's ledger/);
    // Without a known ledger the proposal's own contract is used.
    expect(() => verifyRatingRequest(proposal({ ledger: other }), { ...expectFor, ledger: null })).not.toThrow();
  });

  it("refuses a non-XorvLedger domain or a non-Rating primary type", () => {
    const wrongName = proposal();
    (wrongName.domain as Record<string, unknown>).name = "USDC";
    expect(() => verifyRatingRequest(wrongName, expectFor)).toThrow(/XorvLedger/);
    expect(() => verifyRatingRequest({ ...proposal(), primaryType: "TransferWithAuthorization" }, expectFor)).toThrow(
      /expected a Rating/,
    );
  });

  it("refuses an expired deadline", () => {
    expect(() => verifyRatingRequest(proposal({ deadline: 1000 }), expectFor)).toThrow(/window/);
  });

  it("refuses an empty or malformed body", () => {
    expect(() => verifyRatingRequest(null, expectFor)).toThrow(RatingError);
    const bad = proposal();
    (bad.message as Record<string, unknown>).feedbackHash = "0x12";
    expect(() => verifyRatingRequest(bad, expectFor)).toThrow(/malformed/);
  });
});

describe("rateJob", () => {
  function mockBroker(opts: { propose?: Record<string, unknown>; relay?: (body: Record<string, unknown>) => Response } = {}) {
    const seen: { get?: string; post?: Record<string, unknown> } = {};
    const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!init?.method || init.method === "GET") {
        seen.get = url;
        return new Response(JSON.stringify({ typedData: opts.propose ?? proposal() }), { status: 200 });
      }
      expect(url).toBe(`${BROKER}/api/jobs/${JOB}/rate`);
      seen.post = JSON.parse(String(init.body)) as Record<string, unknown>;
      return (
        opts.relay?.(seen.post) ??
        new Response(JSON.stringify({ txHash: `0x${"ee".repeat(32)}`, feedbackURI: `${BROKER}/feedback/${JOB}.json` }), {
          status: 200,
        })
      );
    };
    return { fetch: impl as typeof fetch, seen };
  }

  it("signs the verified typed data as the buyer and relays it — no gas, one signature", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    const { fetch, seen } = mockBroker();
    const receipt = await rateJob({ brokerUrl: BROKER, jobId: JOB, value: 80, network: NETWORK, ledger: LEDGER, signer: buyer, fetch });

    expect(seen.get).toBe(`${BROKER}/api/jobs/${JOB}/rating?value=80`);
    expect(seen.post).toMatchObject({ value: 80 });
    const typed = verifyRatingRequest({ typedData: proposal() }, { jobId: JOB, value: 80, network: NETWORK });
    expect(seen.post!.deadline).toMatch(/^\d+$/);
    const valid = await verifyTypedData({
      ...typed.typedData,
      message: { ...typed.typedData.message, deadline: BigInt(seen.post!.deadline as string) },
      address: buyer.address,
      signature: seen.post!.signature as Hex,
    });
    expect(valid).toBe(true);
    expect(receipt).toEqual({
      value: 80,
      txHash: `0x${"ee".repeat(32)}`,
      explorerUrl: `${cfg.explorerUrl}/tx/0x${"ee".repeat(32)}`,
      feedbackURI: `${BROKER}/feedback/${JOB}.json`,
    });
  });

  it("never signs a proposal that fails verification", async () => {
    let signed = false;
    const buyer = privateKeyToAccount(generatePrivateKey());
    const signer: RatingSigner = {
      address: buyer.address,
      signTypedData: async (td) => {
        signed = true;
        return buyer.signTypedData(td);
      },
    };
    const { fetch, seen } = mockBroker({ propose: proposal({ value: 20 }) });
    await expect(rateJob({ brokerUrl: BROKER, jobId: JOB, value: 80, network: NETWORK, signer, fetch })).rejects.toThrow(
      RatingError,
    );
    expect(signed).toBe(false);
    expect(seen.post).toBeUndefined();
  });

  it("marks a declined signature as rejected and sends nothing", async () => {
    const signer: RatingSigner = {
      address: privateKeyToAccount(generatePrivateKey()).address,
      signTypedData: async () => {
        throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      },
    };
    const { fetch, seen } = mockBroker();
    const err = await rateJob({ brokerUrl: BROKER, jobId: JOB, value: 80, network: NETWORK, signer, fetch }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RatingError);
    expect((err as RatingError).rejected).toBe(true);
    expect(seen.post).toBeUndefined();
  });

  it("passes the broker's refusal through", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    const { fetch } = mockBroker({
      relay: () => new Response(JSON.stringify({ error: "this job has already been rated" }), { status: 409 }),
    });
    await expect(
      rateJob({ brokerUrl: BROKER, jobId: JOB, value: 80, network: NETWORK, signer: buyer, fetch }),
    ).rejects.toThrow("this job has already been rated");
  });

  it("reports the broker's error on the proposal step", async () => {
    const fetch = (async () => new Response(JSON.stringify({ error: "only completed jobs can be rated" }), { status: 409 })) as typeof globalThis.fetch;
    await expect(fetchRatingRequest({ brokerUrl: BROKER, jobId: JOB, value: 80, network: NETWORK, fetch })).rejects.toThrow(
      "only completed jobs can be rated",
    );
  });

  it("reads the relay tx from the nested or alternate spellings", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ rating: { txHash: "0xabc", feedbackURI: "https://f" } }), { status: 200 })) as typeof globalThis.fetch;
    const receipt = await submitRating({
      brokerUrl: BROKER,
      jobId: JOB,
      value: 60,
      network: NETWORK,
      deadline: "1",
      signature: "0x00",
      fetch,
    });
    expect(receipt).toMatchObject({ value: 60, txHash: "0xabc", feedbackURI: "https://f" });
  });
});
