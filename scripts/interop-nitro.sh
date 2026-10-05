#!/usr/bin/env bash
# Solidity <-> Stylus interop, proven on a real Arbitrum node.
#
# anvil can't run Stylus (WASM) contracts, so the escrow's calls into the Rust
# registry can only be exercised on Nitro. This script, against a Nitro dev
# node (https://docs.arbitrum.io/run-arbitrum-node/run-nitro-dev-node):
#
#   1. deploys XorvRegistry (Rust/Stylus) with `cargo stylus deploy`
#   2. deploys an EIP-3009 test token and XorvEscrow (Solidity) with forge
#   3. wires them together (registry.setEscrow, escrow already knows the registry)
#   4. runs two paid jobs through the production x402 escrow scheme (TypeScript):
#        one released, one refunded
#   5. asserts the registry now shows provider completed=1, failed=1, earned=price,
#      and a score of (1+1)*10000/(1+1+2) = 5000
#
# Usage: NITRO_RPC=http://127.0.0.1:8547 scripts/interop-nitro.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RPC=${NITRO_RPC:-http://127.0.0.1:8547}
# The Nitro dev node's documented, pre-funded development key.
DEV_KEY=${NITRO_DEV_KEY:-0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659}

cast chain-id --rpc-url "$RPC" >/dev/null || { echo "no node at $RPC" >&2; exit 1; }

# A throwaway operator, so this never contends for the dev account's nonce with
# anything else using the same node.
OP_KEY=$(cast wallet new --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].private_key))')
OP=$(cast wallet address "$OP_KEY")
cast send --rpc-url "$RPC" --private-key "$DEV_KEY" "$OP" --value 1ether >/dev/null
echo "operator $OP funded"

echo "── deploying XorvRegistry (Stylus)"
REGISTRY=$(cd "$ROOT/contracts/stylus/registry" && cargo stylus deploy --no-verify \
  --endpoint "$RPC" --private-key "$OP_KEY" --constructor-args "$OP" 2>&1 \
  | sed 's/\x1b\[[0-9;]*m//g' | grep -oE 'deployed code at address: 0x[0-9a-fA-F]{40}' | tail -n1 | awk '{print $NF}')
[ -n "$REGISTRY" ] || { echo "registry deploy failed" >&2; exit 1; }
echo "   registry $REGISTRY"

cd "$ROOT/contracts"
forge build -q
deploy() { forge create --rpc-url "$RPC" --private-key "$OP_KEY" --broadcast "$@" 2>&1 | grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' | awk '{print $NF}'; }
echo "── deploying token + XorvEscrow (Solidity)"
TOKEN=$(deploy test/mocks/MockERC3009.sol:MockERC3009 --constructor-args "Global Dollar" "1")
ESCROW=$(deploy src/XorvEscrow.sol:XorvEscrow --constructor-args "$OP" "$OP" "$REGISTRY" "[$TOKEN]")
echo "   token $TOKEN  escrow $ESCROW"
cast send --rpc-url "$RPC" --private-key "$OP_KEY" "$REGISTRY" "setEscrow(address)" "$ESCROW" >/dev/null

cd "$ROOT/packages/protocol"
RPC="$RPC" OP_KEY="$OP_KEY" TOKEN="$TOKEN" ESCROW="$ESCROW" REGISTRY="$REGISTRY" \
  npx tsx scripts/interop-nitro.mts
