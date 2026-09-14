# =============================================================================
# Assaybank — developer entry points
#
#   make            list every target
#   make up         start the local stack
#   make seed       load skills, roles and a starter question set (from M0)
#
# Targets whose implementation arrives with a later milestone are defined here
# already. They print the milestone that will implement them and exit 0, so a
# newcomer running `make test` on 2026-09-21 gets an explanation rather than a
# missing-script stack trace.
# =============================================================================

SHELL        := /usr/bin/env bash
.SHELLFLAGS  := -eu -o pipefail -c
.DEFAULT_GOAL := help

COMPOSE      ?= docker compose
COMPOSE_DEV  ?= docker-compose.yml
COMPOSE_PROD ?= docker-compose.prod.yml
ENV_FILE     ?= .env
PKG_MANAGER  ?= pnpm

# Scope a target to one service:  make logs S=api
S ?=

# Migration name:                 make migrate-new N=add_question_stats
N ?=

# Database and queue containers, for the shell targets.
PG_SERVICE     ?= postgres
VALKEY_SERVICE ?= valkey
PG_USER        ?= hiring_app
PG_DB          ?= hiring

.PHONY: help up down logs ps restart build seed migrate migrate-new psql redis-cli \
        test test-unit test-integration test-e2e lint typecheck fmt licences sbom \
        docs-check graph clean nuke check-env

# -----------------------------------------------------------------------------
# Help
# -----------------------------------------------------------------------------

help: ## Show this help
	@printf '\nAssaybank — make targets\n\n'
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@printf '\nVariables:  S=<service> (logs, restart)   N=<name> (migrate-new)\n\n'

# Internal: refuse to start the stack without a .env, and refuse to start it
# with the placeholder secrets still in place.
check-env:
	@if [ ! -f "$(ENV_FILE)" ]; then \
		printf 'No %s found. Run:\n\n  cp .env.example %s\n  openssl rand -hex 32   # SESSION_SECRET\n  openssl rand -hex 32   # TOKEN_PEPPER\n\n' "$(ENV_FILE)" "$(ENV_FILE)"; \
		exit 1; \
	fi
	@if grep -q 'CHANGE_ME' "$(ENV_FILE)"; then \
		printf 'warning: %s still contains CHANGE_ME placeholders. Generate them with: openssl rand -hex 32\n' "$(ENV_FILE)"; \
	fi

# -----------------------------------------------------------------------------
# Local stack
# -----------------------------------------------------------------------------

up: check-env ## Start the local stack (postgres, valkey, piston, seaweedfs, mailpit, otel, prometheus, grafana)
	@$(COMPOSE) -f $(COMPOSE_DEV) --env-file $(ENV_FILE) up -d $(S)
	@printf '\nStack starting. Piston pulls language runtimes on first boot; that is the slow part.\n'
	@printf 'API http://localhost:8080  ·  staff http://localhost:5173  ·  candidate http://localhost:5174\n'
	@printf 'Mailpit http://localhost:8025  ·  Prometheus http://localhost:9090  ·  Grafana http://localhost:3030\n\n'
	@printf 'Run `make ps` to check health, `make logs` to follow.\n'

down: ## Stop the local stack, keeping volumes
	@$(COMPOSE) -f $(COMPOSE_DEV) --env-file $(ENV_FILE) down

logs: ## Follow logs (S=api to scope to one service)
	@$(COMPOSE) -f $(COMPOSE_DEV) --env-file $(ENV_FILE) logs -f --tail=200 $(S)

ps: ## Show container status and health
	@$(COMPOSE) -f $(COMPOSE_DEV) --env-file $(ENV_FILE) ps

restart: ## Restart the stack, or one service (S=api)
	@$(COMPOSE) -f $(COMPOSE_DEV) --env-file $(ENV_FILE) restart $(S)

# -----------------------------------------------------------------------------
# Build
# -----------------------------------------------------------------------------

build: ## Build workspace packages and app images
	@if [ ! -f package.json ]; then \
		printf 'build: not implemented until M0 (question bank, 2026-09-21 to 2026-10-11).\n'; \
		printf '       The pnpm workspace and Turborepo pipeline land with the first apps/ code.\n'; \
	else \
		$(PKG_MANAGER) turbo run build; \
		$(COMPOSE) -f $(COMPOSE_DEV) --env-file $(ENV_FILE) build; \
	fi

# -----------------------------------------------------------------------------
# Database
# -----------------------------------------------------------------------------

migrate: ## Apply Drizzle migrations to the local database
	@if [ ! -d packages/db ]; then \
		printf 'migrate: not implemented until M0 (question bank, 2026-09-21 to 2026-10-11).\n'; \
		printf '         Schema and migrations live in packages/db. The runnable reference schema\n'; \
		printf '         is docs/hiring_platform_schema.sql until then.\n'; \
	else \
		$(PKG_MANAGER) --filter @hiring/db migrate; \
	fi

migrate-new: ## Generate a new migration (N=add_question_stats)
	@if [ -z "$(N)" ]; then printf 'migrate-new: pass a name, e.g. make migrate-new N=add_question_stats\n'; exit 1; fi
	@if [ ! -d packages/db ]; then \
		printf 'migrate-new: not implemented until M0 (question bank, 2026-09-21 to 2026-10-11).\n'; \
	else \
		$(PKG_MANAGER) --filter @hiring/db generate -- --name "$(N)"; \
		printf '\nMigrations are expand-contract only: add nullable, backfill, switch reads, drop old,\n'; \
		printf 'across separate deploys. A destructive migration breaks whatever exam window is running.\n'; \
	fi

seed: ## Load skills, roles and a starter question set
	@if [ ! -d packages/db ]; then \
		printf 'seed: not implemented until M0 (question bank, 2026-09-21 to 2026-10-11).\n'; \
		printf '      Seed data is skills, job roles, role-to-skill weights and an imported\n'; \
		printf '      starter bank, each row carrying its source_license (docs/05 section 2).\n'; \
	else \
		$(PKG_MANAGER) --filter @hiring/db seed; \
	fi

psql: ## Open a psql shell on the local database
	@$(COMPOSE) -f $(COMPOSE_DEV) --env-file $(ENV_FILE) exec $(PG_SERVICE) psql -U $(PG_USER) -d $(PG_DB)

redis-cli: ## Open a valkey-cli shell on the local queue backend
	@$(COMPOSE) -f $(COMPOSE_DEV) --env-file $(ENV_FILE) exec $(VALKEY_SERVICE) valkey-cli

# -----------------------------------------------------------------------------
# Tests
# -----------------------------------------------------------------------------

test: test-unit test-integration test-e2e ## Run every suite

test-unit: ## Run unit tests (pure domain, grading, contracts)
	@if [ ! -f package.json ]; then \
		printf 'test-unit: not implemented until M0 (question bank, 2026-09-21 to 2026-10-11).\n'; \
		printf '           Strategy is specified in docs/06-testing-strategy.md.\n'; \
	else \
		$(PKG_MANAGER) turbo run test:unit; \
	fi

test-integration: ## Run integration tests (API against Postgres and Valkey)
	@if [ ! -f package.json ]; then \
		printf 'test-integration: not implemented until M0 (question bank, 2026-09-21 to 2026-10-11).\n'; \
		printf '                  Includes the RLS isolation suite and the assertion that no\n'; \
		printf '                  candidate-scoped response can carry hidden test cases,\n'; \
		printf '                  reference solutions or is_correct flags.\n'; \
	else \
		$(PKG_MANAGER) turbo run test:integration; \
	fi

test-e2e: ## Run end-to-end tests (Playwright, staff console and candidate app)
	@if [ ! -d apps/candidate ]; then \
		printf 'test-e2e: not implemented until M1 (async MCQ, 2026-10-12 to 2026-11-01).\n'; \
		printf '          The first end-to-end journey is invite to submitted attempt to score.\n'; \
	else \
		$(PKG_MANAGER) turbo run test:e2e; \
	fi

# -----------------------------------------------------------------------------
# Code quality
# -----------------------------------------------------------------------------

lint: ## Run ESLint across the workspace
	@if [ ! -f package.json ]; then \
		printf 'lint: not implemented until M0 (question bank, 2026-09-21 to 2026-10-11).\n'; \
	else \
		$(PKG_MANAGER) turbo run lint; \
	fi

typecheck: ## Run tsc --noEmit across the workspace
	@if [ ! -f package.json ]; then \
		printf 'typecheck: not implemented until M0 (question bank, 2026-09-21 to 2026-10-11).\n'; \
	else \
		$(PKG_MANAGER) turbo run typecheck; \
	fi

fmt: ## Format with Prettier (writes in place)
	@if [ ! -f package.json ]; then \
		printf 'fmt: not implemented until M0 (question bank, 2026-09-21 to 2026-10-11).\n'; \
		printf '     Markdown and YAML in this repo follow .editorconfig until then.\n'; \
	else \
		$(PKG_MANAGER) prettier --write .; \
	fi

# -----------------------------------------------------------------------------
# Supply chain
# -----------------------------------------------------------------------------

licences: ## Fail on any prohibited dependency licence (GPL, AGPL, SSPL, BSL, Commons Clause)
	@if [ ! -f scripts/check-licences.mjs ]; then \
		printf 'licences: scripts/check-licences.mjs is missing. It is required by CI.\n'; \
		exit 1; \
	fi
	@node scripts/check-licences.mjs

sbom: ## Produce a CycloneDX SBOM for the current dependency tree
	@if [ ! -f pnpm-lock.yaml ]; then \
		printf 'sbom: not implemented until M0 (question bank, 2026-09-21 to 2026-10-11).\n'; \
		printf '      There is no dependency tree to describe until the workspace exists.\n'; \
		printf '      An SBOM is produced per release once there is one (docs/05 section 1).\n'; \
	else \
		mkdir -p sbom; \
		$(PKG_MANAGER) dlx @cyclonedx/cyclonedx-npm --output-file sbom/hiring.cdx.json; \
		printf 'Wrote sbom/hiring.cdx.json\n'; \
	fi

# -----------------------------------------------------------------------------
# Documentation
# -----------------------------------------------------------------------------

docs-check: ## Check doc freshness and relative links
	@ok=1; \
	if [ -f scripts/check-doc-freshness.mjs ]; then node scripts/check-doc-freshness.mjs || ok=0; \
	else printf 'docs-check: scripts/check-doc-freshness.mjs is missing.\n'; ok=0; fi; \
	if [ -f scripts/check-links.mjs ]; then node scripts/check-links.mjs || ok=0; \
	else printf 'docs-check: scripts/check-links.mjs is missing.\n'; ok=0; fi; \
	[ $$ok -eq 1 ]

graph: ## Regenerate CODE-GRAPH.md from code-graph.json
	@if [ ! -f scripts/gen-code-graph.mjs ]; then \
		printf 'graph: scripts/gen-code-graph.mjs is missing. CODE-GRAPH.md is generated output\n'; \
		printf '       and must never be hand-edited.\n'; \
		exit 1; \
	fi
	@node scripts/gen-code-graph.mjs
	@printf 'Regenerated CODE-GRAPH.md from code-graph.json\n'

# -----------------------------------------------------------------------------
# Cleanup
# -----------------------------------------------------------------------------

clean: ## Remove build output, caches and coverage
	@rm -rf .turbo coverage test-results playwright-report blob-report sbom
	@find . -type d \( -name dist -o -name .vite -o -name .cache \) -not -path './node_modules/*' -prune -exec rm -rf {} + 2>/dev/null || true
	@find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete 2>/dev/null || true
	@printf 'Removed build output, caches and coverage.\n'

nuke: clean ## clean, plus remove containers, volumes, images and node_modules
	@printf 'This removes local database, object-store and Piston volumes. Data is not recoverable.\n'
	@read -r -p 'Type yes to continue: ' reply; [ "$$reply" = "yes" ] || { printf 'Aborted.\n'; exit 1; }
	@$(COMPOSE) -f $(COMPOSE_DEV) --env-file $(ENV_FILE) down --volumes --remove-orphans --rmi local
	@find . -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true
	@printf 'Removed containers, volumes, local images and node_modules. Re-run: make up && pnpm install\n'
