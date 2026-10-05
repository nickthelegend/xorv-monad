#!/usr/bin/env bash
# The whole product, end to end, on a local chain — real processes, real
# contracts, real signatures. Nothing is stubbed.
#
#   buyer (`xorv run`)  →  broker (x402 + escrow facilitator)  →  provider node (`xorv start`)
#        │                         │
#        └── signs ReceiveWithAuthorization     └── fund / release on XorvEscrow → recordOutcome on XorvRegistry
#
# Two modes, both with every contract deployed:
#
#   MODE=anvil  A fresh Anvil node (default). Deploys a test EIP-3009 token,
#               XorvRegistry, XorvEscrow and XorvLog, and proves escrow →
#               registry reputation updates through the real broker.
#
#   MODE=fork   Anvil forking Monad testnet. Settles in the *real* Agora AUSD
#               contract (its EIP-3009, its "Agora Dollar" domain), funded
#               from Agora's own testnet faucet.
#
# Usage: scripts/e2e-local.sh    |    MODE=fork scripts/e2e-local.sh
set -euo pipefail

# Start from nothing: an XORV_* variable inherited from the caller — say a
# shell that sourced .env.local-stack — would point the buyer at another
# chain's token (found when this ran after local-stack testing: every check
# failed reading a balance from the wrong contract). This script sets every
# one it needs itself.
for v in $(env | sed -n 's/^\(XORV_[A-Z0-9_]*\)=.*/\1/p'); do unset "$v"; done

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODE=${MODE:-anvil}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/xorv-e2e.XXXXXX")
BROKER_PORT=${BROKER_PORT:-8499}
BROKER="http://127.0.0.1:$BROKER_PORT"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  [ "${KEEP:-0}" = 1 ] || rm -rf "$WORK"
}
trap cleanup EXIT

say() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
newkey() { cast wallet new --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].private_key))'; }
strip() { sed 's/\x1b\[[0-9;]*m//g'; }

OP_KEY=$(newkey);    OP=$(cast wallet address "$OP_KEY")
PAYER_KEY=$(newkey); PAYER=$(cast wallet address "$PAYER_KEY")
PROV_KEY=$(newkey);  PROV=$(cast wallet address "$PROV_KEY")

# ---------------------------------------------------------------------------
# chain + contracts
# ---------------------------------------------------------------------------
if [ "$MODE" = anvil ]; then
  ANVIL_PORT=${ANVIL_PORT:-8650}
  RPC="http://127.0.0.1:$ANVIL_PORT"
  NETWORK=eip155:31337
  anvil --port "$ANVIL_PORT" --chain-id 31337 --prune-history 300 --silent &
  PIDS+=($!)
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
  cast rpc --rpc-url "$RPC" anvil_setBalance "$OP" 0xde0b6b3a7640000 >/dev/null

  cd "$ROOT/contracts"; forge build -q
  TOKEN=$(forge create --rpc-url "$RPC" --private-key "$OP_KEY" --broadcast \
    test/mocks/MockERC3009.sol:MockERC3009 --constructor-args "Agora Dollar" "1" 2>&1 \
    | grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' | awk '{print $NF}')
  export XORV_STABLECOIN=$TOKEN XORV_STABLECOIN_NAME="Agora Dollar" XORV_STABLECOIN_VERSION=1 XORV_STABLECOIN_SYMBOL=AUSD
  cast send -q --rpc-url "$RPC" --private-key "$OP_KEY" "$TOKEN" "mint(address,uint256)" "$PAYER" 10000000
else
  FORK_PORT=${FORK_PORT:-8651}
  RPC="http://127.0.0.1:$FORK_PORT"
  NETWORK=eip155:10143
  TOKEN=0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC   # the real Agora AUSD on Monad testnet
  FAUCET=0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C  # Agora's testnet faucet: 10,000 AUSD per call
  anvil --fork-url "${FORK_URL:-https://testnet-rpc.monad.xyz}" --port "$FORK_PORT" --prune-history 300 --silent &
  PIDS+=($!)
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
  cast rpc --rpc-url "$RPC" anvil_setBalance "$OP" 0xde0b6b3a7640000 >/dev/null
  # The faucet has a 60s global cooldown: step past it, then take AUSD from it as anyone would.
  cast rpc --rpc-url "$RPC" evm_increaseTime 61 >/dev/null
  cast send -q --rpc-url "$RPC" --private-key "$OP_KEY" "$FAUCET" "requestFunds(address)" "$PAYER"
  echo "   payer holds $(cast call "$TOKEN" 'balanceOf(address)(uint256)' "$PAYER" --rpc-url "$RPC") AUSD units (real contract, from Agora's faucet)"
  cd "$ROOT/contracts"; forge build -q
fi
PAYER_START=$(cast call "$TOKEN" 'balanceOf(address)(uint256)' "$PAYER" --rpc-url "$RPC" | awk '{print $1}')

say "deploying XorvRegistry + XorvEscrow + XorvLog"
OUT=$(XORV_OPERATOR_KEY=$OP_KEY forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast 2>&1)
REGISTRY=$(echo "$OUT" | grep -E '^\s*XorvRegistry ' | awk '{print $2}')
ESCROW=$(echo "$OUT" | grep -E '^\s*XorvEscrow ' | awk '{print $2}')
LOG=$(echo "$OUT" | grep -E '^\s*XorvLog ' | awk '{print $2}')
[ -n "$ESCROW" ] || { echo "$OUT" >&2; exit 1; }
echo "   registry $REGISTRY   escrow $ESCROW   log $LOG"
FROM_BLOCK=$(cast block-number --rpc-url "$RPC")

# ---------------------------------------------------------------------------
# broker + provider node
# ---------------------------------------------------------------------------
say "starting the broker"
cd "$ROOT"
env XORV_NETWORK=$NETWORK XORV_RPC_URL=$RPC XORV_OPERATOR_KEY=$OP_KEY XORV_OPERATOR_ADDRESS= \
  XORV_ESCROW_ADDRESS=$ESCROW XORV_REGISTRY_ADDRESS=$REGISTRY XORV_LOG_ADDRESS=$LOG \
  XORV_LOG_FROM_BLOCK=$FROM_BLOCK XORV_BROKER_PORT=$BROKER_PORT XORV_BROKER_URL=$BROKER \
  XORV_DB="$WORK/broker.db" XORV_MONGO_URI= XORV_DEMO_PAYER_KEY= XORV_CORS_ORIGINS= \
  node services/broker/dist/index.js >"$WORK/broker.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do curl -sf "$BROKER/health" >/dev/null && break; sleep 0.5; done
curl -sf "$BROKER/health" >/dev/null || { cat "$WORK/broker.log"; exit 1; }
grep -E "escrow|reputation|wiring|⚠" "$WORK/broker.log" | sed 's/^/   /'

say "starting a provider node (echo adapter)"
mkdir -p "$WORK/node"
cat >"$WORK/node/config.json" <<JSON
{
  "nodeId": "e2e-node-$RANDOM",
  "label": "e2e-node",
  "network": "$NETWORK",
  "brokerUrl": "$BROKER",
  "address": "$PROV",
  "privateKey": "$PROV_KEY",
  "capabilities": [
    { "id": "echo", "adapter": "echo", "displayName": "Echo", "model": null, "priceUsdMicros": 1000, "maxConcurrency": 2 }
  ],
  "tunnel": { "enabled": false, "hostname": null },
  "sandboxDir": "$WORK/node/jobs"
}
JSON
XORV_HOME="$WORK/node" XORV_RPC_URL=$RPC node packages/cli/dist/index.js start >"$WORK/node.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do
  [ "$(curl -sf "$BROKER/api/providers" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).providers.filter(p=>p.connected).length)}catch{console.log(0)}})')" -ge 1 ] && break
  sleep 0.5
done

# ---------------------------------------------------------------------------
# the buyer
# ---------------------------------------------------------------------------
say "xorv run — paying from an address with no MON"
echo "   payer MON before: $(cast balance "$PAYER" --rpc-url "$RPC")"
RESULT=$(XORV_HOME="$WORK/buyer" XORV_PAYER_KEY=$PAYER_KEY XORV_RPC_URL=$RPC \
  node packages/cli/dist/index.js run "Say hello to Monad" --broker "$BROKER" --adapter echo --max 0.01 --yes --json 2>"$WORK/run.err" || true)
echo "$RESULT" > "$WORK/run.json"
[ -s "$WORK/run.json" ] || { echo "xorv run printed nothing:"; cat "$WORK/run.err"; tail -30 "$WORK/broker.log"; exit 1; }

# Give a registry refresh a beat to land before reading it back.
sleep 3

# ---------------------------------------------------------------------------
# verify on chain
# ---------------------------------------------------------------------------
say "verifying on chain"
PAYER_START=$PAYER_START RPC=$RPC TOKEN=$TOKEN ESCROW=$ESCROW REGISTRY=$REGISTRY PAYER=$PAYER PROV=$PROV BROKER=$BROKER MODE=$MODE \
  node --input-type=module -e '
import { readFileSync } from "node:fs";
const run = JSON.parse(readFileSync(process.argv[1], "utf8"));
const rpc = async (method, params) => (await (await fetch(process.env.RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
const call = async (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const pad = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
const bal = async (who) => BigInt(await call(process.env.TOKEN, "0x70a08231" + pad(who)));
let fails = 0;
const check = (label, ok, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`); if (!ok) fails++; };

check("job completed", run.status === "completed", run.status);
check("result came back", typeof run.result === "string" && run.result.length > 0);
check("paid through escrow", run.escrow?.address?.toLowerCase() === process.env.ESCROW.toLowerCase());
check("escrow released", run.escrow?.state === "released", run.escrow?.releaseTx ?? run.escrow?.lastError ?? "");
const price = BigInt(run.quote.accepts[0].amount);
check("provider received exactly the price", (await bal(process.env.PROV)) === price, `${price} units`);
check("buyer paid exactly the price", (await bal(process.env.PAYER)) === BigInt(process.env.PAYER_START) - price);
check("escrow holds nothing afterwards", (await bal(process.env.ESCROW)) === 0n);
check("buyer spent no gas", BigInt(await rpc("eth_getBalance", [process.env.PAYER, "latest"])) === 0n);
const job = (await (await fetch(`${process.env.BROKER}/api/jobs/${run.jobId}`)).json()).job;
check("release attests to the result hash", job.payment?.escrow?.resultHash === job.resultHash);
if (process.env.REGISTRY) {
  // getProvider(address) → (nodeId, registeredAt, lastSeen, completed, failed, earned, active)
  const raw = await call(process.env.REGISTRY, "0x55f21eb7" + pad(process.env.PROV));
  const words = raw.slice(2).match(/.{64}/g).map((w) => BigInt("0x" + w));
  check("registry: provider registered (sponsored)", words[0] !== 0n);
  check("registry: completed = 1", words[3] === 1n);
  check("registry: earned = price", words[5] === price);
  const providers = (await (await fetch(`${process.env.BROKER}/api/providers`)).json()).providers;
  check("broker sees the on-chain record", providers[0]?.onchain?.completed === 1, JSON.stringify(providers[0]?.onchain ?? null));
}
console.log(`\nmode=${process.env.MODE}  job=${run.jobId}  fund=${run.settlementTransaction}  release=${run.escrow?.releaseTx}`);
process.exit(fails ? 1 : 0);
' "$WORK/run.json" || { echo; echo "--- broker log ---"; tail -40 "$WORK/broker.log"; echo "--- node log ---"; tail -20 "$WORK/node.log"; exit 1; }

# ---------------------------------------------------------------------------
# the agent (AGENT=1): xorv-agent hires the network through the real MCP server
# ---------------------------------------------------------------------------
# Its brain is Kimi or Qwen. With no API key here it runs in FIXTURE MODE: the
# model's responses are replayed from packages/agent/fixtures (documented API
# format, labelled "authored" until re-recorded). Everything after the brain is
# real: the agent binary, the MCP server it spawns, the x402 payment into
# XorvEscrow, the provider run and the release.
if [ "${AGENT:-0}" = 1 ]; then
  for BRAIN in kimi qwen; do
    say "xorv-agent ($BRAIN, FIXTURE MODE) — real MCP + broker + escrow"
    AGENT_OUT=$(XORV_AGENT_FIXTURE=packages/agent/fixtures/$BRAIN-e2e.json XORV_BROKER_URL=$BROKER \
      XORV_PAYER_KEY=$PAYER_KEY XORV_RPC_URL=$RPC XORV_NETWORK=$NETWORK \
      node packages/agent/dist/index.js "Greet Monad, and have the greeting checked" --brain $BRAIN --budget 0.01 --json \
      2>"$WORK/agent-$BRAIN.err" || true)
    echo "$AGENT_OUT" >"$WORK/agent-$BRAIN.json"
    node --input-type=module -e '
import { readFileSync } from "node:fs";
const run = JSON.parse(readFileSync(process.argv[1], "utf8"));
let fails = 0;
const check = (label, ok, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`); if (!ok) fails++; };
check(`${run.brain} brain in fixture mode`, run.brainMode === "fixture", run.model);
check("agent answered", run.stoppedBecause === "answered");
check("agent bought two jobs, both delivered", run.purchases.length === 2 && run.purchases.every((p) => p.ok));
check("agent spent exactly the prices", run.spentUsdMicros === 2000, `${run.spentUsdMicros} micro-USD`);
check("agent kept within budget", run.spentUsdMicros <= run.budgetUsdMicros);
check("every purchase carries on-chain proof", run.purchases.every((p) => p.proof.length >= 1));
process.exit(fails ? 1 : 0);
' "$WORK/agent-$BRAIN.json" || { echo "--- agent stderr ---"; cat "$WORK/agent-$BRAIN.err"; echo "$AGENT_OUT" | head -40; exit 1; }
  done
fi
