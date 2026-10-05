#!/usr/bin/env bash
# Deploy Xorv's three contracts to one chain, wire them together, verify the
# source, and record the addresses — one command per network.
#
#   scripts/deploy-testnet.sh arbitrum-sepolia
#   scripts/deploy-testnet.sh robinhood-testnet
#   scripts/deploy-testnet.sh nitro-dev          # local rehearsal (no verification)
#
# Reads XORV_OPERATOR_KEY from the environment or the repo's .env. That key
# becomes the owner and attester of the escrow and the owner and operator of
# the registry, and it pays all gas — about 0.0005 ETH on Arbitrum Sepolia
# (the Stylus activation data fee is ~0.0001 of it).
#
# Writes deployments/<network>.json and appends the addresses to .env when the
# network is the one .env points XORV_NETWORK at.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET=${1:?usage: deploy-testnet.sh arbitrum-sepolia|robinhood-testnet|nitro-dev}
# .env fills in only what the environment doesn't already set.
if [ -f "$ROOT/.env" ]; then
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    [ -n "${!k+x}" ] || export "$k=$v"
  done < "$ROOT/.env"
fi
: "${XORV_OPERATOR_KEY:?set XORV_OPERATOR_KEY (the operator / facilitator key)}"

case "$TARGET" in
  # Not sepolia-rollup.arbitrum.io: Arbitrum's own public endpoint refuses
  # Stylus activation ("stylus activations not allowed for this request").
  arbitrum-sepolia)  NETWORK=eip155:421614; RPC=${RPC:-https://arbitrum-sepolia-rpc.publicnode.com}
                     VERIFY=(--verify --verifier sourcify) ;;
  robinhood-testnet) NETWORK=eip155:46630;  RPC=${RPC:-https://rpc.testnet.chain.robinhood.com}
                     VERIFY=(--verify --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/) ;;
  nitro-dev)         NETWORK=eip155:412346; RPC=${RPC:-http://127.0.0.1:8547}; VERIFY=() ;;
  *) echo "unknown network $TARGET" >&2; exit 1 ;;
esac

OP=$(cast wallet address "$XORV_OPERATOR_KEY")
BAL=$(cast balance "$OP" --rpc-url "$RPC")
echo "network   $TARGET ($NETWORK)"
echo "operator  $OP — $(cast from-wei "$BAL") ETH"
if [ "$BAL" = "0" ]; then
  echo "the operator has no ETH on $TARGET — fund it first" >&2
  exit 1
fi

strip() { sed 's/\x1b\[[0-9;]*m//g'; }

echo; echo "── XorvRegistry (Rust / Stylus)"
# Public Arbitrum chains have the StylusDeployer at its canonical address; a
# fresh local node doesn't, and local-stack.sh deploys one and passes it here.
DEPLOYER_ARGS=()
[ -n "${XORV_STYLUS_DEPLOYER:-}" ] && DEPLOYER_ARGS=(--deployer-address "$XORV_STYLUS_DEPLOYER")
REG_OUT=$(cd "$ROOT/contracts/stylus/registry" && cargo stylus deploy --no-verify \
  --endpoint "$RPC" --private-key "$XORV_OPERATOR_KEY" \
  ${DEPLOYER_ARGS[@]+"${DEPLOYER_ARGS[@]}"} --constructor-args "$OP" 2>&1 | strip) || true
# (|| true: under set -e a failed deploy exited here silently; the check below prints why.)
# (--constructor-args is variadic: it must come last or it swallows the flags after it.)
REGISTRY=$(echo "$REG_OUT" | grep -oE 'deployed code at address: 0x[0-9a-fA-F]{40}' | tail -n1 | awk '{print $NF}') || true
REG_TX=$(echo "$REG_OUT" | grep -oE 'deployment tx hash: 0x[0-9a-fA-F]{64}' | tail -n1 | awk '{print $NF}') || true
[ -n "$REGISTRY" ] || { echo "$REG_OUT" >&2; exit 1; }
echo "   $REGISTRY  (tx $REG_TX)"
# Cached programs skip most of Stylus' per-call init cost; a bid of 0 is
# accepted while the cache has room. Best effort.
(cd "$ROOT/contracts/stylus/registry" && cargo stylus cache bid "$REGISTRY" 0 \
  --endpoint "$RPC" --private-key "$XORV_OPERATOR_KEY" >/dev/null 2>&1) && echo "   cached in ArbOS" || true

echo; echo "── XorvEscrow + XorvLog (Solidity)"
cd "$ROOT/contracts"
# --skip-simulation: forge's local EVM prices gas without Arbitrum's L1 data
# component, and the node rejects its estimate as "intrinsic gas too low".
# Letting the node estimate gets it right. --slow sends one at a time.
OUT=$(XORV_REGISTRY_ADDRESS=$REGISTRY forge script script/Deploy.s.sol --rpc-url "$RPC" \
  --broadcast --skip-simulation --slow ${VERIFY[@]+"${VERIFY[@]}"} 2>&1) || true
ESCROW=$(echo "$OUT" | grep -E '^\s*XorvEscrow ' | awk '{print $2}') || true
LOG=$(echo "$OUT" | grep -E '^\s*XorvLog ' | awk '{print $2}') || true
[ -n "$ESCROW" ] || { echo "$OUT" >&2; exit 1; }
echo "   escrow $ESCROW"
echo "   log    $LOG"
echo "$OUT" | grep -iE "verif|success|fail" | sed 's/^/   /' | head -8 || true

echo; echo "── wiring"
cast send -q --rpc-url "$RPC" --private-key "$XORV_OPERATOR_KEY" "$REGISTRY" "setEscrow(address)" "$ESCROW"
cast send -q --rpc-url "$RPC" --private-key "$XORV_OPERATOR_KEY" "$REGISTRY" "setOperator(address)" "$OP"
FROM_BLOCK=$(cast block-number --rpc-url "$RPC")
echo "   registry.escrow   = $(cast call "$REGISTRY" 'escrow()(address)' --rpc-url "$RPC")"
echo "   registry.operator = $(cast call "$REGISTRY" 'operator()(address)' --rpc-url "$RPC")"
echo "   escrow.registry   = $(cast call "$ESCROW" 'registry()(address)' --rpc-url "$RPC")"
echo "   escrow.attester   = $(cast call "$ESCROW" 'attester()(address)' --rpc-url "$RPC")"

mkdir -p "$ROOT/deployments"
cat >"$ROOT/deployments/$TARGET.json" <<JSON
{
  "network": "$NETWORK",
  "escrow": "$ESCROW",
  "registry": "$REGISTRY",
  "log": "$LOG",
  "fromBlock": $FROM_BLOCK,
  "operator": "$OP",
  "registryDeployTx": "$REG_TX",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
echo; echo "wrote deployments/$TARGET.json"

if [ "${XORV_NETWORK:-eip155:421614}" = "$NETWORK" ] && [ -f "$ROOT/.env" ] && [ "$TARGET" != nitro-dev ]; then
  # Replace any previous values rather than appending duplicates.
  sed -i.bak -E '/^XORV_(ESCROW|REGISTRY|LOG)_ADDRESS=|^XORV_LOG_FROM_BLOCK=/d' "$ROOT/.env" && rm -f "$ROOT/.env.bak"
  printf 'XORV_ESCROW_ADDRESS=%s\nXORV_REGISTRY_ADDRESS=%s\nXORV_LOG_ADDRESS=%s\nXORV_LOG_FROM_BLOCK=%s\n' \
    "$ESCROW" "$REGISTRY" "$LOG" "$FROM_BLOCK" >>"$ROOT/.env"
  echo "updated .env"
fi
