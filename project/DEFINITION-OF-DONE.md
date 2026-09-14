# Definition of done

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-15
**Companion docs:** [`TRACKER.md`](TRACKER.md), [`MILESTONES.md`](MILESTONES.md), [`GLOSSARY.md`](GLOSSARY.md), [`../docs/06-testing-strategy.md`](../docs/06-testing-strategy.md), [`../docs/04-ADRs.md`](../docs/04-ADRs.md)

---

"Done" means merged to the default branch and satisfying the base checklist below, plus every applicable sub-checklist. It does not mean the code works locally, and it does not mean the pull request is approved. A task whose tracker row says `done` must be something another engineer can rely on without asking.

The list is short on purpose. Every item on it exists because the alternative is a specific, recoverable-but-expensive failure named in the design docs. Nothing is here as a formality.

## Base checklist — every change

- [ ] **Tests at the right level.** Pure logic (rule resolution, scoring, skill roll-up) is unit-tested with no database. Anything crossing a process boundary — RLS, queue, execution, SSE, WebSocket — has an integration test against the real dependency in the dev stack. A change to candidate-visible behaviour has an end-to-end test. A bug fix carries a test that fails without the fix. See [`../docs/06-testing-strategy.md`](../docs/06-testing-strategy.md) for what belongs where.
- [ ] **Docs updated, `Last updated` bumped.** If the change contradicts a sentence in `docs/`, the sentence changes in the same pull request. Every touched doc has its metadata date bumped, and `node scripts/check-doc-freshness.mjs` passes.
- [ ] **`code-graph.json` regenerated if structure changed.** New package, new app, moved module, changed dependency edge — run `node scripts/gen-code-graph.mjs` and commit the result. A stale graph is worse than none, because people trust it.
- [ ] **`TRACKER.md` status flipped in the same pull request.** `todo` → `in-progress` on the first commit, → `done` on the merge commit. A separate tracker-maintenance commit is how the tracker becomes fiction.
- [ ] **ADR added if the decision is expensive to reverse.** The test: would undoing this in three months require a data migration, a re-grade of historical attempts, a dependency swap, or a conversation with legal? If yes, append an ADR to [`../docs/04-ADRs.md`](../docs/04-ADRs.md) stating context, decision, consequences and reversal conditions. Retro-fitting an ADR later means the reasoning is already lost.
- [ ] **Migration is expand-contract.** Add nullable, backfill, switch reads, drop old — across separate deploys. Never a single destructive step. HLD §10: *"Never break a running exam window."*
- [ ] **Licence gate green.** `node scripts/check-licences.mjs` passes, including transitive dependencies (ADR-001).
- [ ] **No candidate-visible leak of hidden content.** `is_correct`, `rationale_md`, `solution_code`, hidden `expected_stdout` and hidden-case `stdin` never reach a candidate-facing response — including error bodies, SSE frames and WebSocket awareness payloads. Filtering happens in the serialisation layer, not in the client. HLD §1: *"Nothing the candidate must not see ever reaches the client."*
- [ ] **Accessibility check for candidate-facing UI.** Keyboard-only path works, axe reports no serious or critical violations, no information conveyed by colour alone, focus order is sensible. WCAG 2.1 AA is an NFR for the candidate experience, and PRD §8 explains why it is not a backlog item.
- [ ] **Audit-log entry for privileged actions.** Any action that changes a score, voids or expires an attempt, publishes or retires a question, grants a permission, issues or revokes a token, or exports data writes an append-only `audit_log` row naming the actor, the entity and — where the API requires one — the reason.
- [ ] **Observability for new async paths.** A new job, queue, sweep, stream or external call ships with at least one metric or span, and is reachable from a dashboard. HLD §8: debugging *"why did this candidate's score differ on re-grade"* is impossible without a trace id propagated through the queue into the worker.

---

## Schema change

Additional to the base checklist.

- [ ] Migration is reversible, or the pull request states explicitly why it is not and what the recovery path is.
- [ ] Expand and contract are separate migrations in separate deploys — never one file that adds and drops.
- [ ] **RLS policy present on any new tenant-scoped table**, plus a negative test proving a session scoped to org A reads zero org B rows on select, update and delete (FR-26, ADR-010).
- [ ] Indexes considered for the new access path, with `org_id` leading any composite index that a policy predicate will use.
- [ ] `EXPLAIN` captured with RLS enabled and compared against the M0 baseline, so plan degradation is caught here rather than under load (R-09).
- [ ] The Drizzle schema and [`../docs/hiring_platform_schema.sql`](../docs/hiring_platform_schema.sql) still agree. They are two views of one model; a divergence means nobody can trust either.
- [ ] High-volume tables (`session_events`, `proctor_events`) are partitioned by month, per HLD §3.5.
- [ ] Retention: any new column holding candidate PII or media has a retention clock and a sweep that enforces it in code (FR-28).

## API change

- [ ] zod schema in `packages/contracts` updated, OpenAPI 3.1 regenerated and committed.
- [ ] Error codes are stable strings from the documented union. Clients branch on `code`, never on `message` — a new failure mode means a new code, not a new sentence.
- [ ] Mutating endpoints accept `Idempotency-Key` and return the original response on replay.
- [ ] List endpoints are cursor-paginated and return `{data[], next_cursor}`.
- [ ] `server_time` present on every response that a client might time against (ADR-006).
- [ ] Permission checked per action, resolved from `user_role_permissions`, never by role name (FR-27).
- [ ] Rate-limit scope decided and applied, or explicitly recorded as unlimited with the reason.
- [ ] Breaking changes: additive first, deprecate, then remove — the same discipline as expand-contract, applied to consumers instead of data.
- [ ] [`../docs/03-API-spec.md`](../docs/03-API-spec.md) updated in the same pull request.

## Candidate-facing UI change

- [ ] Keyboard-only run through the changed flow, by a person, not only by axe.
- [ ] Screen-reader pass on anything that renders question content or reports state.
- [ ] Works on the last two versions of Chrome, Firefox, Safari and Edge (PRD §8).
- [ ] **No work is lost.** Any input path autosaves within 5 seconds, buffers locally, and replays on reconnect. The save state is visible to the candidate — saved, saving, retrying — never an optimistic tick (FR-9, R-15).
- [ ] Countdown derived from `server_time`, never from the local clock (FR-8, ADR-006).
- [ ] The bundle ships from `apps/candidate`. No staff-only code, no correct-answer flags, no question-bank access reaches the candidate build.
- [ ] Copy is comprehensible to a nervous candidate under time pressure. "Grading in progress" beats a spinner; "your work is saved" beats silence.

## New dependency

- [ ] Licence is MIT, Apache-2.0, BSD-2, BSD-3, ISC, MPL-2.0, PostgreSQL, Unlicense or CC0 — checked for the package **and its transitive tree** (ADR-001).
- [ ] Not on the prohibited list: GPL, LGPL where static linking applies, AGPL, SSPL, BSL/BUSL, Commons Clause, source-available, or anything with a field-of-use restriction.
- [ ] Specifically checked against the two named traps in [`../docs/05-licensing-and-compliance.md`](../docs/05-licensing-and-compliance.md) §1: an S3-compatible store that turns out to be MinIO (AGPL-3.0), and a Redis image newer than 7.2 (RSALv2/SSPL). SeaweedFS and Valkey 8 are the canonical answers here (R-08).
- [ ] The pull request says what the dependency does and what writing it ourselves would cost. "It was the first result" is not a justification.
- [ ] Pinned. Runtime and container images pinned by digest, not by tag.
- [ ] SBOM regenerates cleanly.

## New async job

- [ ] **Idempotent by its natural key** — submission id, attempt id, event id. A replayed job produces the same result. HLD §1: *"A replayed grading job must produce the same score."*
- [ ] Retry policy bounded by `QUEUE_MAX_ATTEMPTS` with backoff, and a dead-letter destination.
- [ ] **The failure path never silently scores a candidate zero.** An exhausted job moves the attempt to `under_review` and alerts; it does not finalise with whatever it has. This is the one invariant HLD §9 calls out by name.
- [ ] Queue depth, job duration and failure count exposed as metrics, with an alert on the dead-letter queue becoming non-empty.
- [ ] Trace id propagated from the originating request through the queue into the job and any downstream execution call.
- [ ] Runs under the elevated background-job database role, whose actions are separately audited (ADR-010).
- [ ] A runbook entry exists in [`../docs/12-observability-and-runbooks.md`](../docs/12-observability-and-runbooks.md): what the alert means, what to check, what to do. An alert with no runbook wakes someone who then has to work it out at 03:00.

---

## The two that are never negotiable

Two items above are product constraints rather than engineering standards, and no delivery pressure justifies waiving them.

**No automated rejection.** Proctoring signals are advisory. Nothing in the codebase may let a signal, heuristic or model alter a score, an attempt status, or an advance/reject decision. A release-blocking test asserts this (ADR-007, FR-23, task H-098).

**No AI in the scoring or decision path.** Question drafting assistance with a human publisher, and recording a candidate's own AI usage as evidence, are permitted. Anything that produces or influences a score is not (ADR-011).

If a change appears to require softening either, it is a product decision needing an ADR that supersedes the existing one and a conversation with legal — not a reviewer's judgement call. See R-17.
