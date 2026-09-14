#!/usr/bin/env sh
# ---------------------------------------------------------------------------
# install-runtimes.sh — install the language matrix from packages.json into a
# running Piston instance.
#
# ACTIVATES: M2 (2026-11-02 → 2026-11-27). Runnable today against the dev
# stack; nothing calls Piston until M2.
#
# Development:
#     docker compose up -d piston
#     docker compose exec piston sh /piston/install-runtimes.sh
#   or, from the host with the port temporarily published:
#     PISTON_URL=http://localhost:2000 ./infra/piston/install-runtimes.sh
#
# Production: this script runs at IMAGE BUILD TIME, not at boot. An exec node
# has no egress (docker-compose.prod.yml), so it cannot fetch a runtime even if
# it wanted to. Baking the matrix in is what makes the no-egress rule
# survivable. See README.md in this directory.
#
# Exit codes: 0 all requested runtimes present; 1 one or more failed.
# ---------------------------------------------------------------------------
set -eu

PISTON_URL="${PISTON_URL:-http://localhost:2000}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGES_FILE="${PACKAGES_FILE:-$HERE/packages.json}"
RESOLVED_FILE="${RESOLVED_FILE:-$HERE/resolved-runtimes.json}"

need() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "error: $1 is required and not on PATH" >&2
        exit 1
    }
}
need curl
need jq

echo "Piston endpoint: $PISTON_URL"
echo "Package list:    $PACKAGES_FILE"

# ---------------------------------------------------------------------------
# Wait for Piston. A fresh container spends a while setting up its overlay
# before it answers, and failing here because we asked too early would send
# someone debugging the wrong problem.
# ---------------------------------------------------------------------------
attempt=0
until curl -fsS "$PISTON_URL/api/v2/runtimes" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
        echo "error: Piston did not become ready within 120s" >&2
        exit 1
    fi
    printf '.'
    sleep 2
done
echo
echo "Piston is up."

# ---------------------------------------------------------------------------
# Install each runtime. Piston's package install is idempotent: asking for a
# version that is already present returns success, so a re-run is a no-op and
# a partially-failed run can simply be repeated.
# ---------------------------------------------------------------------------
failed=""
count=0

jq -r '.runtimes[] | "\(.language)\t\(.version)\t\(.role)"' "$PACKAGES_FILE" |
while IFS="$(printf '\t')" read -r language version role; do
    count=$((count + 1))
    printf '[%s] %s %s ... ' "$role" "$language" "$version"

    response="$(
        curl -fsS -X POST "$PISTON_URL/api/v2/packages" \
             -H 'Content-Type: application/json' \
             -d "$(jq -nc --arg l "$language" --arg v "$version" \
                     '{language: $l, version: $v}')" 2>&1
    )" || {
        echo "FAILED"
        echo "    $response" >&2
        failed="$failed $language@$version"
        continue
    }

    echo "ok"
done

# ---------------------------------------------------------------------------
# Record what actually got installed.
#
# packages.json holds targets; this file holds facts. A grading result is only
# reproducible against the exact patch version that produced it, so the
# resolved matrix is an artefact worth keeping and worth attaching to a
# release. CI compares it between builds and fails on an unannounced change.
# ---------------------------------------------------------------------------
curl -fsS "$PISTON_URL/api/v2/runtimes" |
    jq --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       '{resolvedAt: $at, runtimes: [.[] | {language, version, aliases}]}' \
    > "$RESOLVED_FILE"

echo
echo "Resolved matrix written to $RESOLVED_FILE"
jq -r '.runtimes[] | "  \(.language) \(.version)"' "$RESOLVED_FILE"

# ---------------------------------------------------------------------------
# Verify every requested language is present. An install that silently skipped
# a language would surface as a candidate being told their chosen language is
# unavailable, mid-assessment. Better to fail the build.
# ---------------------------------------------------------------------------
missing="$(
    jq -r --slurpfile resolved "$RESOLVED_FILE" '
        [.runtimes[].language] as $want
        | [$resolved[0].runtimes[].language] as $have
        | ($want - $have) | .[]
    ' "$PACKAGES_FILE"
)"

if [ -n "$missing" ]; then
    echo >&2
    echo "error: requested languages missing from the installed matrix:" >&2
    echo "$missing" | sed 's/^/  /' >&2
    exit 1
fi

echo "All requested languages present."
