/**
 * Send a contract write and get its receipt in the same round trip, with
 * Monad's `eth_sendRawTransactionSync` (EIP-7966).
 *
 * Monad returns the receipt as soon as the transaction's block is proposed
 * and executed, with no `eth_getTransactionReceipt` polling, so the time from
 * sending to holding a receipt is one round trip plus one block. viem's own
 * `sendTransactionSync` always sends a timeout parameter, which some nodes
 * (anvil 1.7) reject, so this signs locally and sends the transaction alone.
 *
 * A node without the method answers "method not supported"; then the same
 * signed transaction goes out with `eth_sendRawTransaction`, and the caller
 * polls for the receipt as before. Either way the hash is recorded with how
 * it was sent (`sendMode`), so a speed receipt can say which path it timed.
 *
 * A receipt from a Proposed block is not final: callers that credit value
 * should still wait for finality (see the broker's speed receipt).
 */
import { encodeFunctionData, formatTransactionReceipt, type Abi, type Account, type Address, type Hex, type TransactionReceipt } from "viem";
import type { XorvWalletClient } from "./evm.js";

export type SendMode = "sync" | "async";

const MAX_REMEMBERED = 256;
const sent = new Map<string, { mode: SendMode; receipt: TransactionReceipt | null }>();

function remember(hash: Hex, mode: SendMode, receipt: TransactionReceipt | null): void {
  sent.set(hash.toLowerCase(), { mode, receipt });
  if (sent.size > MAX_REMEMBERED) {
    const oldest = sent.keys().next().value;
    if (oldest !== undefined) sent.delete(oldest);
  }
}

/** The receipt `eth_sendRawTransactionSync` returned for this hash, if it was sent that way. */
export function syncReceipt(hash: string): TransactionReceipt | null {
  return sent.get(hash.toLowerCase())?.receipt ?? null;
}

/** How this process sent a transaction: "sync" (receipt in the response), "async" (polled), or null if it didn't send it. */
export function sendModeOf(hash: string): SendMode | null {
  return sent.get(hash.toLowerCase())?.mode ?? null;
}

/** Whether an RPC error means the node doesn't offer `eth_sendRawTransactionSync`. */
export function isSyncUnsupported(err: unknown): boolean {
  const e = err as { code?: number; cause?: { code?: number }; message?: string; details?: string };
  const code = e?.code ?? e?.cause?.code;
  if (code === -32601 || code === -32604) return true;
  const text = `${e?.message ?? ""} ${e?.details ?? ""}`;
  return /method not (found|supported)|not supported|does not exist|unknown method|not available/i.test(text);
}

export interface SyncWrite {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  gas: bigint;
}

/**
 * Sign `write` with `account` and send it, receipt-in-response when the node
 * supports it. Returns the hash; the receipt, when there is one, is available
 * from `syncReceipt(hash)`.
 */
export async function writeContractSync(wallet: XorvWalletClient, account: Account, write: SyncWrite): Promise<Hex> {
  if (account.type !== "local" || !account.signTransaction) {
    // A remote signer can't hand us a raw transaction; send it the ordinary way.
    const hash = (await wallet.writeContract({ ...write, account, chain: wallet.chain } as never)) as Hex;
    remember(hash, "async", null);
    return hash;
  }
  const data = encodeFunctionData({ abi: write.abi, functionName: write.functionName, args: write.args ?? [] } as never);
  const prepared = await wallet.prepareTransactionRequest({ account, to: write.address, data, gas: write.gas, chain: wallet.chain } as never);
  const serializedTransaction = await account.signTransaction(prepared as never);
  try {
    const raw = await wallet.request(
      { method: "eth_sendRawTransactionSync", params: [serializedTransaction] } as never,
      { retryCount: 0 },
    );
    const receipt = formatTransactionReceipt(raw as never) as TransactionReceipt;
    remember(receipt.transactionHash, "sync", receipt);
    return receipt.transactionHash;
  } catch (err) {
    if (!isSyncUnsupported(err)) throw err;
    const hash = await wallet.sendRawTransaction({ serializedTransaction });
    remember(hash, "async", null);
    return hash;
  }
}
