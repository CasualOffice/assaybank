# Rule: domain invariants

**Status:** draft
**Owner:** _unassigned_ (engineering lead)
**Last updated:** 2026-09-20
**Companion docs:** [`../../docs/04-ADRs.md`](../../docs/04-ADRs.md), [`../../docs/06-testing-strategy.md`](../../docs/06-testing-strategy.md), [`doc-maintenance.md`](doc-maintenance.md), [`review-checklist.md`](review-checklist.md)

---

Eighteen statements that must be true of this system at every moment. Each comes from a decision that is expensive to reverse, and each is guarded by a test that is release-blocking rather than advisory. Nothing here is a preference, a style, or a thing we currently happen to do.

Most are not built yet — the guarding tests are specified in [`docs/06-testing-strategy.md`](../../docs/06-testing-strategy.md) and land with the milestone named in the last column. What the table records is the obligation, so that the test arrives with the code rather than after it. A row whose Lands column names a date is one whose guard exists today and is running.

## Content and scoring

| # | Invariant | From | Guarded by | Lands |
|---|---|---|---|---|
| 1 | A `question_version` with `status = published` is never mutated. Editing produces a new version; the old row is byte-identical to what was served. | ADR-003 | Database rule plus an integration test asserting that an update to a published version is rejected, and a re-grade test that replays a historical attempt against its stored version | M0 |
| 2 | The question set served to an attempt — including option shuffle order — is materialised at attempt start and read back verbatim. It is never recomputed. | ADR-004 | Concurrency test §11.1 (N clients starting the same attempt produce one set) plus the re-grade determinism test §8.3 | M1 |
| 3 | A re-grade of an unchanged attempt against an unchanged version produces an identical score, to the bit. | ADR-003, HLD §1 | The golden corpus §8.2 and the re-grade test §8.3; every collection feeding a score is explicitly sorted, every grading query carries a total order | M2 |
| 4 | No model, heuristic or inference produces or influences a score, a ranking, a recommendation or an advance/reject decision. | ADR-011, ADR-017 | `packages/grading` and `packages/core-domain` are pure and perform no I/O — a structural test asserts no network or filesystem import reaches them; reviewed against [`docs/16-ai-usage-policy.md`](../../docs/16-ai-usage-policy.md) | M1 |
| 5 | The attempt state machine advances only along its declared edges. There is no path that sets a terminal status from outside the machine. | API spec §6 | Table-driven state-machine tests §4.2 covering every legal edge and rejecting every illegal one | M1 |
| 18 | Author-supplied markdown becomes React elements through `packages/markdown` and `packages/ui`'s `Markdown`, and never a string of HTML. No source in `packages/ui`, `apps/web` or `apps/candidate` assigns HTML from a string, no workspace depends on a markdown or HTML-sanitising library, and a link or image destination is kept only when `safeUrl` accepts its scheme. | ADR-022, docs/14 T-038 | `packages/markdown/src/xss-corpus.test.ts` — the payload corpus, checked against the browser's own URL parser rather than a regex of ours — and `tests/fixtures/no-inner-html.test.ts`, which asserts the two structural facts the argument rests on | M0 — built 2026-09-20 |

## Integrity and isolation

| # | Invariant | From | Guarded by | Lands |
|---|---|---|---|---|
| 6 | A proctoring signal never changes a score, an attempt status, or an advance/reject outcome. It raises a flag and attaches evidence for a human. | ADR-007 | The standing ADR-007 test (task H-098), release-blocking: the proctor path writes only `proctor_events` and `attempts.integrity_flag`, and nothing else | M4 |
| 7 | `is_correct`, `rationale_md`, `solution_code`, hidden `expected_stdout` and hidden-case `stdin` never reach a candidate-scoped response — including error bodies, SSE frames and WebSocket awareness payloads. | HLD §1, FR-13 | The leak suite §7: sentinel fixtures, four independent assertions, and the registry gate §7.4 that fails when a new candidate-facing surface is added without being covered | M1 |
| 8 | Every tenant-scoped table carries `org_id` and an RLS policy. `app.current_org` is set per connection; application-level filtering is never the only defence. | ADR-010 | The generated RLS negative matrix §5.3 — for every table, a session scoped to org A reads, updates and deletes zero org B rows | M0 |
| 9 | `apps/api` is the only writer of domain tables, except where a worker's table ownership is recorded explicitly in `code-graph.json`. | CLAUDE.md repo map, ADR-010 | Database grants per role plus an integration test asserting the background-job role cannot write outside its declared tables | M0 |
| 10 | The payload handed to `packages/exec-adapter` contains no question id, no attempt id and no expected output. A sandbox escape therefore teaches the attacker nothing about the hidden cases. | HLD §3.2, ADR-002 | Structural assertion, task H-066: the execution node holds no secrets, no database credentials and no cloud role, verified by enumerating the sandbox environment and filesystem against an allow-list | M2 |
| 11 | Candidate attempt tokens, staff sessions and WebSocket tickets are separate credential domains and never interchangeable. | API spec §1 | Negative tests in `packages/auth`: each credential type is rejected on every surface it does not belong to | M1 |

## Time, jobs and data

| # | Invariant | From | Guarded by | Lands |
|---|---|---|---|---|
| 12 | Deadlines are computed server-side at attempt start and enforced server-side at every write. A client-supplied timestamp is display data. | ADR-006 | The injectable-clock suite §10, including the accommodation case (`extra_time_pct` 25% recorded at start and present in the audit log) | M1 |
| 13 | A grading job is idempotent by its natural key. A replayed job produces the same result rather than a second one. | ADR-008, HLD §1 | §9.1 — the same submission id enqueued twice produces one result row and one score | M2 |
| 14 | An exhausted grading job never finalises a candidate at whatever score it has. It moves the attempt to `under_review` and alerts. | ADR-008, HLD §9 | Integration test driving a job past `QUEUE_MAX_ATTEMPTS` and asserting the attempt is `under_review`, not `finalised` | M2 |
| 15 | Migrations are expand-contract across separate deploys. No single migration both adds and destroys. | HLD §10 | Migration test from the previous release against a database with an exam window open; a destructive step in one file fails review | M0 |
| 16 | Every timestamp column is `timestamptz` stored in UTC and serialised as RFC 3339. Every id is an application-generated UUIDv4. | CLAUDE.md conventions | Schema assertion over `information_schema` in the migration test suite | M0 |
| 17 | A bank import writes each item at most once. Its checkpoint advances in the transaction that writes the item, and a retried job resumes at the checkpoint; a request's job row and its audit row commit together, and nothing is enqueued outside that commit. | ADR-021 | `apps/worker/test/integration/bank-job.integration.test.ts` — a job with a checkpoint of 3 writes only the remaining items, checked by mutation to fail when the checkpoint is ignored | M0 — built 2026-09-17 |

## When your change appears to need an exception

Invariants 6 and 4 — no automated rejection, and no AI in the scoring or decision path — are product constraints with legal exposure attached. They are not reviewer judgement calls. A change that needs either softened requires a new ADR that supersedes ADR-007 or ADR-011 and a conversation with counsel, recorded in [`project/RISKS.md`](../../project/RISKS.md) as R-17. A reviewer who is asked to approve one of these anyway should decline and escalate.

For the remaining sixteen: the exception process is an ADR, not a comment. Write down the context, the decision, the consequences and what would make you revisit it, append it to [`docs/04-ADRs.md`](../../docs/04-ADRs.md), and update this file in the same change — the registry in [`docs/DOC-OWNERSHIP.md`](../../docs/DOC-OWNERSHIP.md) makes any ADR edit fire the trigger that brings you back here. If the invariant survives, say so in the ADR's consequences; the useful record is what we considered, not only what we chose.
