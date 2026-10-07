/**
 * The in-app chain viewer's logic: where an explorer link goes when no public
 * explorer can show it, and what a transaction's logs mean.
 *
 * On a local fork no explorer has ever seen the fork's transactions, so links
 * that would point at MonadVision point here instead, to pages that read the
 * app's own RPC. The logs are decoded against the contracts Xorv actually
 * talks to: Circle USDC's Transfer, XorvEscrow, XorvLedger and the ERC-8004
 * registries. Pure, so it is tested without a browser.
 */
import { decodeEventLog, parseAbi, type Abi, type Hex, type Log } from "viem";
import { IDENTITY_ABI, REPUTATION_ABI, XORV_ESCROW_ABI, XORV_LEDGER_ABI } from "@xorv/protocol/web";

const TRANSFER_ABI = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

/** Where an explorer URL leads in the in-app viewer, or null for pages it doesn't have (NFTs). */
export function viewerPath(explorerUrl: string, href: string): string | null {
  if (!href.startsWith(explorerUrl)) return null;
  const rest = href.slice(explorerUrl.length);
  const m = /^\/(tx|address|token|block)\/([^/?#]+)/.exec(rest);
  if (!m) return null;
  const [, kind, id] = m;
  return `/chain/${kind === "token" ? "address" : kind}/${id}`;
}

export interface DecodedLog {
  index: number;
  address: string;
  /** "XorvEscrow", "USDC", … or null when the emitter isn't one Xorv knows. */
  contract: string | null;
  event: string | null;
  args: Record<string, string>;
  /** Raw topics and data, for anything that didn't decode. */
  raw: { topics: readonly Hex[]; data: Hex } | null;
}

const ABIS: { label: string; abi: Abi }[] = [
  { label: "XorvEscrow", abi: XORV_ESCROW_ABI as Abi },
  { label: "XorvLedger", abi: XORV_LEDGER_ABI as Abi },
  { label: "ERC-8004 identity", abi: IDENTITY_ABI as Abi },
  { label: "ERC-8004 reputation", abi: REPUTATION_ABI as Abi },
  { label: "ERC-20", abi: TRANSFER_ABI as Abi },
];

function show(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(show).join(", ")}]`;
  if (value && typeof value === "object") return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  return String(value);
}

/**
 * Decode each log against the ABIs Xorv knows, naming its emitter from
 * `labels` (lowercased address → name) when it is a known contract.
 */
export function decodeLogs(logs: readonly Pick<Log, "address" | "topics" | "data" | "logIndex">[], labels: Record<string, string>): DecodedLog[] {
  return logs.map((log, i) => {
    const contract = labels[log.address.toLowerCase()] ?? null;
    const preferred = contract ? ABIS.filter((a) => contract.startsWith(a.label) || (a.label === "ERC-20" && contract === "USDC")) : [];
    for (const { abi } of [...preferred, ...ABIS]) {
      try {
        const decoded = decodeEventLog({ abi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
        const args = Object.fromEntries(Object.entries((decoded.args ?? {}) as Record<string, unknown>).map(([k, v]) => [k, show(v)]));
        return { index: log.logIndex ?? i, address: log.address, contract, event: decoded.eventName ?? null, args, raw: null };
      } catch {
        // not this ABI
      }
    }
    return { index: log.logIndex ?? i, address: log.address, contract, event: null, args: {}, raw: { topics: log.topics as Hex[], data: log.data } };
  });
}
