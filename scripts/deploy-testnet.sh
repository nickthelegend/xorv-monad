#!/usr/bin/env bash
# Deploy XorvRegistry, XorvEscrow, XorvLog and XorvRefundKeeper, wire them
# together, and verify them on Sourcify. XORV_CLEANVERSE=1 also deploys the
# CleanverseGate and sets it on the escrow (see docs/DEPLOY-LATER.md first).
#
#   scripts/deploy-testnet.sh monad-testnet   # chain 10143, verified on Sourcify
#   scripts/deploy-testnet.sh anvil           # local rehearsal (no verification)
#
# Needs XORV_OPERATOR_KEY (in .env). The operator becomes owner, attester and
# registry operator, and it pays all the gas: about 0.7 MON on Monad testnet at
# ~100 gwei. Monad charges for the gas *limit*, not the gas used, so estimates
# are padded by 10% rather than forge's default 30%.
#
# Writes deployments/<target>.json and, for the network in .env, the contract
# addresses back into .env.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET=${1:?usage: deploy-testnet.sh monad-testnet|anvil}
# XORV_DEPLOY_ENV=/dev/null keeps a caller's own keys (the local stack's) from being replaced.
ENV_FILE=${XORV_DEPLOY_ENV:-$ROOT/.env}
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }
: "${XORV_OPERATOR_KEY:?set XORV_OPERATOR_KEY (scripts generate one into .env)}"

case "$TARGET" in
  monad-testnet)
    NETWORK=eip155:10143
    RPC=${RPC:-https://testnet-rpc.monad.xyz}
    VERIFY=(--verify --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org)
    ;;
  anvil)
    NETWORK=eip155:31337
    RPC=${RPC:-http://127.0.0.1:8648}
    VERIFY=()
    ;;
  *) echo "unknown target $TARGET" >&2; exit 1 ;;
esac

OP=$(cast wallet address "$XORV_OPERATOR_KEY")
CHAIN=$(cast chain-id --rpc-url "$RPC")
BAL=$(cast balance "$OP" --rpc-url "$RPC")
echo "── $TARGET (chain $CHAIN) via $RPC"
echo "   operator $OP holds $(cast from-wei "$BAL") MON"
[ "$BAL" != 0 ] || { echo "   the operator needs MON for gas: https://faucet.monad.xyz" >&2; exit 1; }

FROM_BLOCK=$(cast block-number --rpc-url "$RPC")

echo; echo "── XorvRegistry + XorvEscrow + XorvLog + XorvRefundKeeper"
cd "$ROOT/contracts"
OUT=$(forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow \
  --gas-estimate-multiplier 110 ${VERIFY[@]+"${VERIFY[@]}"} 2>&1) || true
REGISTRY=$(echo "$OUT" | grep -E '^\s*XorvRegistry ' | awk '{print $2}') || true
ESCROW=$(echo "$OUT" | grep -E '^\s*XorvEscrow ' | awk '{print $2}') || true
LOG=$(echo "$OUT" | grep -E '^\s*XorvLog ' | awk '{print $2}') || true
KEEPER=$(echo "$OUT" | grep -E '^\s*XorvRefundKeeper ' | awk '{print $2}') || true
[ -n "$ESCROW" ] && [ -n "$REGISTRY" ] && [ -n "$LOG" ] || { echo "$OUT" >&2; exit 1; }
echo "   registry $REGISTRY"
echo "   escrow   $ESCROW"
echo "   log      $LOG"
echo "   keeper   $KEEPER (Chainlink CRE refund keeper)"
echo "$OUT" | grep -iE "verif|success|fail" | sed 's/^/   /' | head -12 || true

echo; echo "── wiring, as read back from the chain"
echo "   registry.escrow   = $(cast call "$REGISTRY" 'escrow()(address)' --rpc-url "$RPC")"
echo "   registry.operator = $(cast call "$REGISTRY" 'operator()(address)' --rpc-url "$RPC")"
echo "   escrow.registry   = $(cast call "$ESCROW" 'registry()(address)' --rpc-url "$RPC")"
echo "   escrow.attester   = $(cast call "$ESCROW" 'attester()(address)' --rpc-url "$RPC")"
[ "$(cast call "$REGISTRY" 'escrow()(address)' --rpc-url "$RPC")" = "$ESCROW" ] \
  || { echo "   registry is not wired to the escrow" >&2; exit 1; }

mkdir -p "$ROOT/deployments"
cat >"$ROOT/deployments/$TARGET.json" <<JSON
{
  "network": "$NETWORK",
  "escrow": "$ESCROW",
  "registry": "$REGISTRY",
  "log": "$LOG",
  "refundKeeper": "$KEEPER",
  "fromBlock": $FROM_BLOCK,
  "operator": "$OP",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
echo; echo "wrote deployments/$TARGET.json"

if [ "${XORV_NETWORK:-eip155:10143}" = "$NETWORK" ] && [ -f "$ROOT/.env" ] && [ "$TARGET" != anvil ]; then
  # Replace any previous values rather than appending duplicates.
  sed -i.bak -E '/^XORV_(ESCROW|REGISTRY|LOG)_ADDRESS=|^XORV_LOG_FROM_BLOCK=/d' "$ROOT/.env" && rm -f "$ROOT/.env.bak"
  printf 'XORV_ESCROW_ADDRESS=%s\nXORV_REGISTRY_ADDRESS=%s\nXORV_LOG_ADDRESS=%s\nXORV_LOG_FROM_BLOCK=%s\n' \
    "$ESCROW" "$REGISTRY" "$LOG" "$FROM_BLOCK" >>"$ROOT/.env"
  echo "updated .env"
fi
