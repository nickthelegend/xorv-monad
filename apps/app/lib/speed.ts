/**
 * Formatting for the Monad speed receipt.
 *
 * The numbers come from the broker: how long each settlement took on its own
 * clock, from submitting the transaction to holding the confirmed receipt, and
 * the block, gas and gas payer read back from that receipt. Nothing here is
 * estimated. The one fixed figure is Ethereum's 12-second slot, a protocol
 * constant, shown for scale.
 */
import { formatEther } from "viem";

/** Ethereum mainnet produces one block per 12-second slot (protocol constant). */
export const ETHEREUM_SLOT_MS = 12_000;

/** "612 ms", or "1.24 s" from a second up. */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Wei of MON as a short decimal: "0.0042 MON", "<0.000001 MON". */
export function formatMon(wei: string | bigint): string {
  const value = typeof wei === "bigint" ? wei : BigInt(wei);
  if (value === 0n) return "0 MON";
  if (value < 1_000_000_000_000n) return "<0.000001 MON";
  const [whole, frac = ""] = formatEther(value).split(".");
  const digits = frac.slice(0, 6).replace(/0+$/, "");
  return `${whole}${digits ? `.${digits}` : ""} MON`;
}

/** "84,213" */
export function formatGas(gas: string): string {
  return BigInt(gas).toLocaleString("en-US");
}

/**
 * How many times faster than one Ethereum block, rounded down, when that is
 * worth saying (2× or more); null otherwise.
 */
export function vsEthereumSlot(ms: number | null): number | null {
  if (ms === null || ms <= 0) return null;
  const times = Math.floor(ETHEREUM_SLOT_MS / ms);
  return times >= 2 ? times : null;
}
