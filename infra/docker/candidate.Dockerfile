# apps/candidate — React 19 candidate app (assessment runner + interview join).
#
# ACTIVATES: M1 (2026-10-12 → 2026-10-30). Until apps/candidate is scaffolded
# this file is a specification and `docker build` against it fails.
#
# Stages: base -> deps -> dev -> build -> runtime
# Build from the REPOSITORY ROOT:
#     docker build -f infra/docker/candidate.Dockerfile --target runtime .
#
# ---------------------------------------------------------------------------
# WHY THIS IS A SEPARATE IMAGE FROM apps/web
# ---------------------------------------------------------------------------
# The candidate bundle is built from its own entry point and its own dependency
# closure. Nothing staff-only — question-bank screens, correct-answer flags,
# reference solutions, hidden test cases, reviewer tooling — is reachable from
# this build graph, so none of it can be recovered from the shipped JavaScript.
# "Hidden by a route guard in one bundle" is not a security boundary; "never
# compiled into the artifact" is. docs/02-HLD.md section 1.
#
# The `--filter @hiring/candidate...` below is the enforcement point. If a
# staff-only package ever appears in this file's COPY list, that is the bug.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"
RUN apk add --no-cache tini \
 && corepack enable \
 && corepack prepare pnpm@9 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch

COPY package.json turbo.json ./
COPY apps/candidate/package.json ./apps/candidate/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/ui/package.json ./packages/ui/
COPY packages/config/package.json ./packages/config/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline \
      --filter @hiring/candidate... \
      --filter .

FROM deps AS dev
ENV NODE_ENV=development
USER node
EXPOSE 5174
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -q -O /dev/null http://localhost:5174/ || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "--filter", "@hiring/candidate", "dev", "--host", "0.0.0.0", "--port", "5174"]

FROM deps AS build
ARG VITE_API_PUBLIC_URL
ARG VITE_COLLAB_PUBLIC_URL
ENV NODE_ENV=production \
    VITE_API_PUBLIC_URL=${VITE_API_PUBLIC_URL} \
    VITE_COLLAB_PUBLIC_URL=${VITE_COLLAB_PUBLIC_URL}
COPY . .
RUN pnpm turbo run build --filter @hiring/candidate...
RUN pnpm --filter @hiring/candidate --prod deploy --legacy /deploy \
 && rm -rf /deploy/src /deploy/node_modules/.cache

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /deploy/dist ./dist
COPY --from=build --chown=node:node /deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /deploy/package.json ./package.json
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:3001/ || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "node_modules/.bin/sirv", "dist", "--single", "--host", "0.0.0.0", "--port", "3001"]
