/**
 * `operatorPolicy` against the real contracts on a local chain.
 *
 * The operator here owns the escrow as well as attesting for it, so on chain it
 * could pause it, swap the attester or drain its own MON. The policy is what
 * stops that. The broker's real fund/release path goes through the same routed
 * wallet client the Privy signer uses, with a test sender standing in for
 * Privy's enclave: it applies the policy by Privy's documented rules, then signs
 * locally. The owner-only call is refused before it is signed.
 * Skipped without anvil or the Foundry build output.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, stringToHex, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentRequirements } from "@x402/core/types";
import { ESCROW_SCHEME, EscrowClientScheme, EscrowFacilitatorScheme, escrowJobId, readEscrowJob, releaseEscrow } from "../src/escrow.js";
import { operatorPolicy, routedWalletClient, type TransactionSender } from "../src/privy.js";
import { writeClient } from "../src/chain.js";
import { evaluatePolicy, PolicyDeniedError, type PolicyVerdict } from "./policy-engine.js";
import { XORV_ESCROW_ABI } from "../src/xorv-escrow.abi.js";

const OUT = new URL("../../../contracts/out/", import.meta.url);
const artifact = (name: string) =>
  JSON.parse(readFileSync(new URL(`${name}.sol/${name}.json`, OUT), "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };

const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
const hasBuild = existsSync(new URL("XorvEscrow.sol/XorvEscrow.json", OUT)) && existsSync(new URL("MockERC3009.sol/MockERC3009.json", OUT));

const PORT = await new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    srv.close(() => resolve(port));
  });
});
const NET = "eip155:10143";

function policyRefusal(err: unknown): PolicyDeniedError | null {
  for (let e = err as { cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e instanceof PolicyDeniedError) return e;
  }
  return null;
}
const chain = defineChain({
  id: 10143,
  name: "anvil-as-monad-testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [`http://127.0.0.1:${PORT}`] } },
});

const OPERATOR_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const operator = privateKeyToAccount(OPERATOR_KEY);
const buyer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const provider = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;

describe.skipIf(!hasAnvil || !hasBuild)("operator policy on anvil", () => {
  let node: ChildProcess;
  let pub: PublicClient;
  let deployer: WalletClient;
  let token: Address;
  let escrow: Address;
  let signer: { wallet: WalletClient; address: Address };
  const verdicts: PolicyVerdict[] = [];
  const priorRpc = process.env.XORV_RPC_URL;

  async function deploy(name: string, args: unknown[]): Promise<Address> {
    const a = artifact(name);
    const hash = await deployer.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, account: operator, chain });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  }

  beforeAll(async () => {
    node = spawn("anvil", ["--port", String(PORT), "--chain-id", "10143", "--prune-history", "300", "--silent"]);
    process.env.XORV_RPC_URL = `http://127.0.0.1:${PORT}`;
    pub = createPublicClient({ chain, transport: http() }) as PublicClient;
    deployer = createWalletClient({ chain, transport: http(), account: operator });
    for (let i = 0; i < 50; i++) {
      try {
        await pub.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    token = await deploy("MockERC3009", ["Agora Dollar", "1"]);
    escrow = await deploy("XorvEscrow", [operator.address, operator.address, "0x0000000000000000000000000000000000000000", [token]]);
    const mint = await deployer.writeContract({ address: token, abi: artifact("MockERC3009").abi, functionName: "mint", args: [buyer.address, 10_000_000n], account: operator, chain });
    await pub.waitForTransactionReceipt({ hash: mint });

    // Privy's enclave, as a test double: the policy first, then the signature.
    const policy = operatorPolicy({ network: NET, escrow, tokens: [token] });
    const local = writeClient(NET, OPERATOR_KEY);
    const send: TransactionSender = async (tx) => {
      const ptx = { chainId: 10143, to: tx.to, value: tx.value ?? "0x0", data: tx.data ?? null };
      const verdict = evaluatePolicy(policy, "eth_sendTransaction", ptx);
      verdicts.push(verdict);
      if (!verdict.allowed) throw new PolicyDeniedError(verdict, ptx);
      return local.sendTransaction({
        account: local.account!,
        chain: local.chain,
        to: tx.to as Address,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : undefined,
      });
    };
    signer = { wallet: routedWalletClient(NET, operator.address, send), address: operator.address };
  }, 30_000);

  afterAll(() => {
    node?.kill();
    if (priorRpc === undefined) delete process.env.XORV_RPC_URL;
    else process.env.XORV_RPC_URL = priorRpc;
  });

  it("funds and releases a real escrow through the policy-locked wallet", async () => {
    const block = await pub.getBlock();
    const now = () => Number(block.timestamp) * 1000;
    const req: PaymentRequirements = {
      scheme: ESCROW_SCHEME,
      network: NET,
      asset: token,
      amount: "250000",
      payTo: escrow,
      maxTimeoutSeconds: 300,
      extra: { name: "Agora Dollar", version: "1", escrow, jobId: escrowJobId("q_privy"), deadline: Number(block.timestamp) + 1800, provider },
    };
    const { payload } = await new EscrowClientScheme(buyer, { now }).createPaymentPayload(2, req);
    const facilitator = new EscrowFacilitatorScheme({ public: pub, wallet: signer.wallet }, { now });
    const settled = await facilitator.settle({ x402Version: 2, accepted: req, payload }, req);
    expect(settled.success).toBe(true);

    const jobId = escrowJobId("q_privy");
    expect((await readEscrowJob(pub, escrow, jobId)).status).toBe("funded");
    await releaseEscrow({ public: pub, wallet: signer.wallet }, escrow, jobId, keccak256(stringToHex("result")).slice(2));
    expect((await readEscrowJob(pub, escrow, jobId)).status).toBe("released");

    expect(verdicts.filter((v) => v.allowed).map((v) => (v as { rule: string }).rule)).toEqual([
      "escrow.fund on 10143",
      "escrow.release on 10143",
    ]);
  });

  it("refuses the owner-only pause before signing, though the chain would accept it", async () => {
    const paused = () => pub.readContract({ address: escrow, abi: XORV_ESCROW_ABI, functionName: "paused" }) as Promise<boolean>;
    const nonce = await pub.getTransactionCount({ address: operator.address });
    const err = await signer.wallet
      .writeContract({ account: signer.wallet.account!, chain: signer.wallet.chain, address: escrow, abi: XORV_ESCROW_ABI, functionName: "pause", args: [] } as never)
      .then(() => null, (e: unknown) => e);
    // viem wraps it; the policy's refusal is the cause, and its reason is in the message.
    expect(policyRefusal(err)).toBeInstanceOf(PolicyDeniedError);
    expect(String((err as Error).message)).toMatch(/Policy engine \(test\) refused a transaction to 0x[0-9a-fA-F]{40}: no rule/);
    expect(await paused()).toBe(false);
    expect(await pub.getTransactionCount({ address: operator.address })).toBe(nonce);

    // Control: the same key, unpoliced, can pause it. That is the risk the policy removes.
    const hash = await deployer.writeContract({ address: escrow, abi: XORV_ESCROW_ABI, functionName: "pause", args: [], account: operator, chain });
    await pub.waitForTransactionReceipt({ hash });
    expect(await paused()).toBe(true);
  });

  it("refuses to move the operator's MON", async () => {
    await expect(
      signer.wallet.sendTransaction({ account: signer.wallet.account!, chain: signer.wallet.chain, to: provider, value: 10n ** 18n } as never),
    ).rejects.toThrow(/no rule in policy "xorv-operator-10143" allows it/);
  });
});
