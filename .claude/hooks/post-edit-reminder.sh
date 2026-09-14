#!/usr/bin/env bash
# PostToolUse hook: after a file is written or edited, name the maintenance rule
# that applies to that path. It reminds; it never blocks. Silent when no rule
# matches, because a hook that always says something is a hook people stop reading.
#
# Input : the tool-call JSON on stdin (we need only tool_input.file_path)
# Output: {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}
# Exit  : always 0. A reminder is never a reason to fail a tool call.
set -u

# Resolve the project root without depending on the caller's working directory.
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "$CLAUDE_PROJECT_DIR" ]; then
  ROOT="$CLAUDE_PROJECT_DIR"
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)" || exit 0
fi

INPUT="$(cat 2>/dev/null || true)"
FILE="$(printf '%s' "$INPUT" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -n "$FILE" ] || exit 0

# Repository-relative path. Anything outside the repo is none of our business.
case "$FILE" in
  "$ROOT"/*) REL="${FILE#"$ROOT"/}" ;;
  /*)        exit 0 ;;
  *)         REL="$FILE" ;;
esac

NOTES=""
add() { if [ -z "$NOTES" ]; then NOTES="$1"; else NOTES="$NOTES\\n$1"; fi; }

case "$REL" in
  apps/*|packages/*)
    add "$REL — if this changed a boundary, a package, a queue or an external dependency, update code-graph.json and run 'node scripts/gen-code-graph.mjs' in this same change. CODE-GRAPH.md is generated; never hand-edit it."
    add "Check the layering rules in CODE-GRAPH.md before adding an import. apps/candidate must not import from apps/web or from anything exposing bank queries or correct-answer flags."
    ;;
esac

case "$REL" in
  code-graph.json)
    add "code-graph.json changed. Run 'node scripts/gen-code-graph.mjs' (make graph) and commit CODE-GRAPH.md alongside it."
    ;;
  apps/api/src/routes/*|packages/contracts/*)
    add "Route or contract change: docs/03-API-spec.md must change in this same pull request, and the OpenAPI document must be regenerated and committed."
    ;;
  packages/auth/*|packages/exec-adapter/*|infra/piston/*|infra/postgres/init/03-rls.sql)
    add "New trust boundary or auth change: docs/14-threat-model.md must be updated in this same pull request."
    ;;
  packages/db/schema/*)
    add "Schema change: docs/hiring_platform_schema.sql and the Drizzle schema are two views of one model and must agree. Retention clocks belong in docs/11-data-retention-and-dpia.md. Migrations are expand-contract only."
    ;;
  packages/observability/*|infra/otel/*|infra/prometheus/*|infra/grafana/*)
    add "Telemetry change: docs/12-observability-and-runbooks.md must be updated. A new alert without a runbook entry wakes someone who then has to work it out at 03:00."
    ;;
  docs/04-ADRs.md)
    add "ADRs changed. Append only — an accepted ADR is superseded, never rewritten. Review .claude/rules/invariants.md in the same change."
    ;;
  docs/*)
    add "Bump '**Last updated:**' in every document you touched, then run 'node scripts/check-doc-freshness.mjs --sync' so docs/DOC-OWNERSHIP.md agrees."
    ;;
  .env.example|docker-compose.yml|docker-compose.prod.yml)
    add "A new environment variable lands in four places at once: .env.example, docker-compose.yml, packages/config (so it fails at boot), and the table in docs/13-environments-and-release.md."
    ;;
  infra/*)
    add "Infrastructure change: infra/README.md and docs/13-environments-and-release.md are triggered by this path. Ports are canonical — api 8080, collab 8081, web 5173/3000, candidate 5174/3001."
    ;;
  .github/workflows/*)
    add "Workflow change: CONTRIBUTING.md and docs/06-testing-strategy.md are triggered by this path."
    ;;
  scripts/check-doc-freshness.mjs)
    add "The freshness gate changed. .claude/rules/doc-maintenance.md describes its behaviour and must stay true to it."
    ;;
  project/TRACKER.md|project/STATUS.md|project/MILESTONES.md)
    add "Tracker, status and milestones move together: a completed item flips in TRACKER.md and is summarised in STATUS.md; a satisfied exit criterion is marked in MILESTONES.md with its date and evidence."
    ;;
  package.json|pnpm-lock.yaml)
    add "Dependency change: run 'node scripts/check-licences.mjs'. Permitted licences are MIT, Apache-2.0, BSD-2, BSD-3, ISC, MPL-2.0, PostgreSQL, Unlicense, CC0 — nothing else, including transitively (ADR-001)."
    ;;
esac

[ -n "$NOTES" ] || exit 0

printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Repository maintenance rules for %s:\\n%s\\nSee .claude/rules/doc-maintenance.md."}}\n' "$REL" "$NOTES"
exit 0
