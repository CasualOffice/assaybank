#!/usr/bin/env bash
# Stop hook: run the two gates that are armed today and surface the result.
#
#   node scripts/check-doc-freshness.mjs     registration, metadata, age, index coverage
#   node scripts/gen-code-graph.mjs --check  CODE-GRAPH.md in sync with code-graph.json
#
# It never blocks. A Stop hook that refuses to let the session end is a trap: the
# user cannot leave and the agent cannot always fix what it does not understand.
# So this always exits 0 and reports through "systemMessage". Silent on success.
#
# Exit: always 0.
set -u

if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "$CLAUDE_PROJECT_DIR" ]; then
  ROOT="$CLAUDE_PROJECT_DIR"
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)" || exit 0
fi
cd "$ROOT" 2>/dev/null || exit 0

command -v node >/dev/null 2>&1 || exit 0
[ -f scripts/check-doc-freshness.mjs ] || exit 0

REPORT=""

# Keep the message to the first few lines of a failing report. The full detail is
# one command away, and a wall of text in a hook message is not read.
run_gate() {
  label="$1"; shift
  out="$("$@" 2>&1)"
  if [ $? -ne 0 ]; then
    summary="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | head -n 6)"
    REPORT="${REPORT}
${label} FAILED:
${summary}"
  fi
}

run_gate "doc freshness — node scripts/check-doc-freshness.mjs" node scripts/check-doc-freshness.mjs
if [ -f scripts/gen-code-graph.mjs ]; then
  run_gate "code graph — node scripts/gen-code-graph.mjs --check" node scripts/gen-code-graph.mjs --check
fi

[ -n "$REPORT" ] || exit 0

# JSON-encode via node rather than escaping by hand in shell; the report contains
# quotes, newlines and em dashes, and hand-rolled escaping gets one of them wrong.
MESSAGE="Repository gates are failing. Fix these before opening a pull request.${REPORT}"
printf '%s' "$MESSAGE" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: false, systemMessage: s }) + "\n");
  });
' 2>/dev/null
exit 0
