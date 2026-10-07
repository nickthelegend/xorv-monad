/**
 * The refund-keeper logic under the CRE SDK's own test runtime: its HTTP and EVM
 * capability mocks stand in for the DON, so the full path — index query, on-chain
 * check, report, write — runs without compiling to WASM or a CRE login.
 */
import { describe, expect } from "bun:test";
import { EvmMock, HttpActionsMock, newTestRuntime, test } from "@chainlink/cre-sdk/test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, parseAbiParameters, toHex, type Hex } from "viem";
import { type Config, onCron } from "./workflow";

const MONAD_TESTNET = 2183018362218727504n;
const NOW = 1_791_300_000; // seconds
const JOB_EXPIRED = `0x${"aa".repeat(32)}` as Hex;
const JOB_SETTLED = `0x${"bb".repeat(32)}` as Hex;

const config: Config = {
  schedule: "0 */5 * * * *",
  indexerUrl: "https://indexer.example/v1/graphql",
  chainSelectorName: "monad-testnet",
  escrowAddress: "0x00000000000000000000000000000000000000e5",
  keeperAddress: "0x00000000000000000000000000000000000000c1",
  maxBatch: 50,
  gasLimit: "2000000",
};

const escrowAbi = parseAbi(["function isRefundable(bytes32 jobId) view returns (bool)"]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const hexB64 = (hex: Hex) => Buffer.from(hex.slice(2), "hex").toString("base64");

/** The indexer answering the expired-jobs query with these ids; records what was asked. */
function indexer(ids: string[], seen: { body?: Record<string, unknown> }) {
  const http = HttpActionsMock.testInstance();
  http.sendRequest = (req) => {
    seen.body = JSON.parse(Buffer.from(req.body).toString("utf8"));
    const json = JSON.stringify({ data: { EscrowJob: ids.map((id) => ({ id })) } });
    return { statusCode: 200, body: b64(new TextEncoder().encode(json)) };
  };
}

/** XorvEscrow on Monad testnet: refundable or not, per job; records any report written. */
function chain(refundable: Record<string, boolean>, written: { receiver?: string; raw?: Hex }) {
  const evm = EvmMock.testInstance(MONAD_TESTNET);
  evm.callContract = (req) => {
    const { args } = decodeFunctionData({ abi: escrowAbi, data: toHex(req.call!.data) });
    const ok = refundable[(args[0] as string).toLowerCase()] ?? false;
    return { data: hexB64(encodeFunctionResult({ abi: escrowAbi, functionName: "isRefundable", result: ok })) };
  };
  evm.writeReport = (req) => {
    written.receiver = toHex(req.receiver);
    written.raw = toHex(req.report!.rawReport);
    return { txStatus: "TX_STATUS_SUCCESS", txHash: hexB64(`0x${"77".repeat(32)}`) };
  };
}

describe("refund keeper", () => {
  test("refunds only what the escrow agrees is refundable, through one DON report", () => {
    const seen: { body?: Record<string, unknown> } = {};
    const written: { receiver?: string; raw?: Hex } = {};
    indexer([JOB_SETTLED, JOB_EXPIRED], seen);
    chain({ [JOB_EXPIRED]: true, [JOB_SETTLED]: false }, written);
    const runtime = newTestRuntime<Config>(null, { timeProvider: () => NOW * 1000 }, config);

    const result = onCron(runtime);

    expect(result).toBe(`refunded 1: 0x${"77".repeat(32)}`);
    expect(written.receiver?.toLowerCase()).toBe(config.keeperAddress);
    // The deadline cut-off is the DON's time, not a node clock.
    expect((seen.body?.variables as { now: number }).now).toBe(NOW);
    const logs = runtime.getLogs().join("\n");
    expect(logs).toContain("index lists 2 funded job(s) past their deadline");
    expect(logs).toContain(`skip ${JOB_SETTLED}`);
    // The report carries abi.encode(bytes32[] jobIds) — exactly what XorvRefundKeeper.onReport decodes.
    expect(written.raw?.endsWith(encodeAbiParameters(parseAbiParameters("bytes32[] jobIds"), [[JOB_EXPIRED]]).slice(2))).toBe(true);
  });

  test("does nothing when the index lists no expired jobs", () => {
    const written: { receiver?: string } = {};
    indexer([], {});
    chain({}, written);
    const runtime = newTestRuntime<Config>(null, { timeProvider: () => NOW * 1000 }, config);
    expect(onCron(runtime)).toBe("nothing to refund");
    expect(written.receiver).toBeUndefined();
  });

  test("writes nothing when the index is ahead of the chain", () => {
    const written: { receiver?: string } = {};
    indexer([JOB_SETTLED], {});
    chain({ [JOB_SETTLED]: false }, written);
    const runtime = newTestRuntime<Config>(null, { timeProvider: () => NOW * 1000 }, config);
    expect(onCron(runtime)).toBe("index was ahead of the chain; nothing refundable");
    expect(written.receiver).toBeUndefined();
  });

  test("fails loudly when the index is unreachable", () => {
    const http = HttpActionsMock.testInstance();
    http.sendRequest = () => ({ statusCode: 503, body: "" });
    chain({}, {});
    const runtime = newTestRuntime<Config>(null, { timeProvider: () => NOW * 1000 }, config);
    expect(() => onCron(runtime)).toThrow();
  });
});
