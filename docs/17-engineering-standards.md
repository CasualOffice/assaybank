# Engineering standards

**Status:** draft
**Owner:** _unassigned_ (engineering lead)
**Last updated:** 2026-09-17
**Companion docs:** [`02-HLD.md`](02-HLD.md), [`03-API-spec.md`](03-API-spec.md), [`04-ADRs.md`](04-ADRs.md), [`06-testing-strategy.md`](06-testing-strategy.md), [`12-observability-and-runbooks.md`](12-observability-and-runbooks.md), [`14-threat-model.md`](14-threat-model.md), [`../CLAUDE.md`](../CLAUDE.md), [`../project/DEFINITION-OF-DONE.md`](../project/DEFINITION-OF-DONE.md)

---

## 0. What "production grade" means here

Not "well written". This system decides whether people get jobs, so the bar is set by what happens
when it is wrong rather than by how the code reads:

1. **A candidate never loses work.** Not on a bad network, not on a deploy, not on a worker crash.
2. **A score can always be explained.** Which questions, which version, which submission, which
   runtime, which human overrode what — reconstructable months later.
3. **No candidate sees what they must not see.** Answer keys, reference solutions, hidden test
   cases, other candidates, other organisations.
4. **No infrastructure failure scores anyone zero.** Every failure path preserves the attempt or
   routes it to a human.
5. **Every decision affecting a candidate is auditable and reversible by a human.**

Each rule below traces to one of those five. A rule that cannot be traced to one of them is a
preference, and preferences go in a linter, not in this document.

---

## 1. Language and type discipline

TypeScript strict, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`. Set in P0 when there is
no code to fix; see [`../project/P0-FOUNDATION-PLAN.md`](../project/P0-FOUNDATION-PLAN.md) step 1.

**`any` is forbidden.** `unknown` at boundaries, narrowed by a zod parse. A genuine escape hatch
carries `// eslint-disable-next-line` with a reason on the same line and is reviewed as a change to
the type system, not as a detail.

**No non-null assertions (`!`) in domain or data code.** If a value can be absent, the type says so
and the code handles it. `!` in scoring or draw-resolution code is how a candidate gets `NaN`.

**Parse, don't validate.** Data crossing a boundary — HTTP, queue, database row, environment — is
parsed into a domain type once, at the edge. Inside the boundary, types are trusted because they
were earned. Validation scattered through a call stack means every layer half-trusts its caller and
none of them is right.

**Branded types for identifiers.** `OrgId`, `AttemptId`, `QuestionVersionId` are distinct types,
not bare `string`. This domain has a dozen UUID-shaped identifiers and passing an `attempt_id` where
an `attempt_question_id` belongs is both easy and catastrophic.

---

## 1a. Licence headers

Every source file opens with the MPL-2.0 Exhibit A notice (ADR-020), in the comment syntax of its
language. `scripts/check-licence-headers.mjs` enforces it and `--fix` adds it. This is not
ceremony: MPL is copyleft at file granularity, so the header is what marks a file as Covered
Software, and a file without one has an ambiguous status that surfaces during someone's legal
review rather than during ours.

```ts
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
```

A file deliberately kept outside the licence — third-party vendored code, or a proprietary
extension — is added to the skip list in the script with a comment explaining why, so the exception
is visible rather than implicit.

## 2. Module boundaries and layering

The directions are declared in [`../CODE-GRAPH.md`](../CODE-GRAPH.md) and enforced by lint, not by
convention:

```
apps/*            may import packages/*        never another app
packages/*        may import packages/*        never an app
core-domain       imports nothing with I/O     no db, no http, no fs, no clock
grading           imports nothing with I/O     pure comparison and arithmetic
exec-adapter      never learns a question id   receives code and inputs only
```

**`core-domain` and `grading` are pure on purpose.** The attempt state machine, the section-rule
resolver, the scoring roll-up and the test-case comparison are the parts that must be provable,
re-runnable and identical on a re-grade a year later. Purity is what makes them table-testable
without a database and deterministic under replay.

**`apps/api` is the only writer of domain tables.** The worker writes grading results and job state;
nothing else writes anything. When a second writer appears, invariants that lived in one
transaction quietly stop holding.

**No shared `utils` package.** A module is named for what it does. `utils` accretes unrelated code
with no owner and no boundary, and becomes the thing everything imports and nobody understands.

---

## 3. API design

Conventions come from [`03-API-spec.md`](03-API-spec.md) §2 and are not re-decided per endpoint.

- Resource-oriented paths, plural nouns, `kebab-case`. Verbs only for genuine actions that are not
  CRUD: `/publish`, `/simulate`, `/regrade`, `/void`.
- `PATCH` is partial; `PUT` is not used except for whole-collection replacement (`/skills`).
- Cursor pagination everywhere. Offset pagination breaks under concurrent insertion, and this system
  inserts constantly during an exam window.
- Every mutating endpoint accepts `Idempotency-Key` and replays the original response. Candidates
  retry on bad networks; recruiters double-click.
- Filtering uses explicit query parameters. Never a generic query language — it is an injection
  surface and an unbounded-cost surface at once.

**The serialisation rule, which is the one that matters.** Every response is produced by an explicit
serialiser typed to its audience. Candidate-facing and staff-facing serialisers for the same entity
are different types, not the same type with a flag. A boolean parameter deciding whether to include
answer keys will eventually be passed wrong; two types cannot be.

**Errors.** Stable `code`, human `message`, structured `details`, and a `request_id` that is the
trace id. Clients branch on `code`; `message` may change freely. Never leak an internal message,
a stack, a SQL fragment or an upstream error verbatim — [`14-threat-model.md`](14-threat-model.md)
records error-message leakage as a real path to hidden test-case content.

**Versioning.** `/api/v1` is a compatibility boundary. Additive changes only: new optional fields,
new endpoints. Removing a field or narrowing a type is a v2 change, and there is no v2 planned.

---

## 4. Database

**Constraints belong in the database.** If it can be a `CHECK`, a `UNIQUE`, a foreign key or a
partial index, it is one. Application code is not the only writer — migrations and background jobs
are too, and they will not run your validation function.

**Row-level security on every tenant table, without exception** (ADR-010). Enforced by the generated
suite from P0 step 7: a new table with `org_id` and no policy fails CI. The policy is not optional
because the failure mode is a cross-tenant leak, which is the failure that ends products.

**RLS does not check foreign keys, so resolve every reference first.** PostgreSQL validates a foreign
key without row-level security. A row policed through its parent — `question_skills` through
`questions` — accepts a reference to another tenant's row, because neither the policy nor the key
looks at the referenced tenant. Every id in a request body that names a tenant-owned row is read
back under `withOrg` before it is written, and one the tenant cannot see is refused as not found.
And a table with shared global rows gets per-command policies: `USING (org_id IS NULL OR ...)` on a
policy covering every command lets a tenant delete or claim the shared row (migration 0008,
[`14-threat-model.md`](14-threat-model.md) T-041).

**Validate a `numeric` value against its column's precision and scale at the contract.** PostgreSQL
*rounds* excess scale on insert and raises an overflow past the precision, so `0.125` into a
`numeric(6,2)` is silently stored as `0.13`, and `10000` is a `500`. Every score and weight input is
bounded to what its column holds and refused past two decimal places (`scoreValue` in
`packages/contracts`). Both defects existed until 2026-09-17, found when an export disagreed with its
own import.

**Every child collection is read with a total order.** A query without `ORDER BY` returns heap order,
which is insertion order in a fresh table and in no table after a few updates — so a missing
`ORDER BY` passes every test on freshly seeded data. `short_answer_keys` had no ordinal until
migration 0009. A test that proves an order must first move a row in the heap (an `UPDATE` does).

**Migrations are expand-contract, always:**

```
1. expand    add the new nullable column / new table          deploy
2. backfill  populate it in batches, online                   deploy
3. dual      write both, read old                             deploy
4. switch    read new                                         deploy
5. contract  stop writing old, drop it                        deploy
```

Five deploys where one would do, and that is the point: no step breaks a running exam. **No
migration runs during an open exam window** — see
[`13-environments-and-release.md`](13-environments-and-release.md).

Forward-only. No down migrations: a down migration is either trivially unnecessary or a data-loss
event pretending to be a rollback. Roll forward.

**Conventions.** `snake_case`; plural tables; UUIDv4 primary keys (`gen_random_uuid()`);
`timestamptz` always, never naive; soft delete via `archived_at`, hard delete only for GDPR erasure;
money and scores as `numeric`, never float.

**Transaction boundaries are explicit and shallow.** One transaction per use case, opened at the
service layer, never inside a repository. Nothing that can block — no HTTP call, no queue publish,
no object-store write — happens inside an open transaction. Publish after commit.

**The attempt-start transaction and the finalisation transaction are the two that must be right.**
Attempt start materialises the whole question set atomically (ADR-004); finalisation checks that
every `final_score` is non-null in the same transaction that sets the status. Both carry a comment
naming the ADR and a test for the concurrent case.

---

## 5. Domain rules that are code, not documentation

These are the invariants the product is built on. Each must be enforced at the lowest level that can
enforce it, and each must have a named test.

| Invariant | ADR | Enforced by |
|---|---|---|
| A published `question_version` is never mutated | ADR-003 | Database trigger or rule, plus a `409` at the API, plus a test attempting it as the app role |
| The served question set is written once and never re-rolled | ADR-004 | One transaction at attempt start; a test mutating the bank mid-attempt |
| `deadline_at` is server-computed and never extended by client input | ADR-006 | Computed at start; injectable clock; a test with a manipulated client clock |
| An attempt reaches `finalised` only when every score is non-null | — | Single guarded transaction; a concurrency test |
| No proctoring or AI signal rejects, voids or down-scores | ADR-007, ADR-017 | No such code path exists; a reviewer reads the integrity module at the P6 gate |
| No model sits in the scoring or decision path | ADR-011 | Architecture review; `grading` is pure and has no network import |
| Hidden test-case content never leaves the server | FR-12 | Typed serialisers; the standing leak suite |
| Test-case expectations never enter the sandbox | ADR-002 | The adapter's type signature makes it impossible |
| A published version can always be graded — no coding question published with only visible test cases, no short answer without a key | ADR-003 | `validateKindContent` in `packages/core-domain`, applied at publish on the stored version; a refused publish stamps nothing |
| A version never carries content its kind cannot use | — | The same rule at `wrong_kind` severity, on every version write including `PATCH` — which was a way round it until it was checked there too |

**If an invariant can only be enforced by a person remembering it, it is not enforced.**

---

## 6. Asynchronous work

- **Idempotent by business key.** Grading is idempotent by submission id. A replayed job produces
  an identical result, because at-least-once delivery means replay is normal, not exceptional.
- **Bounded retries with exponential backoff, then a dead-letter queue with an alarm.** A job that
  exhausts retries is visible. It never disappears, and it never silently scores zero — the attempt
  moves to `under_review` and waits for a human.
- **Every queue is declared once** in the registry with concurrency, attempt limit, backoff and
  dead-letter policy. Never configured ad hoc at a call site.
- **Every queue ships with a depth metric and an alarm in the same pull request that creates it.**
  A queue without a depth metric will back up unnoticed during the one hour it matters.
- **No unbounded jobs.** A job that processes "all rows" batches with a cursor and a ceiling.
- **Separate queues by latency class.** Interactive `run` and batch `submit` do not share a queue
  (ADR-008); a batch backlog must never delay a candidate waiting on sample output.

---

- **A sweep that crosses tenants enumerates them elevated and works under RLS.** List organisations through `withElevated` — audited, and named `job.<verb>` so the null-actor row reads as a machine — then do the work per organisation inside `withOrg`. One elevated transaction over every tenant would let a query bug pool one organisation's candidates into another's results with nothing in the database to refuse it. See [`02-HLD.md`](02-HLD.md) §3.4a.

## 7. Security

Derived from [`14-threat-model.md`](14-threat-model.md); that document holds the reasoning.

- **Authorisation is checked per action at the route**, not inferred from a role name (FR-27). A
  route with no explicit permission fails a test that enumerates routes.
- **Treat every submission as hostile.** Execution nodes hold no secrets, no database credentials
  and no cloud role, have no egress, and are recycled. The posture assumes the sandbox will be
  escaped rather than trusting that it will not.
- **A process loads only the configuration it uses.** `loadConfig()` validates the whole application environment and is right for the long-running services. A narrower job — the migration runner is the first — gets a narrow loader (`loadMigrationTarget()`) that asks for exactly what it needs. Otherwise every environment that runs the job must hold secrets the job never touches, which is least privilege failing in configuration rather than in a database grant.
- **Secrets are injected at runtime**, never in the repository, never in an image, never in a log. A password a test needs must look fake on sight — `scripts/check-secrets.mjs` fails the build on one that could pass for real, because a realistic fake is indistinguishable from a leak to both a scanner and a reviewer.
  Rotation cadence per class is in [`13-environments-and-release.md`](13-environments-and-release.md).
- **Tokens are high-entropy, hashed at rest, single-purpose and expiring.** The plaintext is
  returned exactly once. An attempt token grants exactly one attempt and nothing else.
- **All input is parsed at the edge.** No string interpolation into SQL — parameterised queries or
  the query builder, always.
- **Question content is untrusted input.** Authors are trusted, but imported content is not, and
  prompts render as markdown. Sanitise on render; a stored XSS in a question prompt executes in a
  recruiter's session.
- **Customer-supplied webhook URLs are an SSRF surface.** Address-range denylist, no redirect
  following, DNS-rebinding protection, egress proxy.
- **Dependencies:** licence gate on every pull request (ADR-001), SBOM per release, secret scanning,
  and no new dependency without a reviewer asking whether the standard library does it.

---

## 8. Testing

Full strategy in [`06-testing-strategy.md`](06-testing-strategy.md). The standards:

- **Tests are written with the change.** A pull request adding behaviour without a test is
  incomplete, not fast.
- **Pure domain logic is table-driven.** The state machine, the rule resolver, the scoring roll-up
  and the comparison logic are pure precisely so they can be tested exhaustively.
- **Integration tests use a real Postgres** via testcontainers. Never a mock, never SQLite. RLS,
  constraints, transaction semantics and query plans do not exist in a fake.
- **The leak suite is a standing, separately named CI job**, and it grows whenever a
  candidate-facing response is added.
- **Determinism is tested explicitly.** Re-grading reproduces the score exactly; this is an M1 exit
  criterion and a standing test, not a one-off check.
- **Time is injected, never read from the wall clock** in testable code. ADR-006 makes the clock a
  correctness boundary.
- **Coverage is risk-weighted, not a single number.** Scoring, attempt lifecycle, tenancy,
  serialisation and token handling approach exhaustive. A React layout shell does not.
- **A format codec is proven by a round trip that is hostile and strict.** Assert
  `toStrictEqual`, so `null` against `undefined` and `-0` against `0` fail; feed it the text the
  format mangles (for XML: carriage returns, NUL, unpaired surrogates, `]]>`, markup that must stay
  text, whitespace at both ends); and break the codec on purpose once to watch the round trip
  fail. The bank interchange tests in `apps/worker/src/interchange/` were checked that way:
  disabling the text encoding and over-mapping answer keys each fail them.
- **No flaky test is tolerated.** Quarantine within a day, fix or delete within a week. A suite
  people have learned to re-run is a suite that no longer gates anything.

---

## 9. Observability

Standards from [`12-observability-and-runbooks.md`](12-observability-and-runbooks.md):

- Structured JSON logs. Never a token, an answer, hidden test-case content or PII — enforced by the
  redaction deny-list in `packages/observability`, which has its own test.
- Never label a metric with candidate id, attempt id or question id. The helper rejects them.
- Trace context propagates from candidate request through the queue into the worker and the
  execution call. Without it, "why did this candidate's score differ on re-grade" is unanswerable.
- `request_id` in the error envelope is the trace id.
- The audit log is a **domain record**, not telemetry. It lives in Postgres, is append-only, is
  queryable, and is retained for seven years. Do not conflate it with logging.

---

## 10. Performance budgets

From [`01-PRD.md`](01-PRD.md) §8. These are gates in [`07-load-and-capacity-testing.md`](07-load-and-capacity-testing.md),
not aspirations:

| Path | Budget |
|---|---|
| API p95, non-execution | < 300 ms |
| Execution result p95 | < 8 s from submit |
| Editor sync p95, same region | < 150 ms |
| Autosave failure rate | zero |
| Concurrent candidates | 500 sustained, 1000 peak |

**No N+1 queries on any list endpoint** — asserted by a query-count test on the hot paths, because
N+1 is invisible at ten rows and fatal at a thousand. Pagination is mandatory on every collection;
no endpoint returns an unbounded set.

---

## 11. Code review

Reviewers check in this order, most expensive mistake first:

1. **Does it violate an invariant in §5?** Nothing else matters if so.
2. **Can a candidate see something they must not?** Every new response shape, every error path.
3. **Is tenancy enforced?** New table, new query, new background job.
4. **Is it auditable?** Privileged actions write an audit row in the same transaction.
5. **Does it fail safely?** What happens when the database, the queue or the sandbox is down —
   does a candidate lose work, or get scored zero?
6. **Is it tested at the right level?**
7. **Is the migration expand-contract?**
8. **Are the docs updated?** The freshness gate enforces it, but the reviewer judges whether the
   update is honest.
9. Style, naming, structure. Last, because it is cheapest to fix.

**Approve or request changes. Never "LGTM with comments".** If the comments matter, they block; if
they do not, delete them.

---

## 12. Anti-patterns, named

Explicitly not allowed, each because it has a specific failure mode here:

| Anti-pattern | Failure mode |
|---|---|
| A boolean flag deciding whether a response includes answer keys | Passed wrong once, ships answer keys to a candidate |
| Business logic in a database function | Invisible to tests, to review and to the trace |
| `SELECT *` into a serialiser | A new column ships to whoever reads that endpoint |
| Filtering sensitive fields in the frontend | The data already left the server |
| Reading `process.env` outside `packages/config` | Untyped, unvalidated, fails at 02:00 rather than at boot |
| Catching an error to log and rethrow | Duplicate logs, lost stack, no added information |
| A retry without a backoff and a ceiling | Turns a blip into an outage |
| A queue without a depth metric | Backs up unnoticed during the hour it matters |
| Wrapping a library used exactly once | The wrong abstraction, permanently |
| A "temporary" `// TODO` with no task id | Permanent, and nobody knows who owns it |

---

## 13. How this document is maintained

It is a standard, so it changes rarely and deliberately. A new rule requires a reason traceable to
§0 and the enforcement mechanism named alongside it — a rule with no enforcement is a wish.

Where a rule and an ADR disagree, the ADR wins and this document is corrected. Where a rule and the
code disagree, the code is wrong or the rule is obsolete; resolve it rather than leaving the
contradiction standing.
