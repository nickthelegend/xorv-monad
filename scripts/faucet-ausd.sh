#!/usr/bin/env bash
# Give an address 10,000 test AUSD from Agora's Monad testnet faucet.
#
#   scripts/faucet-ausd.sh                 # the demo buyer (XORV_DEMO_PAYER_ADDRESS in .env)
#   scripts/faucet-ausd.sh 0xabc…          # any address
#
# The faucet is a contract with no web page: requestFunds(address) sends 10,000
# AUSD, at most 100,000 per address, with a 60-second cooldown shared by
# everyone. The operator pays the (tiny) MON gas; the recipient needs none.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ROOT/.env" ] && { set -a; . "$ROOT/.env"; set +a; }
RPC=${XORV_RPC_URL:-https://testnet-rpc.monad.xyz}
AUSD=0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC
FAUCET=0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C
TO=${1:-${XORV_DEMO_PAYER_ADDRESS:?pass an address or set XORV_DEMO_PAYER_ADDRESS}}
: "${XORV_OPERATOR_KEY:?set XORV_OPERATOR_KEY: it pays the faucet call's gas}"

before=$(cast call "$AUSD" 'balanceOf(address)(uint256)' "$TO" --rpc-url "$RPC" | awk '{print $1}')
for attempt in 1 2 3 4; do
  if cast send -q --rpc-url "$RPC" --private-key "$XORV_OPERATOR_KEY" "$FAUCET" "requestFunds(address)" "$TO" 2>/tmp/faucet-ausd.err; then
    break
  fi
  # Another team used the shared cooldown in the last minute: wait it out.
  echo "   faucet busy (attempt $attempt): $(head -c 160 /tmp/faucet-ausd.err)"; sleep 65
done
after=$(cast call "$AUSD" 'balanceOf(address)(uint256)' "$TO" --rpc-url "$RPC" | awk '{print $1}')
echo "$TO: $((before / 1000000)) → $((after / 1000000)) AUSD"
