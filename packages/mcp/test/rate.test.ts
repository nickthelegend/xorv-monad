/**
 * `xorv_rate_job`'s core against a mock broker: the rating is signed only if
 * it is for this job, this value, this chain and this payer, and the mock
 * relays it only if the EIP-712 signature recovers to the payer.
 */

import { afterEach, describe, expect, it } from "vitest";
import { brokerClient } from "../src/broker.js";
import { rateJob } from "../src/rate.js";
import { createPayerSigner, resolveSignerConfig } from "../src/signer.js";
import { BUYER_ADDRESS, BUYER_KEY, PRIVY_WALLET_ADDRESS, fakePrivy } from "./helpers/fixtures.js";
import { NETWORK, RATE_TX, startMockBroker, type MockBroker, type MockBrokerOptions } from "./helpers/mock-broker.js";

let broker: MockBroker | null = null;
afterEach(async () => {
  await broker?.close();
  broker = null;
});

async function setup(opts: MockBrokerOptions = {}) {
  broker = await startMockBroker({ ratingSigner: BUYER_ADDRESS, ...opts });
  return {
    broker,
    deps: {
      broker: brokerClient(broker.url),
      signer: createPayerSigner(resolveSignerConfig({ XORV_PRIVATE_KEY: BUYER_KEY })),
      network: NETWORK,
    },
  };
}

describe("rateJob", () => {
  it("signs the broker's Rating and gets it relayed", async () => {
    const { broker, deps } = await setup();
    const result = await rateJob(deps, { jobId: "job_test1", value: 87 });
    expect(result.txHash).toBe(RATE_TX);
    expect(result.explorerUrl).toBe(`https://testnet.monadvision.com/tx/${RATE_TX}`);
    expect(result.offer.agentId).toBe("7");
    expect(broker.ratings).toEqual([expect.objectContaining({ value: 87, valid: true })]);
    expect(broker.hits).toEqual(["GET /api/jobs/job_test1/rating", "POST /api/jobs/job_test1/rate"]);
  });

  it("signs with a Privy server wallet too", async () => {
    const privy = fakePrivy();
    const { broker } = await setup({ ratingSigner: PRIVY_WALLET_ADDRESS });
    const signer = createPayerSigner(
      resolveSignerConfig({ XORV_PRIVY_APP_ID: "a", XORV_PRIVY_APP_SECRET: "s", XORV_PRIVY_WALLET_ID: "wal_test" }),
      { privyClient: privy.factory },
    );
    const result = await rateJob({ broker: brokerClient(broker.url), signer, network: NETWORK }, { jobId: "job_test1", value: 100 });
    expect(result.payer.address).toBe(PRIVY_WALLET_ADDRESS);
    expect(privy.signRequests[0]?.typed_data.primary_type).toBe("Rating");
    expect(broker.ratings[0]?.valid).toBe(true);
  });

  it("refuses when this server is not the job's payer", async () => {
    const { broker, deps } = await setup({ ratingSigner: PRIVY_WALLET_ADDRESS });
    await expect(rateJob(deps, { jobId: "job_test1", value: 50 })).rejects.toThrow(/only the buyer who paid can rate/);
    expect(broker.ratings).toEqual([]);
  });

  it("refuses to sign a rating for a different job", async () => {
    const { broker, deps } = await setup({
      tamperRating: (offer) => {
        (offer.typedData as { message: { jobId: string } }).message.jobId = `0x${"99".repeat(32)}`;
      },
    });
    await expect(rateJob(deps, { jobId: "job_test1", value: 50 })).rejects.toThrow(/is not job job_test1/);
    expect(broker.hits).not.toContain("POST /api/jobs/job_test1/rate");
  });

  it("refuses to sign a different score than the one asked for", async () => {
    const { deps } = await setup({
      tamperRating: (offer) => {
        (offer.typedData as { message: { value: string } }).message.value = "100";
      },
    });
    await expect(rateJob(deps, { jobId: "job_test1", value: 10 })).rejects.toThrow(/asked to rate 10/);
  });

  it("refuses to sign for another chain or another contract type", async () => {
    const { deps } = await setup({
      tamperRating: (offer) => {
        (offer.typedData as { domain: { chainId: number } }).domain.chainId = 143;
      },
    });
    await expect(rateJob(deps, { jobId: "job_test1", value: 10 })).rejects.toThrow(/chain 143/);

    await broker!.close();
    const again = await setup({
      tamperRating: (offer) => {
        (offer.typedData as { domain: { name: string } }).domain.name = "USDC";
      },
    });
    await expect(rateJob(again.deps, { jobId: "job_test1", value: 10 })).rejects.toThrow(/expected a XorvLedger v1 Rating/);
  });

  it("passes the broker's refusal through", async () => {
    const { deps } = await setup();
    await expect(rateJob(deps, { jobId: "job_missing!", value: 10 })).rejects.toThrow(/not found/);
  });

  it("rejects a score outside 0–100 before talking to anyone", async () => {
    const { broker, deps } = await setup();
    await expect(rateJob(deps, { jobId: "job_test1", value: 101 })).rejects.toThrow(/0 \(useless\) to 100/);
    await expect(rateJob(deps, { jobId: "job_test1", value: 2.5 })).rejects.toThrow(/integer/);
    expect(broker.hits).toEqual([]);
  });

  it("needs a payer", async () => {
    const { deps } = await setup();
    await expect(
      rateJob({ ...deps, signer: createPayerSigner(resolveSignerConfig({})) }, { jobId: "job_test1", value: 10 }),
    ).rejects.toThrow(/no payer configured/i);
  });
});
