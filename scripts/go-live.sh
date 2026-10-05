#!/usr/bin/env bash
# Take the public deployment live on a funded testnet, end to end:
#
#   1. deploy XorvRegistry (Stylus), XorvEscrow and XorvLog   (deploy-testnet.sh)
#   2. point the Railway broker at them                       (railway variables)
#   3. point the landing page at them and redeploy both sites (vercel env + deploy-web.sh)
#   4. wait for the broker to come back and check it reports the contracts
#
#   scripts/go-live.sh
#
# Arbitrum Sepolia only: that is the chain the public broker and both sites
# are configured for. (Robinhood Chain Testnet deploys with deploy-testnet.sh,
# but the sites have no Robinhood mode to point at it.)
#
# The only prerequisite is gas: the operator (XORV_OPERATOR_KEY in .env) needs
# ~0.001 ETH on the target chain. (--no-sensitive and no stdin: without them
# `vercel env add` waits on an interactive prompt despite --yes.) Everything else — keys, project ids — is
# already in the repo's config. Safe to re-run: it redeploys fresh contracts.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET=arbitrum-sepolia
RAILWAY_PROJECT=${RAILWAY_PROJECT_ID:-d82a3ea6-6c25-4b47-b3d9-35056ec3eae5}
RAILWAY_SERVICE=${RAILWAY_SERVICE_ID:-d0aefba5-343f-4822-9b3a-a9506b6b78db}
RAILWAY_ENV=${RAILWAY_ENVIRONMENT:-production}
BROKER=${XORV_PUBLIC_BROKER:-https://broker-production-38c5.up.railway.app}
ORG=${VERCEL_ORG_ID:-team_gwapD8j8P5T3NxIU746NjNxe}
LANDING=${VERCEL_LANDING_PROJECT_ID:-prj_6g6dffm4uITc7nV1OapLAbYLsenl}

say() { printf '\n\033[1m── %s\033[0m\n' "$*"; }

say "deploying contracts to $TARGET"
"$ROOT/scripts/deploy-testnet.sh" "$TARGET"

DEPLOYMENT="$ROOT/deployments/$TARGET.json"
field() { node -e 'const d=require(process.argv[1]); process.stdout.write(String(d[process.argv[2]]))' "$DEPLOYMENT" "$1"; }
NETWORK=$(field network); ESCROW=$(field escrow); REGISTRY=$(field registry); LOG=$(field log); FROM=$(field fromBlock)

say "pointing the Railway broker at them"
# Setting variables triggers a redeploy of the service.
RAILWAY_CALLER=go-live railway variables \
  --project "$RAILWAY_PROJECT" --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENV" \
  --set "XORV_NETWORK=$NETWORK" \
  --set "XORV_ESCROW_ADDRESS=$ESCROW" \
  --set "XORV_REGISTRY_ADDRESS=$REGISTRY" \
  --set "XORV_LOG_ADDRESS=$LOG" \
  --set "XORV_LOG_FROM_BLOCK=$FROM" >/dev/null
echo "   set XORV_NETWORK / ESCROW / REGISTRY / LOG / LOG_FROM_BLOCK"

say "pointing the landing page at them"
setenv() {
  VERCEL_ORG_ID=$ORG VERCEL_PROJECT_ID=$LANDING \
    vercel env add "$1" production --value "$2" --force --yes --no-sensitive </dev/null >/dev/null 2>&1 \
    || { echo "   could not set $1 on Vercel" >&2; exit 1; }
  echo "   $1"
}
setenv NEXT_PUBLIC_XORV_ESCROW_ADDRESS "$ESCROW"
setenv NEXT_PUBLIC_XORV_REGISTRY_ADDRESS "$REGISTRY"
setenv NEXT_PUBLIC_XORV_LOG_ADDRESS "$LOG"

say "redeploying both sites"
"$ROOT/scripts/deploy-web.sh"

say "waiting for the broker to report the new contracts"
for _ in $(seq 1 60); do
  got=$(curl -fsS "$BROKER/api/network" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const n=JSON.parse(s);console.log((n.escrow&&n.escrow.address||"")+" "+(n.log&&n.log.address||""))}catch{console.log("")}})' || true)
  case "$got" in "$ESCROW "*) break ;; esac
  sleep 10
done
case "$got" in
  "$ESCROW "*) echo "   broker reports escrow $ESCROW, log ${got#* }" ;;
  *) echo "   the broker hasn't picked the contracts up yet — check the Railway deploy" >&2; exit 1 ;;
esac

cat <<DONE

live on $TARGET ($NETWORK)
  escrow    $ESCROW
  registry  $REGISTRY
  log       $LOG
  record    deployments/$TARGET.json
DONE
