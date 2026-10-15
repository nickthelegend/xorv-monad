/**
 * An escrowed job paid in Agora AUSD, through the live XorvEscrow on Monad testnet.
 *
 * XorvEscrow takes any allow-listed EIP-3009 token, and AUSD is allow-listed at deploy. This script:
 *  1. gets a fresh test buyer 10,000 AUSD from Agora's testnet faucet;
 *  2. has the buyer sign a ReceiveWithAuthorization under AUSD's EIP-712 domain ("Agora Dollar", v1);
 *  3. has the escrow's attester fund a job with it;
 *  4. releases the job to the hosted provider with a result hash.
 * The buyer never holds MON.
 *
 *   node e2e/live/ausd-escrow-job.mjs .env /path/to/buyer-key-out.env
 *
 * The env file supplies XORV_OPERATOR_KEY (pays the faucet call) and XORV_FACILITATOR_KEY (the attester).
 * The fresh buyer key is written to the second path (mode 600), never printed.
 */
import { createPublicClient, createWalletClient, http, keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";

const [envFile, keyOut] = process.argv.slice(2);
if (!envFile || !keyOut) throw new Error("usage: node e2e/live/ausd-escrow-job.mjs <env file> <buyer key out>");
const env = Object.fromEntries(readFileSync(envFile, "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

const R = "https://testnet-rpc.monad.xyz";
const AUSD = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
const FAUCET = "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C";
const ESCROW = "0x87d57e81b71d3eF5172156b5f3c6D01f5b74Df91";
const PROVIDER = "0xE0f2D369a0367694270bD1f7BBA400B0345b9B03";
const chain = { id: 10143, name: "monad", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [R] } } };
const pub = createPublicClient({ chain, transport: http(R) });
const op = createWalletClient({ account: privateKeyToAccount(env.XORV_OPERATOR_KEY), chain, transport: http(R) });
const att = createWalletClient({ account: privateKeyToAccount(env.XORV_FACILITATOR_KEY), chain, transport: http(R) });
const key = generatePrivateKey();
writeFileSync(keyOut, `AUSD_TEST_BUYER_KEY=${key}\n`, { mode: 0o600 });
const buyer = privateKeyToAccount(key);

const abi = [
  { type: "function", name: "requestFunds", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "fundingNonce", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "uint40" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "release", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bytes32" }], outputs: [] },
  { type: "function", name: "fund", stateMutability: "nonpayable", inputs: [{ type: "tuple", components: [
    { name: "jobId", type: "bytes32" }, { name: "buyer", type: "address" }, { name: "provider", type: "address" }, { name: "token", type: "address" },
    { name: "amount", type: "uint256" }, { name: "deadline", type: "uint40" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "signature", type: "bytes" }] }], outputs: [] },
];
const wait = async (hash) => {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${hash}`);
  return r;
};

// Gas limits are tight on purpose: Monad bills the limit, not the gas used.
const out = { buyer: buyer.address };
out.faucetTx = await op.writeContract({ address: FAUCET, abi, functionName: "requestFunds", args: [buyer.address], gas: 160_000n });
await wait(out.faucetTx);
const now = Number((await pub.getBlock()).timestamp);
const jobId = keccak256(toHex(`xorv-ausd-job-${now}`));
const deadline = now + 1800;
const amount = 20_000n; // 0.02 AUSD (6 decimals)
const validBefore = BigInt(now + 600);
const nonce = await pub.readContract({ address: ESCROW, abi, functionName: "fundingNonce", args: [jobId, deadline] });
const signature = await buyer.signTypedData({
  domain: { name: "Agora Dollar", version: "1", chainId: 10143, verifyingContract: AUSD },
  types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType: "ReceiveWithAuthorization",
  message: { from: buyer.address, to: ESCROW, value: amount, validAfter: 0n, validBefore, nonce },
});
out.fundTx = await att.writeContract({ address: ESCROW, abi, functionName: "fund", args: [{ jobId, buyer: buyer.address, provider: PROVIDER, token: AUSD, amount, deadline, validAfter: 0n, validBefore, signature }], gas: 400_000n });
await wait(out.fundTx);
out.releaseTx = await att.writeContract({ address: ESCROW, abi, functionName: "release", args: [jobId, keccak256(toHex("AUSD-settled job result"))], gas: 200_000n });
await wait(out.releaseTx);
out.jobId = jobId;
console.log(JSON.stringify(out, null, 2));
