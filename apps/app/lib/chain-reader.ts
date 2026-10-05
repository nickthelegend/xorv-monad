/**
 * Server-side reads for the /chain viewer: a transaction, its decoded events,
 * and what an address holds — straight from the configured RPC.
 *
 * Exists for chains with no public explorer (a local Nitro node running the
 * whole stack). On Arbitrum Sepolia and Robinhood Chain links go to Arbiscan
 * or the Robinhood explorer instead, and nothing here runs.
 */

import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { XORV_ESCROW_ABI } from "@xorv/protocol/escrow";
import { STABLECOINS, XORV_CHAIN } from "@/lib/chains";

export const chainClient = createPublicClient({ chain: XORV_CHAIN, transport: http() });

const REGISTRY_EVENTS = parseAbi([
  "event ProviderRegistered(address indexed provider, bytes32 indexed nodeId, string metadataUri)",
  "event ProviderDeactivated(address indexed provider)",
  "event Heartbeat(address indexed provider, uint64 timestamp)",
  "event OutcomeRecorded(address indexed provider, bool success, uint256 amount, uint64 completed, uint64 failed)",
  "event EscrowUpdated(address indexed escrow)",
  "event OperatorUpdated(address indexed operator)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
]);
const LOG_EVENTS = parseAbi([
  "event Entry(uint8 indexed kind, bytes32 indexed subject, address indexed author, uint64 seq, string payload)",
]);
const TOKEN_EVENTS = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);

const SOURCES: Array<{ label: string; abi: Abi }> = [
  { label: "XorvEscrow", abi: XORV_ESCROW_ABI as unknown as Abi },
  { label: "XorvRegistry", abi: REGISTRY_EVENTS },
  { label: "XorvLog", abi: LOG_EVENTS },
  { label: "token", abi: TOKEN_EVENTS },
];

export interface DecodedEvent {
  address: Address;
  source: string;
  name: string;
  args: Array<[string, string]>;
}

function show(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

/** Decode one log against every ABI the stack deploys; unknown logs keep their raw topic. */
export function decodeLog(log: Log): DecodedEvent {
  for (const { label, abi } of SOURCES) {
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
      const args = Object.entries((decoded.args ?? {}) as Record<string, unknown>).map(
        ([k, v]) => [k, show(v)] as [string, string],
      );
      const token = STABLECOINS.find((t) => t.address.toLowerCase() === log.address.toLowerCase());
      return {
        address: log.address,
        source: label === "token" && token ? token.symbol : label,
        name: decoded.eventName ?? "event",
        args,
      };
    } catch {
      /* not this ABI */
    }
  }
  return { address: log.address, source: "unknown", name: log.topics[0] ?? "anonymous", args: [] };
}

export async function readTransaction(hash: Hex) {
  const [tx, receipt] = await Promise.all([
    chainClient.getTransaction({ hash }),
    chainClient.getTransactionReceipt({ hash }),
  ]);
  const block = await chainClient.getBlock({ blockNumber: receipt.blockNumber });
  return {
    hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    timestamp: Number(block.timestamp) * 1000,
    from: tx.from,
    to: tx.to ?? receipt.contractAddress ?? null,
    created: receipt.contractAddress ?? null,
    value: formatEther(tx.value),
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    events: receipt.logs.map(decodeLog),
  };
}

export async function readAddress(address: Address) {
  const [code, wei, ...balances] = await Promise.all([
    chainClient.getCode({ address }),
    chainClient.getBalance({ address }),
    ...STABLECOINS.map((t) =>
      chainClient
        .readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [address] })
        .then((units) => ({ symbol: t.symbol, amount: formatUnits(units, 6) }))
        .catch(() => ({ symbol: t.symbol, amount: "—" })),
    ),
  ]);
  const isContract = Boolean(code && code !== "0x");
  let token: { name: string; symbol: string; totalSupply: string } | null = null;
  if (isContract) {
    try {
      const [name, symbol, supply] = await Promise.all([
        chainClient.readContract({ address, abi: erc20Abi, functionName: "name" }),
        chainClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
        chainClient.readContract({ address, abi: erc20Abi, functionName: "totalSupply" }),
      ]);
      token = { name, symbol, totalSupply: formatUnits(supply, 6) };
    } catch {
      /* not a token */
    }
  }
  return { address, isContract, codeBytes: isContract ? (code!.length - 2) / 2 : 0, eth: formatEther(wei), balances, token };
}
