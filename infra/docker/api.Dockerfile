# apps/api — Fastify HTTP + SSE API.
#
# ACTIVATES: M0 (2026-09-21 → 2026-10-09), when apps/api and the pnpm
# workspace are scaffolded. Until then this file is a specification: it is
# syntactically complete and correct for the layout the repo canon defines,
# but `docker build` against it fails because apps/api does not exist. The
# corresponding compose service is guarded behind the `apps` profile.
#
# Stages: base -> deps -> dev -> build -> runtime
# Build from the REPOSITORY ROOT so the workspace manifests resolve:
#     docker build -f infra/docker/api.Dockerfile --target runtime .

# ---------------------------------------------------------------------------
# base — the common foundation. Pinned minor, not just major: a silent Node
# bump between the build stage and the runtime stage is a class of bug that
# only shows up under load.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    NODE_OPTIONS="--enable-source-maps"
# tini reaps zombies and forwards signals, so SIGTERM reaches Node and the
# server can drain in-flight requests instead of being killed mid-response.
RUN apk add --no-cache tini libstdc++ \
 && corepack enable \
 && corepack prepare pnpm@9 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — resolve and fetch the dependency graph.
#
# `pnpm fetch` populates the store from the lockfile ALONE. It needs no
# package.json files, so this layer is invalidated only when the lockfile
# changes — not when any source file does.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch

# Now bring in every manifest in the workspace and install offline from the
# fetched store. Copying manifests separately from sources keeps the install
# layer cached across ordinary code edits.
COPY package.json turbo.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY packages/core-domain/package.json ./packages/core-domain/
COPY packages/exec-adapter/package.json ./packages/exec-adapter/
COPY packages/grading/package.json ./packages/grading/
COPY packages/auth/package.json ./packages/auth/
COPY packages/config/package.json ./packages/config/
COPY packages/observability/package.json ./packages/observability/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline \
      --filter @assaybank/api... \
      --filter .

# ---------------------------------------------------------------------------
# dev — hot reload. Sources arrive as a bind mount from compose, not COPY, so
# nothing is baked in. node_modules stay in the image.
# ---------------------------------------------------------------------------
FROM deps AS dev
ENV NODE_ENV=development
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -q -O /dev/null http://localhost:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "--filter", "@assaybank/api", "dev"]

# ---------------------------------------------------------------------------
# build — compile TypeScript for api and every package it depends on.
# ---------------------------------------------------------------------------
FROM deps AS build
ENV NODE_ENV=production
COPY . .
RUN pnpm turbo run build --filter @assaybank/api...

# `pnpm deploy` flattens the workspace into a self-contained directory with
# only the production dependency closure — no symlinks into a sibling package,
# no devDependencies, no source. That directory is what ships.
RUN pnpm --filter @assaybank/api --prod deploy --legacy /deploy

# ---------------------------------------------------------------------------
# runtime — minimal, non-root, no toolchain.
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    API_PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /deploy ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
