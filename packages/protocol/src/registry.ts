/**
 * Reading and writing XorvRegistry — the Solidity contract that holds
 * each provider's on-chain reputation.
 *
 * The escrow writes outcomes into it inside every release, refund and
 * reassign, so a provider's record cannot be claimed, only earned. The broker
 * reads it back to rank providers, and sponsors each provider's registration
 * so a provider never needs MON.
 *
 * The ABI below is IXorvRegistry (contracts/src/interfaces/IXorvRegistry.sol),
 * which the Solidity XorvRegistry implements selector for selector.
 */

import {
  getAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { XORV_ESCROW_ABI } from "./xorv-escrow.abi.js";

export const XORV_REGISTRY_ABI = parseAbi([
  "function register(bytes32 nodeId, string metadataUri)",
  "function registerFor(address provider, bytes32 nodeId, string metadataUri)",
  "function deactivate()",
  "function heartbeat()",
  "function heartbeatFor(address provider)",
  "function getProvider(address provider) view returns (bytes32 nodeId, uint64 registeredAt, uint64 lastSeen, uint64 completed, uint64 failed, uint256 earned, bool active)",
  "function isActive(address provider) view returns (bool)",
  "function score(address provider) view returns (uint32)",
  "function providerCount() view returns (uint64)",
  "function owner() view returns (address)",
  "function escrow() view returns (address)",
  "function operator() view returns (address)",
  "event ProviderRegistered(address indexed provider, bytes32 indexed nodeId, string metadataUri)",
  "event OutcomeRecorded(address indexed provider, bool success, uint256 amount, uint64 completed, uint64 failed)",
]);

/** A provider's record as the registry holds it. */
export interface OnchainReputation {
  /** True once registered (by the provider or sponsored by a broker). */
  registered: boolean;
  active: boolean;
  completed: number;
  failed: number;
  /** Lifetime stablecoin earned through the escrow, 6dp units, as a string. */
  earnedUnits: string;
  /** Laplace-smoothed success rate in basis points; 5000 with no history. */
  score: number;
  /** Unix seconds of first record, 0 if none. */
  registeredAt: number;
}

/** The bytes32 a provider's node id is registered under. */
export function registryNodeId(nodeId: string): Hex {
  return keccak256(stringToHex(`xorv:node:${nodeId}`));
}

export async function readReputation(
  client: PublicClient,
  registry: Address,
  provider: Address,
): Promise<OnchainReputation> {
  const [record, score] = await Promise.all([
    client.readContract({ address: registry, abi: XORV_REGISTRY_ABI, functionName: "getProvider", args: [provider] }),
    client.readContract({ address: registry, abi: XORV_REGISTRY_ABI, functionName: "score", args: [provider] }),
  ]);
  const [nodeId, registeredAt, , completed, failed, earned, active] = record;
  return {
    registered: nodeId !== `0x${"0".repeat(64)}`,
    active,
    completed: Number(completed),
    failed: Number(failed),
    earnedUnits: earned.toString(),
    score: Number(score),
    registeredAt: Number(registeredAt),
  };
}

/**
 * Register a provider on its behalf. The wallet must be the registry's owner
 * or operator; the provider spends nothing.
 */
export async function sponsorRegistration(
  clients: { public: PublicClient; wallet: WalletClient },
  registry: Address,
  provider: Address,
  nodeId: string,
  metadataUri: string,
): Promise<Hex> {
  const account = clients.wallet.account;
  if (!account) throw new Error("registry: wallet has no account");
  const hash = await clients.wallet.writeContract({
    account,
    chain: clients.wallet.chain,
    address: registry,
    abi: XORV_REGISTRY_ABI,
    functionName: "registerFor",
    args: [provider, registryNodeId(nodeId), metadataUri.slice(0, 256)],
  });
  const receipt = await clients.public.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`registerFor reverted: ${hash}`);
  return hash;
}

/**
 * Everything that must be true of the deployed contracts for this operator to
 * run jobs through them, as a list of human-readable problems (empty = fine).
 *
 * Each item is a failure that would otherwise surface only at settlement time
 * — an attester mismatch reverts every `fund`, an escrow the registry doesn't
 * know makes every reputation update fail silently inside the escrow's
 * try/catch — so the broker checks them at boot and says so.
 */
export async function checkContractWiring(opts: {
  client: PublicClient;
  operator: string;
  escrow?: string | null;
  registry?: string | null;
  tokens?: readonly string[];
}): Promise<string[]> {
  const problems: string[] = [];
  const operator = getAddress(opts.operator);
  const c = opts.client;
  if (opts.escrow) {
    const escrow = getAddress(opts.escrow);
    const code = await c.getCode({ address: escrow });
    if (!code || code === "0x") return [`XorvEscrow ${escrow}: no contract at that address on this network`];
    const [attester, paused, escrowRegistry] = await Promise.all([
      c.readContract({ address: escrow, abi: XORV_ESCROW_ABI, functionName: "attester" }),
      c.readContract({ address: escrow, abi: XORV_ESCROW_ABI, functionName: "paused" }),
      c.readContract({ address: escrow, abi: XORV_ESCROW_ABI, functionName: "registry" }),
    ]);
    if (!isAddressEqual(attester, operator)) {
      problems.push(`XorvEscrow attester is ${attester}, not this operator (${operator}) — every escrow payment will revert`);
    }
    if (paused) problems.push("XorvEscrow is paused — new jobs cannot be funded");
    for (const token of opts.tokens ?? []) {
      const ok = await c.readContract({ address: escrow, abi: XORV_ESCROW_ABI, functionName: "tokenAllowed", args: [getAddress(token)] });
      if (!ok) problems.push(`XorvEscrow does not accept ${token} — buyers paying in it will be refused`);
    }
    if (opts.registry && !isAddressEqual(escrowRegistry, getAddress(opts.registry))) {
      problems.push(`XorvEscrow reports outcomes to ${escrowRegistry}, not to the configured registry ${opts.registry}`);
    }
  }
  if (opts.registry) {
    const registry = getAddress(opts.registry);
    const code = await c.getCode({ address: registry });
    if (!code || code === "0x") return [...problems, `XorvRegistry ${registry}: no contract at that address on this network`];
    const [regEscrow, regOperator, regOwner] = await Promise.all([
      c.readContract({ address: registry, abi: XORV_REGISTRY_ABI, functionName: "escrow" }),
      c.readContract({ address: registry, abi: XORV_REGISTRY_ABI, functionName: "operator" }),
      c.readContract({ address: registry, abi: XORV_REGISTRY_ABI, functionName: "owner" }),
    ]);
    if (opts.escrow && !isAddressEqual(regEscrow, getAddress(opts.escrow))) {
      problems.push(`XorvRegistry only accepts outcomes from ${regEscrow}, not the configured escrow — reputation will never move`);
    }
    if (!isAddressEqual(regOperator, operator) && !isAddressEqual(regOwner, operator)) {
      problems.push(`this operator is neither owner nor operator of XorvRegistry — sponsored registration will fail`);
    }
  }
  return problems;
}
