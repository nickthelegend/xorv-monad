#!/usr/bin/env bash
# The whole product, end to end, on a local chain — real processes, real
# contracts, real signatures. Nothing is stubbed.
#
#   buyer (`xorv run`)  →  broker (x402 + escrow facilitator)  →  provider node (`xorv start`)
#        │                         │
#        └── signs ReceiveWithAuthorization     └── fund / release on XorvEscrow → recordOutcome on XorvRegistry
#
# Two modes, because no single local chain has both halves:
#
#   MODE=nitro  A Nitro dev node (real Arbitrum node software). Deploys the
#               Stylus registry, a test EIP-3009 token, XorvEscrow and XorvLog,
#               and proves Solidity → Stylus reputation updates through the
#               real broker. Needs a node at NITRO_RPC (default :8547).
#
#   MODE=fork   anvil forking Arbitrum Sepolia. Settles in the *real* Paxos
#               USDG contract (its EIP-3009 facet, its domain), with balances
#               written into its storage. No registry: anvil can't run Stylus.
#
# Usage: MODE=nitro scripts/e2e-local.sh    |    MODE=fork scripts/e2e-local.sh
set -euo pipefail

# Start from nothing: an XORV_* variable inherited from the caller — say a
# shell that sourced .env.local-stack — would point the buyer at another
# chain's token (found when this ran after local-stack testing: every check
# failed reading a balance from the wrong contract). This script sets every
# one it needs itself.
for v in $(env | sed -n 's/^\(XORV_[A-Z0-9_]*\)=.*/\1/p'); do unset "$v"; done

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODE=${MODE:-nitro}
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
if [ "$MODE" = nitro ]; then
  RPC=${NITRO_RPC:-http://127.0.0.1:8547}
  NETWORK=eip155:412346
  DEV_KEY=${NITRO_DEV_KEY:-0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659}
  cast chain-id --rpc-url "$RPC" >/dev/null || { echo "no Nitro dev node at $RPC" >&2; exit 1; }
  cast send -q --rpc-url "$RPC" --private-key "$DEV_KEY" "$OP" --value 1ether

  say "deploying XorvRegistry (Rust / Stylus)"
  REGISTRY=$(cd "$ROOT/contracts/stylus/registry" && cargo stylus deploy --no-verify \
    --endpoint "$RPC" --private-key "$OP_KEY" --constructor-args "$OP" 2>&1 | strip \
    | grep -oE 'deployed code at address: 0x[0-9a-fA-F]{40}' | tail -n1 | awk '{print $NF}')
  [ -n "$REGISTRY" ] || { echo "registry deploy failed" >&2; exit 1; }
  echo "   $REGISTRY"

  cd "$ROOT/contracts"; forge build -q
  TOKEN=$(forge create --rpc-url "$RPC" --private-key "$OP_KEY" --broadcast \
    test/mocks/MockERC3009.sol:MockERC3009 --constructor-args "Global Dollar" "1" 2>&1 \
    | grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' | awk '{print $NF}')
  export XORV_STABLECOIN=$TOKEN XORV_STABLECOIN_NAME="Global Dollar" XORV_STABLECOIN_VERSION=1 XORV_STABLECOIN_SYMBOL=USDG
  cast send -q --rpc-url "$RPC" --private-key "$OP_KEY" "$TOKEN" "mint(address,uint256)" "$PAYER" 10000000
else
  FORK_PORT=${FORK_PORT:-8612}
  RPC="http://127.0.0.1:$FORK_PORT"
  NETWORK=eip155:421614
  TOKEN=0xFFC95faa3d63Cde504a05B567C600B78C0b41892   # the real Paxos USDG
  REGISTRY=""
  anvil --fork-url "${FORK_URL:-https://sepolia-rollup.arbitrum.io/rpc}" --port "$FORK_PORT" --silent &
  PIDS+=($!)
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
  cast rpc --rpc-url "$RPC" anvil_setBalance "$OP" 0xde0b6b3a7640000 >/dev/null
  # USDG keeps balances in a mapping at storage slot 1 (found by probing).
  cast rpc --rpc-url "$RPC" anvil_setStorageAt "$TOKEN" "$(cast index address "$PAYER" 1)" \
    "$(cast to-uint256 10000000)" >/dev/null
  echo "   payer holds $(cast call "$TOKEN" 'balanceOf(address)(uint256)' "$PAYER" --rpc-url "$RPC") USDG units (real contract)"
  cd "$ROOT/contracts"; forge build -q
fi

say "deploying XorvEscrow + XorvLog (Solidity)"
OUT=$(XORV_OPERATOR_KEY=$OP_KEY XORV_REGISTRY_ADDRESS=${REGISTRY:-0x0000000000000000000000000000000000000000} \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast 2>&1)
ESCROW=$(echo "$OUT" | grep -E '^\s*XorvEscrow ' | awk '{print $2}')
LOG=$(echo "$OUT" | grep -E '^\s*XorvLog ' | awk '{print $2}')
[ -n "$ESCROW" ] || { echo "$OUT" >&2; exit 1; }
echo "   escrow $ESCROW   log $LOG"
if [ -n "$REGISTRY" ]; then
  cast send -q --rpc-url "$RPC" --private-key "$OP_KEY" "$REGISTRY" "setEscrow(address)" "$ESCROW"
  cast send -q --rpc-url "$RPC" --private-key "$OP_KEY" "$REGISTRY" "setOperator(address)" "$OP"
fi
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
say "xorv run — paying from an address with no ETH"
echo "   payer ETH before: $(cast balance "$PAYER" --rpc-url "$RPC")"
RESULT=$(XORV_HOME="$WORK/buyer" XORV_PAYER_KEY=$PAYER_KEY XORV_RPC_URL=$RPC \
  node packages/cli/dist/index.js run "Say hello to Arbitrum" --broker "$BROKER" --adapter echo --max 0.01 --yes --json 2>"$WORK/run.err" || true)
echo "$RESULT" > "$WORK/run.json"
[ -s "$WORK/run.json" ] || { echo "xorv run printed nothing:"; cat "$WORK/run.err"; tail -30 "$WORK/broker.log"; exit 1; }

# Give a registry refresh a beat to land before reading it back.
sleep 3

# ---------------------------------------------------------------------------
# verify on chain
# ---------------------------------------------------------------------------
say "verifying on chain"
RPC=$RPC TOKEN=$TOKEN ESCROW=$ESCROW REGISTRY=$REGISTRY PAYER=$PAYER PROV=$PROV BROKER=$BROKER MODE=$MODE \
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
check("buyer paid exactly the price", (await bal(process.env.PAYER)) === 10_000_000n - price);
check("escrow holds nothing afterwards", (await bal(process.env.ESCROW)) === 0n);
check("buyer spent no gas", BigInt(await rpc("eth_getBalance", [process.env.PAYER, "latest"])) === 0n);
const job = (await (await fetch(`${process.env.BROKER}/api/jobs/${run.jobId}`)).json()).job;
check("release attests to the result hash", job.payment?.escrow?.resultHash === job.resultHash);
if (process.env.REGISTRY) {
  // getProvider(address) → (nodeId, registeredAt, lastSeen, completed, failed, earned, active)
  const raw = await call(process.env.REGISTRY, "0x55f21eb7" + pad(process.env.PROV));
  const words = raw.slice(2).match(/.{64}/g).map((w) => BigInt("0x" + w));
  check("Stylus registry: provider registered (sponsored)", words[0] !== 0n);
  check("Stylus registry: completed = 1", words[3] === 1n);
  check("Stylus registry: earned = price", words[5] === price);
  const providers = (await (await fetch(`${process.env.BROKER}/api/providers`)).json()).providers;
  check("broker sees the on-chain record", providers[0]?.onchain?.completed === 1, JSON.stringify(providers[0]?.onchain ?? null));
}
console.log(`\nmode=${process.env.MODE}  job=${run.jobId}  fund=${run.settlementTransaction}  release=${run.escrow?.releaseTx}`);
process.exit(fails ? 1 : 0);
' "$WORK/run.json" || { echo; echo "--- broker log ---"; tail -40 "$WORK/broker.log"; echo "--- node log ---"; tail -20 "$WORK/node.log"; exit 1; }
