#!/usr/bin/env bash
# Run the indexer against a local chain (Anvil), with its own Postgres schema
# and its own Hasura, so it never disturbs other Envio indexers on this machine.
#
#   ENVIO_ESCROW_ADDRESS=0x… ENVIO_REGISTRY_ADDRESS=0x… ENVIO_LOG_ADDRESS=0x… \
#   ENVIO_RPC_URL=http://127.0.0.1:8648 indexer/local.sh
#
# GraphQL: http://localhost:${XORV_INDEXER_GRAPHQL_PORT:-8082}/v1/graphql
#
# Envio's local CLI shares one Postgres (`envio-postgres`) and one Hasura across
# projects, and Hasura's table tracking is last-writer-wins, so this indexer
# writes to schema `xorv_monad` and tracks it in a Hasura of its own.
set -euo pipefail
cd "$(dirname "$0")"
SCHEMA=${ENVIO_PG_SCHEMA:-xorv_monad}
HASURA_PORT=${XORV_INDEXER_GRAPHQL_PORT:-8082}
HASURA=xorv-monad-hasura
PG=envio-postgres

docker inspect "$PG" >/dev/null 2>&1 || { echo "needs Envio's local Postgres ($PG): run 'pnpm envio local docker up' once" >&2; exit 1; }
PG_PORT=$(docker port "$PG" 5432/tcp | head -1 | sed 's/.*://')

if ! docker inspect "$HASURA" >/dev/null 2>&1; then
  docker exec "$PG" psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='hasura_meta_xorv_monad'" | grep -q 1 \
    || docker exec "$PG" psql -U postgres -c "CREATE DATABASE hasura_meta_xorv_monad;" >/dev/null
  docker run -d --name "$HASURA" --network envio-network -p "$HASURA_PORT:8080" \
    -e HASURA_GRAPHQL_METADATA_DATABASE_URL="postgres://postgres:testing@$PG:5432/hasura_meta_xorv_monad" \
    -e HASURA_GRAPHQL_DATABASE_URL="postgres://postgres:testing@$PG:5432/envio-dev?options=-c%20search_path%3D$SCHEMA%2Cpublic" \
    -e HASURA_GRAPHQL_ADMIN_SECRET=testing \
    -e HASURA_GRAPHQL_UNAUTHORIZED_ROLE=public \
    -e HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES=true \
    -e HASURA_GRAPHQL_CORS_DOMAIN='*' \
    hasura/graphql-engine:v2.43.0 >/dev/null
fi
docker start "$HASURA" >/dev/null
for _ in $(seq 1 60); do curl -sf "http://localhost:$HASURA_PORT/healthz" >/dev/null && break; sleep 1; done

export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
export ENVIO_TUI=false ENVIO_PG_HOST=localhost ENVIO_PG_PORT="$PG_PORT" ENVIO_PG_USER=postgres ENVIO_PG_PASSWORD=testing \
  ENVIO_PG_DATABASE=envio-dev ENVIO_PG_SCHEMA="$SCHEMA" ENVIO_INDEXER_PORT="${ENVIO_INDEXER_PORT:-9871}" \
  HASURA_GRAPHQL_ENDPOINT="http://localhost:$HASURA_PORT/v1/metadata" HASURA_GRAPHQL_ADMIN_SECRET=testing
exec pnpm exec envio start --config config.local.yaml
