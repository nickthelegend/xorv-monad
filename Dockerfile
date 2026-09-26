# Xorv broker.
#
# Node 24 rather than 20: the persistence layer uses node:sqlite, which lands in
# 22.5. Running the broker without it is supported but means losing every job on
# restart, which is not a default worth shipping in a container.
FROM node:24-slim AS build

WORKDIR /app
RUN corepack enable

# Manifests first, so a source-only change doesn't re-resolve the whole tree.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY services/broker/package.json services/broker/
RUN pnpm install --frozen-lockfile --filter @xorv/protocol... --filter @xorv/broker...

COPY packages/protocol packages/protocol
COPY services/broker services/broker
RUN pnpm --filter @xorv/protocol build && pnpm --filter @xorv/broker build

# --- runtime ---------------------------------------------------------------
FROM node:24-slim

WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/protocol packages/protocol
COPY --from=build /app/services/broker services/broker
COPY --from=build /app/node_modules node_modules

# Jobs and earnings live here; mount a volume or they go with the container.
RUN mkdir -p /data && chown -R node:node /data /app
ENV XORV_DB=/data/xorv.db
VOLUME ["/data"]

USER node
EXPOSE 8402

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8402/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "services/broker/dist/index.js"]
