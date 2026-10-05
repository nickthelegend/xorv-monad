#!/usr/bin/env bash
# Take the public deployment live on Monad testnet, end to end:
#
#   1. deploy XorvRegistry, XorvEscrow and XorvLog            (deploy-testnet.sh)
#   2. point the Railway broker at them                       (railway variables)
#   3. point the landing page at them and redeploy both sites (vercel env + deploy-web.sh)
#   4. wait for the broker to come back and check it reports the contracts
#
#   scripts/go-live.sh
#
# Prerequisites: MON for gas on the operator (XORV_OPERATOR_KEY in .env,
# ~0.7 MON), and deployments/hosting.env naming this project's own Railway and
# Vercel projects. Only contract addresses are written to the hosts: secrets
# (the operator key, the demo payer key) are set by the owner in each
# dashboard, never by a script. (--no-sensitive and no stdin: without them
# `vercel env add` waits on an interactive prompt despite --yes.)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET=monad-testnet
# No defaults: see deploy-web.sh. Monad's own projects live in deployments/hosting.env.
[ -f "$ROOT/deployments/hosting.env" ] && { set -a; . "$ROOT/deployments/hosting.env"; set +a; }
RAILWAY_PROJECT=${RAILWAY_PROJECT_ID:?set RAILWAY_PROJECT_ID (the Monad broker project)}
RAILWAY_SERVICE=${RAILWAY_SERVICE_ID:?set RAILWAY_SERVICE_ID}
RAILWAY_ENV=${RAILWAY_ENVIRONMENT:-production}
BROKER=${XORV_PUBLIC_BROKER:?set XORV_PUBLIC_BROKER (the Monad broker URL)}
ORG=${VERCEL_ORG_ID:?set VERCEL_ORG_ID}
LANDING=${VERCEL_LANDING_PROJECT_ID:?set VERCEL_LANDING_PROJECT_ID}

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
