/**
 * XorvLedger conventions are a contract between four codebases (the Solidity,
 * the broker's writer, the Envio indexer and the apps' readers): an id hashed
 * one way here and another way there is a receipt nobody can find. These pin
 * the ABI, the id/hash rules, the EIP-712 rating digest (against the
 * contract's own construction), and the bounded feed reader.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  concat,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  hashTypedData,
  keccak256,
  stringToBytes,
  toHex,
  verifyTypedData,
  zeroHash,
  type Abi,
  type AbiEvent,
  type AbiParameter,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MONAD_MAINNET, MONAD_TESTNET } from "../src/chains.js";
import { publicClientFor } from "../src/evm.js";
import {
  DEFAULT_LEDGER_SCAN_BLOCKS,
  LEDGER_EVENT_NAMES,
  LEDGER_LABEL_MAX_BYTES,
  MAX_LOG_BLOCK_RANGE,
  NO_AGENT,
  RATING_TAG1,
  RATING_TYPES,
  XORV_LEDGER_ABI,
  agentIdArg,
  agentIdFromArg,
  bytes32OrZero,
  capabilityString,
  jobIdHash,
  jobReceipt,
  ledgerLabel,
  parseCapabilityString,
  providerIdHash,
  ratingMessage,
  ratingTypedData,
  readLedgerEvents,
  registerProviderArgs,
  shapeLedgerEvent,
  textHash,
} from "../src/ledger.js";
import { RpcError, fakeRpc, hex } from "./support/fake-rpc.js";

const LEDGER = "0x1234567890AbcdEF1234567890aBcdef12345678";
const BUYER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const PAY_TO = "0x00000000219ab540356cBB839Cbe05303d7705Fa";

describe("XORV_LEDGER_ABI", () => {
  const names = (type: string) =>
    XORV_LEDGER_ABI.filter((item) => item.type === type).map((item) => ("name" in item ? item.name : ""));

  it("has every function in the contract interface", () => {
    expect(names("function").sort()).toEqual(
      [
        "NO_AGENT",
        "RATING_TYPEHASH",
        "identity",
        "reputation",
        "owner",
        "broker",
        "jobs",
        "setBroker",
        "transferOwnership",
        "registerProvider",
        "heartbeat",
        "recordJobs",
        "rateJob",
        "ratingDigest",
      ].sort(),
    );
    expect(XORV_LEDGER_ABI[0]).toMatchObject({ type: "constructor" });
  });

  it("has every event and error", () => {
    expect(names("event")).toEqual([
      "ProviderRegistered",
      "ProviderHeartbeat",
      "JobRecorded",
      "JobRated",
      "BrokerSet",
      "OwnershipTransferred",
    ]);
    expect(names("error")).toEqual([
      "NotOwner",
      "NotBroker",
      "DuplicateJob",
      "UnknownJob",
      "AlreadyRated",
      "NoAgent",
      "PayToNotAgentWallet",
      "BadValue",
      "Expired",
      "BadSignature",
      "AgentIdTooLarge",
      "ZeroAddress",
      "SelfDealing",
    ]);
  });

  // packages/contracts commits the compiler's own ABI. This transcription has to say exactly the
  // same thing: the broker encodes its writes with it and names the errors its writes revert with
  // (a missing error decodes as a bare "reverted", and the broker can't tell why a receipt failed).
  const compiledAbiPath = fileURLToPath(new URL("../../contracts/abi/XorvLedger.json", import.meta.url));
  it.skipIf(!existsSync(compiledAbiPath))("matches the compiled contract ABI, minus what EIP712 itself declares", () => {
    const eip712Extras = ["function:eip712Domain", "event:EIP712DomainChanged", "error:InvalidShortString", "error:StringTooLong"];
    type Item = Abi[number];
    const key = (item: Item) => `${item.type}:${"name" in item ? item.name : ""}`;
    // internalType is solc's annotation, not part of the interface.
    const param = (p: AbiParameter): unknown => ({
      name: p.name ?? "",
      type: p.type,
      ...("indexed" in p && p.indexed !== undefined ? { indexed: p.indexed } : {}),
      ...("components" in p ? { components: p.components.map(param) } : {}),
    });
    const normalize = (item: Item) => ({
      key: key(item),
      inputs: "inputs" in item ? item.inputs.map(param) : [],
      outputs: "outputs" in item ? item.outputs.map(param) : [],
      stateMutability: "stateMutability" in item ? item.stateMutability : undefined,
      anonymous: "anonymous" in item ? item.anonymous : undefined,
    });
    const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);

    const compiled = (JSON.parse(readFileSync(compiledAbiPath, "utf8")) as Abi).filter(
      (item) => !eip712Extras.includes(key(item)),
    );
    expect((XORV_LEDGER_ABI as Abi).map(normalize).sort(byKey)).toEqual(compiled.map(normalize).sort(byKey));
  });

  it("encodes the JobReceipt struct field-for-field in contract order", () => {
    const recordJobs = getAbiItem({ abi: XORV_LEDGER_ABI, name: "recordJobs" });
    const components = recordJobs.inputs[0].components;
    expect(components.map((c) => `${c.type} ${c.name}`)).toEqual([
      "bytes32 jobId",
      "uint256 agentId",
      "address buyer",
      "address payTo",
      "uint256 amount",
      "bytes32 paymentTx",
      "bytes32 requestHash",
      "bytes32 resultHash",
      "uint32 durationMs",
      "bool ok",
    ]);
  });

  it("indexes the event fields the indexer filters on", () => {
    const indexed = (name: string) =>
      (getAbiItem({ abi: XORV_LEDGER_ABI, name: name as "JobRecorded" }) as AbiEvent).inputs
        .filter((i) => i.indexed)
        .map((i) => i.name);
    expect(indexed("ProviderRegistered")).toEqual(["providerId", "payTo", "agentId"]);
    expect(indexed("ProviderHeartbeat")).toEqual(["providerId"]);
    expect(indexed("JobRecorded")).toEqual(["jobId", "agentId", "buyer"]);
    expect(indexed("JobRated")).toEqual(["jobId", "agentId", "buyer"]);
  });

  it("maps each feed to its event", () => {
    expect(LEDGER_EVENT_NAMES).toEqual({
      registrations: "ProviderRegistered",
      heartbeats: "ProviderHeartbeat",
      receipts: "JobRecorded",
      ratings: "JobRated",
    });
  });
});

describe("ids and hashes", () => {
  it("hashes a broker job id as keccak256 of its UTF-8 bytes", () => {
    expect(jobIdHash("job_2eHjgDqDuMyv")).toBe(keccak256(toHex("job_2eHjgDqDuMyv")));
    expect(jobIdHash("job_2eHjgDqDuMyv")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(jobIdHash("job_a")).not.toBe(jobIdHash("job_b"));
  });

  it("hashes provider ids and text the same way, UTF-8 included", () => {
    expect(providerIdHash("prv_1LanKLZA8vhK")).toBe(keccak256(stringToBytes("prv_1LanKLZA8vhK")));
    expect(textHash("héllo ✓")).toBe(keccak256(stringToBytes("héllo ✓")));
  });

  it("hashes a missing result as the empty string, so a failed job still has a resultHash", () => {
    expect(textHash(null)).toBe(keccak256("0x"));
    expect(textHash(undefined)).toBe(textHash(""));
  });

  it("maps a missing tx hash to the zero hash and lowercases real ones", () => {
    const tx = `0x${"AB".repeat(32)}`;
    expect(bytes32OrZero(tx)).toBe(tx.toLowerCase());
    expect(bytes32OrZero(null)).toBe(zeroHash);
    expect(bytes32OrZero("")).toBe(zeroHash);
    expect(bytes32OrZero("0x1234")).toBe(zeroHash);
  });

  it("maps a missing agent id to NO_AGENT and back", () => {
    expect(NO_AGENT).toBe(2n ** 256n - 1n);
    expect(agentIdArg(null)).toBe(NO_AGENT);
    expect(agentIdArg(undefined)).toBe(NO_AGENT);
    expect(agentIdArg("")).toBe(NO_AGENT);
    expect(agentIdArg("42")).toBe(42n);
    expect(agentIdArg(0)).toBe(0n);
    expect(() => agentIdArg("-1")).toThrow(/non-negative/);
    expect(agentIdFromArg(NO_AGENT)).toBeNull();
    expect(agentIdFromArg(42n)).toBe("42");
    expect(agentIdFromArg("0")).toBe("0");
  });
});

describe("labels and capabilities", () => {
  it("truncates labels to 64 UTF-8 bytes without splitting a character", () => {
    expect(LEDGER_LABEL_MAX_BYTES).toBe(64);
    expect(ledgerLabel("short")).toBe("short");
    expect(ledgerLabel("x".repeat(100))).toBe("x".repeat(64));
    const emoji = "🚀".repeat(20); // 4 bytes each
    const cut = ledgerLabel(emoji);
    expect(new TextEncoder().encode(cut).length).toBe(64);
    expect(cut).toBe("🚀".repeat(16));
    // A 3-byte char straddling the boundary is dropped, not mangled.
    const mixed = `${"a".repeat(62)}✓`;
    expect(ledgerLabel(mixed)).toBe("a".repeat(62));
  });

  it("renders capabilities as adapter:priceUsdMicros pairs", () => {
    expect(
      capabilityString([
        { adapter: "claude-code", priceUsdMicros: 10_000 },
        { adapter: "qwen", priceUsdMicros: 5_000 },
      ]),
    ).toBe("claude-code:10000,qwen:5000");
    expect(capabilityString([])).toBe("");
  });

  it("round-trips through parseCapabilityString and skips junk", () => {
    const caps = [
      { adapter: "codex" as const, priceUsdMicros: 20_000 },
      { adapter: "kimi" as const, priceUsdMicros: 1 },
    ];
    expect(parseCapabilityString(capabilityString(caps))).toEqual(caps);
    expect(parseCapabilityString("a:1,broken,b:x,:5,c:-2,d:7")).toEqual([
      { adapter: "a", priceUsdMicros: 1 },
      { adapter: "d", priceUsdMicros: 7 },
    ]);
  });

  it("builds registerProvider arguments with every id rule applied", () => {
    const args = registerProviderArgs({
      providerId: "prv_1",
      address: PAY_TO.toLowerCase(),
      agentId: null,
      label: "n".repeat(80),
      capabilities: [{ adapter: "grok", priceUsdMicros: 3_000 }],
    });
    expect(args).toEqual([providerIdHash("prv_1"), PAY_TO, NO_AGENT, "n".repeat(64), "grok:3000"]);
  });
});

describe("jobReceipt", () => {
  it("hashes the prompt and result and never carries either", () => {
    const tx = `0x${"cd".repeat(32)}`;
    const receipt = jobReceipt({
      jobId: "job_1",
      agentId: "7",
      buyer: BUYER.toLowerCase(),
      payTo: PAY_TO,
      amount: "10000",
      paymentTx: tx,
      prompt: "write a haiku",
      result: "an answer",
      durationMs: 8_400.6,
      ok: true,
    });
    expect(receipt).toEqual({
      jobId: jobIdHash("job_1"),
      agentId: 7n,
      buyer: BUYER,
      payTo: PAY_TO,
      amount: 10_000n,
      paymentTx: tx,
      requestHash: textHash("write a haiku"),
      resultHash: textHash("an answer"),
      durationMs: 8_401,
      ok: true,
    });
    expect(JSON.stringify(receipt, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("haiku");
  });

  it("records an unpaid, failed job with zero payment fields and NO_AGENT", () => {
    const receipt = jobReceipt({
      jobId: "job_2",
      agentId: null,
      buyer: null,
      payTo: PAY_TO,
      amount: 0n,
      paymentTx: null,
      prompt: "p",
      result: null,
      durationMs: -5,
      ok: false,
    });
    expect(receipt.agentId).toBe(NO_AGENT);
    expect(receipt.buyer).toBe("0x0000000000000000000000000000000000000000");
    expect(receipt.paymentTx).toBe(zeroHash);
    expect(receipt.resultHash).toBe(textHash(""));
    expect(receipt.durationMs).toBe(0);
  });

  it("clamps durations to uint32", () => {
    const receipt = jobReceipt({
      jobId: "j", agentId: "1", buyer: BUYER, payTo: PAY_TO, amount: "1", paymentTx: null,
      prompt: "", result: "", durationMs: 2 ** 40, ok: true,
    });
    expect(receipt.durationMs).toBe(0xffff_ffff);
  });
});

describe("ratingTypedData", () => {
  const rating = {
    jobId: jobIdHash("job_rated"),
    value: 92,
    tag2: "claude-code",
    endpoint: "https://broker.xorv.xyz/api/jobs",
    feedbackURI: "https://broker.xorv.xyz/feedback/job_rated.json",
    feedbackHash: keccak256(toHex("{}")),
    deadline: 1_790_000_000,
  };

  it("uses the XorvLedger domain on the right chain, with the contract's field order", () => {
    const td = ratingTypedData({ network: MONAD_TESTNET, ledger: LEDGER.toLowerCase(), rating });
    expect(td.domain).toEqual({
      name: "XorvLedger",
      version: "1",
      chainId: 10143,
      verifyingContract: LEDGER,
    });
    expect(td.primaryType).toBe("Rating");
    expect(td.types).toBe(RATING_TYPES);
    expect(td.message).toEqual({ ...rating, value: 92n, deadline: 1_790_000_000n });
    expect(ratingTypedData({ network: MONAD_MAINNET, ledger: LEDGER, rating }).domain.chainId).toBe(143);
    expect(RATING_TAG1).toBe("starred");
  });

  it("produces exactly the digest XorvLedger.ratingDigest computes (OZ EIP712 _hashTypedDataV4)", () => {
    const typehash = keccak256(
      stringToBytes(
        "Rating(bytes32 jobId,int128 value,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash,uint256 deadline)",
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" }, { type: "bytes32" }, { type: "int128" }, { type: "bytes32" },
          { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" },
        ],
        [
          typehash,
          rating.jobId,
          92n,
          keccak256(stringToBytes(rating.tag2)),
          keccak256(stringToBytes(rating.endpoint)),
          keccak256(stringToBytes(rating.feedbackURI)),
          rating.feedbackHash,
          1_790_000_000n,
        ],
      ),
    );
    const domainTypehash = keccak256(
      stringToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    );
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [domainTypehash, keccak256(stringToBytes("XorvLedger")), keccak256(stringToBytes("1")), 10143n, LEDGER],
      ),
    );
    const expected = keccak256(concat(["0x1901", domainSeparator, structHash]));
    expect(hashTypedData(ratingTypedData({ network: MONAD_TESTNET, ledger: LEDGER, rating }))).toBe(expected);
  });

  it("round-trips a buyer signature through viem verifyTypedData", async () => {
    const buyer = privateKeyToAccount(generatePrivateKey());
    const td = ratingTypedData({ network: MONAD_TESTNET, ledger: LEDGER, rating });
    const signature = await buyer.signTypedData(td);
    expect(await verifyTypedData({ ...td, address: buyer.address, signature })).toBe(true);

    // The same signature must not verify for another ledger, chain or value.
    const otherLedger = ratingTypedData({
      network: MONAD_TESTNET,
      ledger: "0x0000000000000000000000000000000000000001",
      rating,
    });
    expect(await verifyTypedData({ ...otherLedger, address: buyer.address, signature })).toBe(false);
    const otherChain = ratingTypedData({ network: MONAD_MAINNET, ledger: LEDGER, rating });
    expect(await verifyTypedData({ ...otherChain, address: buyer.address, signature })).toBe(false);
    const otherValue = ratingTypedData({ network: MONAD_TESTNET, ledger: LEDGER, rating: { ...rating, value: 100 } });
    expect(await verifyTypedData({ ...otherValue, address: buyer.address, signature })).toBe(false);
  });

  it("accepts JSON-shaped input (strings where the struct wants bigints)", () => {
    const msg = ratingMessage({ ...rating, value: "50", deadline: "1790000000" });
    expect(msg.value).toBe(50n);
    expect(msg.deadline).toBe(1_790_000_000n);
  });

  it("refuses out-of-range values and malformed hashes before anything is signed", () => {
    expect(() => ratingMessage({ ...rating, value: 101 })).toThrow(/0 to 100/);
    expect(() => ratingMessage({ ...rating, value: -1 })).toThrow(/0 to 100/);
    expect(() => ratingMessage({ ...rating, jobId: "job_rated" })).toThrow(/jobIdHash/);
    expect(() => ratingMessage({ ...rating, feedbackHash: "0x12" })).toThrow(/feedbackHash/);
    expect(() => ratingTypedData({ network: "hedera:testnet", ledger: LEDGER, rating })).toThrow(/unsupported/);
  });
});

// ---------------------------------------------------------------------------
// readLedgerEvents over a scripted RPC
// ---------------------------------------------------------------------------

interface StoredLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  removed?: boolean;
}

function eventLog(
  eventName: "JobRecorded" | "ProviderRegistered" | "ProviderHeartbeat" | "JobRated",
  args: Record<string, unknown>,
  blockNumber: number,
  logIndex: number,
  address = LEDGER,
): StoredLog {
  const item = getAbiItem({ abi: XORV_LEDGER_ABI, name: eventName }) as AbiEvent;
  const indexedArgs = Object.fromEntries(
    item.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name!]]),
  );
  const topics = encodeEventTopics({ abi: [item], eventName, args: indexedArgs } as never) as Hex[];
  const nonIndexed = item.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as never);
  return {
    address,
    topics,
    data,
    blockNumber: BigInt(blockNumber),
    logIndex,
    transactionHash: keccak256(toHex(`${blockNumber}:${logIndex}`)),
  };
}

function receiptLog(block: number, logIndex: number, overrides: Record<string, unknown> = {}): StoredLog {
  return eventLog(
    "JobRecorded",
    {
      jobId: jobIdHash(`job_${block}_${logIndex}`),
      agentId: 7n,
      buyer: BUYER,
      payTo: PAY_TO,
      amount: 10_000n,
      paymentTx: keccak256(toHex(`pay_${block}`)),
      requestHash: textHash("prompt"),
      resultHash: textHash("result"),
      durationMs: 1_234,
      ok: true,
      ...overrides,
    },
    block,
    logIndex,
  );
}

/** A chain with `latest` as its head, serving `logs`; block timestamps are `1_700_000_000 + n`. */
function ledgerChain(latest: number, logs: StoredLog[], opts: { failGetLogs?: boolean } = {}) {
  const rpc = fakeRpc({
    eth_blockNumber: () => hex(latest),
    eth_getLogs: ([filter]) => {
      if (opts.failGetLogs) throw new RpcError("eth_getLogs is limited to a 100 range");
      const f = filter as { address: string; topics: Array<Hex | null>; fromBlock: Hex; toBlock: Hex };
      const from = BigInt(f.fromBlock);
      const to = BigInt(f.toBlock);
      return logs
        .filter(
          (log) =>
            log.address.toLowerCase() === f.address.toLowerCase() &&
            log.topics[0] === f.topics[0] &&
            log.blockNumber >= from &&
            log.blockNumber <= to,
        )
        .map((log) => ({
          address: log.address.toLowerCase(),
          topics: log.topics,
          data: log.data,
          blockNumber: hex(log.blockNumber),
          blockHash: keccak256(toHex(`block${log.blockNumber}`)),
          logIndex: hex(log.logIndex),
          transactionHash: log.transactionHash,
          transactionIndex: "0x0",
          removed: log.removed ?? false,
        }));
    },
    eth_getBlockByNumber: ([blockTag]) => {
      const n = BigInt(blockTag as string);
      return {
        number: hex(n),
        hash: keccak256(toHex(`block${n}`)),
        parentHash: zeroHash,
        timestamp: hex(1_700_000_000n + n),
        transactions: [],
        uncles: [],
        gasLimit: hex(150_000_000n),
        gasUsed: "0x0",
        baseFeePerGas: hex(100_000_000_000n),
        logsBloom: `0x${"0".repeat(512)}`,
        extraData: "0x",
        miner: "0x0000000000000000000000000000000000000000",
        difficulty: "0x0",
        size: "0x0",
        nonce: "0x0000000000000000",
      };
    },
  });
  const client = publicClientFor(MONAD_TESTNET, { transport: rpc.transport });
  const ranges = () =>
    rpc.calls
      .filter((c) => c.method === "eth_getLogs")
      .map((c) => {
        const f = c.params[0] as { fromBlock: Hex; toBlock: Hex };
        return [Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))] as const;
      })
      .sort((a, b) => b[1] - a[1]);
  return { client, calls: rpc.calls, ranges };
}

describe("readLedgerEvents", () => {
  it("scans backwards in windows of at most 100 blocks and returns newest first", async () => {
    const chain = ledgerChain(10_000, [
      receiptLog(9_995, 0),
      receiptLog(9_995, 3),
      receiptLog(9_850, 1),
      receiptLog(9_500, 0),
    ]);
    const events = await readLedgerEvents(MONAD_TESTNET, LEDGER, { kind: "receipts", limit: 3, client: chain.client });

    expect(events.map((e) => e.id)).toEqual(["9995:3", "9995:0", "9850:1"]);
    expect(MAX_LOG_BLOCK_RANGE).toBe(100);
    const ranges = chain.ranges();
    for (const [from, to] of ranges) expect(to - from + 1).toBeLessThanOrEqual(100);
    // Contiguous, non-overlapping, descending from the head.
    expect(ranges[0]).toEqual([9_901, 10_000]);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]![1]).toBe(ranges[i - 1]![0] - 1);
    // Enough events were found in the first batch of windows: it stopped early,
    // never reaching block 9_500.
    expect(ranges.length).toBe(4);
    expect(Math.min(...ranges.map((r) => r[0]))).toBeGreaterThan(9_500);
  });

  it("decodes receipts into JSON-safe shapes, with timestamps from the block", async () => {
    const chain = ledgerChain(20_000, [
      receiptLog(19_990, 0),
      receiptLog(19_980, 0, { agentId: NO_AGENT, paymentTx: zeroHash, ok: false, amount: 0n }),
    ]);
    const [paid, unpaid] = await readLedgerEvents(MONAD_TESTNET, LEDGER, { kind: "receipts", client: chain.client });

    expect(paid).toMatchObject({
      kind: "receipts",
      id: "19990:0",
      blockNumber: 19_990,
      at: (1_700_000_000 + 19_990) * 1000,
      data: {
        jobId: jobIdHash("job_19990_0"),
        agentId: "7",
        buyer: BUYER,
        payTo: PAY_TO,
        amount: "10000",
        paymentTx: keccak256(toHex("pay_19990")),
        requestHash: textHash("prompt"),
        resultHash: textHash("result"),
        durationMs: 1_234,
        ok: true,
      },
    });
    expect(paid!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(unpaid!.data).toMatchObject({ agentId: null, paymentTx: null, ok: false, amount: "0" });
    // Everything survives JSON.
    expect(() => JSON.stringify([paid, unpaid])).not.toThrow();
  });

  it("decodes registrations, heartbeats and ratings", async () => {
    const providerId = providerIdHash("prv_x");
    const chain = ledgerChain(30_000, [
      eventLog(
        "ProviderRegistered",
        { providerId, payTo: PAY_TO, agentId: 12n, label: "node-7f3a", capabilities: "claude-code:10000" },
        29_990,
        0,
      ),
      eventLog("ProviderHeartbeat", { providerId, activeJobs: 2, capacity: 3, uptimeSeconds: 900 }, 29_991, 0),
      eventLog(
        "JobRated",
        { jobId: jobIdHash("job_r"), agentId: 12n, buyer: BUYER, value: 88n, feedbackHash: textHash("f") },
        29_992,
        0,
      ),
    ]);
    const [registration] = await readLedgerEvents(MONAD_TESTNET, LEDGER, { kind: "registrations", client: chain.client });
    expect(registration!.data).toEqual({
      providerId,
      payTo: PAY_TO,
      agentId: "12",
      label: "node-7f3a",
      capabilities: "claude-code:10000",
    });
    const [beat] = await readLedgerEvents(MONAD_TESTNET, LEDGER, { kind: "heartbeats", client: chain.client });
    expect(beat!.data).toEqual({ providerId, activeJobs: 2, capacity: 3, uptimeSeconds: 900 });
    const [rated] = await readLedgerEvents(MONAD_TESTNET, LEDGER, { kind: "ratings", client: chain.client });
    expect(rated!.data).toEqual({
      jobId: jobIdHash("job_r"),
      agentId: "12",
      buyer: BUYER,
      value: 88,
      feedbackHash: textHash("f"),
    });
  });

  it("is bounded by maxBlocks (default 20k) — deeper history is the indexer's job", async () => {
    expect(DEFAULT_LEDGER_SCAN_BLOCKS).toBe(20_000);
    const chain = ledgerChain(40_000, [receiptLog(39_500, 0)]);
    const events = await readLedgerEvents(MONAD_TESTNET, LEDGER, {
      kind: "receipts",
      maxBlocks: 250,
      client: chain.client,
    });
    expect(events).toEqual([]);
    expect(chain.ranges()).toEqual([
      [39_901, 40_000],
      [39_801, 39_900],
      [39_751, 39_800],
    ]);

    const wide = ledgerChain(40_000, []);
    await readLedgerEvents(MONAD_TESTNET, LEDGER, { kind: "receipts", client: wide.client });
    const ranges = wide.ranges();
    expect(ranges.length).toBe(200);
    expect(ranges.at(-1)![0]).toBe(40_000 - 20_000 + 1);
  });

  it("never scans below fromBlock (the ledger's deploy block)", async () => {
    const chain = ledgerChain(50_000, [receiptLog(49_950, 0), receiptLog(49_000, 0)]);
    const events = await readLedgerEvents(MONAD_TESTNET, LEDGER, {
      kind: "receipts",
      fromBlock: 49_940n,
      client: chain.client,
    });
    expect(events.map((e) => e.blockNumber)).toEqual([49_950]);
    expect(chain.ranges()).toEqual([[49_940, 50_000]]);
  });

  it("handles a chain younger than one window", async () => {
    const chain = ledgerChain(42, [receiptLog(0, 0), receiptLog(42, 1)]);
    const events = await readLedgerEvents(MONAD_TESTNET, LEDGER, { kind: "receipts", client: chain.client });
    expect(events.map((e) => e.id)).toEqual(["42:1", "0:0"]);
    expect(chain.ranges()).toEqual([[0, 42]]);
  });

  it("returns nothing when fromBlock is above the head", async () => {
    const chain = ledgerChain(100, []);
    expect(await readLedgerEvents(MONAD_TESTNET, LEDGER, { kind: "receipts", fromBlock: 500, client: chain.client })).toEqual([]);
    expect(chain.ranges()).toEqual([]);
  });

  it("caches block timestamps, so a refreshed feed only pays for new blocks", async () => {
    const chain = ledgerChain(60_000, [receiptLog(59_990, 0), receiptLog(59_990, 1), receiptLog(59_970, 0)]);
    await readLedgerEvents(MONAD_TESTNET, LEDGER, { kind: "receipts", client: chain.client });
    const blockReads = () => chain.calls.filter((c) => c.method === "eth_getBlockByNumber").length;
    expect(blockReads()).toBe(2); // two distinct blocks
    await readLedgerEvents(MONAD_TESTNET, LEDGER, { kind: "receipts", client: chain.client });
    expect(blockReads()).toBe(2);
  });

  it("ignores logs from other contracts, removed logs and undecodable logs", async () => {
    const foreign = receiptLog(70_990, 0);
    foreign.address = "0x0000000000000000000000000000000000000bad";
    const removed = receiptLog(70_980, 0);
    removed.removed = true;
    const garbage = receiptLog(70_970, 0);
    garbage.data = "0x1234";
    const chain = ledgerChain(71_000, [foreign, removed, garbage, receiptLog(70_960, 0)]);
    const events = await readLedgerEvents(MONAD_TESTNET, LEDGER, { kind: "receipts", client: chain.client });
    expect(events.map((e) => e.id)).toEqual(["70960:0"]);
  });

  it("throws on an RPC error rather than returning a feed that looks empty", async () => {
    const chain = ledgerChain(80_000, [], { failGetLogs: true });
    await expect(readLedgerEvents(MONAD_TESTNET, LEDGER, { kind: "receipts", client: chain.client })).rejects.toThrow(
      /100 range/,
    );
  });

  it("refuses a malformed ledger address", async () => {
    const chain = ledgerChain(1, []);
    await expect(readLedgerEvents(MONAD_TESTNET, "0.0.9848247", { kind: "receipts", client: chain.client })).rejects.toThrow(
      /not an EVM address/,
    );
  });
});

describe("shapeLedgerEvent", () => {
  it("returns null for missing or partial args instead of throwing", () => {
    expect(shapeLedgerEvent("receipts", undefined)).toBeNull();
    expect(shapeLedgerEvent("receipts", {})).toBeNull();
    expect(shapeLedgerEvent("ratings", [])).toBeNull();
    expect(shapeLedgerEvent("heartbeats", { providerId: zeroHash, activeJobs: 1 })).toBeNull();
  });
});
