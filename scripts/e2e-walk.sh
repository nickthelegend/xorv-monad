#!/usr/bin/env bash
# The completeness walk: bring up the whole local stack, walk every screen and
# flow of the app in Google Chrome (apps/app/e2e/walk.spec.ts), then stop it all.
#
#   - a fresh local chain with real contracts (scripts/local-stack.sh)
#   - the broker, a provider node selling real models (Codex, Claude Code),
#     the Envio indexer, and a production build of the app on :3302
#
# Everything is stopped by PID at the end, never by pattern: other sessions on
# this machine run their own nodes, brokers and indexers.
#
#   scripts/e2e-walk.sh                 # walk it, then stop everything
#   SERVE=1 scripts/e2e-walk.sh         # the one-command local demo: bring it all up and
#                                       # keep it up until Ctrl-C (then stop everything)
#   XORV_CODEX_MODEL=…                  # pins Codex's model, for logins that need one
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
LOGS=$(mktemp -d "${TMPDIR:-/tmp}/xorv-walk.XXXXXX")
PIDS=()
PORTS=(8402 8411 9871 3302 8648)

say() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
cleanup() {
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  for port in "${PORTS[@]}"; do
    for pid in $(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
  done
  docker stop xorv-monad-hasura >/dev/null 2>&1 || true
  echo "logs: $LOGS"
}
trap cleanup EXIT

wait_port() { # port, seconds
  for _ in $(seq 1 "$2"); do lsof -ti tcp:"$1" -sTCP:LISTEN >/dev/null 2>&1 && return 0; sleep 1; done
  echo "nothing listening on :$1 after $2 s" >&2; return 1
}

for port in "${PORTS[@]}"; do
  if lsof -ti tcp:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo ":$port is already in use — stop the local stack first" >&2; exit 1
  fi
done

say "fresh local chain and contracts"
scripts/local-stack.sh >"$LOGS/stack.log" 2>&1 || { tail -30 "$LOGS/stack.log"; exit 1; }
rm -f data/local-stack.db data/local-stack.db-*

say "broker, provider node, indexer"
scripts/local-stack-run.sh broker >"$LOGS/broker.log" 2>&1 & PIDS+=($!)
wait_port 8402 90
scripts/local-stack-run.sh provider >"$LOGS/provider.log" 2>&1 & PIDS+=($!)
scripts/local-stack-run.sh indexer >"$LOGS/indexer.log" 2>&1 & PIDS+=($!)
wait_port 8411 90
wait_port 8082 120

say "production build of the app"
set -a; . ./.env.local-stack; set +a
export NEXT_PUBLIC_XORV_BROKER_URL=http://localhost:8402 XORV_BROKER_URL=http://localhost:8402 XORV_DEMO_PAYER_KEY=
pnpm --filter xorv-app exec next build >"$LOGS/app-build.log" 2>&1 || { tail -30 "$LOGS/app-build.log"; exit 1; }
pnpm --filter xorv-app exec next start -p 3302 >"$LOGS/app.log" 2>&1 & PIDS+=($!)
wait_port 3302 60

if [ "${SERVE:-0}" = 1 ]; then
  say "Xorv is up on a local chain — Ctrl-C stops everything"
  echo "   app        http://localhost:3302"
  echo "   broker     http://localhost:8402/api/network"
  echo "   indexer    http://localhost:8082/v1/graphql"
  echo "   chain      http://127.0.0.1:8648 (chain 31337)"
  echo "   buy from the terminal: XORV_PAYER_KEY=\$XORV_DEMO_PAYER_KEY node packages/cli/dist/index.js run \"…\" --broker http://localhost:8402 --max 0.50"
  wait
  exit 0
fi

say "walking the app in Chrome"
cd apps/app
XORV_APP_URL=http://localhost:3302 ./node_modules/.bin/playwright test
