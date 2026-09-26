/**
 * The chain: a local fork of Monad testnet, funded and with XorvLedger on it.
 *
 * Forking (rather than a blank local chain) is the point of the exercise: the
 * USDC the buyer pays in is Circle's real FiatToken at its real address, with
 * its real EIP-712 domain ("USDC", "2") and its real EIP-3009
 * `transferWithAuthorization`; the Identity and Reputation registries are the
 * canonical ERC-8004 v2.0.0 singletons at their vanity 0x8004… addresses. So
 * the broker, the CLI and the MCP server run with their default testnet
 * configuration — only the RPC URL points somewhere else.
 *
 * The fork is Hardhat 3's EDR, from packages/contracts (`hardhat node
 * --network monadFork`): the toolchain is already in the repo, and its
 * `hardhat_*` methods do the funding. XorvLedger goes on with the package's
 * own deploy script (`--network monadForkRpc`), which recognises the fork by
 * its chain id and wires the ledger to the canonical registries.
 */

import { createRequire } from "node:module";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  encodeAbiParameters,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { MONAD_TESTNET, networkConfig, viemChain } from "@xorv/protocol";
import { delay, tail, type ManagedProcess, type ProcessGroup } from "./procs.js";

export const FIAT_TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function masterMinter() view returns (address)",
  "function isMinter(address) view returns (bool)",
  "function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);

export interface Fork {
  url: string;
  chainId: number;
  forkBlock: bigint;
  forkedFrom: string;
  process: ManagedProcess;
  client: PublicClient;
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

/** Hardhat's CLI entry, resolved from packages/contracts so the repo's pinned version runs. */
function hardhatCli(contractsDir: string): string {
  const require = createRequire(path.join(contractsDir, "package.json"));
  const pkgPath = require.resolve("hardhat/package.json");
  const pkg = require(pkgPath) as { bin: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.hardhat;
  if (!bin) throw new Error("could not find hardhat's CLI entry point");
  return path.join(path.dirname(pkgPath), bin);
}

export async function startFork(opts: {
  group: ProcessGroup;
  contractsDir: string;
  port: number;
  forkUrl: string;
  forkBlock: string | null;
  env: NodeJS.ProcessEnv;
}): Promise<Fork> {
  const url = `http://127.0.0.1:${opts.port}`;
  const proc = opts.group.start("fork", process.execPath, [hardhatCli(opts.contractsDir), "node", "--network", "monadFork", "--port", String(opts.port)], {
    cwd: opts.contractsDir,
    env: { ...opts.env, MONAD_FORK_URL: opts.forkUrl, MONAD_FORK_BLOCK: opts.forkBlock ?? "" },
  });
  await proc.waitFor(/Started HTTP and WebSocket JSON-RPC server/, 180_000);

  const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  };

  const chainId = Number(await rpc<string>("eth_chainId"));
  if (chainId !== networkConfig(MONAD_TESTNET).chainId) {
    throw new Error(`the fork reports chain id ${chainId}, expected 10143\n${tail(proc.output)}`);
  }
  const metadata = await rpc<{ forkedNetwork?: { forkBlockNumber: number; chainId: number } | null }>("hardhat_metadata");
  if (!metadata.forkedNetwork) throw new Error("hardhat_metadata says the node is not forking");

  const client = createPublicClient({ chain: viemChain(MONAD_TESTNET), transport: http(url, { timeout: 120_000 }), pollingInterval: 100 });
  return {
    url,
    chainId,
    forkBlock: BigInt(metadata.forkedNetwork.forkBlockNumber),
    forkedFrom: opts.forkUrl,
    process: proc,
    client,
    rpc,
  };
}

/** Give an address native MON (hardhat_setBalance). */
export async function setMon(fork: Fork, address: Address, wei: bigint): Promise<void> {
  await fork.rpc("hardhat_setBalance", [address, toHex(wei)]);
}

export interface UsdcFunding {
  method: "masterMinter" | "storage";
  masterMinter: Address | null;
  txHashes: Hex[];
}

/**
 * Mint real (forked) USDC to `to`: impersonate FiatToken's masterMinter, make
 * it a minter, and mint — the token's own code path, so the balance, total
 * supply and Transfer event are all genuine. If the masterMinter route is
 * unavailable (a contract masterMinter that can't be impersonated, a changed
 * token), fall back to writing the balance slot directly.
 */
export async function fundUsdc(fork: Fork, usdc: Address, to: Address, amount: bigint): Promise<UsdcFunding> {
  const before = await fork.client.readContract({ address: usdc, abi: FIAT_TOKEN_ABI, functionName: "balanceOf", args: [to] });
  try {
    const masterMinter = getAddress(await fork.client.readContract({ address: usdc, abi: FIAT_TOKEN_ABI, functionName: "masterMinter" }));
    await fork.rpc("hardhat_impersonateAccount", [masterMinter]);
    await setMon(fork, masterMinter, 10n ** 20n);
    const wallet = createWalletClient({ chain: viemChain(MONAD_TESTNET), transport: http(fork.url, { timeout: 120_000 }) });
    const txHashes: Hex[] = [];
    for (const [functionName, args] of [
      ["configureMinter", [masterMinter, amount]],
      ["mint", [to, amount]],
    ] as const) {
      const hash = await wallet.writeContract({
        account: masterMinter,
        address: usdc,
        abi: FIAT_TOKEN_ABI,
        functionName,
        args: args as never,
        chain: viemChain(MONAD_TESTNET),
      });
      const receipt = await fork.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
      txHashes.push(hash);
    }
    await fork.rpc("hardhat_stopImpersonatingAccount", [masterMinter]);
    const after = await fork.client.readContract({ address: usdc, abi: FIAT_TOKEN_ABI, functionName: "balanceOf", args: [to] });
    if (after - before !== amount) throw new Error(`minted ${amount} but the balance moved by ${after - before}`);
    return { method: "masterMinter", masterMinter, txHashes };
  } catch (err) {
    console.error(`  ! minting through the masterMinter failed (${err instanceof Error ? err.message : err}); writing the balance slot`);
    await writeBalanceSlot(fork, usdc, to, before + amount);
    return { method: "storage", masterMinter: null, txHashes: [] };
  }
}

/**
 * Find the balances mapping by probing: write a candidate slot, read
 * `balanceOf`, and keep the slot that moved it (restoring the others).
 * FiatToken v2.2 keeps balances (and a blacklist bit) at slot 9, but probing
 * survives a layout change.
 */
async function writeBalanceSlot(fork: Fork, token: Address, holder: Address, value: bigint): Promise<void> {
  for (let slot = 0n; slot < 64n; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, slot]));
    const previous = await fork.rpc<Hex>("eth_getStorageAt", [token, key, "latest"]);
    await fork.rpc("hardhat_setStorageAt", [token, key, toHex(value, { size: 32 })]);
    const balance = await fork.client.readContract({ address: token, abi: FIAT_TOKEN_ABI, functionName: "balanceOf", args: [holder] });
    if (balance === value) return;
    await fork.rpc("hardhat_setStorageAt", [token, key, toHex(BigInt(previous), { size: 32 })]);
  }
  throw new Error(`could not find ${token}'s balance slot`);
}

export interface LedgerDeployment {
  address: Address;
  fromBlock: bigint;
  txHash: Hex | null;
  output: string;
  ms: number;
}

/** Deploy XorvLedger with packages/contracts' own script, and read the address it prints. */
export async function deployLedger(opts: {
  group: ProcessGroup;
  contractsDir: string;
  fork: Fork;
  broker: Address;
  env: NodeJS.ProcessEnv;
}): Promise<LedgerDeployment> {
  const result = await opts.group.run(
    "deploy",
    process.execPath,
    [hardhatCli(opts.contractsDir), "run", "scripts/deploy.ts", "--network", "monadForkRpc"],
    {
      cwd: opts.contractsDir,
      env: { ...opts.env, MONAD_FORK_RPC_URL: opts.fork.url, XORV_BROKER_ADDRESS: opts.broker },
      timeoutMs: 300_000,
    },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const address = /XORV_LEDGER_ADDRESS=(0x[0-9a-fA-F]{40})/.exec(output)?.[1];
  const fromBlock = /XORV_LEDGER_FROM_BLOCK=(\d+)/.exec(output)?.[1];
  if (result.code !== 0 || !address || !fromBlock) {
    throw new Error(`the deploy script failed (exit ${result.code})\n${tail(output)}`);
  }
  if (!/is a fork of monadTestnet: using its canonical ERC-8004 registries/.test(output)) {
    throw new Error(`the deploy script did not recognise the fork, so the ledger is not wired to the real registries\n${tail(output)}`);
  }
  const txHash = (/Sent\s+(0x[0-9a-fA-F]{64})/.exec(output)?.[1] ?? null) as Hex | null;
  return { address: getAddress(address), fromBlock: BigInt(fromBlock), txHash, output, ms: result.ms };
}

/** Poll until `check` returns a value (or throw after `timeoutMs`). */
export async function waitUntil<T>(what: string, timeoutMs: number, check: () => Promise<T | null | undefined | false>, everyMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await delay(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${lastError ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})` : ""}`);
}
