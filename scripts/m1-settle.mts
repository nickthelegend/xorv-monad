/**
 * M1 — prove a real x402 payment settles on Arbitrum Sepolia, in USDG.
 *
 * Deliberately standalone. It imports nothing from `@xorv/*`, so it can be run
 * and trusted on its own, and it stays as the reference the protocol layer is
 * written against.
 *
 * ## What it is proving
 *
 * Paxos USDG (and Circle USDC) implement EIP-3009 `transferWithAuthorization`,
 * so the buyer signs an authorization offline, broadcasts nothing, holds **no
 * ETH**, and the facilitator relays it and pays the gas. That is the same
 * property Hedera's fee-payer model gave us, reached by a different mechanism,
 * and it means **no custom x402 scheme is needed** — the stock `@x402/evm`
 * exact scheme settles as-is, given the token's EIP-712 domain.
 *
 * The domain is the one thing that cannot be read: USDG's `version()` reverts
 * and it has no `eip712Domain()`. So it is configured, and checked by
 * recomputing `DOMAIN_SEPARATOR` and comparing it with the contract's.
 *
 * Run:
 *   pnpm dlx tsx scripts/m1-settle.mts            # pays in USDG
 *   TOKEN=USDC pnpm dlx tsx scripts/m1-settle.mts  # pays in USDC
 */

import {
  createPublicClient,
  createWalletClient,
  domainSeparator,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactEvmScheme as registerFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { toClientEvmSigner, toFacilitatorEvmSigner } from "@x402/evm";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
) as Record<string, string>;

/** The Arbitrum Sepolia stablecoins, with their verified EIP-712 domains. */
const TOKENS = {
  USDG: {
    address: "0xFFC95faa3d63Cde504a05B567C600B78C0b41892" as const,
    domain: { name: "Global Dollar", version: "1" },
  },
  USDC: {
    address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as const,
    domain: { name: "USD Coin", version: "2" },
  },
};
const SYMBOL = (process.env.TOKEN ?? "USDG").toUpperCase() as keyof typeof TOKENS;
if (!TOKENS[SYMBOL]) {
  console.error(`TOKEN must be USDG or USDC, got ${process.env.TOKEN}`);
  process.exit(1);
}
const TOKEN = TOKENS[SYMBOL].address;
const DOMAIN = TOKENS[SYMBOL].domain;
const NETWORK = "eip155:421614";
/** 1000 units = $0.001 at 6 decimals. Small on purpose: this runs for real. */
const AMOUNT = "1000";

const payer = privateKeyToAccount(env.XORV_DEMO_PAYER_KEY as `0x${string}`);
const facilitatorAccount = privateKeyToAccount(env.XORV_OPERATOR_KEY as `0x${string}`);
const provider = env.XORV_DEMO_PROVIDER_ADDRESS as `0x${string}`;

const transport = http(env.XORV_RPC_URL || undefined);
const publicClient = createPublicClient({ chain: arbitrumSepolia, transport });
const facilitatorWallet = createWalletClient({
  account: facilitatorAccount,
  chain: arbitrumSepolia,
  transport,
});

const step = (n: string, s: string) => console.log(`\n${n}  ${s}`);
const line = (k: string, v: unknown) => console.log(`     ${k.padEnd(22)} ${v}`);

async function balances(label: string) {
  const [payerToken, payerEth, providerToken] = await Promise.all([
    publicClient.readContract({ address: TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [payer.address] }),
    publicClient.getBalance({ address: payer.address }),
    publicClient.readContract({ address: TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [provider] }),
  ]);
  console.log(
    `     ${label.padEnd(22)} payer ${formatUnits(payerToken, 6)} ${SYMBOL}  |  ` +
      `${formatUnits(payerEth, 18)} ETH  |  provider ${formatUnits(providerToken, 6)} ${SYMBOL}`,
  );
  return { payerToken, payerEth, providerToken };
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n  M1 — settle a real x402 payment on Arbitrum Sepolia in ${SYMBOL}\n` + "  ".padEnd(60, "─"));
  line("chain", `${arbitrumSepolia.name} (${arbitrumSepolia.id})`);
  line("token", `${SYMBOL} ${TOKEN}`);
  line("payer", payer.address);
  line("provider (payTo)", provider);
  line("facilitator", facilitatorAccount.address);

  step("1.", "check the configured EIP-712 domain against the contract");
  const expected = domainSeparator({
    domain: { ...DOMAIN, chainId: arbitrumSepolia.id, verifyingContract: getAddress(TOKEN) },
  });
  const actual = (await publicClient.readContract({
    address: TOKEN,
    abi: [{ name: "DOMAIN_SEPARATOR", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }],
    functionName: "DOMAIN_SEPARATOR",
  })) as string;
  line("eip-712 domain", `name="${DOMAIN.name}" version="${DOMAIN.version}"`);
  line("DOMAIN_SEPARATOR", actual.toLowerCase() === expected.toLowerCase() ? "matches ✔" : `MISMATCH (${actual})`);
  if (actual.toLowerCase() !== expected.toLowerCase()) process.exit(1);

  const before = await balances("before");
  if (before.payerToken < BigInt(AMOUNT)) {
    console.error(`\n  ✖ payer holds ${before.payerToken} ${SYMBOL} units, needs ${AMOUNT}. Fund ${payer.address}.\n`);
    process.exit(1);
  }

  step("2.", "buyer signs an EIP-3009 authorization — broadcasts nothing");
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: toClientEvmSigner(payer, publicClient),
    networks: [NETWORK],
  });

  const requirements = {
    scheme: "exact" as const,
    network: NETWORK as never,
    amount: AMOUNT,
    asset: TOKEN,
    payTo: provider,
    maxTimeoutSeconds: 300,
    extra: DOMAIN,
  };
  // `createPaymentPayload` takes the whole 402 body, not a bare requirement:
  // it selects from `accepts` using the schemes the client has registered.
  const payload = await client.createPaymentPayload({
    x402Version: 2,
    resource: { url: "https://xorv.dev/m1", method: "POST" } as never,
    accepts: [requirements],
  });
  line("scheme", requirements.scheme);
  line("payload keys", Object.keys(payload.payload ?? {}).join(", "));
  line("payer broadcast?", "no — offline signature only");

  step("3.", "facilitator verifies, then relays and pays the gas");
  const facilitator = new x402Facilitator();
  registerFacilitatorScheme(facilitator, {
    // Composed by hand rather than spread from the viem clients: the signer
    // needs reads, a typed-data check, and writes, which live on two different
    // clients, and `writeContract`/`sendTransaction` must stay bound to the
    // wallet that holds the account.
    signer: toFacilitatorEvmSigner({
      address: facilitatorAccount.address,
      readContract: (args) => publicClient.readContract(args as never) as Promise<unknown>,
      verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
      getCode: (args) => publicClient.getCode(args as never),
      waitForTransactionReceipt: (args) =>
        publicClient.waitForTransactionReceipt(args as never) as never,
      writeContract: (args) => facilitatorWallet.writeContract(args as never),
      sendTransaction: (args) => facilitatorWallet.sendTransaction(args as never),
    }),
    // Not optional, and it fails confusingly if omitted: routing derives from
    // this set, and a wildcard is only produced when 2+ networks share a
    // namespace. Without it verify() throws inside escapeRegExp.
    networks: [NETWORK as never],
  });

  const verified = await facilitator.verify(payload as never, requirements as never);
  line("verify", JSON.stringify(verified));
  if (!(verified as { isValid?: boolean }).isValid) {
    console.error("\n  ✖ verification failed — not broadcasting.\n");
    process.exit(1);
  }

  const settled = await facilitator.settle(payload as never, requirements as never);
  line("settle", JSON.stringify(settled));

  const txHash = (settled as { transaction?: string }).transaction;
  step("4.", "confirm on chain");
  const after = await balances("after");
  const moved = after.providerToken - before.providerToken;
  const spent = before.payerToken - after.payerToken;

  // Gas is ETH and the buyer never sends a transaction, so its ETH balance
  // must not move by a single wei.
  const gasPaidByPayer = before.payerEth - after.payerEth;

  line("provider received", `${moved} units (expected ${AMOUNT})`);
  line("payer spent", `${spent} units`);
  line("payer paid in gas", `${gasPaidByPayer} wei — must be 0`);
  if (txHash) line("arbiscan", `https://sepolia.arbiscan.io/tx/${txHash}`);

  const ok = moved === BigInt(AMOUNT) && spent === BigInt(AMOUNT) && gasPaidByPayer === 0n;
  console.log("\n  " + (ok ? "✔ M1 PASSED" : "✖ M1 FAILED") + ` — a buyer holding no ETH paid in ${SYMBOL}, and never sent a transaction.\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\n  ✖", err?.shortMessage ?? err?.message ?? err);
  if (err?.cause?.message) console.error("    cause:", err.cause.message);
  process.exit(1);
});
