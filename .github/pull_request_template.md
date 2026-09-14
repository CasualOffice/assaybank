<!--
Title format: <type>(<scope>): <summary> [H-NNN]   e.g. feat(core-domain): materialise option shuffle order at attempt start [H-041]
The full definition of done is project/DEFINITION-OF-DONE.md. This template is that
document as a checklist. Delete the sections that do not apply; do not delete the
base checklist or the four questions.
-->

**Tracker id:** H-
**Milestone:** M
**Type:** feat / fix / docs / refactor / test / chore / perf / build / ci / revert

## What this changes

<!-- One paragraph. What behaviour is different after this merges, and for whom. -->

## Why

<!-- The problem, not the solution. Link the FR, ADR, milestone exit criterion or
     risk this traces to. A change with no reference is either missing its reference
     or is work the project did not agree to do. -->

---

## The four questions

Answer all four in prose. "No" is a perfectly good answer; an unanswered one is not.

**1. Does this need an ADR?** Would undoing it in three months require a data migration, a re-grade of historical attempts, a dependency swap, or a conversation with legal? If yes, the ADR is appended to `docs/04-ADRs.md` in this pull request and linked here. No accepted ADR has been edited in place.

> 

**2. Can any candidate see something they must not?** `is_correct`, `rationale_md`, `solution_code`, hidden `expected_stdout`, hidden-case `stdin`, another candidate's answer — in a response body, an error body, an SSE frame, a WebSocket awareness payload, a log line or a source map. Say what you checked, not that you checked.

> 

**3. Does this include a migration?** If yes: it is expand-contract, expand and contract are separate migrations in separate deploys, every new tenant table has `org_id` and an RLS policy with a negative test, and the rollback position is stated. Never break a running exam window.

> 

**4. Which documents did this make wrong, and are they fixed here?** Name them. `node scripts/check-doc-freshness.mjs --changed …` enforces the trigger rules, but no gate can tell whether the updated text is true.

> 

---

## Base checklist — every change

- [ ] Tests at the right level; a bug fix carries a test that fails without the fix (`docs/06-testing-strategy.md`)
- [ ] `make lint typecheck` clean
- [ ] Docs updated and `**Last updated:**` bumped on every document touched; `node scripts/check-doc-freshness.mjs` passes
- [ ] `node scripts/check-links.mjs` passes
- [ ] `code-graph.json` updated and `make graph` re-run if a boundary, package, queue or external dependency changed — `CODE-GRAPH.md` was regenerated, never hand-edited
- [ ] `project/TRACKER.md` status flipped in this pull request, and `project/STATUS.md` updated
- [ ] `project/MILESTONES.md` updated if an exit criterion was met, with the date and the evidence
- [ ] Any answered question removed from `project/OPEN-QUESTIONS.md` and written into the document that owns the subject
- [ ] Licence gate green (`node scripts/check-licences.mjs`)
- [ ] No candidate-visible leak of hidden content — filtered in the serialisation layer, not the client
- [ ] Accessibility checked for candidate-facing UI: keyboard-only path, axe clean of serious and critical, no colour-only information
- [ ] Audit-log entry for any privileged action (score change, void, expire, publish, retire, permission grant, token issue, export)
- [ ] Observability for any new async path: at least one metric or span, trace id propagated, reachable from a dashboard

## Schema change

- [ ] Expand-contract, in separate migrations
- [ ] RLS policy on every new tenant table, with a negative test proving org A reads zero org B rows on select, update and delete
- [ ] Indexes considered, `org_id` leading any composite index a policy predicate uses
- [ ] `EXPLAIN` captured with RLS enabled and compared against the M0 baseline
- [ ] Drizzle schema and `docs/hiring_platform_schema.sql` still agree
- [ ] Retention clock and sweep for any new column holding candidate PII or media

## API change

- [ ] zod schema in `packages/contracts` updated, OpenAPI 3.1 regenerated and committed
- [ ] Error codes are stable strings from the documented union; clients branch on `code`, never `message`
- [ ] `Idempotency-Key` honoured on mutating endpoints, returning the original response on replay
- [ ] List endpoints cursor-paginated, returning `{data[], next_cursor}`
- [ ] `server_time` present on any response a client might time against
- [ ] Permission checked per action, never by role name
- [ ] Rate-limit scope decided, or explicitly recorded as unlimited with the reason
- [ ] Breaking change handled additively first: add, deprecate, then remove
- [ ] `docs/03-API-spec.md` updated in this pull request

## Candidate-facing UI change

- [ ] Keyboard-only run through the changed flow, by a person
- [ ] Screen-reader pass on anything rendering question content or reporting state
- [ ] Last two versions of Chrome, Firefox, Safari and Edge
- [ ] No work is lost: autosave within 5 seconds, local buffering, replay on reconnect, save state visible to the candidate
- [ ] Countdown derived from `server_time`, never the local clock
- [ ] Ships from `apps/candidate`; no staff-only code, correct-answer flags or bank access in the candidate build
- [ ] Copy is comprehensible to a nervous candidate under time pressure

## New dependency

- [ ] Licence is MIT, Apache-2.0, BSD-2, BSD-3, ISC, MPL-2.0, PostgreSQL, Unlicense or CC0 — checked transitively
- [ ] Not MinIO (AGPL-3.0) and not Redis above 7.2 (RSALv2/SSPL); SeaweedFS and Valkey 8 are the answers here
- [ ] What it does, and what writing it ourselves would cost, stated below. "It was the first result" is not a justification
- [ ] Pinned; container images pinned by digest
- [ ] SBOM regenerates cleanly

> 

## New async job

- [ ] Idempotent by its natural key — a replayed job produces the same result
- [ ] Retry bounded by `QUEUE_MAX_ATTEMPTS` with backoff and a dead-letter destination
- [ ] The failure path never silently scores a candidate zero: an exhausted job moves the attempt to `under_review` and alerts
- [ ] Queue depth, job duration and failure count exposed as metrics, with an alert on a non-empty dead-letter queue
- [ ] Trace id propagated from request through queue into job and any execution call
- [ ] Runs under the background-job database role
- [ ] Runbook entry in `docs/12-observability-and-runbooks.md`

## New environment variable

- [ ] `.env.example`
- [ ] `docker-compose.yml`
- [ ] `packages/config`, so a missing or malformed value fails at boot
- [ ] The table in `docs/13-environments-and-release.md`

---

## The two that are never negotiable

- [ ] **No automated rejection.** Nothing here lets a proctoring signal, heuristic or threshold change a score, an attempt status, or an advance/reject decision (ADR-007).
- [ ] **No AI in the scoring or decision path.** No model produces, ranks, adjusts or recommends an outcome (ADR-011).

If this change appears to require softening either, stop: that is a product decision needing an ADR that supersedes the existing one and a conversation with legal, not a reviewer's judgement call. See `project/RISKS.md` R-17.
