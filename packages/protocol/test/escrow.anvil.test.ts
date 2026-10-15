/**
 * The escrow scheme end to end, against the real contracts on a local chain.
 *
 * Deploys XorvEscrow and an EIP-3009 test token to anvil, then drives the
 * whole x402 path with the production code: the buyer's client scheme signs,
 * the facilitator scheme verifies and funds, and the broker's helpers release
 * and refund. Skipped when anvil or the Foundry build output is missing, so
 * the suite still runs on a machine without Foundry.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
import { escrowWriter } from "../src/x402.js";
import { walletClientFor } from "../src/evm.js";
import { sendModeOf, syncReceipt } from "../src/sync-send.js";

const OUT = new URL("../../../contracts/out/", import.meta.url);
const artifact = (name: string, file = name) =>
  JSON.parse(readFileSync(new URL(`${file}.sol/${name}.json`, OUT), "utf8")) as {
    abi: unknown[];
    bytecode: { object: Hex };
  };

const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
const hasBuild =
  existsSync(new URL("XorvEscrow.sol/XorvEscrow.json", OUT)) &&
  existsSync(new URL("MockERC3009.sol/MockERC3009.json", OUT));

// A free port, not a fixed one: a fixed port that something else already
// listens on (a Docker container held 8547 here) makes anvil fail to bind and
// the suite talk to a stranger's node.
const PORT = await new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    srv.close(() => resolve(port));
  });
});
const chain = defineChain({
  id: 10143,
  name: "anvil-as-monad-testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [`http://127.0.0.1:${PORT}`] } },
});

// anvil's well-known dev keys.
const operator = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const buyer = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const provider = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;

describe.skipIf(!hasAnvil || !hasBuild)("escrow scheme on anvil", () => {
  let node: ChildProcess;
  let pub: PublicClient;
  let wallet: WalletClient;
  let token: Address;
  let escrow: Address;

  async function deploy(name: string, args: unknown[], file = name): Promise<Address> {
    const a = artifact(name, file);
    const hash = await wallet.deployContract({
      abi: a.abi,
      bytecode: a.bytecode.object,
      args,
      account: operator,
      chain,
    });
    const r = await pub.waitForTransactionReceipt({ hash });
    return r.contractAddress!;
  }

  const balanceOf = (who: Address) =>
    pub.readContract({
      address: token,
      abi: artifact("MockERC3009").abi,
      functionName: "balanceOf",
      args: [who],
    }) as Promise<bigint>;

  async function requirementsFor(quoteId: string): Promise<PaymentRequirements> {
    const block = await pub.getBlock();
    return {
      scheme: ESCROW_SCHEME,
      network: "eip155:10143",
      asset: token,
      amount: "250000",
      payTo: escrow,
      maxTimeoutSeconds: 300,
      extra: {
        name: "Agora Dollar",
        version: "1",
        escrow,
        jobId: escrowJobId(quoteId),
        deadline: Number(block.timestamp) + 1800,
        provider,
      },
    };
  }

  async function pay(quoteId: string) {
    const req = await requirementsFor(quoteId);
    const block = await pub.getBlock();
    const client = new EscrowClientScheme(buyer, { now: () => Number(block.timestamp) * 1000 });
    const { payload } = await client.createPaymentPayload(2, req);
    const facilitator = new EscrowFacilitatorScheme(
      { public: pub, wallet },
      { now: () => Number(block.timestamp) * 1000 },
    );
    const p = { x402Version: 2, accepted: req, payload };
    return { req, p, facilitator };
  }

  beforeAll(async () => {
    node = spawn("anvil", ["--port", String(PORT), "--chain-id", "10143", "--silent"]);
    pub = createPublicClient({ chain, transport: http() }) as PublicClient;
    wallet = createWalletClient({ chain, transport: http(), account: operator });
    for (let i = 0; i < 50; i++) {
      try {
        await pub.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    token = await deploy("MockERC3009", ["Agora Dollar", "1"]);
    escrow = await deploy("XorvEscrow", [
      operator.address,
      operator.address,
      "0x0000000000000000000000000000000000000000",
      [token],
    ]);
    const mint = await wallet.writeContract({
      address: token,
      abi: artifact("MockERC3009").abi,
      functionName: "mint",
      args: [buyer.address, 10_000_000n],
      account: operator,
      chain,
    });
    await pub.waitForTransactionReceipt({ hash: mint });
  }, 30_000);

  afterAll(() => {
    node?.kill();
  });

  it("verifies, funds, and releases to the provider", async () => {
    const { req, p, facilitator } = await pay("q_release");

    expect(await facilitator.verify(p, req)).toEqual({ isValid: true, payer: buyer.address });
    const settled = await facilitator.settle(p, req);
    expect(settled.success).toBe(true);
    expect(settled.transaction).toMatch(/^0x[0-9a-f]{64}$/);

    const jobId = escrowJobId("q_release");
    const funded = await readEscrowJob(pub, escrow, jobId);
    expect(funded.status).toBe("funded");
    expect(funded.buyer).toBe(buyer.address);
    expect(funded.provider).toBe(provider);
    expect(await balanceOf(escrow)).toBe(250_000n);

    // The same payment can't be settled twice.
    const again = await facilitator.verify(p, req);
    expect(again.isValid).toBe(false);

    const resultHash = keccak256(stringToHex("the result")).slice(2);
    await releaseEscrow({ public: pub, wallet }, escrow, jobId, resultHash);
    expect((await readEscrowJob(pub, escrow, jobId)).status).toBe("released");
    expect(await balanceOf(provider)).toBe(250_000n);
    expect(await balanceOf(escrow)).toBe(0n);
  });

  it("refunds the buyer when the job fails", async () => {
    const before = await balanceOf(buyer.address);
    const { req, p, facilitator } = await pay("q_refund");
    expect((await facilitator.settle(p, req)).success).toBe(true);
    expect(await balanceOf(buyer.address)).toBe(before - 250_000n);

    await refundEscrow({ public: pub, wallet }, escrow, escrowJobId("q_refund"));
    expect((await readEscrowJob(pub, escrow, escrowJobId("q_refund"))).status).toBe("refunded");
    expect(await balanceOf(buyer.address)).toBe(before);
  });

  it("releases through the broker's writer with the receipt in the send's own response (eth_sendRawTransactionSync)", async () => {
    const { req, p, facilitator } = await pay("q_sync");
    expect((await facilitator.settle(p, req)).success).toBe(true);
    const writer = escrowWriter(walletClientFor("eip155:10143", operator, { rpcUrl: `http://127.0.0.1:${PORT}` }), operator);
    const resultHash = keccak256(stringToHex("synced")).slice(2);
    const tx = await releaseEscrow({ public: pub, wallet: writer }, escrow, escrowJobId("q_sync"), resultHash);
    expect(sendModeOf(tx)).toBe("sync");
    expect(syncReceipt(tx)).toMatchObject({ transactionHash: tx, status: "success" });
    expect((await readEscrowJob(pub, escrow, escrowJobId("q_sync"))).status).toBe("released");
  });
});
