#!/usr/bin/env bash
# Deploy and initialize the XorvRegistry Stylus contract.
#
#   RPC_URL=https://sepolia-rollup.arbitrum.io/rpc PRIVATE_KEY=0x... ./deploy.sh
#
# Required env:
#   RPC_URL       Arbitrum (or Orbit) RPC endpoint with Stylus enabled.
#   PRIVATE_KEY   Hex private key of a funded deployer.
# Optional env:
#   OWNER         Registry owner. Defaults to the deployer's address.
#   ESCROW        If set (and the deployer is the owner), calls setEscrow(ESCROW).
#   OPERATOR      If set (and the deployer is the owner), calls setOperator(OPERATOR).
#   REPRODUCIBLE  1 = reproducible Docker build (verifiable on Arbiscan); 0 = local build
#                 (--no-verify). Default: 1 if Docker is reachable, else 0.
#   CACHE_BID     If set (wei), places an ArbOS program-cache bid so calls pay the cheaper
#                 cached init cost. `0` is a valid bid while the cache is not full.
#
# Initialization is atomic: the contract has a Stylus constructor, so `cargo stylus deploy`
# routes through the StylusDeployer and deploys + activates + calls constructor(OWNER) in one
# transaction — nobody can front-run `initialize`. If the owner still reads as zero afterwards
# (e.g. the code was deployed some other way), the script falls back to `initialize(OWNER)`.
#
# Prints the deployed address on the last line of stdout.
set -euo pipefail

: "${RPC_URL:?set RPC_URL}"
: "${PRIVATE_KEY:?set PRIVATE_KEY}"

command -v cargo >/dev/null || { echo "cargo not found" >&2; exit 1; }
command -v cast >/dev/null || { echo "cast (Foundry) not found" >&2; exit 1; }
cargo stylus --version >/dev/null 2>&1 || { echo "cargo-stylus not found: cargo install cargo-stylus" >&2; exit 1; }

cd "$(dirname "$0")"

DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
OWNER=${OWNER:-$DEPLOYER}
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
echo "chain $CHAIN_ID | deployer $DEPLOYER | owner $OWNER" >&2

# Docker is only needed for the reproducible build. `docker info` can hang when the daemon is
# wedged, so give it a few seconds in the background.
docker_ok() {
  command -v docker >/dev/null || return 1
  docker info >/dev/null 2>&1 &
  local pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$pid" 2>/dev/null; then wait "$pid"; return $?; fi
    sleep 1
  done
  kill "$pid" 2>/dev/null || true
  return 1
}
if [[ -z "${REPRODUCIBLE:-}" ]]; then
  if docker_ok; then REPRODUCIBLE=1; else REPRODUCIBLE=0; fi
fi
VERIFY_FLAG=()
[[ "$REPRODUCIBLE" == 1 ]] || VERIFY_FLAG=(--no-verify)
echo "reproducible build: $REPRODUCIBLE" >&2

# Keep the key off the command line (and out of `ps`) for cargo-stylus.
KEYFILE=$(mktemp)
chmod 600 "$KEYFILE"
trap 'rm -f "$KEYFILE"' EXIT
printf '%s' "$PRIVATE_KEY" >"$KEYFILE"

echo "checking..." >&2
cargo stylus check --endpoint "$RPC_URL" >&2

echo "deploying..." >&2
LOG=$(cargo stylus deploy ${VERIFY_FLAG[@]+"${VERIFY_FLAG[@]}"} \
  --endpoint "$RPC_URL" \
  --private-key-path "$KEYFILE" \
  --constructor-args "$OWNER" 2>&1 | tee /dev/stderr)

# cargo-stylus colours its output; strip ANSI escapes before parsing.
ADDRESS=$(printf '%s\n' "$LOG" | sed 's/\x1b\[[0-9;]*m//g' \
  | grep -oE 'deployed code at address: 0x[0-9a-fA-F]{40}' | tail -n1 | awk '{print $NF}')
if [[ -z "$ADDRESS" ]]; then
  echo "could not find the deployed address in cargo-stylus output" >&2
  exit 1
fi
ADDRESS=$(cast to-check-sum-address "$ADDRESS")

CURRENT_OWNER=$(cast call "$ADDRESS" 'owner()(address)' --rpc-url "$RPC_URL")
if [[ "$CURRENT_OWNER" == "0x0000000000000000000000000000000000000000" ]]; then
  echo "owner unset; calling initialize($OWNER)" >&2
  cast send "$ADDRESS" 'initialize(address)' "$OWNER" \
    --private-key "$PRIVATE_KEY" --rpc-url "$RPC_URL" >&2
  CURRENT_OWNER=$(cast call "$ADDRESS" 'owner()(address)' --rpc-url "$RPC_URL")
fi
if [[ "$(cast to-check-sum-address "$CURRENT_OWNER")" != "$(cast to-check-sum-address "$OWNER")" ]]; then
  echo "owner is $CURRENT_OWNER, expected $OWNER" >&2
  exit 1
fi
echo "owner verified: $CURRENT_OWNER" >&2

owner_is_deployer=0
[[ "$(cast to-check-sum-address "$OWNER")" == "$(cast to-check-sum-address "$DEPLOYER")" ]] && owner_is_deployer=1
for pair in "ESCROW:setEscrow" "OPERATOR:setOperator"; do
  var=${pair%%:*}
  fn=${pair##*:}
  value=${!var:-}
  [[ -n "$value" ]] || continue
  if [[ "$owner_is_deployer" != 1 ]]; then
    echo "skipping $fn: the owner ($OWNER) must call it" >&2
    continue
  fi
  echo "$fn($value)" >&2
  cast send "$ADDRESS" "$fn(address)" "$value" \
    --private-key "$PRIVATE_KEY" --rpc-url "$RPC_URL" >&2
done

if [[ -n "${CACHE_BID:-}" ]]; then
  echo "placing cache bid of $CACHE_BID wei" >&2
  cargo stylus cache bid "$ADDRESS" "$CACHE_BID" \
    --endpoint "$RPC_URL" --private-key-path "$KEYFILE" >&2
fi

echo "XorvRegistry deployed on chain $CHAIN_ID" >&2
echo "$ADDRESS"
