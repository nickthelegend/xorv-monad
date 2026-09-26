# Xorv broker on Monad.
#
#   docker build -t xorv-broker .
#   docker run -p 8402:8402 -v xorv-data:/data --env-file .env xorv-broker
#
# (or `docker compose up`, which does both and names every variable.)
#
# Node 22: the oldest line CI proves the broker on, and its persistence layer
# needs node:sqlite, unflagged from 22.13 (every node:22 image is past that).
# Without it the broker still runs, but in memory — every job and every
# lifetime earning gone on restart, which is not a default worth shipping in a
# container.
#
# Everything the broker runs is pure JS (viem, @x402/*, hono, ws, the noble
# ciphers), so no stage needs native build tools. pnpm is the version pinned
# by the root package.json's packageManager, through corepack.
ARG NODE_IMAGE=node:22-slim

# --- base: pnpm + the manifests the install resolves from -------------------
FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY package.json ./
# Fetched once here, so both install stages below run the same pnpm.
RUN corepack enable && corepack install
# Manifests first, so a source-only change doesn't re-resolve the tree. Only
# the two packages the broker is built from: a filtered, frozen install checks
# the lockfile against the projects it installs, and needs nothing else.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/protocol/package.json packages/protocol/
COPY services/broker/package.json services/broker/

# --- build: full install, protocol compiled before the broker ---------------
FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @xorv/broker...
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY services/broker services/broker
# The broker resolves @xorv/protocol through its compiled dist/, so the order
# matters.
RUN pnpm --filter @xorv/protocol build && pnpm --filter @xorv/broker build

# --- prod-deps: the runtime closure only (no tsc, tsx, vitest, @types) ------
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @xorv/broker...

# --- runtime ----------------------------------------------------------------
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production

# Code and dependencies stay root-owned: the broker only ever writes to /data.
COPY --from=prod-deps /app/package.json ./
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=prod-deps /app/packages/protocol/node_modules packages/protocol/node_modules
COPY --from=prod-deps /app/services/broker/node_modules services/broker/node_modules
COPY --from=build /app/packages/protocol/package.json packages/protocol/
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/services/broker/package.json services/broker/
COPY --from=build /app/services/broker/dist services/broker/dist

# Jobs, lifetime earnings and private-job vaults live here; mount a volume or
# they go with the container. A Monad-specific file name, so a volume that
# held the Hedera broker's xorv.db is never read as this one.
RUN mkdir -p /data && chown node:node /data
ENV XORV_DB=/data/xorv-monad.db \
    XORV_BROKER_PORT=8402
VOLUME ["/data"]

USER node
EXPOSE 8402

# Follows XORV_BROKER_PORT, so moving the port doesn't mark a healthy broker
# as dead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.XORV_BROKER_PORT||8402)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "services/broker/dist/index.js"]
