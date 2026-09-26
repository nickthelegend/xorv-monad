/**
 * Pin the ABIs the handlers decode with.
 *
 * abis/XorvLedger.json is a verbatim copy of packages/contracts/abi/XorvLedger.json (the
 * compiler output, itself pinned to SPEC §4 by the contracts tests): its events must equal
 * the contract's event for event, and every one of them except ERC-5267's
 * EIP712DomainChanged must be indexed. The ERC-8004 ABIs are hand-written, so their events
 * must hash to the topic0 values observed on the deployed v2.0.0 registries. Also keeps the
 * testnet and mainnet configs from drifting apart.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAbiItem, toEventSelector, type Abi, type AbiEvent } from "viem";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");
const events = (abi: Abi) => abi.filter((item): item is AbiEvent => item.type === "event");
const abi = (name: string) => events(JSON.parse(read(`abis/${name}.json`)) as Abi);

const shape = (e: AbiEvent) => ({
  name: e.name,
  inputs: e.inputs.map((i) => ({ name: i.name, type: i.type, indexed: i.indexed ?? false })),
});
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** Emitted by OpenZeppelin's EIP712 base (ERC-5267); XorvLedger never actually emits it. */
const NOT_INDEXED = ["EIP712DomainChanged"];

describe("XorvLedger ABI", () => {
  const spec = [
    "event ProviderRegistered(bytes32 indexed providerId, address indexed payTo, uint256 indexed agentId, string label, string capabilities)",
    "event ProviderHeartbeat(bytes32 indexed providerId, uint32 activeJobs, uint32 capacity, uint32 uptimeSeconds)",
    "event JobRecorded(bytes32 indexed jobId, uint256 indexed agentId, address indexed buyer, address payTo, uint256 amount, bytes32 paymentTx, bytes32 requestHash, bytes32 resultHash, uint32 durationMs, bool ok)",
    "event JobRated(bytes32 indexed jobId, uint256 indexed agentId, address indexed buyer, int128 value, bytes32 feedbackHash)",
    "event BrokerSet(address indexed broker)",
    "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  ].map((s) => parseAbiItem(s) as AbiEvent);

  it("has the SPEC §4 events, plus only what the EIP712 base adds", () => {
    const ours = abi("XorvLedger");
    expect(ours.filter((e) => !NOT_INDEXED.includes(e.name)).map(shape).sort(byName)).toEqual(
      spec.map(shape).sort(byName),
    );
    expect(ours.filter((e) => NOT_INDEXED.includes(e.name)).map((e) => e.name)).toEqual(NOT_INDEXED);
  });

  // The committed contract ABI lives outside this package. It is there in a monorepo
  // checkout (and in the Linux test mirror, see README); an Envio Cloud build only sees
  // services/indexer, which is fine: the SPEC check above still runs everywhere.
  const contractsAbi = `${root}../../packages/contracts/abi/XorvLedger.json`;
  it.skipIf(!existsSync(contractsAbi))(
    "matches packages/contracts/abi/XorvLedger.json event for event, byte for byte",
    () => {
      const theirs = readFileSync(contractsAbi, "utf8");
      expect(abi("XorvLedger").map(shape).sort(byName)).toEqual(events(JSON.parse(theirs) as Abi).map(shape).sort(byName));
      // A verbatim copy, so refreshing it is `cp`, never a hand edit.
      expect(read("abis/XorvLedger.json")).toBe(theirs);
    },
  );

  it("is indexed in full by config.yaml", () => {
    const ledgerEvents = abi("XorvLedger")
      .map((e) => e.name)
      .filter((name) => !NOT_INDEXED.includes(name));
    expect(configEvents(read("config.yaml"), "XorvLedger").sort()).toEqual(ledgerEvents.sort());
  });
});

/** The event names listed under one top-level `contracts:` entry of a config file. */
function configEvents(yaml: string, contract: string): string[] {
  const start = yaml.indexOf(`\n  - name: ${contract}\n`);
  if (start === -1) throw new Error(`${contract} is not a top-level contract`);
  const rest = yaml.slice(start + 1);
  const end = rest.slice(1).search(/^ {2}- name: /m);
  const block = end === -1 ? rest : rest.slice(0, end + 1);
  return [...block.matchAll(/^\s+- event: (\w+)/gm)].map((m) => m[1]!);
}

describe("ERC-8004 v2.0.0 ABIs", () => {
  // topic0 values from the deployed registries (research-erc8004.md §3.4).
  const expected: Record<string, string> = {
    Registered: "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a",
    URIUpdated: "0x3a2c7fffc2cba7582c690e3b82c453ea02a308326a98a3ad7576c606336409fb",
    MetadataSet: "0x2c149ed548c6d2993cd73efe187df6eccabe4538091b33adbd25fafdb8a1468b",
    Transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    NewFeedback: "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc",
    FeedbackRevoked: "0x25156fd3288212246d8b008d5921fde376c71ed14ac2e072a506eb06fde6d09d",
    ResponseAppended: "0xb1c6be0b5b8aef6539e2fac0fd131a2faa7b49edf8e505b5eb0ad487d56051d4",
  };

  it("hashes to the live topic0 of every indexed event", () => {
    const events = [...abi("IdentityRegistry"), ...abi("ReputationRegistry")];
    const got = Object.fromEntries(events.map((e) => [e.name, toEventSelector(e)]));
    expect(got).toEqual(expected);
  });

  it("define every event config.yaml subscribes to", () => {
    for (const contract of ["IdentityRegistry", "ReputationRegistry"]) {
      const names = abi(contract).map((e) => e.name);
      for (const event of configEvents(read("config.yaml"), contract)) expect(names).toContain(event);
    }
  });

  it("keeps the indexed layout the handlers depend on", () => {
    const feedback = abi("ReputationRegistry").find((e) => e.name === "NewFeedback")!;
    expect(feedback.inputs.filter((i) => i.indexed).map((i) => i.name)).toEqual([
      "agentId",
      "clientAddress",
      "indexedTag1",
    ]);
    // ERC-721 Transfer: all three indexed (distinguishes it from ERC-20's Transfer).
    const transfer = abi("IdentityRegistry").find((e) => e.name === "Transfer")!;
    expect(transfer.inputs.every((i) => i.indexed)).toBe(true);
  });
});

describe("configs", () => {
  const testnet = read("config.yaml");
  const mainnet = read("config.mainnet.yaml");
  const eventNames = (yaml: string) => [...yaml.matchAll(/^\s+- event: (\w+)/gm)].map((m) => m[1]);
  const contracts = (yaml: string) => [...yaml.matchAll(/^\s+- name: (\w+)/gm)].map((m) => m[1]);

  it("index the same contracts and events on both chains", () => {
    expect(eventNames(mainnet)).toEqual(eventNames(testnet));
    expect(contracts(mainnet)).toEqual(contracts(testnet));
    expect(eventNames(testnet)).toHaveLength(13);
  });

  it("point at the SPEC §2 chain ids and ERC-8004 singletons", () => {
    expect(testnet).toMatch(/- id: 10143\b/);
    expect(testnet).toContain("0x8004A818BFB912233c491871b3d84c89A494BD9e");
    expect(testnet).toContain("0x8004B663056A597Dffe9eCcC1965A193B7388713");
    expect(mainnet).toMatch(/- id: 143\b/);
    expect(mainnet).toContain("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
    expect(mainnet).toContain("0x8004BAa17C55a88189AE136b182e5fdA19dE9b63");
  });

  it("never put an env placeholder in a comment (envio interpolates comments too)", () => {
    for (const yaml of [testnet, mainnet]) {
      const commentLines = yaml.split("\n").filter((l) => l.trimStart().startsWith("#"));
      expect(commentLines.filter((l) => l.includes("${"))).toEqual([]);
    }
  });
});
