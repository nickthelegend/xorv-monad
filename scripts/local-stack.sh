#!/usr/bin/env bash
# Stand up the whole of Xorv on a local Anvil node — nothing mocked.
#
#   - Anvil (chain 31337) on :8648, pruning old state so it never fills the disk
#   - Circle's production stablecoin code (FiatTokenV2_2 behind FiatTokenProxy,
#     initialized exactly as Circle deploys it), as the payment token
#   - XorvRegistry, XorvEscrow and XorvLog, wired together
#   - funded operator, demo buyer and provider accounts
#
# Writes .env.local-stack, which the broker, provider node and apps read when
# started with scripts/local-stack-run.sh. Use this to work offline; everything
# it does is the same code path as Monad testnet.
#
#   scripts/local-stack.sh            # (re)deploy on the running node, or start one
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${ANVIL_PORT:-8648}
RPC="http://127.0.0.1:$PORT"
DEV_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # Anvil's first funded account
CIRCLE_DIR=${CIRCLE_DIR:-$HOME/.cache/xorv/stablecoin-evm}
OUT="$ROOT/.env.local-stack"

say() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
strip() { sed 's/\x1b\[[0-9;]*m//g'; }
newkey() { cast wallet new --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].private_key))'; }
send() { cast send -q --rpc-url "$RPC" --private-key "$1" "${@:2}"; }
create() { # key, artifact path:name, constructor args...
  forge create --rpc-url "$RPC" --private-key "$1" --broadcast "$2" ${3:+--constructor-args} "${@:3}" 2>&1 \
    | grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' | awk '{print $NF}'
}

# -- the node -----------------------------------------------------------------
if ! cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  say "starting Anvil on :$PORT"
  nohup anvil --port "$PORT" --chain-id 31337 --prune-history 300 --silent >/dev/null 2>&1 &
  for _ in $(seq 1 30); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
fi
echo "   chain $(cast chain-id --rpc-url "$RPC") at $RPC"

# -- accounts -----------------------------------------------------------------
OP_KEY=$(newkey);       OP=$(cast wallet address "$OP_KEY")
PAYER_KEY=$(newkey);    PAYER=$(cast wallet address "$PAYER_KEY")
PROV_KEY=$(newkey);     PROV=$(cast wallet address "$PROV_KEY")
TOKEN_ADMIN_KEY=$(newkey); TOKEN_ADMIN=$(cast wallet address "$TOKEN_ADMIN_KEY")
TOKEN_OWNER_KEY=$(newkey); TOKEN_OWNER=$(cast wallet address "$TOKEN_OWNER_KEY")
for a in "$OP" "$TOKEN_ADMIN" "$TOKEN_OWNER"; do send "$DEV_KEY" "$a" --value 3ether; done

# -- Circle's stablecoin --------------------------------------------------------
say "deploying Circle FiatTokenV2_2 (production code) behind FiatTokenProxy"
if [ ! -f "$CIRCLE_DIR/artifacts/foundry/FiatTokenV2_2.sol/FiatTokenV2_2.json" ]; then
  rm -rf "$CIRCLE_DIR"; mkdir -p "$(dirname "$CIRCLE_DIR")"
  git clone -q --depth 1 https://github.com/circlefin/stablecoin-evm "$CIRCLE_DIR"
  (cd "$CIRCLE_DIR" && git submodule update --init --depth 1 lib/forge-std >/dev/null 2>&1 \
    && mkdir -p node_modules/@openzeppelin/contracts \
    && curl -sL https://registry.npmjs.org/@openzeppelin/contracts/-/contracts-3.4.2.tgz \
       | tar -xz -C node_modules/@openzeppelin/contracts --strip-components=1 \
    && forge build contracts/v2/FiatTokenV2_2.sol contracts/v1/FiatTokenProxy.sol >/dev/null 2>&1)
fi
cd "$CIRCLE_DIR"
# FiatTokenV2_2 links Circle's SignatureChecker library (its ERC-1271 support): deploy it, then link.
SIGLIB=$(create "$TOKEN_OWNER_KEY" contracts/util/SignatureChecker.sol:SignatureChecker)
IMPL=$(forge create --rpc-url "$RPC" --private-key "$TOKEN_OWNER_KEY" --broadcast \
  --libraries "contracts/util/SignatureChecker.sol:SignatureChecker:$SIGLIB" \
  contracts/v2/FiatTokenV2_2.sol:FiatTokenV2_2 2>&1 | grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' | awk '{print $NF}')
[ -n "$IMPL" ] || { echo "FiatTokenV2_2 deploy failed" >&2; exit 1; }
PROXY=$(create "$TOKEN_ADMIN_KEY" contracts/v1/FiatTokenProxy.sol:FiatTokenProxy "$IMPL")
# The proxy admin may not call the implementation; everything else goes through the proxy as the owner.
send "$TOKEN_OWNER_KEY" "$PROXY" "initialize(string,string,string,uint8,address,address,address,address)" \
  "USD Coin" "USDC" "USD" 6 "$TOKEN_OWNER" "$TOKEN_OWNER" "$TOKEN_OWNER" "$TOKEN_OWNER"
send "$TOKEN_OWNER_KEY" "$PROXY" "initializeV2(string)" "USD Coin"
send "$TOKEN_OWNER_KEY" "$PROXY" "initializeV2_1(address)" "$TOKEN_OWNER"
send "$TOKEN_OWNER_KEY" "$PROXY" "initializeV2_2(address[],string)" "[]" "USDC"
send "$TOKEN_OWNER_KEY" "$PROXY" "configureMinter(address,uint256)" "$TOKEN_OWNER" 1000000000000
send "$TOKEN_OWNER_KEY" "$PROXY" "mint(address,uint256)" "$PAYER" 100000000     # 100 USDC to the demo buyer
echo "   USDC $PROXY  (impl $IMPL)  name=$(cast call "$PROXY" 'name()(string)' --rpc-url "$RPC") version=$(cast call "$PROXY" 'version()(string)' --rpc-url "$RPC")"

# -- Xorv's contracts ---------------------------------------------------------------
say "deploying Xorv's contracts"
XORV_DEPLOY_ENV=/dev/null XORV_OPERATOR_KEY=$OP_KEY XORV_STABLECOIN=$PROXY RPC=$RPC "$ROOT/scripts/deploy-testnet.sh" anvil | strip | sed 's/^/   /'
DEP="$ROOT/deployments/anvil.json"
ESCROW=$(node -e 'console.log(require(process.argv[1]).escrow)' "$DEP")
REGISTRY=$(node -e 'console.log(require(process.argv[1]).registry)' "$DEP")
LOG=$(node -e 'console.log(require(process.argv[1]).log)' "$DEP")
FROM_BLOCK=$(node -e 'console.log(require(process.argv[1]).fromBlock)' "$DEP")

cat >"$OUT" <<ENV
# Written by scripts/local-stack.sh — a local Anvil node with real contracts. Not for any public network.
XORV_NETWORK=eip155:31337
XORV_RPC_URL=$RPC
XORV_STABLECOIN=$PROXY
XORV_STABLECOIN_NAME="USD Coin"
XORV_STABLECOIN_VERSION=2
XORV_STABLECOIN_SYMBOL=USDC
XORV_OPERATOR_KEY=$OP_KEY
XORV_DEMO_PAYER_KEY=$PAYER_KEY
XORV_DEMO_PAYER_ADDRESS=$PAYER
XORV_PROVIDER_KEY=$PROV_KEY
XORV_PROVIDER_ADDRESS=$PROV
XORV_ESCROW_ADDRESS=$ESCROW
XORV_REGISTRY_ADDRESS=$REGISTRY
XORV_LOG_ADDRESS=$LOG
XORV_LOG_FROM_BLOCK=$FROM_BLOCK
NEXT_PUBLIC_XORV_NETWORK=eip155:31337
NEXT_PUBLIC_XORV_RPC_URL=$RPC
NEXT_PUBLIC_XORV_STABLECOIN=$PROXY
NEXT_PUBLIC_XORV_STABLECOIN_NAME="USD Coin"
NEXT_PUBLIC_XORV_STABLECOIN_VERSION=2
NEXT_PUBLIC_XORV_STABLECOIN_SYMBOL=USDC
NEXT_PUBLIC_XORV_ESCROW_ADDRESS=$ESCROW
NEXT_PUBLIC_XORV_REGISTRY_ADDRESS=$REGISTRY
NEXT_PUBLIC_XORV_LOG_ADDRESS=$LOG
# The Envio indexer over this chain (indexer/local.sh), read by the app's network page.
NEXT_PUBLIC_XORV_INDEXER_URL=http://localhost:8082/v1/graphql
ENVIO_ESCROW_ADDRESS=$ESCROW
ENVIO_REGISTRY_ADDRESS=$REGISTRY
ENVIO_LOG_ADDRESS=$LOG
ENVIO_RPC_URL=$RPC
ENV
chmod 600 "$OUT"
say "wrote .env.local-stack"
echo "   operator $OP · buyer $PAYER (100 USDC, 0 MON) · provider $PROV"
