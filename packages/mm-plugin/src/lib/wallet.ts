/**
 * Which address the active MetaMask wallet signs as.
 *
 * x402's EIP-3009 authorization names its payer (`from`) *inside* the message
 * being signed, so the address is needed before the signature exists. The
 * plugin reads it from `ctx.walletStateManager` (capability `wallet-read`):
 * the selected wallet when there is one, otherwise the only EVM wallet.
 * `--from` overrides it, and `assertSignedBy` checks the result either way —
 * a wrong guess fails before anything is sent, never as a rejected payment.
 */

import { isEvmAddress, normalizeAddress } from "@xorv/protocol";
import type { Address } from "viem";
import { XorvPluginError } from "./errors.js";

/** One wallet row in the host's local wallet state (the fields this needs). */
export interface WalletEntry {
  address?: string;
  id?: string;
  name?: string;
  namespace?: string;
}

/** The subset of `walletStateManager.read()` the plugin looks at. */
export interface WalletStateSnapshot {
  byokWallets?: WalletEntry[];
  remoteWallets?: WalletEntry[];
  selectedWallet?: {
    mode?: string;
    namespace?: string;
    ref?: { id?: string; address?: string; name?: string };
  } | null;
}

const isEvm = (entry: WalletEntry) => (entry.namespace ?? "evm") === "evm" && Boolean(entry.address && isEvmAddress(entry.address));

export function activeEvmAddress(state: WalletStateSnapshot | null | undefined, override?: string | null): Address {
  const forced = override?.trim();
  if (forced) {
    if (!isEvmAddress(forced)) {
      throw new XorvPluginError("XORV_INVALID_INPUT", `--from "${forced}" is not an EVM address`, "Pass a 0x address from mm wallet list.");
    }
    return normalizeAddress(forced);
  }

  const wallets = [...(state?.remoteWallets ?? []), ...(state?.byokWallets ?? [])].filter(isEvm);
  const selected = state?.selectedWallet;
  if (selected && (selected.namespace ?? "evm") === "evm" && selected.ref) {
    const ref = selected.ref;
    if (ref.address && isEvmAddress(ref.address)) return normalizeAddress(ref.address);
    const match = wallets.find((w) => (ref.id && w.id === ref.id) || (ref.name && w.name === ref.name));
    if (match?.address) return normalizeAddress(match.address);
  }

  const distinct = [...new Set(wallets.map((w) => normalizeAddress(w.address!)))];
  if (distinct.length === 0) {
    throw new XorvPluginError(
      "XORV_NO_WALLET",
      "no EVM wallet is set up in MetaMask Agent Wallet",
      "Run mm init (or mm wallet create), then fund it with test USDC from https://faucet.circle.com (Monad Testnet).",
    );
  }
  // Several wallets and none selected: take the first. The signature check
  // afterwards turns a wrong pick into a clear "select the wallet" error.
  return distinct[0]!;
}
