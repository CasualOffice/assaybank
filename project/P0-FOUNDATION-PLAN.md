# P0 — Foundation build plan

**Status:** draft
**Owner:** _unassigned_ (engineering lead)
**Last updated:** 2026-09-15
**Companion docs:** [`ROADMAP.md`](ROADMAP.md), [`../docs/17-engineering-standards.md`](../docs/17-engineering-standards.md), [`../CODE-GRAPH.md`](../CODE-GRAPH.md), [`../docs/13-environments-and-release.md`](../docs/13-environments-and-release.md), [`DEFINITION-OF-DONE.md`](DEFINITION-OF-DONE.md)

---

## Why this document exists separately

Every other phase in [`ROADMAP.md`](ROADMAP.md) builds features against an existing skeleton. P0
builds the skeleton, and it is the only phase where getting the order wrong is expensive — a
package built before the thing it depends on gets a shape that fits nothing, and a test harness
added after the code it should have driven never catches up.

Two weeks, ten working days, 2026-09-21 → 2026-10-02. One engineer. Each step below states what it
produces, the decisions that are already made and are not reopened, how it is verified, and what
"done" means. Steps are strictly ordered unless marked parallel.

**The discipline that makes this phase work:** every package gets an interface, a test and a real
consumer before it gets an implementation. A package with no consumer is speculation, and P0 is
where speculation is cheapest to write and most expensive to keep.

---

## Day allocation

| Days | Steps | Output |
|---|---|---|
| 1 | 1–2 | Workspace and toolchain compiling and linting |
| 2 | 3–4 | Config and observability packages with consumers |
| 3–4 | 5–6 | Contracts package and the database package with migrations |
| 5 | 7 | RLS harness and the first negative test |
| 6–7 | 8–10 | api, worker and collab skeletons running under compose |
| 8 | 11 | web and candidate skeletons with the accessibility baseline |
| 9 | 12–13 | Test harness complete, leak suite seeded |
| 10 | 14–15 | CI enforcing, SBOM, exit gate |

Two days of this fortnight are unallocated on purpose. They will be used. If they are not, the
phase closes early and P1 starts early — do not fill them with scaffolding nobody asked for.

---

## Step 1 — Workspace skeleton

**Produces.** `package.json` (root, private, `packageManager` pinned), `pnpm-workspace.yaml`,
`turbo.json`, `tsconfig.base.json`, per-workspace `tsconfig.json`, `.npmrc`.

The fourteen workspaces from [`../CODE-GRAPH.md`](../CODE-GRAPH.md) are created now, each with a
`package.json`, an `src/index.ts` exporting nothing yet, and a passing empty test. Creating all of
them up front means the dependency graph and the layering lint rule are correct from day one rather
than being discovered in P2.

**Already decided, do not reopen.** pnpm + Turborepo, Node 22, TypeScript 5.x (ADR-012, ADR-013).

**TypeScript configuration is a one-way door.** Turn the strict flags on now, when there is no code
to fix:

```
strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride,
noFallthroughCasesInSwitch, noUnusedLocals, noUnusedParameters,
verbatimModuleSyntax, isolatedModules, moduleResolution: "bundler" | "node16"
```

`noUncheckedIndexedAccess` in particular is miserable to adopt later and catches a whole class of
bug in the scoring and draw-resolution code that P2 and P3 will write.

**Verified by.** `pnpm install && pnpm -r typecheck` clean across fourteen workspaces.

**Done when.** A new workspace can be added with one command and is picked up by turbo, lint and
typecheck with no further wiring.

---

## Step 2 — Toolchain and guard rails

**Produces.** ESLint flat config, Prettier, `lint-staged`, a commit hook, `commitlint`.

**The layering rule is the important part.** [`../CODE-GRAPH.md`](../CODE-GRAPH.md) declares
directions that must hold: apps may import packages; packages must never import apps;
`core-domain` and `grading` must import no I/O at all. Encode that as a lint rule
(`import/no-restricted-paths` or equivalent) in this step, so the first violation fails a pull
request rather than being found in a review six weeks later.

**Verified by.** A deliberate violation — `packages/core-domain` importing `packages/db` — fails
`pnpm lint`. Write that as a fixture test, do not just try it once by hand.

**Done when.** `pnpm lint`, `pnpm format:check` and `pnpm typecheck` all run from the root and from
any single workspace, and the layering fixture fails as intended.

---

## Step 3 — `packages/config`

**Produces.** One zod schema covering every variable in
[`../docs/13-environments-and-release.md`](../docs/13-environments-and-release.md)'s reference
table, parsed once at boot, exported as a typed frozen object.

**Rules.** It fails fast and loudly — a missing or malformed variable stops the process with a
message naming the variable and what was expected, never a `undefined` that surfaces as a
confusing error three layers deep at 02:00. No `process.env` access anywhere else in the codebase;
that is a lint rule, added here.

Secrets are read but never logged, and the module exposes a redacted `toString` so an accidental
`console.log(config)` cannot leak `SESSION_SECRET` or `TOKEN_PEPPER`.

**Verified by.** Unit tests for a missing required variable, a malformed URL, an out-of-range
number, and the redaction behaviour. A test asserts the schema and `.env.example` agree in both
directions — a variable in one and not the other fails.

**Done when.** That last test passes, which makes `.env.example` executable documentation rather
than a file that drifts.

---

## Step 4 — `packages/observability`

**Produces.** Structured JSON logger, OpenTelemetry bootstrap, Prometheus metrics registry, and the
request-context helper that carries trace id and org id.

**Rules from [`../docs/12-observability-and-runbooks.md`](../docs/12-observability-and-runbooks.md),
implemented here rather than documented and hoped for:**

- The log redaction deny-list is code. Tokens, answers, hidden test-case content and PII never reach
  a log line. A unit test feeds an object containing each forbidden field and asserts the output.
- Metric label cardinality is bounded by construction — a helper rejects candidate id, attempt id
  and question id as label values. Unbounded cardinality kills a Prometheus instance, and it is
  much easier to prevent in a wrapper than to find later.
- `request_id` in the error envelope is the trace id, so a support ticket resolves to a trace.

**Verified by.** Redaction tests; a cardinality test asserting the forbidden labels throw; a trace
propagated end to end once api and worker exist (revisit at step 9).

---

## Step 5 — `packages/contracts`

**Produces.** The error envelope, the stable error-code enum from
[`../docs/03-API-spec.md`](../docs/03-API-spec.md) §2, shared zod primitives (UUID, RFC 3339
timestamp, cursor, pagination envelope), and OpenAPI 3.1 emission.

**Why this precedes the API.** The error format, the pagination shape and the idempotency semantics
are cross-cutting. Defining them after two endpoints exist means two endpoints that do it
differently, and API consistency is one of the things this repository is explicitly trying to get
right.

**Rules.** Error codes are a closed union; adding one is a deliberate edit. Clients branch on
`code`, never on `message` — so `message` is allowed to change and `code` is not. The OpenAPI
document is generated from the zod schemas, never hand-maintained, and CI fails if the committed
document differs from the generated one.

**Verified by.** A generated OpenAPI document that validates against the 3.1 meta-schema, and a
drift check in CI.

---

## Step 6 — `packages/db`

**Produces.** Drizzle schema modelling
[`../docs/hiring_platform_schema.sql`](../docs/hiring_platform_schema.sql), migration tooling, and
migration `0001_initial`.

**The important change this step makes.** Today the schema is a `.sql` file mounted into the
Postgres container. From this step it is a migration, and the mounted file stops being the source of
truth. That transition happens once, here, and
[`../infra/postgres/init/02-schema.sql`](../infra/postgres/init/02-schema.sql) is updated in the
same change so the two cannot disagree.

**Rules.**

- Expand-contract from migration 0001, per [`../docs/17-engineering-standards.md`](../docs/17-engineering-standards.md).
  The habit costs nothing now and is the only thing that lets a migration run without breaking an
  exam window later.
- Migrations are forward-only and idempotent to re-run.
- Constraints live in the database. A check that can be expressed as a constraint is not expressed
  in application code, because application code is not the only writer — background jobs and
  migrations are too.
- `timestamptz` everywhere, never naive timestamps.

**Verified by.** `make migrate` twice: the second run is a no-op. A testcontainers integration test
applies all migrations to an empty database and asserts the resulting schema matches the Drizzle
model.

---

## Step 7 — Tenancy and the RLS harness

**Produces.** The connection-pool hook that sets `app.current_org` per checkout, the elevated
background-job role, RLS policies on every tenant table, and the **generated** RLS test suite.

**This is the highest-value step in P0.** ADR-010 is only worth anything if it is complete, and
"complete" means no tenant table was missed. So the test is generated from the schema, not written
by hand:

> For every table carrying an `org_id` column, assert that a query executed as org A returns zero
> rows belonging to org B, for select, update and delete.

A new tenant table added in P2 without a policy fails this suite automatically. A hand-written
suite would not have that property, and the one table someone forgets is the one that leaks.

**Also here.** Measure the query-plan cost of RLS now, on seeded data, and record the numbers.
Risk `R-09` says plans can degrade; discovering that at P7 under load is too late.

**Verified by.** The generated suite passing, and a deliberate fixture — a table with `org_id` and
no policy — failing it.

**Done when.** Cross-org isolation is proven by test on every table that exists, and cannot be
silently lost by adding a table.

---

## Step 8 — `apps/api` skeleton

**Produces.** Fastify server with `/healthz`, `/readyz`, `/metrics`, the global error handler, the
request-context plugin, graceful shutdown, and the OpenAPI route.

**Rules.**

- Every response goes through the typed serialiser. No route returns a database row directly — that
  is the habit that eventually ships `is_correct` to a candidate.
- The error handler converts any unhandled throw into the standard envelope with a `request_id`,
  and logs the cause without leaking it to the client.
- `/readyz` checks its dependencies (database, Valkey); `/healthz` does not. Conflating them means a
  transient database blip restarts every API pod at once.
- Graceful shutdown drains in-flight requests before exit.

**Verified by.** An integration test that forces an unhandled error and asserts the envelope shape
and that no stack trace reaches the client.

---

## Step 9 — `apps/worker` skeleton

**Produces.** BullMQ setup, the six-queue registry from `code-graph.json`, a no-op job with full
lifecycle, dead-letter wiring, queue-depth metrics, graceful shutdown.

**Rules.** Every queue is registered in one place with its concurrency, attempt limit, backoff and
dead-letter behaviour — not configured ad hoc at each call site. Jobs are idempotent by their
business key from the first one. A job that exhausts retries lands in the dead-letter queue and
raises an alarm; it never silently disappears.

**Verified by.** A job that always fails reaches the dead-letter queue and increments the alarm
metric. Trace context propagates from an API request through the queue into the worker — this
completes step 4's deferred verification.

---

## Step 10 — `apps/collab` skeleton

**Produces.** y-websocket server, ticket validation before upgrade, a metrics endpoint.

**Rules.** The ticket is checked before the WebSocket upgrade completes, not after. Tickets are
single-use with a 60-second life. No document logic yet — that is P5 — but the security boundary is
built now, because a service that starts life accepting unauthenticated upgrades tends to keep a
path that does.

**Verified by.** Connection without a ticket is refused; a reused ticket is refused.

---

## Step 11 — `apps/web` and `apps/candidate` skeletons

**Produces.** Two Vite + React + TanStack Router applications, shared `packages/ui` with design
tokens (the palette from [`../brand/README.md`](../brand/README.md)), a layout shell, an error
boundary, and the accessibility baseline.

**Why two applications and not one (ADR-013).** A separate candidate bundle means staff-only code,
correct-answer handling and question-bank access cannot reach a candidate's browser through a
bundler mistake. Enforce it: a lint rule forbids `apps/candidate` importing anything staff-scoped,
and a build-time check fails if the candidate bundle contains a staff-only symbol.

**Accessibility baseline, established now.** Skip link, focus-visible styling, a live region for
announcements, colour contrast tokens that pass AA, and axe wired into the component test run. Every
screen built from P2 onward inherits it. Retrofitting accessibility across thirty screens is the
outcome [`../docs/15-accessibility-conformance.md`](../docs/15-accessibility-conformance.md) exists
to prevent.

**Verified by.** axe clean on both shells; keyboard-only navigation of the shell; the bundle check
failing on a deliberate staff-symbol import.

---

## Step 12 — Test harness

**Produces.** Vitest projects for unit and integration, testcontainers fixtures for Postgres and
Valkey, Playwright, axe integration, coverage reporting, and a deterministic seed.

**Rules.** Integration tests use a real Postgres via testcontainers, never a mock and never SQLite.
The database is the thing most likely to behave differently from your mental model, and RLS in
particular cannot be tested against a fake. Each test gets an isolated schema or database so the
suite can run in parallel.

Time is injectable everywhere. P3's timer work is untestable otherwise, and ADR-006 makes the clock
a correctness boundary rather than a detail.

**Verified by.** The full suite runs from a clean clone with only Docker available.

---

## Step 13 — The leak suite, seeded

**Produces.** A standing suite, separate from unit and integration, whose single job is to assert
that nothing a candidate must not see can reach a candidate-scoped response.

It starts nearly empty — there is barely an API yet — with the harness and one assertion. It grows
an assertion in every later phase. Establishing it now means "add the leak assertion" is part of how
this team builds a candidate-facing endpoint, rather than a retrofit after a near miss.

**Verified by.** The suite runs in CI as its own job with its own name, so a failure is
unambiguous in the pull request checks.

---

## Step 14 — CI enforcing

**Produces.** `ci.yml` switched from skip-if-no-workspace to enforcing; the first `pnpm-lock.yaml`;
the first CycloneDX SBOM; branch protection configured.

**Rules.** The licence gate now has a real dependency tree to grade (ADR-001). Verify it genuinely
fails by planting an AGPL package on a scratch branch — task `H-039`. A gate nobody has seen fail is
a gate nobody knows works.

Required checks on the default branch: lint, typecheck, unit, integration, leak suite, build, docs
freshness, link check, code-graph sync, licence gate.

**Verified by.** A pull request that violates each gate is blocked by that gate. Walk all ten.

---

## Step 15 — Exit gate

Run the P0 exit gate in [`ROADMAP.md`](ROADMAP.md) §5. The criterion that matters most is the one
that is easiest to fake: **a clean clone on a second machine reaching a running stack and a green CI
run in under ten minutes, without asking anyone a question.** Time it on a machine that has never
built this repository, ideally with someone who did not write it.

Record the result in [`STATUS.md`](STATUS.md), update [`MILESTONES.md`](MILESTONES.md)'s M-1
checklist, and flip the P0 tasks in [`TRACKER.md`](TRACKER.md).

---

## What P0 deliberately does not build

Naming these prevents the phase from expanding:

| Not built | Why | Where it lands |
|---|---|---|
| Any domain model | There is no domain in P0 | P1, P2 |
| Authentication | Needs the tenancy spine underneath it | P1 |
| Any candidate-facing screen | Nothing to render yet | P3 |
| The execution adapter | Needs no foundation work; it is self-contained | P4 |
| A plugin or extension system | Nothing has a second implementation | Never, unless a second one appears |
| Abstractions over Drizzle, Fastify or BullMQ | Wrapping a library you have used once produces the wrong abstraction | Only when a second implementation is real |
| A shared "utils" package | It becomes a dumping ground with no owner and no boundary | Never |

---

## The five ways this phase fails

1. **Toolchain churn.** The stack is settled in ADR-012 and ADR-013. Reopening it costs days and
   changes nothing about what the product does.
2. **Building for imagined futures.** Every abstraction in P0 has exactly one consumer. If a second
   is genuinely coming in P2, still wait for it.
3. **Skipping step 7.** Tenancy is the one thing here that cannot be added later without a data
   migration and a security review. It is also the easiest to postpone because nothing visibly
   depends on it yet.
4. **Deferring the test harness to "when there is something to test".** By then the code was
   written without tests driving it, and the harness gets shaped around code instead of the reverse.
5. **Declaring done without the clean-clone test.** Everything works on the machine that built it.
   That is not the claim being made.
