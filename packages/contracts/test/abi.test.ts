import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import hre from "hardhat";
import { type Abi, type AbiParameter, parseAbi, toEventSelector } from "viem";

import { ABI_PATH, formatAbi } from "../scripts/lib/abi-file.js";

// packages/protocol's XORV_LEDGER_ABI and the Envio indexer are written against SPEC section 4, and
// checked against abi/XorvLedger.json. These tests keep all three honest: the committed file must be
// what the compiler produces, and the compiled interface must be exactly the spec.

/** SPEC section 4, as human-readable ABI. Parameter names matter for events and structs (the indexer
 *  and viem decode by name), so they are compared there; function argument names are not. */
const SPEC_ABI = parseAbi([
  "struct JobReceipt { bytes32 jobId; uint256 agentId; address buyer; address payTo; uint256 amount; bytes32 paymentTx; bytes32 requestHash; bytes32 resultHash; uint32 durationMs; bool ok; }",
  "struct Rating { bytes32 jobId; int128 value; string tag2; string endpoint; string feedbackURI; bytes32 feedbackHash; uint256 deadline; }",
  "constructor(address identity_, address reputation_, address broker_)",
  "function NO_AGENT() view returns (uint256)",
  "function RATING_TYPEHASH() view returns (bytes32)",
  "function identity() view returns (address)",
  "function reputation() view returns (address)",
  "function owner() view returns (address)",
  "function broker() view returns (address)",
  "function jobs(bytes32) view returns (address buyer, uint64 agentId, bool rated)",
  "function setBroker(address)",
  "function transferOwnership(address)",
  "function registerProvider(bytes32 providerId, address payTo, uint256 agentId, string label, string capabilities)",
  "function heartbeat(bytes32 providerId, uint32 activeJobs, uint32 capacity, uint32 uptimeSeconds)",
  "function recordJobs(JobReceipt[] receipts)",
  "function rateJob(Rating r, bytes buyerSig)",
  "function ratingDigest(Rating r) view returns (bytes32)",
  "event ProviderRegistered(bytes32 indexed providerId, address indexed payTo, uint256 indexed agentId, string label, string capabilities)",
  "event ProviderHeartbeat(bytes32 indexed providerId, uint32 activeJobs, uint32 capacity, uint32 uptimeSeconds)",
  "event JobRecorded(bytes32 indexed jobId, uint256 indexed agentId, address indexed buyer, address payTo, uint256 amount, bytes32 paymentTx, bytes32 requestHash, bytes32 resultHash, uint32 durationMs, bool ok)",
  "event JobRated(bytes32 indexed jobId, uint256 indexed agentId, address indexed buyer, int128 value, bytes32 feedbackHash)",
  "event BrokerSet(address indexed broker)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "error NotOwner()",
  "error NotBroker()",
  "error DuplicateJob(bytes32 jobId)",
  "error UnknownJob(bytes32 jobId)",
  "error AlreadyRated(bytes32 jobId)",
  "error NoAgent(bytes32 jobId)",
  "error PayToNotAgentWallet(uint256 agentId, address payTo, address agentWallet)",
  "error BadValue()",
  "error Expired()",
  "error BadSignature()",
  "error AgentIdTooLarge()",
  "error ZeroAddress()",
  "error SelfDealing(bytes32 jobId)",
]);

/** What `is EIP712("XorvLedger", "1")` adds on its own (ERC-5267 and OpenZeppelin's ShortStrings). */
const EIP712_EXTRAS = ["function:eip712Domain", "event:EIP712DomainChanged", "error:InvalidShortString", "error:StringTooLong"];

type Item = Abi[number];
const key = (item: Item) => `${item.type}:${"name" in item ? item.name : ""}`;

function param(p: AbiParameter, withName: boolean): unknown {
  const components = "components" in p ? p.components : undefined;
  return {
    type: p.type,
    ...(withName ? { name: p.name ?? "" } : {}),
    ...(components ? { components: components.map((c) => param(c, true)) } : {}),
  };
}

/** The parts of an ABI item that affect encoding, decoding and indexing. */
function shape(item: Item): unknown {
  switch (item.type) {
    case "event":
      return item.inputs.map((p) => ({ ...(param(p, true) as object), indexed: Boolean(p.indexed) }));
    case "error":
      return item.inputs.map((p) => param(p, true));
    case "function":
      return {
        inputs: item.inputs.map((p) => param(p, false)),
        outputs: item.outputs.map((p) => param(p, false)),
        stateMutability: item.stateMutability,
      };
    case "constructor":
      return item.inputs.map((p) => param(p, false));
    default:
      return item;
  }
}

describe("XorvLedger ABI", async function () {
  const artifact = await hre.artifacts.readArtifact("XorvLedger");
  const compiled = artifact.abi as Abi;

  it("abi/XorvLedger.json is up to date (run `pnpm --filter @xorv/contracts abi`)", async function () {
    const committed = await readFile(ABI_PATH, "utf8").catch(() => "");
    assert.ok(committed !== "", "abi/XorvLedger.json is missing");
    // Compare parsed JSON so a CRLF checkout of the file on Windows doesn't count as a change.
    assert.deepEqual(JSON.parse(committed), JSON.parse(formatAbi(compiled)));
  });

  it("matches SPEC section 4 exactly, plus only what EIP712 itself declares", async function () {
    const expectedKeys = [...SPEC_ABI.map(key), ...EIP712_EXTRAS].sort();
    assert.deepEqual(compiled.map(key).sort(), expectedKeys);

    for (const specItem of SPEC_ABI) {
      const item = compiled.find((c) => key(c) === key(specItem));
      assert.ok(item, `missing ${key(specItem)}`);
      assert.deepEqual(shape(item), shape(specItem), `${key(specItem)} differs from the spec`);
    }
  });

  it("keeps the event topics the indexer subscribes to", async function () {
    const topic = (name: string) => {
      const event = compiled.find((c) => c.type === "event" && c.name === name);
      assert.ok(event && event.type === "event");
      return toEventSelector(event);
    };
    assert.equal(topic("JobRated"), "0x9cfbad1dfe3b6a50504b85ee878b72fc93d0bfb713f0bf4b2adbf526e792fa3e");
    assert.equal(
      topic("JobRecorded"),
      toEventSelector("JobRecorded(bytes32,uint256,address,address,uint256,bytes32,bytes32,bytes32,uint32,bool)"),
    );
  });
});
