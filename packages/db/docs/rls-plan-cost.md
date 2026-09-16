# RLS plan cost — the measured baseline

**Status:** draft
**Owner:** _unassigned_ (engineering lead)
**Last updated:** 2026-09-17
**Companion docs:** [`../../../docs/04-ADRs.md`](../../../docs/04-ADRs.md) (ADR-010), [`../../../project/RISKS.md`](../../../project/RISKS.md) (R-09), [`../../../project/P1-TENANCY-PLAN.md`](../../../project/P1-TENANCY-PLAN.md) (step 2), [`../../../docs/07-load-and-capacity-testing.md`](../../../docs/07-load-and-capacity-testing.md)

---

## Why this document exists

ADR-010 accepts a cost in one clause — *"some query plans degrade — measure before
assuming"* — and R-09 turns that into a named risk with a trigger: *"any query plan in the
M0 baseline changing from index scan to sequential scan after a migration."* A trigger needs
a baseline to fire against. This is the baseline.

It is not a performance report. The numbers below are microseconds on a laptop and they
will not resemble production. What they establish is the **shape** of each plan with the
policies applied, so that the day a plan changes there is something to compare against
other than an opinion.

## How it was produced

`packages/db/tests/rls-plan-cost.test.ts`, against real PostgreSQL 16 in a container — the
version `docker-compose.yml` pins, because RLS planning behaviour is version-sensitive
enough that measuring on another major would prove less than it appears to.

| | |
|---|---|
| Volume | 12 organisations, 12,012 attempts, 24,024 `attempt_questions`, 24,024 answers, 4,812 published question versions |
| Fixture | `packages/db/test/volume-fixture.ts` — deterministic, no `random()`, `ANALYZE`d before capture |
| RLS **on** | `hiring_app`, inside `withOrg(orgId, …)`; policies apply |
| RLS **off** | `hiring_job`, which has `BYPASSRLS` (ADR-010); byte-identical SQL, no policy |
| Sampling | 7 runs per plan, first discarded cold, median by execution time |
| Machine | Apple Silicon, Docker Desktop 28.1.1, `postgres:16-alpine` defaults (no tuning) |

Twelve organisations rather than one is load-bearing. With a single tenant
`org_id = app_current_org()` is true for every row, the policy costs nothing by
construction, and the measurement is guaranteed to be wrong in the flattering direction.

Four of the five queries carry **no `org_id` predicate of their own**. That is the point:
under ADR-010 the application does not filter by tenant, the policy does. Measuring a query
that already says `WHERE org_id = $1` would measure a redundant predicate and conclude that
RLS is free.

To re-capture: `pnpm --filter @assaybank/db test tests/rls-plan-cost.test.ts`, then read
`packages/db/out/rls-plan-cost.md`. That path is build output and git-ignored on purpose —
timings differ per machine, and a suite that rewrites a committed document on every run
leaves CI with a dirty tree and the reader with no idea which numbers anyone reviewed.

## The result, in one table

| Query | Planning (off → on) | Execution (off → on) | Buffers (off → on) | Verdict |
|---|---|---|---|---|
| `attempt-read` | 0.010 → 0.029 ms | 0.011 → 0.016 ms | 3 → 3 | Free. Same plan plus a filter |
| `served-question-set` | 0.072 → 0.132 ms | 0.025 → 0.045 ms | 9 → 21 | Two extra primary-key lookups per row |
| `attempt-answers` | 0.066 → 0.154 ms | 0.017 → 0.056 ms | 9 → 27 | Three extra primary-key lookups per row |
| `staff-attempt-page` | 0.016 → 0.026 ms | 0.059 → 0.117 ms | 20 → 21 | **Index condition narrowed** — see finding 2 |
| `finalisation-guard` | 0.059 → 0.158 ms | 0.019 → 0.063 ms | 9 → 21 | Three extra primary-key lookups per row |

**No query on this list degraded to a sequential scan, and no query changed how it reaches
a table that grows without bound.** R-09's trigger did not fire. That is the headline, and
it is a useful result rather than a boring one: it means the policies as written in
migration `0002_rls` are index-satisfiable, which was the thing nobody could claim before
somebody measured it.

Two findings underneath the headline are worth carrying forward.

## Finding 1 — the `EXISTS` policies cost a primary-key lookup per row, per level

Every table in migration 0002's **Group B** — `attempt_questions`, `answers`,
`question_versions` and eighteen others — has no `org_id` of its own and reaches its
organisation through a foreign key. Their policies are `EXISTS (SELECT 1 FROM parent …)`,
and the planner implements each one as a `SubPlan` executed **once per candidate row**.

`answers` is two levels deep (`answers` → `attempt_questions` → `attempts`), so reading one
attempt's answers under RLS performs three extra index lookups per row where the same query
under `BYPASSRLS` performs none. That is the 9 → 27 buffer count, and the 3.3× execution
time.

Three things make this acceptable rather than alarming:

1. **Every one of those lookups is a primary-key index scan.** Not one degenerated into a
   scan — the chain is `attempts_pkey`, `attempt_questions_pkey`, `questions_pkey`. R-09's
   mitigation asked for policy predicates to be index-satisfiable and they are.
2. **The multiplier applies to a tiny row count.** These queries are scoped to one attempt,
   so "per row" is two rows, not two hundred thousand. Three lookups × two rows is six
   buffer hits, and 39 microseconds.
3. **The absolute numbers are in the noise of a network round trip.** The slowest query here
   is 0.117 ms against an NFR of 300 ms at p95. Two orders of magnitude of headroom.

The place this stops being true is a query that returns many child rows — a report over a
whole cohort's answers, or the psychometrics job reading `attempt_questions` across a
question version. Those are P5 and P7 work, they are the queries R-09 says will show the
symptom first, and they belong in the load scenarios in `docs/07-load-and-capacity-testing.md`
rather than in this per-attempt baseline. **Re-measure this document when the first
cohort-wide report exists.**

## Finding 2 — a composite index loses its trailing column under RLS

This is the one real degradation, and it is worth understanding because it will recur on
every future listing query.

`attempts_org_id_status_idx` is `(org_id, status)`. The staff list query filters on both
columns. Without RLS both go into the index condition and 167 index entries are read. With
RLS the index condition keeps `org_id` and drops `status` to a heap filter:

```
-- without RLS
->  Bitmap Index Scan on attempts_org_id_status_idx (rows=167)
      Index Cond: ((org_id = '…') AND (status = 'submitted'))

-- with RLS
->  Bitmap Index Scan on attempts_org_id_status_idx (rows=1001)
      Index Cond: (org_id = '…')
    Filter: (status = 'submitted')
    Rows Removed by Filter: 834
```

Six times the index entries, and 834 heap tuples fetched and discarded.

**Why.** A row-level-security qual is a security barrier. PostgreSQL will not evaluate a
user qual before a security qual unless the user qual's operator is marked `LEAKPROOF`,
because a leaky operator could report the contents of a row the policy was about to hide
through an error message or a timing difference. And:

```
uuid_eq(uuid, uuid)                      leakproof = true
texteq(text, text)                       leakproof = true
int4eq(integer, integer)                 leakproof = true
timestamptz_lt(timestamptz, timestamptz) leakproof = true
enum_eq(anyenum, anyenum)                leakproof = false
```

`status` is a PostgreSQL enum. `enum_eq` is not leakproof, so it cannot be pushed beneath
the policy and into the index condition. Nothing about our schema is wrong; the enum type is
the right model for a state machine. This is a property of RLS and enums together, and it
will apply to **every future index whose trailing column is an enum** — `questions.status`,
`questions.kind`, `applications.stage`.

**The cost is bounded.** `org_id` is still an index condition, so the worst case is "all of
one organisation's attempts", never "all attempts". The blast radius is one tenant's data
volume, which is the property multi-tenancy was supposed to give us.

**The mitigation, verified rather than guessed.** A partial index moves the enum predicate
out of the runtime quals entirely: a partial index's predicate is proved at *planning* time,
where leakproofness does not apply. Reproduced on the same engine, same shape, 12,000 rows
across 12 organisations:

```
-- with (org_id, status) only
->  Bitmap Index Scan on t_org_status (rows=1000)
      Index Cond: (org_id = '…')
    Filter: (status = 'submitted')          Rows Removed by Filter: 833

-- after CREATE INDEX … ON t (org_id, created_at DESC) WHERE status = 'submitted'
->  Bitmap Index Scan on t_org_created_submitted (rows=167)
      Recheck Cond: ((org_id = '…') AND (status = 'submitted'))
    (no Filter, no rows removed)
```

167 index entries instead of 1000, and the filter disappears.

**Not applied yet, deliberately.** The staff list is 0.117 ms at a thousand attempts per
organisation and there is no staff console to be slow. An index added before the query that
needs it is an index nobody can later justify removing. The recommendation is recorded here
with its evidence so that P5, when the console is built against real cohort volume, can
apply it in one line rather than rediscover it.

## What is gated in CI, and what is not

`tests/rls-plan-cost.test.ts` asserts three things and measures a fourth.

| | Asserted | Why this one |
|---|---|---|
| No sequential scan over `attempts`, `attempt_questions`, `answers`, `candidates`, `submissions`, `audit_log` or `proctor_events` under RLS | yes | R-09's trigger, restricted to the tables that grow with usage. A sequential scan over `assessments` is forty rows forever; one over `answers` is everything every candidate has ever typed |
| Every one of those tables is reached the same way with RLS on and off | yes | Join order and join method may legitimately change, because the policy predicates alter row estimates. How a large relation is reached is the part whose cost scales |
| The RLS arm actually had the policy applied, and the `BYPASSRLS` arm did not | yes | The vacuity control. If the "with RLS" arm ever ran as a bypassing role, every plan would match perfectly and every assertion would pass while proving the opposite of what it claims |
| Planning and execution time | **no** | At tens of microseconds, run-to-run noise exceeds the effect. A threshold here is a flaky test wearing the costume of a performance gate. Numbers are evidence for a human; plan shape is the gate |

## Policy changes since the capture

Migration 0008 (2026-09-17) replaced the single policy on `skills` and `user_roles` with one policy
per command, so a tenant can no longer delete or claim a shared global row. Neither table is on the
gated list, and the `SELECT` predicate is character-for-character the one 0002 created, so no plan
above is affected. Nothing was re-measured.

## When to re-read this

- Any migration that adds, drops or redefines a policy on a table in the list above.
- The first query that returns many child rows at once — a cohort report, the psychometrics
  job. Finding 1 says that is where the per-row `SubPlan` stops being free. The psychometrics
  sweep now exists (`readItemResponses`, 2026-09-17) and reads every finalised answer in a tenant;
  its plan has **not** been captured here yet.
- The first staging load run (`docs/07-load-and-capacity-testing.md`). R-09's trigger is
  "API p95 above 250 ms on any non-execution endpoint"; these plans are the first place to
  look when it fires.

---

# The captured plans

Verbatim output of `EXPLAIN (ANALYZE, BUFFERS)`, both arms, for each query.

## Read one attempt by id (`attempt-read`)

The single hottest tenant-scoped statement in the system. Every heartbeat, every autosave and every page of the candidate runner reconciles against this row, and ADR-006 makes it the authority for the countdown, so it is on the path of every candidate every few seconds for the whole of an exam window.

```sql
SELECT id, status, started_at, deadline_at, submitted_at
        FROM attempts
       WHERE id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid
```

### Without RLS — `hiring_job`, `BYPASSRLS`

```
Index Scan using attempts_pkey on attempts  (cost=0.29..8.30 rows=1 width=44) (actual time=0.006..0.006 rows=1 loops=1)
  Index Cond: (id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid)
  Buffers: shared hit=3
Planning Time: 0.010 ms
Execution Time: 0.011 ms
```

### With RLS — `hiring_app`, inside `withOrg`

```
Index Scan using attempts_pkey on attempts  (cost=0.29..8.32 rows=1 width=44) (actual time=0.008..0.009 rows=1 loops=1)
  Index Cond: (id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid)
  Filter: (org_id = (NULLIF(current_setting('app.current_org'::text, true), ''::text))::uuid)
  Buffers: shared hit=3
Planning Time: 0.029 ms
Execution Time: 0.016 ms
```

## Read the materialised question set for an attempt (`served-question-set`)

ADR-004: the served set is written once at attempt start and read back verbatim on start, on resume and on every re-grade. It joins the bank, so it is the query where a policy on a child table (`question_versions` reaches its org through `questions`) has the most room to turn a lookup into a join.

```sql
SELECT aq.id, aq.ordinal, aq.max_score, qv.id AS version_id, qv.difficulty
        FROM attempt_questions aq
        JOIN question_versions qv ON qv.id = aq.question_version_id
       WHERE aq.attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid
       ORDER BY aq.ordinal
```

### Without RLS — `hiring_job`, `BYPASSRLS`

```
Sort  (cost=28.43..28.43 rows=2 width=43) (actual time=0.010..0.010 rows=2 loops=1)
  Sort Key: aq.ordinal
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=9
  ->  Nested Loop  (cost=4.59..28.42 rows=2 width=43) (actual time=0.005..0.006 rows=2 loops=1)
        Buffers: shared hit=9
        ->  Bitmap Heap Scan on attempt_questions aq  (cost=4.30..11.81 rows=2 width=41) (actual time=0.002..0.002 rows=2 loops=1)
              Recheck Cond: (attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid)
              Heap Blocks: exact=1
              Buffers: shared hit=3
              ->  Bitmap Index Scan on attempt_questions_attempt_id_ordinal_key  (cost=0.00..4.30 rows=2 width=0) (actual time=0.001..0.001 rows=2 loops=1)
                    Index Cond: (attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid)
                    Buffers: shared hit=2
        ->  Index Scan using question_versions_pkey on question_versions qv  (cost=0.28..8.30 rows=1 width=18) (actual time=0.002..0.002 rows=1 loops=2)
              Index Cond: (id = aq.question_version_id)
              Buffers: shared hit=6
Planning:
  Buffers: shared hit=12
Planning Time: 0.072 ms
Execution Time: 0.025 ms
```

### With RLS — `hiring_app`, inside `withOrg`

```
Sort  (cost=45.08..45.09 rows=1 width=43) (actual time=0.018..0.019 rows=2 loops=1)
  Sort Key: aq.ordinal
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=21
  ->  Nested Loop  (cost=4.59..45.07 rows=1 width=43) (actual time=0.012..0.016 rows=2 loops=1)
        Buffers: shared hit=21
        ->  Bitmap Heap Scan on attempt_questions aq  (cost=4.30..28.44 rows=1 width=41) (actual time=0.006..0.007 rows=2 loops=1)
              Recheck Cond: (attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid)
              Filter: (SubPlan 1)
              Heap Blocks: exact=1
              Buffers: shared hit=9
              ->  Bitmap Index Scan on attempt_questions_attempt_id_ordinal_key  (cost=0.00..4.30 rows=2 width=0) (actual time=0.001..0.001 rows=2 loops=1)
                    Index Cond: (attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid)
                    Buffers: shared hit=2
              SubPlan 1
                ->  Index Scan using attempts_pkey on attempts a  (cost=0.29..8.32 rows=1 width=0) (actual time=0.002..0.002 rows=1 loops=2)
                      Index Cond: (id = aq.attempt_id)
                      Filter: (org_id = (NULLIF(current_setting('app.current_org'::text, true), ''::text))::uuid)
                      Buffers: shared hit=6
        ->  Index Scan using question_versions_pkey on question_versions qv  (cost=0.28..16.61 rows=1 width=18) (actual time=0.004..0.004 rows=1 loops=2)
              Index Cond: (id = aq.question_version_id)
              Filter: (SubPlan 3)
              Buffers: shared hit=12
              SubPlan 3
                ->  Index Scan using questions_pkey on questions q  (cost=0.28..8.31 rows=1 width=0) (actual time=0.002..0.002 rows=1 loops=2)
                      Index Cond: (id = qv.question_id)
                      Filter: (org_id = (NULLIF(current_setting('app.current_org'::text, true), ''::text))::uuid)
                      Buffers: shared hit=6
Planning:
  Buffers: shared hit=12
Planning Time: 0.132 ms
Execution Time: 0.045 ms
```

## Read an attempt's answers (`attempt-answers`)

The autosave and resume path. `answers` has no tenant key of its own and reaches its organisation through `attempt_questions` and `attempts`, so its policy is a two-level EXISTS — the most expensive predicate shape in migration 0002, on the largest table in the schema.

```sql
SELECT a.id, a.attempt_question_id, a.seconds_spent, a.final_score
        FROM answers a
        JOIN attempt_questions aq ON aq.id = a.attempt_question_id
       WHERE aq.attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid
```

### Without RLS — `hiring_job`, `BYPASSRLS`

```
Nested Loop  (cost=4.59..28.43 rows=2 width=43) (actual time=0.005..0.006 rows=2 loops=1)
  Buffers: shared hit=9
  ->  Bitmap Heap Scan on attempt_questions aq  (cost=4.30..11.81 rows=2 width=16) (actual time=0.001..0.002 rows=2 loops=1)
        Recheck Cond: (attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid)
        Heap Blocks: exact=1
        Buffers: shared hit=3
        ->  Bitmap Index Scan on attempt_questions_attempt_id_ordinal_key  (cost=0.00..4.30 rows=2 width=0) (actual time=0.001..0.001 rows=2 loops=1)
              Index Cond: (attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid)
              Buffers: shared hit=2
  ->  Index Scan using answers_attempt_question_id_key on answers a  (cost=0.29..8.30 rows=1 width=43) (actual time=0.002..0.002 rows=1 loops=2)
        Index Cond: (attempt_question_id = aq.id)
        Buffers: shared hit=6
Planning:
  Buffers: shared hit=12
Planning Time: 0.066 ms
Execution Time: 0.017 ms
```

### With RLS — `hiring_app`, inside `withOrg`

```
Nested Loop  (cost=4.59..53.37 rows=1 width=43) (actual time=0.015..0.020 rows=2 loops=1)
  Buffers: shared hit=27
  ->  Bitmap Heap Scan on attempt_questions aq  (cost=4.30..28.44 rows=1 width=16) (actual time=0.006..0.007 rows=2 loops=1)
        Recheck Cond: (attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid)
        Filter: (SubPlan 7)
        Heap Blocks: exact=1
        Buffers: shared hit=9
        ->  Bitmap Index Scan on attempt_questions_attempt_id_ordinal_key  (cost=0.00..4.30 rows=2 width=0) (actual time=0.001..0.001 rows=2 loops=1)
              Index Cond: (attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid)
              Buffers: shared hit=2
        SubPlan 7
          ->  Index Scan using attempts_pkey on attempts a_2  (cost=0.29..8.32 rows=1 width=0) (actual time=0.002..0.002 rows=1 loops=2)
                Index Cond: (id = aq.attempt_id)
                Filter: (org_id = (NULLIF(current_setting('app.current_org'::text, true), ''::text))::uuid)
                Buffers: shared hit=6
  ->  Index Scan using answers_attempt_question_id_key on answers a  (cost=0.29..24.93 rows=1 width=43) (actual time=0.006..0.006 rows=1 loops=2)
        Index Cond: (attempt_question_id = aq.id)
        Filter: (SubPlan 3)
        Buffers: shared hit=18
        SubPlan 3
          ->  Index Scan using attempt_questions_pkey on attempt_questions aq_1  (cost=0.29..16.62 rows=1 width=0) (actual time=0.004..0.004 rows=1 loops=2)
                Index Cond: (id = a.attempt_question_id)
                Filter: (SubPlan 1)
                Buffers: shared hit=12
                SubPlan 1
                  ->  Index Scan using attempts_pkey on attempts a_1  (cost=0.29..8.32 rows=1 width=0) (actual time=0.002..0.002 rows=1 loops=2)
                        Index Cond: (id = aq_1.attempt_id)
                        Filter: (org_id = (NULLIF(current_setting('app.current_org'::text, true), ''::text))::uuid)
                        Buffers: shared hit=6
Planning:
  Buffers: shared hit=12
Planning Time: 0.154 ms
Execution Time: 0.056 ms
```

## One page of the staff attempt list (`staff-attempt-page`)

The recruiter console, and the only query here that names `org_id` itself — a listing has no other way to scope. It is the case where the policy predicate is redundant with the query predicate, and therefore the case that shows what a duplicated predicate costs on an ordered index page.

```sql
SELECT id, candidate_id, status, created_at
        FROM attempts
       WHERE org_id = 'a3f451fb-55b4-4459-acc8-727088f697bd'::uuid
         AND status = 'submitted'
       ORDER BY created_at DESC
       LIMIT 50
```

### Without RLS — `hiring_job`, `BYPASSRLS`

```
Limit  (cost=217.39..217.51 rows=50 width=44) (actual time=0.042..0.046 rows=50 loops=1)
  Buffers: shared hit=20
  ->  Sort  (cost=217.39..217.80 rows=167 width=44) (actual time=0.041..0.043 rows=50 loops=1)
        Sort Key: created_at DESC
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=20
        ->  Bitmap Heap Scan on attempts  (cost=6.00..211.84 rows=167 width=44) (actual time=0.008..0.026 rows=167 loops=1)
              Recheck Cond: ((org_id = 'a3f451fb-55b4-4459-acc8-727088f697bd'::uuid) AND (status = 'submitted'::attempt_status))
              Heap Blocks: exact=18
              Buffers: shared hit=20
              ->  Bitmap Index Scan on attempts_org_id_status_idx  (cost=0.00..5.96 rows=167 width=0) (actual time=0.006..0.006 rows=167 loops=1)
                    Index Cond: ((org_id = 'a3f451fb-55b4-4459-acc8-727088f697bd'::uuid) AND (status = 'submitted'::attempt_status))
                    Buffers: shared hit=2
Planning Time: 0.016 ms
Execution Time: 0.059 ms
```

### With RLS — `hiring_app`, inside `withOrg`

```
Limit  (cost=240.41..240.53 rows=50 width=44) (actual time=0.092..0.095 rows=50 loops=1)
  Buffers: shared hit=21
  ->  Sort  (cost=240.41..240.83 rows=167 width=44) (actual time=0.092..0.093 rows=50 loops=1)
        Sort Key: created_at DESC
        Sort Method: top-N heapsort  Memory: 28kB
        Buffers: shared hit=21
        ->  Result  (cost=15.85..234.86 rows=167 width=44) (actual time=0.019..0.076 rows=167 loops=1)
              One-Time Filter: ((NULLIF(current_setting('app.current_org'::text, true), ''::text))::uuid = 'a3f451fb-55b4-4459-acc8-727088f697bd'::uuid)
              Buffers: shared hit=21
              ->  Bitmap Heap Scan on attempts  (cost=15.85..234.86 rows=167 width=44) (actual time=0.017..0.064 rows=167 loops=1)
                    Recheck Cond: (org_id = 'a3f451fb-55b4-4459-acc8-727088f697bd'::uuid)
                    Filter: (status = 'submitted'::attempt_status)
                    Rows Removed by Filter: 834
                    Heap Blocks: exact=18
                    Buffers: shared hit=21
                    ->  Bitmap Index Scan on attempts_org_id_status_idx  (cost=0.00..15.79 rows=1001 width=0) (actual time=0.015..0.015 rows=1001 loops=1)
                          Index Cond: (org_id = 'a3f451fb-55b4-4459-acc8-727088f697bd'::uuid)
                          Buffers: shared hit=3
Planning Time: 0.026 ms
Execution Time: 0.117 ms
```

## May this attempt be finalised? (`finalisation-guard`)

docs/17 §4: an attempt reaches `finalised` only when every `final_score` is non-null, checked in the same transaction that sets the status. It runs inside the finalisation transaction, so its cost is lock-holding time on the row every other writer for that attempt is queued behind.

```sql
SELECT count(*)::int AS unscored
        FROM attempt_questions aq
        JOIN answers a ON a.attempt_question_id = aq.id
       WHERE aq.attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid
         AND a.final_score IS NULL
```

### Without RLS — `hiring_job`, `BYPASSRLS`

```
Aggregate  (cost=28.43..28.44 rows=1 width=4) (actual time=0.006..0.006 rows=1 loops=1)
  Buffers: shared hit=9
  ->  Nested Loop  (cost=4.59..28.43 rows=1 width=0) (actual time=0.005..0.006 rows=1 loops=1)
        Buffers: shared hit=9
        ->  Bitmap Heap Scan on attempt_questions aq  (cost=4.30..11.81 rows=2 width=16) (actual time=0.001..0.001 rows=2 loops=1)
              Recheck Cond: (attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid)
              Heap Blocks: exact=1
              Buffers: shared hit=3
              ->  Bitmap Index Scan on attempt_questions_attempt_id_ordinal_key  (cost=0.00..4.30 rows=2 width=0) (actual time=0.001..0.001 rows=2 loops=1)
                    Index Cond: (attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid)
                    Buffers: shared hit=2
        ->  Index Scan using answers_attempt_question_id_key on answers a  (cost=0.29..8.30 rows=1 width=16) (actual time=0.002..0.002 rows=0 loops=2)
              Index Cond: (attempt_question_id = aq.id)
              Filter: (final_score IS NULL)
              Rows Removed by Filter: 0
              Buffers: shared hit=6
Planning:
  Buffers: shared hit=12
Planning Time: 0.059 ms
Execution Time: 0.019 ms
```

### With RLS — `hiring_app`, inside `withOrg`

```
Aggregate  (cost=53.38..53.39 rows=1 width=4) (actual time=0.018..0.019 rows=1 loops=1)
  Buffers: shared hit=21
  ->  Nested Loop  (cost=4.59..53.38 rows=1 width=0) (actual time=0.018..0.018 rows=1 loops=1)
        Buffers: shared hit=21
        ->  Bitmap Heap Scan on attempt_questions aq  (cost=4.30..28.44 rows=1 width=16) (actual time=0.006..0.007 rows=2 loops=1)
              Recheck Cond: (attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid)
              Filter: (SubPlan 1)
              Heap Blocks: exact=1
              Buffers: shared hit=9
              ->  Bitmap Index Scan on attempt_questions_attempt_id_ordinal_key  (cost=0.00..4.30 rows=2 width=0) (actual time=0.001..0.001 rows=2 loops=1)
                    Index Cond: (attempt_id = '006a2e22-bcfb-490d-ad1e-adb55e74e3b2'::uuid)
                    Buffers: shared hit=2
              SubPlan 1
                ->  Index Scan using attempts_pkey on attempts a_1  (cost=0.29..8.32 rows=1 width=0) (actual time=0.002..0.002 rows=1 loops=2)
                      Index Cond: (id = aq.attempt_id)
                      Filter: (org_id = (NULLIF(current_setting('app.current_org'::text, true), ''::text))::uuid)
                      Buffers: shared hit=6
        ->  Index Scan using answers_attempt_question_id_key on answers a  (cost=0.29..24.93 rows=1 width=16) (actual time=0.005..0.005 rows=0 loops=2)
              Index Cond: (attempt_question_id = aq.id)
              Filter: ((final_score IS NULL) AND (SubPlan 5))
              Rows Removed by Filter: 0
              Buffers: shared hit=12
              SubPlan 5
                ->  Index Scan using attempt_questions_pkey on attempt_questions aq_1  (cost=0.29..16.62 rows=1 width=0) (actual time=0.007..0.007 rows=1 loops=1)
                      Index Cond: (id = a.attempt_question_id)
                      Filter: (SubPlan 3)
                      Buffers: shared hit=6
                      SubPlan 3
                        ->  Index Scan using attempts_pkey on attempts a_2  (cost=0.29..8.32 rows=1 width=0) (actual time=0.003..0.003 rows=1 loops=1)
                              Index Cond: (id = aq_1.attempt_id)
                              Filter: (org_id = (NULLIF(current_setting('app.current_org'::text, true), ''::text))::uuid)
                              Buffers: shared hit=3
Planning:
  Buffers: shared hit=12
Planning Time: 0.158 ms
Execution Time: 0.063 ms
```
