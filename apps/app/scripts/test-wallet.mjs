#!/usr/bin/env node
/**
 * A wallet for driving the app's wallet flows in a browser that has no wallet
 * extension — the local Anvil stack only.
 *
 * It is the signing half of an EIP-1193 wallet, over HTTP on 127.0.0.1: a
 * page-side `window.ethereum` (printed by `--snippet`) forwards every request
 * here. Accounts, chain id, EIP-712 signatures and transactions are answered
 * with a real key — a fresh one, generated on first run into
 * data/test-wallet.key (gitignored) — and everything else is proxied to the
 * node. So what the app gets back is exactly what a wallet would give it:
 * real signatures the token contract verifies, real transactions on chain.
 * The one thing it does not have is a consent popup; it signs whatever the
 * page asks, which is why it refuses any chain but the local dev node.
 *
 *   node apps/app/scripts/test-wallet.mjs            # serve on :8420
 *   node apps/app/scripts/test-wallet.mjs --snippet  # the page-side provider
 *                                                    # (also served at GET /snippet.js)
 *
 * Network behaviour follows MetaMask's, so the app's wrong-network handling
 * can be exercised: the wallet is on one chain at a time, switches only to a
 * chain it knows (4902 otherwise, until `wallet_addEthereumChain`), refuses
 * to sign typed data whose domain names another chain, and emits
 * `chainChanged`. XORV_TEST_WALLET_START_CHAIN starts it elsewhere (it can
 * only transact on the dev node), XORV_TEST_WALLET_KNOWS_DEV=0 makes the dev
 * node a chain it has never heard of, `ethereum.__userSwitchChain(id)` is
 * the user picking another network in the wallet's own menu, and
 * `ethereum.__userRejectNext()` is the user pressing Reject on the next prompt.
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWalletClient, defineChain, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const PORT = Number(process.env.XORV_TEST_WALLET_PORT ?? 8420);
const RPC = process.env.XORV_RPC_URL ?? "http://127.0.0.1:8648";
const CHAIN_ID = 31337;
const ORIGIN = process.env.XORV_TEST_WALLET_ORIGIN ?? "http://localhost:3302";

const SNIPPET = `(() => {
  const listeners = {};
  const call = async (method, params) => {
    const res = await fetch("http://127.0.0.1:${PORT}", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
    });
    const body = await res.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return body.result;
  };
  const emit = (event, value) => (listeners[event] ?? []).forEach((fn) => fn(value));
  window.ethereum = {
    isXorvTestWallet: true,
    request: async ({ method, params }) => {
      const before = method.startsWith("wallet_") ? await call("eth_chainId") : null;
      const result = await call(method, params);
      if (before !== null) {
        const after = await call("eth_chainId");
        if (after !== before) emit("chainChanged", after);
      }
      return result;
    },
    on: (event, fn) => ((listeners[event] ??= []).push(fn)),
    removeListener: (event, fn) => (listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn)),
    __userRejectNext: () => call("xorv_testRejectNext"),
    __userSwitchChain: async (id) => {
      await call("xorv_testUserSwitch", [id]);
      emit("chainChanged", "0x" + Number(id).toString(16));
    },
  };
  window.dispatchEvent(new Event("ethereum#initialized"));
})();\n`;

if (process.argv.includes("--snippet")) {
  process.stdout.write(SNIPPET);
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// XORV_TEST_WALLET_KEY_FILE: a second identity, e.g. an empty wallet for the "can't afford it" path.
const keyFile = resolve(root, process.env.XORV_TEST_WALLET_KEY_FILE ?? "data/test-wallet.key");
if (!existsSync(keyFile)) {
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, generatePrivateKey(), { mode: 0o600 });
}
const account = privateKeyToAccount(readFileSync(keyFile, "utf8").trim());
const chain = defineChain({
  id: CHAIN_ID,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const actualChain = Number(
  (await (await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  })).json()).result,
);
if (actualChain !== CHAIN_ID) {
  console.error(`refusing: ${RPC} is chain ${actualChain}, not the local dev node (${CHAIN_ID})`);
  process.exit(1);
}

const hex = (n) => (n === undefined || n === null ? undefined : BigInt(n));

// The network the wallet is on, and the ones it knows — as in a real wallet.
let current = Number(process.env.XORV_TEST_WALLET_START_CHAIN ?? CHAIN_ID);
const known = new Set([current, 1, 10143]);
if (process.env.XORV_TEST_WALLET_KNOWS_DEV !== "0") known.add(CHAIN_ID);
let rejectNext = false;
const userRejects = () => {
  if (!rejectNext) return;
  rejectNext = false;
  throw Object.assign(new Error("MetaMask Tx Signature: User denied transaction signature."), { code: 4001 });
};
const onDevChain = () => {
  if (current !== CHAIN_ID) {
    throw Object.assign(new Error(`the wallet is on chain ${current}, not ${CHAIN_ID}`), { code: 4901 });
  }
};

async function handle(method, params) {
  switch (method) {
    case "eth_requestAccounts":
    case "eth_accounts":
      return [account.address];
    case "eth_chainId":
      return `0x${current.toString(16)}`;
    case "wallet_switchEthereumChain": {
      const wanted = Number(params?.[0]?.chainId);
      if (!known.has(wanted)) {
        throw Object.assign(new Error(`Unrecognized chain ID ${params?.[0]?.chainId}`), { code: 4902 });
      }
      current = wanted;
      return null;
    }
    case "wallet_addEthereumChain": {
      const wanted = Number(params?.[0]?.chainId);
      if (wanted !== CHAIN_ID) throw Object.assign(new Error(`only chain ${CHAIN_ID} can be added`), { code: 4902 });
      // MetaMask adds the network and switches to it in one approval.
      known.add(wanted);
      current = wanted;
      return null;
    }
    case "xorv_testRejectNext":
      rejectNext = true;
      return null;
    case "xorv_testUserSwitch": {
      current = Number(params?.[0]);
      known.add(current);
      return null;
    }
    case "eth_signTypedData_v4": {
      const [from, raw] = params;
      if (from.toLowerCase() !== account.address.toLowerCase()) throw new Error("unknown account");
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      userRejects();
      // MetaMask refuses typed data whose domain names another chain.
      if (data.domain?.chainId !== undefined && Number(data.domain.chainId) !== current) {
        throw Object.assign(
          new Error(`Provided chainId "${Number(data.domain.chainId)}" must match the active chainId "${current}"`),
          { code: -32602 },
        );
      }
      const { EIP712Domain: _domain, ...types } = data.types;
      return account.signTypedData({ domain: data.domain, types, primaryType: data.primaryType, message: data.message });
    }
    case "eth_sendTransaction": {
      const [tx] = params;
      if (tx.from && tx.from.toLowerCase() !== account.address.toLowerCase()) throw new Error("unknown account");
      userRejects();
      onDevChain();
      return wallet.sendTransaction({ to: tx.to, data: tx.data, value: hex(tx.value), gas: hex(tx.gas) });
    }
    default: {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
      });
      const body = await res.json();
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
      return body.result;
    }
  }
}

createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", ORIGIN);
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-private-network", "true");
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  // The page-side provider, so a test can inject it with one fetch.
  if (req.method === "GET" && req.url === "/snippet.js") {
    return void res.writeHead(200, { "content-type": "text/javascript" }).end(SNIPPET);
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  let id = null;
  try {
    const msg = JSON.parse(body);
    id = msg.id ?? null;
    const result = await handle(msg.method, msg.params);
    console.log(`[test-wallet] ${msg.method}`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  } catch (err) {
    console.log(`[test-wallet] error: ${err.shortMessage ?? err.message}`);
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: err.code ?? -32000, message: err.shortMessage ?? err.message } }));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[test-wallet] ${account.address} on http://127.0.0.1:${PORT} (on chain ${current}, transacts on ${CHAIN_ID}, origin ${ORIGIN})`);
});
