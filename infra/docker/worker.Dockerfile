# apps/worker — BullMQ grading workers and the scheduled sweeps
# (deadline sweep, question stats, retention).
#
# ACTIVATES: M0 (2026-09-21 → 2026-10-09) for the scheduled sweeps; the grading
# pipeline it exists for lands in M2 (2026-11-02 → 2026-11-27). Until apps/worker
# is scaffolded this file is a specification and `docker build` against it fails.
#
# Stages: base -> deps -> dev -> build -> runtime
# Build from the REPOSITORY ROOT:
#     docker build -f infra/docker/worker.Dockerfile --target runtime .
#
# This image carries database and object-store credentials at runtime. It is
# therefore scheduled on worker-labelled nodes and never on exec nodes — see
# the header of docker-compose.prod.yml.

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
COPY apps/worker/package.json ./apps/worker/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY packages/core-domain/package.json ./packages/core-domain/
COPY packages/exec-adapter/package.json ./packages/exec-adapter/
COPY packages/grading/package.json ./packages/grading/
COPY packages/config/package.json ./packages/config/
COPY packages/observability/package.json ./packages/observability/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline \
      --filter @assaybank/worker... \
      --filter .

FROM deps AS dev
ENV NODE_ENV=development
USER node
# 9464 carries /healthz and the Prometheus /metrics endpoint. The worker serves
# no domain routes; this listener exists so the orchestrator and the scrape job
# have something to talk to.
EXPOSE 9464
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -q -O /dev/null http://localhost:9464/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "--filter", "@assaybank/worker", "dev"]

FROM deps AS build
ENV NODE_ENV=production
COPY . .
RUN pnpm turbo run build --filter @assaybank/worker...
RUN pnpm --filter @assaybank/worker --prod deploy --legacy /deploy

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /deploy ./
USER node
EXPOSE 9464
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:9464/healthz || exit 1
# tini forwards SIGTERM so the worker can stop accepting jobs and let the job
# in flight finish. A killed worker leaves a submission ungraded, and an
# ungraded submission must never become a silent zero (docs/02-HLD.md s9).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/worker.js"]
