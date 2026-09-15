# apps/collab — y-websocket server holding live Yjs documents for interview
# sessions, with Valkey pub/sub fanout and periodic snapshots to Postgres.
#
# ACTIVATES: M3 (2026-11-30 → 2026-12-25). Until apps/collab is scaffolded this
# file is a specification and `docker build` against it fails.
#
# Stages: base -> deps -> dev -> build -> runtime
# Build from the REPOSITORY ROOT:
#     docker build -f infra/docker/collab.Dockerfile --target runtime .

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    NODE_OPTIONS="--enable-source-maps"
RUN apk add --no-cache tini libstdc++ \
 && corepack enable \
 && corepack prepare pnpm@9 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch

COPY package.json turbo.json ./
COPY apps/collab/package.json ./apps/collab/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY packages/auth/package.json ./packages/auth/
COPY packages/config/package.json ./packages/config/
COPY packages/observability/package.json ./packages/observability/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline \
      --filter @assaybank/collab... \
      --filter .

FROM deps AS dev
ENV NODE_ENV=development
USER node
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -q -O /dev/null http://localhost:8081/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "--filter", "@assaybank/collab", "dev"]

FROM deps AS build
ENV NODE_ENV=production
COPY . .
RUN pnpm turbo run build --filter @assaybank/collab...
RUN pnpm --filter @assaybank/collab --prod deploy --legacy /deploy

FROM base AS runtime
ENV NODE_ENV=production \
    COLLAB_PORT=8081
WORKDIR /app
COPY --from=build --chown=node:node /deploy ./
USER node
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:8081/healthz || exit 1
# On SIGTERM the process snapshots every open document to Postgres before
# exiting. Without tini forwarding the signal, an instance loses up to one
# snapshot interval of interview work on every deploy.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
