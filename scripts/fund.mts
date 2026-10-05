/**
 * Move funds between the demo accounts on Arbitrum Sepolia (or XORV_NETWORK).
 *
 * Faucets fund one address at a time, so this spreads a single claim across the
 * roles:
 *
 *   - ETH goes to the **operator** only. Its facilitator relays every buyer's
 *     signed authorization and pays the gas; nobody else ever sends a
 *     transaction.
 *   - USDG / USDC goes to the **buyer**. It needs no ETH — it only signs.
 *   - The provider needs nothing. It only receives.
 *
 * Sent from the demo payer key (XORV_DEMO_PAYER_KEY), so moving a stablecoin
 * spends a little of the payer's ETH. Moving ETH to the operator is the usual
 * first step.
 *
 *   pnpm dlx tsx scripts/fund.mts <to-address> <amount> [ETH|USDG|USDC]
 */

import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseEther,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { evmChain } from "../packages/protocol/src/chain.ts";
import {
  DEFAULT_NETWORK,
  explorerTx,
  stablecoinBySymbol,
} from "../packages/protocol/src/constants.ts";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
) as Record<string, string>;

const [to, amount, asset = "ETH"] = process.argv.slice(2);
if (!to || !amount) {
  console.error("usage: tsx scripts/fund.mts <to-address> <amount> [ETH|USDG|USDC]");
  process.exit(1);
}

const network = env.XORV_NETWORK || DEFAULT_NETWORK;
if (env.XORV_RPC_URL) process.env.XORV_RPC_URL = env.XORV_RPC_URL;
const chain = evmChain(network);
const transport = http(chain.rpcUrls.default.http[0]);
const from = privateKeyToAccount(env.XORV_DEMO_PAYER_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account: from, chain, transport });
const recipient = getAddress(to);

let hash: `0x${string}`;
if (asset.toUpperCase() === "ETH") {
  const value = parseEther(amount);
  console.log(`  ${from.address}\n→ ${recipient}\n  ${amount} ETH on ${chain.name}`);
  hash = await wallet.sendTransaction({ to: recipient, value });
} else {
  const token = stablecoinBySymbol(network, asset);
  if (!token) {
    console.error(`  ✖ ${asset} is not configured on ${chain.name}`);
    process.exit(1);
  }
  // 6 decimals, like every stablecoin Xorv prices in.
  const units = parseUnits(amount, token.decimals);
  console.log(`  ${from.address}\n→ ${recipient}\n  ${amount} ${token.symbol} on ${chain.name}`);
  hash = await wallet.writeContract({
    address: getAddress(token.address),
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, units],
  });
}

console.log("  tx", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log("  status", receipt.status, "· block", receipt.blockNumber);
if (asset.toUpperCase() === "ETH") {
  console.log("  recipient now holds", formatEther(await publicClient.getBalance({ address: recipient })), "ETH");
} else {
  const token = stablecoinBySymbol(network, asset)!;
  const held = await publicClient.readContract({
    address: getAddress(token.address),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [recipient],
  });
  console.log("  recipient now holds", formatUnits(held, 6), token.symbol);
}
console.log(`  ${explorerTx(network, hash)}`);
