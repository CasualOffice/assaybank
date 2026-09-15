# Testing strategy

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-15
**Companion docs:** [`01-PRD.md`](01-PRD.md), [`02-HLD.md`](02-HLD.md), [`03-API-spec.md`](03-API-spec.md), [`04-ADRs.md`](04-ADRs.md), [`07-load-and-capacity-testing.md`](07-load-and-capacity-testing.md), [`12-observability-and-runbooks.md`](12-observability-and-runbooks.md), [`13-environments-and-release.md`](13-environments-and-release.md), [`15-accessibility-conformance.md`](15-accessibility-conformance.md), [`../project/DEFINITION-OF-DONE.md`](../project/DEFINITION-OF-DONE.md), [`../project/MILESTONES.md`](../project/MILESTONES.md)

---

No test described in this document has been written. The repository is documentation only. Everything below is a specification of suites to build, and every suite names the milestone that delivers it and the requirement it defends.

## 1. What a failing test protects here

Most software fails in ways the user can retry. This system fails in ways a candidate cannot. A wrong score is not a defect the candidate can work around by refreshing; it is a rejection they will never know was unjustified, produced by a machine, in a regulated decision category. That asymmetry is the whole argument of this document and it changes what gets tested and how hard.

Four failure classes carry the asymmetry, and they set the priorities for everything that follows.

| Failure class | What it looks like in production | Who notices | Cost |
|---|---|---|---|
| **Silent mis-scoring** | A weighted sum rounds the wrong way, a partial-credit rule drops a mark, a re-grade produces a different number | Nobody, unless a candidate disputes | A rejection that cannot be defended, and every prior score is now suspect |
| **Leakage** | `is_correct`, a reference solution, a hidden test case, or another candidate's answer reaches a candidate-scoped response | Nobody, until the question bank is worthless | Bank compromise plus a cohort of scores that measured nothing |
| **Lost work** | Autosave fails quietly while the UI shows saved state | The candidate, at submit, with no recourse | An understated score, visibly our fault, unrecoverable (R-15) |
| **Time errors** | A deadline is enforced from the wrong clock, an accommodation is not applied, a sweep expires an attempt early | The candidate, mid-exam | An accommodation failure is a discrimination exposure, not a bug |

Everything else — a 500 on a report export, a broken filter in the staff console — is an ordinary defect with ordinary urgency. Test budget follows that distinction rather than following code volume. Section 17 states coverage in those terms.

Two product constraints are also test subjects rather than review conventions, because a constraint nobody tests is a constraint that erodes under delivery pressure (R-17):

- **ADR-007** — no code path lets a proctoring signal change a score, void an attempt, alter attempt status, or reject a candidate. Proved by a standing test (task H-098), release-blocking.
- **ADR-011** — no model output enters the scoring or decision path. Proved by a dependency and import gate described in [`16-ai-usage-policy.md`](16-ai-usage-policy.md) and asserted in the same suite.

## 2. The pyramid, and the three places this system inverts it

The classical pyramid — many unit tests, fewer integration tests, a handful of end-to-end tests — holds for most of this codebase and should not be argued with. The domain core is genuinely pure, so it is cheap to test exhaustively at the bottom, and Playwright runs are slow and brittle, so they stay few and load-bearing.

```
                     /\
                    /  \        E2E (Playwright)          ~5 journeys, ~8 min
                   /----\
                  /      \      Contract (generated)      1 per endpoint, ~2 min
                 /--------\
                /          \    Integration (containers)  ~250 tests, ~6 min
               /------------\
              /              \  Unit (pure, in-process)   ~1200 tests, < 40 s
             /----------------\

    Standing suites that do not sit on this pyramid:

    [ leak suite ]        exhaustive over every candidate-scoped route x every surface
    [ determinism ]       whole-pipeline replay against a golden corpus
    [ sandbox security ]  5 attacks, real Piston, real kernel limits, no mocks
```

The three inversions are deliberate and each has a reason the pyramid cannot express.

**The leak suite is exhaustive, not sampled.** Normal integration testing samples: test the interesting handlers, trust the rest. Leakage does not fail on the interesting handler; it fails on the one route someone added on a Friday that serialises a question version with the default serialiser. So the leak suite enumerates every candidate-scoped route from the route registry and asserts against all of them, and a route without leak coverage fails CI rather than passing silently. Breadth is the point; depth is not.

**Sandbox security tests run against real infrastructure.** They are few — five attacks — and they are the most expensive tests in the repository, requiring a real Piston with real cgroup limits and a real network policy. Mocking them proves nothing at all, because what is under test *is* the kernel configuration. They therefore live at the top of the cost curve while sitting at the bottom of the pyramid by count.

**Determinism is tested as a whole-pipeline replay.** Reproducibility is not a property of any one function; it is a property of the composition of the draw, the serialisation, the execution, the comparison, and the rounding. A unit test on `computeScore` cannot catch a re-grade that differs because the worker read test cases in a different order. So the determinism suite runs the real pipeline twice over a fixed corpus and compares outputs byte for byte (section 8).

| Layer | Runs against | Speed budget | Milestone | Gate |
|---|---|---|---|---|
| Unit | Nothing. Pure functions, no clock, no I/O | < 40 s whole suite | M0 | Pre-commit and PR |
| Integration | Real Postgres 16 and Valkey 8 in testcontainers | < 6 min | M0 | PR |
| Contract | The generated OpenAPI document and the running API | < 2 min | M0 | PR |
| Leak | Running API, real database, real SSE | < 3 min | M1 | PR, release-blocking |
| Determinism | Full grading pipeline over the golden corpus | < 10 min | M1 | PR for the corpus, nightly in full |
| E2E | Built apps in Chromium, Firefox, WebKit | < 8 min per browser | M1 | PR on Chromium, nightly on all three |
| Sandbox security | Real Piston on an execution node | < 5 min | M2 | Nightly and pre-release |
| Accessibility | Built candidate app plus axe-core | < 3 min | M1 | PR; manual pass per release |
| Load | Staging with production-shaped data | 20 min to 4 h | M1 | Pre-release and per [`07-load-and-capacity-testing.md`](07-load-and-capacity-testing.md) |

## 3. Tooling and layout

Every tool below is permissively licensed and passes the gate in [`05-licensing-and-compliance.md`](05-licensing-and-compliance.md) §1. A test tool is still a dependency in `pnpm-lock.yaml` and still fails the build if its licence is prohibited.

| Concern | Tool | Licence | Why this one |
|---|---|---|---|
| Unit and integration runner | Vitest | MIT | Native TypeScript and ESM, no separate transform step, parallel worker pools that map cleanly onto one container per worker |
| HTTP-level API tests | `fastify.inject()` (light-my-request) | BSD-3 | Exercises the real routing, hooks and serialisers without binding a port, so tests stay parallel-safe |
| Containers | Testcontainers for Node | MIT | Postgres and Valkey at the exact production versions, torn down deterministically |
| Property-based tests | fast-check | MIT | Invariants over generated inputs where the input space is larger than a table (section 4.7) |
| Browser E2E | Playwright | Apache-2.0 | Three engines from one API, trace viewer, first-class network interception for offline simulation |
| Accessibility | axe-core plus `@axe-core/playwright` | MPL-2.0 | MPL-2.0 is permitted; axe is the de-facto rule set that [`15-accessibility-conformance.md`](15-accessibility-conformance.md) maps to |
| Load | k6 | see [`07-load-and-capacity-testing.md`](07-load-and-capacity-testing.md) §4 | Licence position is stated there, not assumed here |
| Fixture data | `@faker-js/faker` with a pinned seed | MIT | Deterministic when seeded; unseeded use is prohibited (section 15) |

**Prohibited in tests.** No network calls to anything outside the compose network. No `Date.now()` (section 10). No unseeded randomness. No `sleep`-based synchronisation in integration tests — wait on a condition with a bounded timeout, because a `sleep` that passes on a laptop is a flake on a loaded runner. No snapshot assertions over whole response bodies in the leak suite; snapshots record what the code does, and the leak suite must assert what the code must never do.

**Layout.** Tests live next to what they test, except where the target is a cross-cutting property.

```
packages/core-domain/src/attempt-state.test.ts        colocated unit
packages/grading/src/compare.test.ts                  colocated unit
packages/db/test/rls/*.test.ts                        RLS matrix, needs containers
apps/api/test/integration/*.test.ts                   routes against real dependencies
apps/api/test/contract/*.test.ts                      generated from packages/contracts
apps/api/test/leak/*.test.ts                          the standing leak suite
apps/worker/test/determinism/*.test.ts                golden-corpus replay
apps/worker/test/idempotency/*.test.ts                job replay
apps/candidate/e2e/*.spec.ts                          Playwright, candidate journeys
apps/web/e2e/*.spec.ts                                Playwright, staff journeys
infra/piston/test/*.test.ts                           sandbox attacks, real Piston
playwright.config.ts                                  root config, one project per app
```

Reports land at the repository root (`test-results/`, `playwright-report/`, `coverage/`) because `make clean` removes them there, and all four are ignored by git.

## 4. Unit layer — the pure core

`packages/core-domain` and `packages/grading` perform no I/O by construction ([`../CLAUDE.md`](../CLAUDE.md) repo map). That is not a stylistic preference; it exists so that the logic which decides a candidate's score can be tested exhaustively at microsecond cost, with no container, no clock, and no mock. If a test in either package needs a mock, the boundary has been drawn wrong and the fix is to move the I/O out, not to add the mock.

### 4.1 Table-driven by default

Every case in these packages is a row in a table, and the table is the specification. The form is uniform so a reviewer reads the cases rather than the plumbing:

```ts
const cases: Array<{
  name: string;            // what the row proves, in domain language
  given: Input;            // the whole input, literal, no builders
  expect: Output;          // the whole expected output, literal
  because?: string;        // the requirement or ADR the row defends
}> = [ /* ... */ ];

it.each(cases)('$name', ({ given, expect: want }) => {
  expect(subject(given)).toStrictEqual(want);
});
```

Rows carry a `because` referencing `FR-n`, an ADR, or a milestone exit criterion wherever the row exists for a stated reason rather than for coverage. A row with no reason and no obvious meaning is a row nobody will dare delete when the behaviour legitimately changes.

### 4.2 Attempt state machine

The machine in [`03-API-spec.md`](03-API-spec.md) §8 has eight states — `created`, `in_progress`, `submitted`, `expired`, `auto_graded`, `under_review`, `finalised`, `voided` — and a small event set. The test is the full `(state x event)` matrix with an expected result of either a target state or a named rejection, which means the table has an entry for every cell, including every illegal combination.

Rows that must exist and must be named as such:

- Every legal transition from the diagram, one row each.
- Every illegal transition, expecting a typed rejection carrying a stable error code from `packages/contracts`, not a thrown string.
- `voided` reachable from every state, requiring a non-empty reason (FR-25).
- `finalised` unreachable while any `answers.final_score` is null (API spec §8), expressed at the unit layer as a guard function over the answer set, and re-proved against the database constraint in section 11.3.
- Terminal states accepting no event at all.
- Re-grade of a `finalised` attempt producing a new grading run rather than a state change (FR-21).

A meta-test asserts the table covers the Cartesian product exactly once: every `(state, event)` pair appears, no pair appears twice. Adding a state to the enum without adding its row fails the suite, which is the property that keeps the matrix honest after the fourth person has touched it.

### 4.3 Section-rule resolution

Rule resolution turns `section_rules` into a concrete ordered question list (FR-6, ADR-004). It is the highest-consequence pure function in the system, because a bad draw produces an exam that was never sat by anyone else in the cohort. Cases:

| Case | Expected |
|---|---|
| Fixed picks only | The pinned versions in `ordinal` order, no draw performed |
| Draw of `pick_count` from an ample pool | Exactly `pick_count`, all matching skills, kinds and difficulty band |
| Pool exactly equal to `pick_count` | Succeeds, consumes the pool |
| Pool smaller than `pick_count` | Typed `insufficient_pool` failure naming the shortfall per skill — never a short draw, never a silent substitution outside the band |
| `exclude_seen_days` excludes a version this candidate saw inside the window | Excluded; if that makes the pool insufficient, the previous row's failure |
| The same question eligible in two sections | Appears once across the attempt; the second section draws a replacement |
| Retired or unpublished versions in the candidate pool | Never drawn (FR-1) |
| Shuffle with a fixed seed | Byte-identical order across runs; a different seed gives a different order |
| Option shuffle for MCQ | `option_order` recorded, and it is a permutation of exactly the option set |
| Zero-weight or duplicate skill ids in the rule | Normalised deterministically, documented in the row |

`simulate` ([`03-API-spec.md`](03-API-spec.md) §5) shares this resolver. A test asserts that `simulate` and attempt start produce identical feasibility verdicts for the same rule and bank state, because a recruiter who was told the assessment is feasible must not meet `insufficient_pool` mid-exam — the API spec calls that the single worst failure this product can have.

### 4.4 Grading comparison

`packages/grading` compares actual output to expected under a grading mode. The failure modes are all mundane and all have cost a candidate a mark somewhere:

- Trailing newline present or absent; trailing spaces on a line; `\r\n` versus `\n`.
- Leading and interior whitespace under strict versus trimmed modes, stated per mode rather than inferred.
- Numeric comparison with a declared tolerance; `0.1 + 0.2` against `0.3`; negative zero; `NaN`; scientific notation.
- Unordered-output mode where line order is not significant but multiplicity is.
- Output exceeding `EXEC_MAX_OUTPUT_BYTES`: truncation happens before comparison and before storage, and a truncated stream is a failure with a distinct reason, never a silent pass because the first N bytes matched.
- Empty expected output with empty actual output — a pass, not a degenerate case.
- Non-UTF-8 bytes in stdout; a lone surrogate; a null byte.
- Compile failure: zero cases run, score zero, full compiler stderr retained for the candidate (API spec §7) but the *test-case* content still absent (section 7).
- Timeout and signal kills distinguished from wrong answers in the reason, because "your code was too slow" and "your code was wrong" are different feedback.
- `unit_tests` mode where the harness itself fails to start, which must not read as a candidate failure but as an infrastructure failure routing to review.
- `custom_checker` returning a malformed verdict — rejected, routed to review, never defaulted to pass or to fail.

### 4.5 Scoring and skill roll-up

- Weighted sum over sections against `max_score` per question version, with a hand-computed expected value in the table, not one derived by calling the function.
- Partial credit for `mcq_multi`, including the all-wrong case and the over-selection case.
- Negative marking floors at zero for the attempt as a whole and at the configured floor per question (`negative_score`), with a row proving a candidate cannot end below zero.
- Manual override replaces the auto score, requires a reason, and both values survive into the audit payload (FR-21).
- Per-skill sub-scores derived through `question_skills` weights (FR-20, ADR-009): a question tagged to two skills contributes to both, weights normalise, and a skill with no served question reports "not assessed" rather than zero. Reporting zero for an unassessed skill is a misleading number on a hiring decision, which makes it a correctness bug rather than a presentation choice.
- Rounding is decimal, half-up, at `numeric(6,2)`, applied once at the end. A test asserts that no intermediate value is rounded and that IEEE floats never touch a score: the arithmetic runs on a decimal type and the column is `numeric(6,2)`. This single rule removes the largest source of re-grade drift (section 8).

### 4.6 Property-based invariants

Where the input space is larger than a table can cover, fast-check asserts invariants over generated inputs. Properties worth stating, each with a fixed seed recorded in the test so a failure is reproducible:

- Scoring is monotonic: adding a passing test case never lowers a score.
- Scoring is bounded: `0 <= raw_score <= sum(max_score)` for every generated answer set.
- The draw is a permutation: resolved question sets contain no duplicates and every element came from the eligible pool.
- Option shuffle is a bijection: applying `option_order` and inverting it returns the original option list.
- The state machine is total: every generated event sequence ends in a defined state or a typed rejection, never an exception.

## 5. Integration layer — testcontainers

Integration tests run against PostgreSQL 16 and Valkey 8 in containers at the same versions as `docker-compose.yml`. Nothing here uses an in-memory substitute. An in-memory Postgres does not have row-level security, and RLS is the mechanism under test.

### 5.1 Container lifecycle

One Postgres container and one Valkey container per Vitest worker process, started once and reused across the files that worker runs. Within Postgres, migrations are applied once into a template database at suite start and each test file clones it with `CREATE DATABASE ... TEMPLATE`, which is an order of magnitude faster than re-running migrations and guarantees every file starts from an identical schema. Within a file, each test runs inside a transaction that is rolled back on completion, except the tests that need real concurrency (section 11), which take their own connections and clean up explicitly.

### 5.2 Migration tests

- Every migration applies forward from empty and from the previous release tag.
- Applying the migration set twice is a no-op, so a partially applied deploy can be retried.
- Every migration is expand-contract ([`../CLAUDE.md`](../CLAUDE.md) hard rule 9): a test parses the generated SQL and fails on `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN ... SET NOT NULL` without a prior backfill migration, or a type narrowing, unless the change carries an explicit `-- contract-phase:` annotation naming the expand migration it follows. The point is that a destructive migration cannot land by accident during an exam window.
- Schema drift: the Drizzle schema in `packages/db` generates the same DDL as the migration chain produces. Drift here means the ORM's mental model and the database disagree, which surfaces later as a runtime error on a rare column.

### 5.3 RLS negative tests — the gate that matters

ADR-010 is the reason a forgotten `WHERE` clause returns nothing instead of another tenant's data. That guarantee is worth exactly as much as the tests that hold it up, so the RLS suite is generated rather than hand-written (task H-017).

The generator reads `information_schema` for every table carrying an `org_id` column and emits, for each one, a fixed battery. Two orgs are seeded — org A and org B — each with a full object graph. The session sets `app.current_org` to org A, then:

| Assertion | Why this shape |
|---|---|
| `SELECT` of a known org B row id returns **zero rows** | Not an error. An error tells an attacker the row exists; zero rows tells them nothing |
| `SELECT count(*)` over the table equals org A's count exactly | Aggregates are the classic RLS bypass, because a count leaks volume even when rows are hidden |
| `UPDATE` targeting an org B row id affects zero rows | RLS `USING` without a matching `WITH CHECK` lets an update move a row across the boundary |
| `INSERT` with `org_id` set to org B is rejected | The `WITH CHECK` half of the policy |
| `DELETE` targeting an org B row id affects zero rows | — |
| `UPDATE ... RETURNING` on an org B row returns no rows | `RETURNING` is a second read path and gets its own assertion |
| A join from an org A row to an org B row yields zero rows | Joins are where a policy on the parent gets trusted for the child |
| The same battery with `app.current_org` unset | Zero rows everywhere, never "all rows". An unset variable must fail closed |
| The same battery with `app.current_org` set to a malformed value | A clean error, not a cast that silently matches |

Three further tests exist once, not per table:

- **Coverage.** Every table with an `org_id` column has RLS enabled *and* a policy attached *and* a row in the generated suite. A new tenant table without a policy fails the build, which is the enforcement behind [`../CLAUDE.md`](../CLAUDE.md) hard rule 8 — otherwise the rule is a comment.
- **Pooling.** The application sets the org with `SET LOCAL` inside a transaction, not `SET` on the connection. A test checks out a connection, runs a request as org A, returns it to the pool, checks it out again and reads as org B, asserting no bleed. This is the bug that transaction-mode connection poolers produce and it is invisible until two tenants are busy simultaneously.
- **The job role.** `DATABASE_JOB_ROLE` is elevated so sweeps can cross org boundaries. Tests assert that it is a distinct role from `DATABASE_APP_ROLE`, that the API never connects as it, and that every cross-org read under it writes an audit row. An elevated role with no audit trail is an unlogged backdoor.

`EXPLAIN` baselines for the attempt hot path are captured here too, with RLS enabled, so a policy that turns an index scan into a sequential scan is caught in M0 rather than during a campus drive (R-09).

### 5.4 Queue integration

Against real Valkey and real BullMQ, for the queues named in [`../CODE-GRAPH.md`](../CODE-GRAPH.md):

- `grading.submit` uses the submission id as the BullMQ job id, so enqueuing twice produces one job. Tested by enqueuing the same submission id concurrently from two connections and asserting a single execution.
- Retry honours `QUEUE_MAX_ATTEMPTS` and exponential backoff from `QUEUE_BACKOFF_MS` with jitter; the delays are asserted as a monotonic non-decreasing sequence rather than as exact values, because asserting exact jittered delays is a flake generator.
- Exhausted retries land in `grading.submit.dlq`, move the attempt to `under_review`, and **never** write a zero score (HLD §9). This assertion is the one that keeps an infrastructure failure from becoming a candidate's rejection.
- `grading.run` uses a lower attempt count and surfaces failure to the candidate as a run error that is never recorded as a score.
- Interactive and batch queues have independent concurrency: a saturated `grading.submit` still lets a `grading.run` job start within a bounded time. Tested by filling the submit queue and measuring run-queue pickup.
- `maintenance.cron` repeatable jobs register exactly once across two worker instances starting simultaneously.

### 5.5 SSE and streaming

`GET /attempt/submissions/{id}/stream` is tested as a real event stream, not as a JSON endpoint: an event fires per progress step, the terminal event closes the stream, a client that disconnects and reconnects with `Last-Event-ID` resumes without duplicating a result, and a stream for another candidate's submission is rejected before any frame is written. Every frame also passes through the leak suite (section 7.5).

### 5.6 Webhooks

Signature is HMAC-SHA256 over the raw body, verified with the raw bytes rather than a re-serialised object; a test that re-serialises before signing would pass while production fails on key order. Delivery is at-least-once with a bounded 24-hour retry window, deliveries carry a stable `event_id`, and secret rotation with an overlap window accepts both signatures during the overlap and only the new one after (R-16).

## 6. Contract tests — the API and the spec cannot drift

`packages/contracts` holds zod schemas, the generated OpenAPI 3.1 document, and the error-code enum, and it is the single source of API truth ([`../CLAUDE.md`](../CLAUDE.md) repo map). Drift between that document and the implementation is the defect that breaks the candidate app in production while every server test passes, so three independent gates hold the chain together.

```
  zod schemas (hand-written, packages/contracts)
        │
        ├── Fastify route schemas ──► runtime validation of requests and responses
        │
        ├── OpenAPI 3.1 (generated, committed) ──► gate 1: regeneration is a no-op
        │
        └── generated test client ──► gate 2: every integration test speaks the spec
```

**Gate 1 — the committed document is current.** CI regenerates the OpenAPI document and fails if the result differs from the committed file. The document is generated output and is never hand-edited.

**Gate 2 — the implementation obeys the schema at runtime.** In test and staging (`APP_ENV != production`), the API validates outgoing responses against the declared response schema and fails the request on mismatch. Every integration test therefore doubles as a contract test: a handler returning an undeclared field fails the test that touches it. In production this validation is off, because failing a candidate's request over a spec mismatch is worse than serving the extra field — but the leak suite in section 7 keeps running in every environment, since the undeclared field that matters is the one that leaks.

**Gate 3 — breaking changes are visible.** A spec-diff step compares the generated document against the previous release tag and classifies each change. Removing a field, narrowing a type, adding a required request field, or removing an error code is breaking and requires an explicit `breaking-change:` label plus a note in the release. Additive changes pass silently.

Two further assertions:

- **Error-code coverage.** Every member of the error-code enum is produced by at least one test, and every error response in every test carries a code from the enum. An error code that no test can provoke is either dead or undocumented, and a response carrying an invented code breaks the client rule that branching happens on `code` and never on `message` (API spec §2).
- **Idempotency declaration.** Every mutating route either declares `Idempotency-Key` support or is listed in an explicit exemption file with a reason. The list is reviewed; silence is not an exemption.

## 7. The leak suite

FR-12, HLD §7 and [`../CLAUDE.md`](../CLAUDE.md) hard rule 4 all say the same thing: nothing a candidate must not see may reach a candidate-scoped response. This section specifies the standing suite that proves it. It is a suite and not a review convention because review catches the handler someone wrote and misses the handler someone generated, and because the consequence of one miss is a compromised bank and a cohort of meaningless scores.

The suite is release-blocking. A failure in it is not triaged; it stops the release.

### 7.1 The forbidden inventory

| Must never reach a candidate | Source | Why it is fatal |
|---|---|---|
| `mcq_options.is_correct` | Question bank | The answer key. One leak invalidates every future use of the question |
| `question_versions.explanation_md`, any rationale field | Question bank | Contains the reasoning and frequently the answer |
| Reference or solution code on a coding question | `coding_specs` | Hands over the submission |
| `test_cases.stdin` and `test_cases.expected_stdout` where `is_sample = false` | Question bank | Hidden cases become sample cases; the question no longer discriminates |
| Hidden-case labels beyond the opaque label, counts that reveal structure | `submission_results` | Partial leakage is still leakage |
| `short_answer_keys` match specifications | Question bank | The answer key in another shape |
| Another candidate's answers, scores, submissions, identity | Attempt data | Tenant and candidate isolation failure, plus a privacy incident |
| Staff-only fields: `integrity_flag` internals, reviewer notes, interviewer private notes | Attempts, sessions | FR-19; also tells a candidate what the proctoring watches |
| Bank-wide identifiers that enable enumeration | `questions.id` ranges, cursors | An enumerable bank is a downloadable bank |

### 7.2 Sentinel fixtures make the assertion reliable

A leak assertion built on field names is weak: it catches `{"is_correct": true}` and misses `"Expected 42 but got 7"` inside a stderr string. So every forbidden value in the fixture bank is a sentinel — a high-entropy token that appears nowhere else in the system:

```
hidden expected stdout   ->  "LEAKCANARY_EXPECTED_7f3a9c21"
reference solution body  ->  "LEAKCANARY_SOLUTION_51d08be4"
explanation markdown     ->  "LEAKCANARY_RATIONALE_c9a17f60"
correct option text      ->  "LEAKCANARY_CORRECT_2b6e4d05"
other candidate's answer ->  "LEAKCANARY_OTHERCAND_a04f77e3"
```

The oracle is then a substring search for `LEAKCANARY_` over the entire serialised response — body, headers, and every SSE frame — after normalising for transport encodings: base64, URL encoding, JSON string escaping, and gzip. A response containing the sentinel anywhere, in any encoding, fails. This catches the diff message, the stack trace, the validation error echoing the input, and the debug field someone added to a shared serialiser, none of which a field-name check would find.

### 7.3 Four independent assertions

1. **Type level.** Candidate-facing response types are constructed from an allow-list of fields, not by omitting fields from a full type. A compile-time test (`expectTypeOf`) asserts the candidate DTO type has no property in common with the forbidden set. Omission-based DTOs fail open when someone adds a column; allow-list DTOs fail closed.
2. **Serialiser unit tests.** Each candidate serialiser is given a fully populated domain object with every forbidden field set to its sentinel, and its output is asserted to contain no sentinel. Fast, runs in the unit suite, catches the common case immediately.
3. **Route sweep.** Every route in the candidate-scoped route registry is called with a valid attempt token against the sentinel fixture bank, in both its success path and at least three failure paths, and every response is scanned. Section 7.4 explains how the registry stays complete.
4. **Transport sweep.** The same scan applied to surfaces that are not JSON response bodies (section 7.5).

### 7.4 The registry gate keeps the suite standing

Fastify exposes its route table. The suite reads it, filters to routes whose authentication strategy is the attempt token or the room-code session, and asserts that each one appears in the leak-suite manifest. A new candidate-scoped route that nobody added to the manifest fails CI with a message naming the route. That inversion — the suite discovers routes rather than waiting to be told about them — is what makes this a standing guarantee instead of a snapshot of what the codebase looked like in M1.

The same gate covers the candidate bundle: a build-time check asserts `apps/candidate` imports nothing from `apps/web` and nothing from any package that exposes bank queries or correct-answer flags, matching the repo-map prohibition. A leak through a JavaScript bundle is still a leak, and it is permanent once shipped.

### 7.5 Surfaces the sweep must cover

- **Success responses** for every candidate route, including the question payload, the answer echo, the submission status, and the report a candidate may see after the attempt closes.
- **Error responses** at every status: 400 validation errors that echo input, 403, 404, 409 conflicts carrying `details`, 422, 429, and the 500 handler. The 500 handler gets an explicit test that a thrown error containing a sentinel in its message produces a response containing no sentinel — the generic shape with a `request_id` and nothing else (API spec §2).
- **SSE frames** on `GET /attempt/submissions/{id}/stream`: every progress frame, the terminal frame, and any error frame. Hidden-case results carry pass/fail and an opaque label only.
- **Headers**, including anything an error handler might attach, and `Location` on redirects.
- **Trace and log output** reachable by a candidate, and — by a separate assertion in `packages/observability` — sentinels must not reach logs at all, since [`../CLAUDE.md`](../CLAUDE.md) prohibits logging candidate answers, tokens and media.
- **WebSocket frames** from M3: the collab awareness payload and document updates must carry no interviewer private-note content (FR-19, task H-090).
- **Export artifacts** a candidate can reach through a pre-signed URL.
- **Compile and runtime error output** surfaced to the candidate, which is the subtlest case: full compiler stderr is candidate-visible by design (API spec §7), and it must be shown while still containing no hidden-case content. The test compiles a program whose error message would include a hidden input if the harness passed one in, and asserts it does not.

### 7.6 Cross-candidate isolation

A matrix over candidate A's token against candidate B's identifiers: attempt, attempt question, answer, submission, SSE stream, proctor event, report, pre-signed asset. Every one returns `not_found` rather than `forbidden`, because `forbidden` confirms the object exists. One row per identifier type, and a meta-test asserting the matrix covers every candidate-reachable identifier type in the contracts package.

The attempt token is also asserted to be incapable of reaching any bank route, any other org's data, or any staff route — the API spec says it is scoped to exactly one attempt, and this is where that claim is proved.

### 7.7 What this suite cannot prove

It cannot prove the absence of a timing side channel, it cannot prove a question is not memorable enough for a candidate to recount afterwards, and it cannot prove the bank has not leaked through a screenshot. Those are handled by exposure counting and retirement (FR-4), not by tests, and [`14-threat-model.md`](14-threat-model.md) owns the analysis.

## 8. Determinism and re-grade reproducibility

M1's exit criterion is that scores reproduce exactly on re-grade. "Exactly" means byte-identical `raw_score`, `score_pct` and per-skill sub-scores, not "within a rounding tolerance". A re-grade that differs by 0.01 is a defect, because a pass mark sits at a boundary and a candidate sits on either side of it.

### 8.1 Sources of nondeterminism and the rule for each

| Source | Rule | Where it is tested |
|---|---|---|
| Floating-point arithmetic | Decimal type end to end; `numeric(6,2)` columns; rounding half-up, once, at the end | Unit (4.5) plus the golden corpus |
| Map or object iteration order | Every collection that feeds a score is explicitly sorted by a stable key before reduction | Property test: shuffling the input collection does not change the output |
| SQL without `ORDER BY` | Every query feeding grading carries a total order, including a tiebreak on `id` | A lint rule over the query layer plus an integration test that runs the load twice with different physical row order |
| `now()` inside grading | Grading reads no clock. Timestamps are recorded, never used as inputs to a score | Unit: the grading functions take no clock parameter and none is available to them |
| The question draw | Materialised at attempt start and read back verbatim; never recomputed (ADR-004) | Integration: restart, re-read and re-grade all return identical `attempt_questions` and `option_order` |
| Locale collation | String comparison in grading is byte-wise, never collation-dependent; the database uses `C` collation for comparison columns | Integration test running under two `LC_COLLATE` settings |
| Runtime image drift | `submissions.runtime_image` and `language_version` are recorded per submission (FR-13); a re-grade pins the recorded image | Integration: re-grade with a newer image available still selects the recorded digest |
| Output truncation | Truncation is deterministic at `EXEC_MAX_OUTPUT_BYTES` on a byte boundary, applied before comparison and before storage | Unit plus a case in the corpus with output straddling the limit |
| Test-case order | Cases execute in `ordinal` order and results are stored in that order | Integration |
| Parallel case execution | Permitted, but results are reassembled in `ordinal` order before scoring | Concurrency test running cases with randomised completion order |

### 8.2 The golden corpus

A committed corpus of complete, frozen inputs: attempt, served question versions, answers, submissions with their code, recorded runtime identity, and the expected outputs. Roughly forty attempts covering every question kind, every grading mode, partial credit, negative marking, compile failure, timeout, memory kill, output flood, an unassessed skill, and a manual override.

The corpus is the regression net for every future change to grading. A change that alters any corpus output is either a bug or a deliberate scoring change; a deliberate change updates the corpus in the same commit, with the diff visible in review and a note in the release. A scoring change that lands without a visible corpus diff is exactly the change nobody will be able to explain to a candidate six months later.

### 8.3 The re-grade test

Beyond the corpus, the M1 exit evidence (task H-062) runs the real endpoint: `POST /attempts/{id}/regrade` on all fifty attempts from the concurrency run, asserting every score is byte-identical, that a new grading run row exists rather than a mutated one, and that the audit log holds both runs (FR-21, API spec §8). The same run asserts the attempt's `attempt_questions` and `option_order` are unchanged (FR-7).

### 8.4 When a re-grade is allowed to differ

Only when a human changed something, and then the difference must be attributable:

- A manual score override was applied — the audit log holds both values and the reason.
- A question version was found defective and the attempt was re-graded against a decision recorded in the audit log. The published version itself is still immutable (ADR-003); what changes is the scoring decision about it, and it is recorded as such.

Any other difference is a defect. A test asserts that a re-grade with no intervening human action produces a run whose scores match the previous run in every field.

## 9. Idempotency

### 9.1 Grading jobs replayed by submission id

BullMQ is instructed to use the submission id as the job id, so the queue itself deduplicates, but the queue is not the only way a job runs twice: a worker can die after writing results and before acknowledging. Tests:

- Enqueue the same submission id twice concurrently; exactly one job executes.
- Run the worker handler twice against the same submission; `submission_results` holds one row per case, not two, and the score is unchanged.
- Kill the worker between writing `submission_results` and updating `submissions`; on replay the job completes and the final state is correct. Simulated with an injected fault point rather than a real kill, so it runs in CI.
- Replay after the attempt has already finalised: the job is a no-op and does not reopen the attempt.
- Two workers dequeue the same job through a lock expiry; database-level uniqueness on `(submission_id, test_case_id)` makes the second write fail cleanly rather than duplicating.

### 9.2 `Idempotency-Key` on the HTTP surface

The middleware (task H-025) returns the original response body and status on replay. Tests: a replay with the same key and the same body returns the stored response without re-executing; a replay with the same key and a *different* body returns `conflict` rather than silently serving the old response; two concurrent requests with the same key produce one execution and one stored response; keys are scoped per org and per route so a key cannot collide across tenants; the record expires on a stated TTL.

### 9.3 Webhook consumers

Deliveries carry a stable `event_id` and the same event may arrive more than once. A test asserts `event_id` is stable across retries of the same event and unique across distinct events, and the ATS integration tests in [`09-ats-integration.md`](09-ats-integration.md) cover the consumer-side dedupe that keeps a duplicate delivery from moving a candidate's stage twice (R-16).

### 9.4 Attempt start

`POST /attempt/start` called twice returns the same attempt with the same materialised question set. It does not re-roll, does not create a second attempt, and does not extend `deadline_at` (FR-7, FR-8). The concurrent version of this is section 11.2.

## 10. Time — everything runs on an injectable clock

### 10.1 The rule

No production code calls `Date.now()`, `new Date()` with no argument, or `now()` in SQL on a path that decides anything. Time arrives through a `Clock` interface supplied at composition; tests inject a controllable clock they can advance instantly. A lint rule fails the build on direct clock access outside the clock module itself, because a single stray `Date.now()` turns a deterministic test into one that passes until the runner is slow.

The database's `now()` remains authoritative for `created_at` defaults. What is forbidden is a *decision* — expiry, eligibility, retention — taken against a clock the tests cannot move.

### 10.2 Cases

| Case | Assertion | Requirement |
|---|---|---|
| Submit before deadline | Accepted | FR-8 |
| Submit one millisecond after `deadline_at` | Rejected with `attempt_expired`, `details.deadline_at` present | FR-8, ADR-006 |
| Autosave after deadline but before the sweep runs | Rejected; the attempt is not silently extended | ADR-006 |
| Client sends a timestamp in the past or future | Ignored entirely; the server clock decides | ADR-006 |
| Client clock skewed by ±1 hour | `server_time` in every response drives the countdown; no behavioural change | ADR-006 |
| Heartbeat during a suspended tab, resuming after 20 minutes | `seconds_remaining` reflects real elapsed time, never paused | ADR-006 |
| Accommodation `extra_time_pct` of 25% | `deadline_at` computed at start as `duration x 1.25`, recorded, and present in the audit log | PRD §9, API spec §6 |
| Accommodation added after the attempt started | Explicit, tested behaviour — not an accident. TBD — owner: product, decide by 2026-10-16, before M1 closes |
| Section-level `duration_seconds` alongside the attempt deadline | The earlier of the two binds; tested at the boundary | FR-6 |
| Deadline sweep at `deadline_at + 1s` | Attempt moves to `expired` and autosaved answers are graded, not discarded | FR-8, task H-052 |
| Sweep while the candidate is mid-submit | Exactly one outcome — `submitted` or `expired`, never both, never neither | section 11 |
| Sweep run twice over the same attempt | Idempotent; no duplicate grading, no second audit row | — |
| Sweep unable to run for 10 minutes | On resumption, every overdue attempt is expired with the correct expiry time, not the discovery time | ADR-006 |
| Attempt spanning a DST transition | Duration is measured in elapsed seconds; the wall clock changing does not move `deadline_at` | conventions |
| `opens_at` in the future | Redemption before `opens_at` is rejected with a stable code | API spec §6 |
| Invitation `expires_at` passed | Redemption rejected; an attempt already in progress is unaffected | API spec §6 |
| Retention clocks | Time-travel past each `RETENTION_*` value asserts the sweep deletes the row and the object (task H-105) | FR-28 |

All timestamps are `timestamptz` stored UTC ([`../CLAUDE.md`](../CLAUDE.md) conventions), and a test asserts no `timestamp without time zone` column exists anywhere in the schema.

## 11. Concurrency

These tests take real connections, run real parallel requests, and do not roll back into a shared transaction. They are the slowest integration tests in the suite and they cover the bugs that only appear when a cohort starts at once — the bugs HLD §10 says are the reason staging carries production-shaped data.

The harness runs N clients that block on a barrier and release simultaneously, with the database at a stated isolation level, repeated enough times to make a race probable rather than possible. Each test states the invariant it protects, and a passing run is evidence rather than proof — which is why the invariants are also enforced by constraints in the database, where a race cannot argue with them.

### 11.1 Attempt start

Ten simultaneous `POST /attempt/start` calls on one invitation:

- Exactly one `attempts` row exists.
- Exactly one set of `attempt_questions` exists, and every client received the same set in the same order with the same `option_order` (FR-7, ADR-004).
- Every response carries the same `deadline_at`; no client's start extended it.
- `max_attempts` is respected under parallelism, so a candidate cannot obtain a second attempt by racing.
- `questions.exposure_count` increments exactly once per served version, since exposure drives retirement (FR-4) and a double count corrupts the leakage signal.

### 11.2 The finalisation guard

The transition to `finalised` requires every `answers.final_score` to be non-null, in a single transaction (API spec §8, HLD §4.4). Tests:

- Two grading workers completing the last two questions simultaneously produce exactly one finalisation and exactly one `attempt.finalised` webhook.
- A report request racing finalisation either sees the pre-finalised state or the complete one — never a half-graded attempt, which is the classic bug this guard exists to prevent.
- The guard is enforced by a database constraint, not only by application logic: a direct SQL update setting `status = 'finalised'` with a null `final_score` is rejected. Application-level guards lose races; constraints do not.
- A manual override landing concurrently with automatic finalisation results in the override being reflected in the final score, not overwritten.

### 11.3 Autosave interleaving

Two autosaves for the same answer arriving out of order: the later `seconds_spent` and content win deterministically, and the earlier arrival does not resurrect stale content. Autosave during submit either lands before the submit snapshot or is rejected — never applied after the answer was graded.

### 11.4 Submission budget and execution budget

Ten parallel submissions against a question with a limit of ten total: exactly ten are accepted and the eleventh is rejected, with no off-by-one under parallelism. The per-attempt execution budget behaves the same way, because the budget exists to stop one candidate starving the execution pool (HLD §6) and a budget that races is not a budget.

### 11.5 Scorecard reveal

Two reviewers submitting simultaneously: neither can read the other before both are submitted, and the moment both are submitted both become readable. The rule is enforced in the API, not in the UI (API spec §11), so the test drives the API directly.

### 11.6 Sweep versus submit

Covered in section 10.2 and repeated here under real parallelism: the deadline sweep and a candidate's final submit racing produce exactly one terminal state.

## 12. End-to-end — Playwright

E2E tests are expensive and brittle in proportion to how many there are, so there are five. They exist to prove the journeys compose, not to test logic that a unit or integration test could reach. Anything that can be asserted below the browser is asserted below the browser.

| # | Journey | Covers | Milestone |
|---|---|---|---|
| 1 | Author writes, reviews and publishes a coding question, and it becomes immutable | M0 lifecycle, test-case editor, the publish action reading as irreversible | M0 |
| 2 | Recruiter builds an assessment with a fixed and a random section, simulates it, invites a candidate | Rule resolution through the UI, `simulate` feasibility, invitation issuance with the token shown once | M1 |
| 3 | Candidate redeems a link, completes a mixed MCQ and coding attempt, loses the network mid-attempt, resumes with no data loss, submits before the deadline | FR-9, FR-11, the countdown driven by `server_time`, the SSE result panel | M1, extended in M2 |
| 4 | Interviewer and candidate share a live session, edit simultaneously, run code, and the interviewer files a scorecard; the session replays | FR-16 to FR-19, ADR-005 | M3 |
| 5 | Proctored attempt raises signals, the attempt is flagged, a reviewer sees the evidence and no automated verdict exists anywhere | FR-23, FR-24, ADR-007 | M4 |

Journey 3 carries the network-loss step explicitly: Playwright takes the context offline for thirty seconds mid-attempt, the client buffers, and on reconnect the server state matches what the candidate typed. R-15 is the highest-likelihood candidate-experience risk in the register and this is the test that holds it.

**Conventions.** Selection is by accessible role and name, never by CSS class — which makes the E2E suite a partial accessibility test for free and stops it breaking on every restyle. Each journey seeds its own org through the API and tears it down, so journeys run in parallel. Traces and video are retained on failure only. Chromium runs on every PR; Firefox and WebKit run nightly, matching the PRD's last-two-versions browser support.

## 13. Accessibility testing

WCAG 2.1 AA for the candidate experience is a PRD non-functional requirement, and the PRD states the reason plainly: a candidate who cannot complete an assessment because of a screen-reader failure is a discrimination exposure (R-11). [`15-accessibility-conformance.md`](15-accessibility-conformance.md) owns the conformance detail; this section owns the test mechanics.

**Automated, every PR.** axe-core runs against every candidate-app route and every staff route that a keyboard-only user must reach, in both light and dark themes, at 320 px and 1280 px widths, and at 200% zoom. Any violation at `serious` or `critical` fails the build. `moderate` and `minor` violations are recorded against an allow-list that must shrink between releases and may never grow without a named owner and a date.

**Automated, targeted.** Focus order is asserted programmatically across each attempt route; focus is asserted to be trapped inside modals and restored on close; every interactive element is reachable and operable from the keyboard alone, including Monaco, whose keyboard trap is the known hard case — `Escape` must release focus from the editor and a test asserts it does. Live-region announcements are asserted for the countdown at its thresholds, for autosave state, and for submission results, since a candidate who cannot hear the timer is running an untimed exam they believe is timed.

**Manual, per release.** Automation catches roughly a third of real barriers. A scripted manual pass runs the full candidate journey with NVDA on Firefox, VoiceOver on Safari, and keyboard only with no pointer, and records the result in the release notes. The script, its pass criteria and its evidence format live in [`15-accessibility-conformance.md`](15-accessibility-conformance.md). The M4 exit criterion requires this pass; it is not satisfied by a green axe run.

## 14. Sandbox security tests

HLD §7 instructs us to assume the sandbox will eventually be escaped. These tests assert that the containment around it holds, which means they must run against a real Piston with real kernel limits and a real network policy. A mocked sandbox test asserts that the mock is a mock.

Each attack is a small program committed as a fixture, run through the same execution path a candidate submission takes, with the limits from `EXEC_CPU_TIME_MS`, `EXEC_WALL_TIME_MS`, `EXEC_MEMORY_MB`, `EXEC_MAX_PROCESSES` and `EXEC_MAX_OUTPUT_BYTES`.

| Attack | Fixture | Must happen | Must not happen |
|---|---|---|---|
| Fork bomb | Unbounded process spawn, in each supported language | Killed at `EXEC_MAX_PROCESSES`, reported as a resource-limit failure, node healthy for the next execution within one interval | Node saturation, queue stall, host process starvation |
| Network egress | Outbound DNS, TCP to a public address, TCP to the API port, TCP to the Postgres port, and a link-local metadata request | Every attempt fails at the network layer | Any connection established; any DNS resolution succeeding |
| Memory bomb | Allocation loop past `EXEC_MEMORY_MB` | OOM-killed inside the cgroup, reported as a memory-limit failure | Host OOM killer firing, other executions affected |
| Output flood | Unbounded stdout, then unbounded stderr | Truncated at `EXEC_MAX_OUTPUT_BYTES`, stored truncated, the case scored as a failure with a truncation reason | Unbounded memory growth in the worker; a truncated stream comparing equal to expected |
| Filesystem escape | Read `/etc/shadow`, read the host mount table, write outside the work directory, traverse with `../`, read another execution's work directory, read an environment variable | All denied | Any host path readable; any cross-execution read; any secret present to be read |
| CPU spin | Tight loop with no output | Killed at `EXEC_CPU_TIME_MS`, distinguished from wall-clock timeout | The wall-clock limit being the only backstop |
| Zombie and orphan processes | Detached child outliving the parent | Reaped with the cgroup; nothing survives the execution | A process surviving into the next execution |

Two structural assertions accompany them (task H-066): the execution node holds no secrets, no database credentials and no cloud IAM role — asserted by enumerating the environment and the filesystem inside the sandbox and comparing against an allow-list — and the `exec-adapter` payload contains no question id, no attempt id and no expectation, which is the invariant that means an escape teaches the attacker nothing about the hidden cases (HLD §3.2).

**Cadence and failure handling.** Nightly and pre-release, never on PR, because they need a dedicated node. Any failure blocks the release and opens an incident against R-02 — this is the only suite where a single failure has that standing, because the alternative is shipping a known escape into an exam window.

## 15. Seed and fixture strategy

Four layers, each with a different lifetime and a different owner.

| Layer | Contents | Lifetime | Used by |
|---|---|---|---|
| **Reference seed** | System `user_roles`, `permissions`, `user_role_permissions`, the starter two-level skill taxonomy | Committed, changes with a migration | Every environment including production (task H-018) |
| **Fixture bank** | ~60 question versions across all eight kinds, deterministic ids, sentinel values in every forbidden field | Committed | Unit, integration, leak, determinism |
| **Scenario builders** | Typed functions — `anOrg()`, `aPublishedCodingQuestion()`, `anAttemptInProgress()` — composing valid graphs with sensible defaults and explicit overrides | Committed | Integration, E2E, concurrency |
| **Volume data** | Production-shaped volumes for staging: 5000 questions, 200 assessments, 50k attempts, 2M `session_events` rows | Generated, never committed | Load testing ([`07-load-and-capacity-testing.md`](07-load-and-capacity-testing.md) §9) |

**Rules that apply to all four.**

- **Deterministic identifiers.** Fixture UUIDs are fixed constants, not generated. A failing test names a row you can find in the fixture file by reading the id.
- **No real candidate data, ever.** Names, emails and code are synthetic. A test fixture containing a real person is a privacy incident with a git history (R-20).
- **No secrets.** Local secrets are generated with `openssl rand -hex 32`, never committed, including in fixtures.
- **Licensed content only.** The fixture bank is written in-house or drawn from the datasets in [`05-licensing-and-compliance.md`](05-licensing-and-compliance.md) §2, with `source_license` and `external_ref` set on every imported row. Fixtures are the first place a scraped question sneaks in.
- **Sentinels in every forbidden field.** A fixture question with an empty `explanation_md` makes the leak suite pass for the wrong reason. A test asserts every fixture version has all forbidden fields populated with sentinels.
- **Builders produce valid graphs.** A builder that can produce an attempt without an invitation lets a test assert behaviour that production cannot reach.

**Question-bank fixtures specifically** cover: every kind in the `question_kind` enum; a question with multiple versions where an earlier version was served to an earlier attempt; a retired version; a question tagged to two skills at different weights; a coding question with sample and hidden cases and per-case weights; a coding question whose reference solution passes and one whose reference solution deliberately fails one case, for the author-preview path; an MCQ with partial credit and one with negative marking; a short-answer question with each match mode; a SQL question with a fixture database; and one question in a non-English locale for [`08-i18n-and-localisation.md`](08-i18n-and-localisation.md).

## 16. Flake policy

A flaky test in this repository is worse than a missing one, because it teaches the team to re-run the suite, and a team that re-runs the suite will eventually re-run past a real failure in the leak suite.

1. **No automatic retries in CI for unit, integration, contract, leak, determinism or sandbox suites.** A retry here hides a race, and races are the defects this system cannot afford. Playwright is permitted one retry, and a test that needs it is already a candidate for quarantine.
2. **Quarantine within one working day.** A test that fails without a code change is moved to a quarantined project that still runs and still reports, but does not block. Quarantine requires a tracker task with an owner and a due date.
3. **Quarantine expires in ten working days.** At expiry the test is either fixed or deleted. A quarantined test with no owner is deleted, and the requirement it covered goes back on the backlog — an untrusted test is not coverage.
4. **Budget.** At most five quarantined tests at any time. At six, flake work takes priority over feature work. The count is reported in [`../project/STATUS.md`](../project/STATUS.md).
5. **Never quarantine a leak, determinism, RLS, or ADR-007 test.** These are release-blocking by construction. If one flakes, the flake is the incident.
6. **Root-cause categories are recorded** — timing, shared state, ordering, resource contention, real race — because the distribution tells you whether the harness or the system is at fault.

## 17. Coverage expectations, stated as risk

A single repository-wide coverage percentage optimises for the easiest lines and says nothing about whether the dangerous ones are tested. A 90% number reached by covering serialisers and skipping the scoring branch is worse than an honest 70%. So coverage is expressed per tier, with the tier decided by what a defect there costs a candidate.

| Tier | Code | Expectation | Enforcement |
|---|---|---|---|
| **Tier 1 — decides an outcome** | `packages/grading`, scoring and skill roll-up in `packages/core-domain`, deadline computation, the finalisation guard, candidate-facing serialisers | 100% of branches, and every branch traceable to a named case. New uncovered branch fails the build | Per-file branch threshold at 100%, plus mutation testing on this tier only (section 17.1) |
| **Tier 2 — isolation and integrity** | `packages/auth`, RLS policies, the attempt token path, proctor-event ingestion, exec-adapter payload construction | Every path has a negative test. Coverage is a by-product; the negative test is the requirement | Generated RLS matrix, leak registry gate, ADR-007 test |
| **Tier 3 — orchestration** | `apps/api` handlers, `apps/worker` pipelines, `apps/collab` | ~80% lines, and every error path and every state transition exercised at least once | Directory threshold |
| **Tier 4 — presentation** | `apps/web`, `apps/candidate`, `packages/ui` | No line threshold. Covered by E2E journeys, axe, and component tests for anything with logic — countdown, autosave state, results panel | Journey coverage plus the axe gate |
| **Tier 5 — generated and glue** | Generated OpenAPI, Drizzle migrations, config parsing | Excluded from the number; covered by the generation gates in section 6 | — |

**17.1 Mutation testing on tier 1 only.** Line coverage proves a line ran, not that an assertion would have caught it being wrong. On tier 1 that difference is the difference between a correct score and a plausible one, so a nightly mutation run over `packages/grading` and the scoring functions reports a surviving-mutant list. Target: no surviving mutant in scoring arithmetic, comparison operators, or boundary conditions. Elsewhere it is advisory. Tool choice is TBD — owner: engineering lead, decide by 2026-10-30 (M1 close), with the licence checked against the policy before adoption.

## 18. What runs when

| Stage | Suites | Budget | Failure means |
|---|---|---|---|
| **Pre-commit** (local hook) | Lint, format, typecheck on changed packages, unit tests for changed packages, doc-freshness check | < 20 s | Commit blocked locally; bypassable with `--no-verify` and caught in CI |
| **Pull request** | Everything above repository-wide, integration with containers, contract gates, leak suite, determinism over the golden corpus, E2E on Chromium, axe, licence gate, SBOM diff | < 15 min wall clock with parallel jobs | Merge blocked. No override for the leak, RLS or ADR-007 suites |
| **Merge to main** | The PR set plus E2E on Firefox and WebKit, migration-from-previous-release test | < 25 min | Revert or fix forward within the day; main stays releasable |
| **Nightly** | Sandbox security against real Piston, mutation run on tier 1, full determinism corpus, soak of the queue for one hour, accessibility across the full route list, dependency and licence audit, `EXPLAIN` baseline diff | < 90 min | A tracker task by the next morning; sandbox failures open an incident |
| **Pre-release** | Everything nightly, plus the load scenarios that gate the release ([`07-load-and-capacity-testing.md`](07-load-and-capacity-testing.md) §5), plus the manual accessibility pass, plus a restore-from-backup rehearsal | Half a day | Release blocked |
| **Pre-exam-window** (before a campus drive or certification sitting) | Smoke on staging and production, the deadline-stampede scenario at the expected cohort size, queue depth and DLQ verified empty, `simulate` run against every assessment in the window | < 2 h | The window does not open. A cohort discovering an infeasible assessment mid-exam is unrecoverable |

The pre-exam-window row is not ceremony. Every other row protects the codebase; that one protects a specific set of named people on a specific date.

## 19. Exit criteria and the tests that prove them

Each row states the criterion from [`01-PRD.md`](01-PRD.md) §6 or §8, the suite that proves it, and where the evidence is recorded. [`../project/MILESTONES.md`](../project/MILESTONES.md) carries the same mapping from the milestone side; the two must agree.

| Milestone | Exit criterion | Proving test | Suite | Evidence |
|---|---|---|---|---|
| M0 | 200 questions loaded, tagged to ≥ 3 job roles | Seeded-count query plus `GET /job-roles/{id}/coverage` non-zero for three roles | Integration | Task H-040 run output |
| M0 | Exportable and re-importable without loss | QTI 2.1 and JSON round trip into an empty org, deep equality excluding generated ids and timestamps | Integration | Task H-033 |
| M0 | Published versions are immutable (FR-1, ADR-003) | `PATCH` on a published version returns 409 `version_immutable` | Contract | CI run id |
| M0 | Tenant isolation holds (FR-26, ADR-010) | Generated RLS matrix, zero rows across org boundary on every verb | Integration | Task H-017 |
| M1 | 50 candidates complete a 30-question test concurrently | k6 `mcq-50-concurrent`; 50/50 reach `finalised`, zero autosave failures, API p95 < 300 ms | Load | k6 result file |
| M1 | Scores reproduce exactly on re-grade | Golden corpus plus regrade of all 50 attempts, byte-identical scores, both runs in the audit log | Determinism | Task H-062 |
| M1 | The draw never re-rolls (FR-7, ADR-004) | Restart, regrade and re-read return identical `attempt_questions` and `option_order` | Integration | CI run id |
| M1 | The client cannot move the deadline (FR-8, ADR-006) | Skewed clock and tampered payload rejected with `attempt_expired` | Integration | CI run id |
| M1 | Nothing hidden leaks (FR-12, HLD §7) | Leak suite over every candidate route, all surfaces, sentinel oracle | Leak | Task H-056, release-blocking |
| M1 | Zero answer loss (FR-9, NFR) | Offline-and-resume E2E journey plus the autosave-failure-rate gate in the load run | E2E and Load | Journey 3 trace, Prometheus series |
| M2 | 100 concurrent submissions graded | k6 `coding-100-inflight`; 100/100 reach `done`, DLQ empty | Load | Task H-080 |
| M2 | Execution result p95 < 8 s | `exec_result_latency_seconds` p95 over the run window, submit to final SSE event | Load plus metrics | Dashboard in [`12-observability-and-runbooks.md`](12-observability-and-runbooks.md) |
| M2 | Hidden cases never leak under execution (FR-12) | Leak suite extended over run and submit responses, SSE frames, compile and runtime error output | Leak | CI run id |
| M2 | Grading is reproducible (ADR-008) | Same submission id replayed twice, identical `submission_results` and score | Idempotency | CI run id |
| M2 | The sandbox is assumed hostile (FR-15, HLD §7) | Five-attack suite against real Piston plus the no-secrets node assertion | Sandbox | Task H-066, nightly run |
| M2 | Runtime identity recorded (FR-13, G4) | Every `submissions` row has non-null `language_version` and `runtime_image` | Integration | CI run id |
| M3 | A 45-minute loop runs and replays (FR-18) | Scripted rehearsal plus replay reconstructing `doc_state` at 1x, 2x and 8x | E2E and rehearsal | Task H-094, rehearsal note |
| M3 | Convergence without a central lock (FR-17, ADR-005) | Three clients, concurrent edits, forced disconnect and reconnect, identical converged state | Integration | Task H-082 |
| M3 | Editor sync p95 < 150 ms (NFR) | Awareness round-trip measurement during the `collab-session-scale` load scenario | Load | k6 result file |
| M3 | Private notes stay private (FR-19) | Leak suite over the candidate session payload and awareness frames | Leak | Task H-090 |
| M3 | Scorecards do not anchor (FR-22) | Reviewer B reads reviewer A only after both submit, asserted at the API | Integration and concurrency | CI run id |
| M4 | A 90-minute certification exam runs end to end | Scripted rehearsal: SEB launch, consent, timed attempt, grade, certificate verified | E2E and rehearsal | Task H-109 |
| M4 | No automated verdict exists (FR-23, ADR-007) | Standing test that the proctor path writes only `proctor_events` and `attempts.integrity_flag` | Integration | Task H-098, release-blocking |
| M4 | Void requires a reason (FR-25) | `POST /attempts/{id}/void` without a reason returns `validation_failed`; with one, an audit row names the actor | Contract and integration | CI run id |
| M4 | Consent is real consent | Declining consent still reaches a completed attempt by a non-proctored route | E2E | CI run id |
| M4 | Retention enforced in code (FR-28) | Time-travel past each `RETENTION_*` value; row and object both deleted | Integration | Task H-105 |
| M4 | Accessibility holds (WCAG 2.1 AA) | axe in CI at zero serious or critical, plus the manual screen-reader pass | Accessibility | [`15-accessibility-conformance.md`](15-accessibility-conformance.md) evidence |
| All | 500 sustained and 1000 peak candidates (NFR) | Steady-state and peak scenarios against the SLO gate table | Load | [`07-load-and-capacity-testing.md`](07-load-and-capacity-testing.md) §6 |

## 20. Known gaps in this strategy

Stated rather than hidden, each with an owner and a date.

1. **Psychometric validity is not testable here.** No suite can prove a question measures the skill it claims to measure. That evidence comes from p-value and discrimination statistics accumulating over real cohorts (FR-5) and from the score-to-performance correlation in PRD §10, which is a year-scale measurement, not a CI job.
2. **Adverse-impact testing needs real demographic data** that only exists once the platform has volume. Until then, `GET /reports/adverse-impact` is tested for correct arithmetic against synthetic distributions only, including the four-fifths boundary. Owner: data lead, revisit by 2027-01-30.
3. **Mutation-testing tool undecided.** TBD — owner: engineering lead, decide by 2026-10-30.
4. **Mid-attempt accommodation behaviour undecided** (section 10.2). TBD — owner: product, decide by 2026-10-16.
5. **Safe Exam Browser cannot be tested in CI.** It is a candidate-installed desktop application. The M4 handshake is covered by a scripted manual rehearsal, and the test plan for it belongs to M4 entry. Owner: M4 lead, decide by 2026-12-19.
6. **LiveKit media quality is not load-tested here.** Audio and video carrying an interview is a separate capacity question owned by [`07-load-and-capacity-testing.md`](07-load-and-capacity-testing.md) §5 scenario `collab-session-scale`, which measures signalling and document sync but not media bitrate. Owner: M3 lead, decide by 2026-11-30.
