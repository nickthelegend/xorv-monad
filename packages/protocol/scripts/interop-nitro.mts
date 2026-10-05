/**
 * Second half of scripts/interop-nitro.sh (repo root): drive two jobs through the
 * production escrow scheme and read the Stylus registry back.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PaymentRequirements } from "@x402/core/types";
import {
  ESCROW_SCHEME,
  EscrowClientScheme,
  EscrowFacilitatorScheme,
  escrowJobId,
  readEscrowJob,
  refundEscrow,
  releaseEscrow,
} from "../src/escrow.js";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};
const RPC = env("RPC");
const TOKEN = env("TOKEN") as Address;
const ESCROW = env("ESCROW") as Address;
const REGISTRY = env("REGISTRY") as Address;

const probe = createPublicClient({ transport: http(RPC) });
const chain = defineChain({
  id: await probe.getChainId(),
  name: "nitro-dev",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const operator = privateKeyToAccount(env("OP_KEY") as Hex);
const buyer = privateKeyToAccount(generatePrivateKey());
const provider = privateKeyToAccount(generatePrivateKey()).address;
const pub = createPublicClient({ chain, transport: http() }) as PublicClient;
const wallet = createWalletClient({ chain, transport: http(), account: operator });

const tokenAbi = parseAbi([
  "function mint(address,uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const registryAbi = parseAbi([
  "function getProvider(address) view returns (bytes32,uint64,uint64,uint64,uint64,uint256,bool)",
  "function score(address) view returns (uint32)",
  "function escrow() view returns (address)",
]);

const PRICE = 250_000n;
await pub.waitForTransactionReceipt({
  hash: await wallet.writeContract({ address: TOKEN, abi: tokenAbi, functionName: "mint", args: [buyer.address, 10_000_000n] }),
});

async function payFor(quoteId: string) {
  const block = await pub.getBlock();
  const now = () => Number(block.timestamp) * 1000;
  const req: PaymentRequirements = {
    scheme: ESCROW_SCHEME,
    network: `eip155:${chain.id}`,
    asset: TOKEN,
    amount: PRICE.toString(),
    payTo: ESCROW,
    maxTimeoutSeconds: 300,
    extra: {
      name: "Global Dollar",
      version: "1",
      escrow: ESCROW,
      jobId: escrowJobId(quoteId),
      deadline: Number(block.timestamp) + 1800,
      provider,
    },
  };
  const { payload } = await new EscrowClientScheme(buyer, { now }).createPaymentPayload(2, req);
  const facilitator = new EscrowFacilitatorScheme({ public: pub, wallet }, { now });
  const settled = await facilitator.settle({ x402Version: 2, accepted: req, payload }, req);
  if (!settled.success) throw new Error(`fund failed: ${settled.errorReason} ${settled.errorMessage}`);
  console.log(`   funded ${quoteId}: ${settled.transaction}`);
  return escrowJobId(quoteId);
}

function check(label: string, ok: boolean) {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) process.exitCode = 1;
}

console.log("── job 1: delivered → release");
const j1 = await payFor(`nitro-release-${Date.now()}`);
const rel = await releaseEscrow({ public: pub, wallet }, ESCROW, j1, keccak256(stringToHex("result")));
console.log(`   released: ${rel}`);

console.log("── job 2: failed → refund");
const j2 = await payFor(`nitro-refund-${Date.now()}`);
const ref = await refundEscrow({ public: pub, wallet }, ESCROW, j2);
console.log(`   refunded: ${ref}`);

const [nodeId, , , completed, failed, earned, active] = await pub.readContract({
  address: REGISTRY, abi: registryAbi, functionName: "getProvider", args: [provider],
});
const score = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "score", args: [provider] });
const providerBalance = await pub.readContract({ address: TOKEN, abi: tokenAbi, functionName: "balanceOf", args: [provider] });
const buyerBalance = await pub.readContract({ address: TOKEN, abi: tokenAbi, functionName: "balanceOf", args: [buyer.address] });

console.log("── registry (Stylus) after both jobs");
console.log({ nodeId, completed, failed, earned, active, score });
check("escrow → registry: completed = 1", completed === 1n);
check("escrow → registry: failed = 1", failed === 1n);
check("escrow → registry: earned = price", earned === PRICE);
check("score = (1+1)*10000/(1+1+2) = 5000", score === 5000);
check("job 1 released", (await readEscrowJob(pub, ESCROW, j1)).status === "released");
check("job 2 refunded", (await readEscrowJob(pub, ESCROW, j2)).status === "refunded");
check("provider paid exactly once", providerBalance === PRICE);
check("buyer net cost = one job", buyerBalance === 10_000_000n - PRICE);
