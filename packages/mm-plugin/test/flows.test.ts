import { describe, expect, it } from "vitest";
import { BrokerClient } from "../src/lib/broker.js";
import { runJob } from "../src/lib/flows.js";
import { watchJob } from "../src/lib/job.js";
import { rateJob, verifyRatingRequest } from "../src/lib/rate.js";
import { activeEvmAddress } from "../src/lib/wallet.js";
import {
  ATTACKER_ADDRESS,
  BROKER_URL,
  JOB_ID,
  OTHER,
  PAYER,
  fakeBroker,
  fakeMetaMask,
  job,
  networkInfo,
  ratingRequestFor,
  SETTLE_TX,
} from "./helpers.js";

const client = (broker: ReturnType<typeof fakeBroker>) => new BrokerClient({ baseUrl: BROKER_URL, fetch: broker.fetch });

describe("watchJob", () => {
  it("follows the SSE stream to `done` and relays provider events", async () => {
    const broker = fakeBroker();
    const events: string[] = [];
    const statuses: string[] = [];
    const final = await watchJob({
      broker: client(broker),
      jobId: JOB_ID,
      timeoutMs: 5_000,
      onEvent: (e) => events.push(e.text),
      onStatus: (s) => statuses.push(s),
    });
    expect(final.status).toBe("completed");
    expect(events).toEqual(["Drafting the haiku…"]);
    expect(statuses).toEqual(["running", "completed"]);
  });

  it("falls back to polling when the stream is unavailable, without replaying events twice", async () => {
    const running = job({ status: "running", result: null, events: [{ at: 1, kind: "message", text: "step 1" }] });
    const done = job({
      events: [
        { at: 1, kind: "message", text: "step 1" },
        { at: 2, kind: "tool_call", text: "ran tests" },
      ],
    });
    const broker = fakeBroker({ stream: "fail", polls: [running, running, done] });
    const events: string[] = [];
    const final = await watchJob({
      broker: client(broker),
      jobId: JOB_ID,
      timeoutMs: 60_000,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      onEvent: (e) => events.push(e.text),
    });
    expect(final.status).toBe("completed");
    expect(events).toEqual(["step 1", "ran tests"]);
  });

  it("gives up at the deadline with the job id to check later", async () => {
    const broker = fakeBroker({ stream: "fail", polls: [job({ status: "running", result: null })] });
    let clock = 0;
    await expect(
      watchJob({
        broker: client(broker),
        jobId: JOB_ID,
        timeoutMs: 10_000,
        pollIntervalMs: 4_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toMatchObject({ code: "XORV_JOB_TIMEOUT", hint: expect.stringContaining(`mm xorv job ${JOB_ID}`) });
  });
});

describe("runJob after payment", () => {
  it("keeps the settlement link when the wait times out", async () => {
    const broker = fakeBroker({ stream: "fail", polls: [job({ status: "running", result: null })] });
    const mm = fakeMetaMask();
    await expect(
      runJob(
        {
          broker: client(broker),
          executor: async () => mm.executor,
          walletState: () => ({ byokWallets: [{ address: PAYER.address }] }),
          publicClient: () => null,
        },
        { prompt: "x", maxPriceUsdMicros: 50_000, timeoutSeconds: 0.001 },
      ),
    ).rejects.toMatchObject({
      code: "XORV_JOB_TIMEOUT",
      message: expect.stringContaining(`https://testnet.monadvision.com/tx/${SETTLE_TX}`),
      hint: expect.stringContaining(`mm xorv job ${JOB_ID}`),
    });
    expect(broker.payments).toHaveLength(1);
  });
});

describe("rating verification", () => {
  const net = networkInfo();

  it("accepts the broker's proposal when every field checks out", () => {
    const { typedData, chainId } = verifyRatingRequest({ jobId: JOB_ID, value: 100, request: ratingRequestFor(100), network: net });
    expect(chainId).toBe(10143);
    expect(typedData.domain.verifyingContract).toBe(net.ledger!.address);
  });

  const tamper = (mutate: (r: ReturnType<typeof ratingRequestFor>) => void) => {
    const request = ratingRequestFor(80);
    mutate(request);
    return () => verifyRatingRequest({ jobId: JOB_ID, value: 80, request, network: net });
  };

  it("refuses a proposal for another contract", () => {
    expect(tamper((r) => (r.typedData.domain.verifyingContract = ATTACKER_ADDRESS))).toThrow(/names contract/);
  });

  it("refuses a proposal for another chain", () => {
    expect(tamper((r) => (r.typedData.domain.chainId = 143))).toThrow(/chain 143/);
  });

  it("refuses a proposal for another job or value", () => {
    expect(tamper((r) => (r.typedData.message.jobId = `0x${"99".repeat(32)}`))).toThrow(/different job/);
    expect(tamper((r) => (r.typedData.message.value = "100"))).toThrow(/value is 100/);
  });

  it("refuses a far-future deadline", () => {
    const request = ratingRequestFor(80, { deadline: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 });
    expect(() => verifyRatingRequest({ jobId: JOB_ID, value: 80, request, network: net })).toThrow(/deadline/);
  });

  it("refuses when the broker has no ledger", () => {
    expect(() =>
      verifyRatingRequest({ jobId: JOB_ID, value: 80, request: ratingRequestFor(80), network: networkInfo({ ledger: null }) }),
    ).toThrow(expect.objectContaining({ code: "XORV_RATING_REFUSED" }));
  });

  it("reports the broker's refusal to record a rating as XORV_RATING_REFUSED", async () => {
    const refusing = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/rating")) {
        return new Response(JSON.stringify({ error: "this job has already been rated" }), { status: 409 });
      }
      return fakeBroker().fetch(input, init);
    };
    const broker = new BrokerClient({ baseUrl: BROKER_URL, fetch: refusing as typeof fetch });
    const mm = fakeMetaMask();
    await expect(rateJob({ broker, executor: mm.executor, jobId: JOB_ID, stars: 5, value: 100 })).rejects.toMatchObject({
      code: "XORV_RATING_REFUSED",
      message: expect.stringContaining("already been rated"),
    });
    expect(mm.requests).toHaveLength(0);
  });

  it("refuses to rate from a wallet that did not pay for the job", async () => {
    const broker = fakeBroker();
    const mm = fakeMetaMask({ account: OTHER });
    await expect(
      rateJob({ broker: client(broker), executor: mm.executor, jobId: JOB_ID, stars: 5, value: 100, address: OTHER.address }),
    ).rejects.toMatchObject({ code: "XORV_SIGNER_MISMATCH", hint: expect.stringContaining(PAYER.address) });
    expect(mm.requests).toHaveLength(0);
  });
});

describe("activeEvmAddress", () => {
  it("uses the selected wallet, by id or by address", () => {
    const state = {
      remoteWallets: [
        { id: "a", address: OTHER.address },
        { id: "b", address: PAYER.address.toLowerCase() },
      ],
      selectedWallet: { namespace: "evm", ref: { id: "b" } },
    };
    expect(activeEvmAddress(state)).toBe(PAYER.address);
    expect(activeEvmAddress({ selectedWallet: { ref: { address: OTHER.address } } })).toBe(OTHER.address);
  });

  it("falls back to the first EVM wallet and ignores non-EVM ones", () => {
    expect(
      activeEvmAddress({ byokWallets: [{ address: "So1anaAddr", namespace: "solana" }, { address: PAYER.address }] }),
    ).toBe(PAYER.address);
  });

  it("honours --from and refuses junk", () => {
    expect(activeEvmAddress(null, OTHER.address.toLowerCase())).toBe(OTHER.address);
    expect(() => activeEvmAddress(null, "vitalik.eth")).toThrow(/not an EVM address/);
  });

  it("explains how to set a wallet up when there is none", () => {
    expect(() => activeEvmAddress({ remoteWallets: [], byokWallets: [] })).toThrow(
      expect.objectContaining({ code: "XORV_NO_WALLET", hint: expect.stringContaining("mm init") }),
    );
  });
});
