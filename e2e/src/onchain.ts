/**
 * Reading the facts back off the fork.
 *
 * Every claim the system makes — "the buyer paid the provider", "the receipt
 * is on XorvLedger", "the rating is ERC-8004 reputation" — is checked here
 * against the chain itself, not against what the broker says about it: logs
 * decoded with the contracts' own ABIs, state read from the contracts.
 */

import { decodeEventLog, getAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { IDENTITY_ABI, REPUTATION_ABI, XORV_LEDGER_ABI } from "@xorv/protocol";
import { FIAT_TOKEN_ABI } from "./chain.js";

export interface UsdcTransfer {
  from: Address;
  to: Address;
  value: bigint;
}

export interface Settlement {
  txHash: Hex;
  receipt: TransactionReceipt;
  from: Address;
  transfers: UsdcTransfer[];
  authorizers: Address[];
  gasUsed: bigint;
}

/** A settlement transaction: who sent it, and the USDC it moved. */
export async function readSettlement(client: PublicClient, usdc: Address, txHash: Hex): Promise<Settlement> {
  const [receipt, tx] = await Promise.all([
    client.getTransactionReceipt({ hash: txHash }),
    client.getTransaction({ hash: txHash }),
  ]);
  const transfers: UsdcTransfer[] = [];
  const authorizers: Address[] = [];
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(usdc)) continue;
    try {
      const decoded = decodeEventLog({ abi: FIAT_TOKEN_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "Transfer") {
        transfers.push({ from: getAddress(decoded.args.from), to: getAddress(decoded.args.to), value: decoded.args.value });
      } else if (decoded.eventName === "AuthorizationUsed") {
        authorizers.push(getAddress(decoded.args.authorizer));
      }
    } catch {
      // Another FiatToken event (e.g. a v2.2 balance-state event) — not one we assert on.
    }
  }
  return { txHash, receipt, from: getAddress(tx.from), transfers, authorizers, gasUsed: receipt.gasUsed };
}

export type LedgerEvents = Awaited<ReturnType<typeof readLedgerEvents>>;

/** Every XorvLedger event since the deploy block. */
export async function readLedgerEvents(client: PublicClient, ledger: Address, fromBlock: bigint) {
  const events = await client.getContractEvents({ address: ledger, abi: XORV_LEDGER_ABI, fromBlock, toBlock: "latest" });
  const of = <N extends (typeof events)[number]["eventName"]>(name: N) =>
    events.filter((e) => e.eventName === name) as Array<Extract<(typeof events)[number], { eventName: N }>>;
  return {
    all: events,
    registered: of("ProviderRegistered"),
    heartbeats: of("ProviderHeartbeat"),
    recorded: of("JobRecorded"),
    rated: of("JobRated"),
  };
}

export interface Feedback {
  txHash: Hex;
  blockNumber: bigint;
  agentId: bigint;
  client: Address;
  feedbackIndex: bigint;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: Hex;
}

/** The Reputation Registry's NewFeedback events for one agent since `fromBlock`. */
export async function readFeedback(client: PublicClient, reputation: Address, agentId: bigint, fromBlock: bigint): Promise<Feedback[]> {
  const logs = await client.getContractEvents({
    address: reputation,
    abi: REPUTATION_ABI,
    eventName: "NewFeedback",
    args: { agentId },
    fromBlock,
    toBlock: "latest",
  });
  return logs.map((log) => ({
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    agentId: log.args.agentId!,
    client: getAddress(log.args.clientAddress!),
    feedbackIndex: log.args.feedbackIndex!,
    value: log.args.value!,
    valueDecimals: log.args.valueDecimals!,
    tag1: log.args.tag1!,
    tag2: log.args.tag2!,
    endpoint: log.args.endpoint!,
    feedbackURI: log.args.feedbackURI!,
    feedbackHash: log.args.feedbackHash!,
  }));
}

export async function reputationSummary(
  client: PublicClient,
  reputation: Address,
  agentId: bigint,
  clients: Address[],
  tag1: string,
): Promise<{ count: bigint; value: bigint; decimals: number }> {
  const [count, value, decimals] = await client.readContract({
    address: reputation,
    abi: REPUTATION_ABI,
    functionName: "getSummary",
    args: [agentId, clients, tag1, ""],
  });
  return { count, value, decimals };
}

/**
 * What `getSummary` must return for these feedback entries, computed the way
 * the ERC-8004 v2 Reputation Registry does: every value normalized to 18
 * decimals, the mean taken in integers (truncating), then scaled down to the
 * most common `valueDecimals`. Ratings are whole numbers (decimals 0), so 87
 * and 64 summarize to 75, not 75.5 — a float comparison would call the
 * registry wrong.
 */
export function expectedSummary(entries: Feedback[]): { count: bigint; value: bigint; decimals: number } {
  if (entries.length === 0) return { count: 0n, value: 0n, decimals: 0 };
  const WAD_DECIMALS = 18;
  const counts = new Array<number>(WAD_DECIMALS + 1).fill(0);
  let sum = 0n;
  for (const f of entries) {
    const decimals = Math.min(f.valueDecimals, WAD_DECIMALS);
    sum += f.value * 10n ** BigInt(WAD_DECIMALS - decimals);
    counts[decimals]!++;
  }
  // The first most frequent precision wins, as in the registry's loop.
  let mode = 0;
  for (let d = 0; d <= WAD_DECIMALS; d++) if (counts[d]! > counts[mode]!) mode = d;
  const count = BigInt(entries.length);
  // BigInt division truncates toward zero, like Solidity's signed division.
  return { count, value: sum / count / 10n ** BigInt(WAD_DECIMALS - mode), decimals: mode };
}

export async function agentState(client: PublicClient, identity: Address, agentId: bigint) {
  const [owner, wallet, uri] = await Promise.all([
    client.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "ownerOf", args: [agentId] }),
    client.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "getAgentWallet", args: [agentId] }),
    client.readContract({ address: identity, abi: IDENTITY_ABI, functionName: "tokenURI", args: [agentId] }),
  ]);
  return { owner: getAddress(owner), wallet: getAddress(wallet), uri };
}

export async function ledgerJobState(client: PublicClient, ledger: Address, jobId: Hex) {
  const [buyer, agentId, rated] = await client.readContract({ address: ledger, abi: XORV_LEDGER_ABI, functionName: "jobs", args: [jobId] });
  return { buyer: getAddress(buyer), agentId, rated };
}

export async function usdcBalance(client: PublicClient, usdc: Address, holder: Address): Promise<bigint> {
  return client.readContract({ address: usdc, abi: FIAT_TOKEN_ABI, functionName: "balanceOf", args: [holder] });
}
