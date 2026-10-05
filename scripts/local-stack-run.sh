#!/usr/bin/env bash
# Run one component of the local stack against the contracts scripts/local-stack.sh deployed.
#
#   scripts/local-stack-run.sh broker     # :8402 — x402 + escrow facilitator + reputation
#   scripts/local-stack-run.sh provider   # a node selling Claude Code and Codex (real models, no echo)
#   scripts/local-stack-run.sh app        # job board on :3302
#   scripts/local-stack-run.sh landing    # marketing site on :3300
#   scripts/local-stack-run.sh indexer    # Envio indexer over the local chain (GraphQL :8082)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE="$ROOT/.env.local-stack"
[ -f "$ENV_FILE" ] || { echo "run scripts/local-stack.sh first" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
# The broker reads only this file, not the repo .env (which is the public testnet config).
export XORV_ENV_FILE="$ENV_FILE"

BROKER_PORT=${BROKER_PORT:-8402}
APP_PORT=${APP_PORT:-3302}
LANDING_PORT=${LANDING_PORT:-3300}
export XORV_BROKER_URL="http://localhost:$BROKER_PORT"
# A local node has no public explorer: every link goes to the app's /chain viewer.
export XORV_EXPLORER_URL="http://localhost:$APP_PORT/chain"
cd "$ROOT"

case "${1:?component: broker|provider|app|landing|indexer}" in
  broker)
    exec env XORV_BROKER_PORT="$BROKER_PORT" XORV_DB="$ROOT/data/local-stack.db" \
      XORV_CORS_ORIGINS="http://localhost:$APP_PORT,http://localhost:$LANDING_PORT" \
      XORV_MONGO_URI= XORV_TRUST_PROXY= node services/broker/dist/index.js
    ;;
  provider)
    HOME_DIR="${XORV_LOCAL_PROVIDER_HOME:-$HOME/.xorv-local-stack/provider}"
    mkdir -p "$HOME_DIR"
    node -e '
      const fs = require("fs");
      const [file, network, broker, address, key] = process.argv.slice(1);
      let prior = {};
      try { prior = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      // XORV_CODEX_MODEL pins the Codex model, for logins that cannot use the default one.
      const models = { codex: process.env.XORV_CODEX_MODEL || null };
      const cap = (id, name, price) => ({ id, adapter: id, displayName: name, model: models[id] ?? null, priceUsdMicros: price, maxConcurrency: 1 });
      fs.writeFileSync(file, JSON.stringify({
        nodeId: prior.nodeId || require("crypto").randomBytes(12).toString("hex"),
        label: "local-stack-node",
        network, brokerUrl: broker, address, privateKey: key,
        // Real models only: the jobs this node sells run on Claude Code and Codex.
        capabilities: [cap("codex", "Codex", 200000), cap("claude-code", "Claude Code", 250000)],
        region: null,
        tunnel: { enabled: false, hostname: null },
        sandboxDir: require("path").join(require("path").dirname(file), "jobs"),
      }, null, 2), { mode: 0o600 });
    ' "$HOME_DIR/config.json" "$XORV_NETWORK" "$XORV_BROKER_URL" "$XORV_PROVIDER_ADDRESS" "$XORV_PROVIDER_KEY"
    exec env XORV_HOME="$HOME_DIR" node packages/cli/dist/index.js start --port 8411
    ;;
  app)
    exec env NEXT_PUBLIC_XORV_BROKER_URL="$XORV_BROKER_URL" XORV_DEMO_PAYER_KEY= \
      pnpm --filter xorv-app exec next dev -p "$APP_PORT"
    ;;
  landing)
    exec env NEXT_PUBLIC_XORV_BROKER_URL="$XORV_BROKER_URL" NEXT_PUBLIC_XORV_APP_URL="http://localhost:$APP_PORT" \
      pnpm --filter xorv-landing exec next dev -p "$LANDING_PORT"
    ;;
  indexer)
    exec "$ROOT/indexer/local.sh"
    ;;
  *) echo "unknown component $1" >&2; exit 1 ;;
esac
