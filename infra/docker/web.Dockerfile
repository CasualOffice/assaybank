# apps/web — React 19 + TanStack Router staff console (recruiter, interviewer,
# admin). Built to static assets and served by a minimal static server.
#
# ACTIVATES: M0 (2026-09-21 → 2026-10-09) with the question bank screens. Until
# apps/web is scaffolded this file is a specification and `docker build` fails.
#
# Stages: base -> deps -> dev -> build -> runtime
# Build from the REPOSITORY ROOT:
#     docker build -f infra/docker/web.Dockerfile --target runtime .
#
# Vite inlines VITE_* values at build time, so the public URLs are build args,
# not runtime environment. A different environment means a different image —
# which is the correct trade: the bundle a browser downloaded is then always
# traceable to one build.

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
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/ui/package.json ./packages/ui/
COPY packages/config/package.json ./packages/config/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline \
      --filter @assaybank/web... \
      --filter .

FROM deps AS dev
ENV NODE_ENV=development
USER node
EXPOSE 5173
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -q -O /dev/null http://localhost:5173/ || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# --host binds 0.0.0.0; without it the dev server is unreachable from outside
# the container.
CMD ["pnpm", "--filter", "@assaybank/web", "dev", "--host", "0.0.0.0", "--port", "5173"]

FROM deps AS build
ARG VITE_API_PUBLIC_URL
ARG VITE_COLLAB_PUBLIC_URL
ENV NODE_ENV=production \
    VITE_API_PUBLIC_URL=${VITE_API_PUBLIC_URL} \
    VITE_COLLAB_PUBLIC_URL=${VITE_COLLAB_PUBLIC_URL}
COPY . .
RUN pnpm turbo run build --filter @assaybank/web...

# The static server is its own tiny workspace package (packages/… is not
# involved). Deploying it separately keeps the runtime image free of Vite,
# TypeScript and every other build-time dependency.
RUN pnpm --filter @assaybank/web --prod deploy --legacy /deploy \
 && rm -rf /deploy/src /deploy/node_modules/.cache

# ---------------------------------------------------------------------------
# runtime — static assets only. No application code, no secrets, no database
# client. The server's single job is to return files and fall back to
# index.html so client-side routing survives a deep link refresh.
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /deploy/dist ./dist
COPY --from=build --chown=node:node /deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /deploy/package.json ./package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:3000/ || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "node_modules/.bin/sirv", "dist", "--single", "--host", "0.0.0.0", "--port", "3000"]
