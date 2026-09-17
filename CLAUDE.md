# Operating rules for this repository

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-18
**Companion docs:** [`README.md`](README.md), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CODE-GRAPH.md`](CODE-GRAPH.md), [`project/DEFINITION-OF-DONE.md`](project/DEFINITION-OF-DONE.md), [`docs/DOC-OWNERSHIP.md`](docs/DOC-OWNERSHIP.md)

---

This file is the operating contract for anyone changing this repository — human engineer or AI agent. It is deliberately prescriptive. Where it states a rule it also states the reason, because a rule whose reason you do not know is a rule you will break the first time it is inconvenient.

## The project in three sentences

Assaybank is a self-hosted technical hiring platform covering async assessments, live coding interviews and proctored certification exams against one shared question bank and one skill taxonomy. The design is complete and documented, and the build is under way: as of 2026-09-17 the foundation (P0) and tenancy/identity (P1) are complete and the question bank (P2) is in progress — see [`project/STATUS.md`](project/STATUS.md). Describe only what is merged and tested as existing; everything else is planned, in future or imperative tense. Check the code before asserting either — this file said "no application code" for two days after there was some.

## Repo map: who owns what

| Path | Owns | Must not |
|---|---|---|
| `apps/api` | Every write to a domain table. AuthN/AuthZ, question-bank CRUD and version lifecycle, assessment composition, attempt lifecycle, the server-authoritative timer, enqueuing grading jobs, report generation, webhook emission | Run candidate code, hold WebSocket document state, compute a score synchronously |
| `apps/worker` | BullMQ grading consumers; scheduled sweeps — deadline sweep, question statistics, retention erasure; bank import and export, including the interchange formats (JSON bank document, QTI 2.1 package) in `src/interchange/` | Serve HTTP to candidates or staff |
| `apps/collab` | Live Yjs documents for interview sessions, awareness fanout, periodic snapshots | Write domain tables other than the session snapshot and event append it owns |
| `apps/web` | Staff console: recruiter, interviewer, admin | Ship in the candidate bundle |
| `apps/candidate` | Candidate assessment runner and interview join | Import from `apps/web`, or from any package that exposes correct-answer flags, hidden test cases or bank queries |
| `packages/contracts` | zod schemas, generated OpenAPI 3.1, the error-code enum — the single source of API truth | Import from any app |
| `packages/db` | Drizzle schema, migrations, RLS policies, seed | Contain business rules |
| `packages/core-domain` | Attempt state machine, section-rule resolution, scoring, skill roll-up | Perform I/O |
| `packages/exec-adapter` | Piston behind `execute(language, version, files, stdin, limits)` | Receive a question ID, a test-case expectation or any database handle |
| `packages/grading` | Test-case comparison and weighted scoring — pure functions | Perform I/O or read configuration |
| `packages/auth` | Staff sessions and OIDC, candidate attempt tokens, WebSocket tickets, per-action permission checks | Encode role names in call sites — permissions are checked per action |
| `packages/config` | Env parsing and validation, failing fast at boot | Read `process.env` anywhere else in the codebase |
| `packages/observability` | Logger, OTel tracing, metrics | Log candidate answers, tokens or proctor media |
| `packages/ui` | Shared React components and design tokens for `web` and `candidate` | Contain staff-only strings, routes or data shapes |

**`apps/api` is the only writer of domain tables.** Workers and the collab service read what they need and go through the API — or, where a worker genuinely owns a table (grading results, session events, `question_stats`), that ownership is recorded explicitly in `code-graph.json` and the table is listed there. Anything else writing domain state means two clocks, two validation paths and a state machine that can be driven from outside itself.

## Read before you write

The design decisions below are load-bearing. If your change touches the left column, read the right column first; a change that contradicts one of these is rejected in review regardless of how good the code is.

| If you are touching… | Read first |
|---|---|
| Attempts, timers, deadlines, resume, autosave | [ADR-004](docs/04-ADRs.md) (materialised question set) and [ADR-006](docs/04-ADRs.md) (the server owns the clock) |
| Question content, versions, publishing, retirement | [ADR-003](docs/04-ADRs.md) (published versions are immutable) |
| Code execution, sandboxing, limits, the Piston adapter | [ADR-002](docs/04-ADRs.md) (Piston over Judge0) and [`docs/02-HLD.md`](docs/02-HLD.md) §7 (security and the sandbox) |
| Tenancy, `org_id`, RLS, cross-org queries, reporting | [ADR-010](docs/04-ADRs.md) (row-level security for tenant isolation) |
| Proctoring, integrity signals, the review queue | [ADR-007](docs/04-ADRs.md) (signals, never decisions) |
| Adding or upgrading any dependency | [`docs/05-licensing-and-compliance.md`](docs/05-licensing-and-compliance.md) §1 (dependency licence policy) |
| Scoring, ranking, recommendations, candidate comparison | [ADR-011](docs/04-ADRs.md) (no AI in the scoring path) and [`docs/16-ai-usage-policy.md`](docs/16-ai-usage-policy.md) |
| Writing any code at all — types, layering, errors, migrations, tests | [`docs/17-engineering-standards.md`](docs/17-engineering-standards.md) (the production-grade bar and the invariants enforced in code) |
| Starting a phase, or wondering what to build next | [`project/ROADMAP.md`](project/ROADMAP.md), and [`project/P0-FOUNDATION-PLAN.md`](project/P0-FOUNDATION-PLAN.md) while the foundation is being built |

## Hard rules

Each is an imperative with its reason attached. None of them is a preference.

1. **Never mutate a published `question_version`.** Editing creates a new version and the old one stays exactly as it was served. Without this you cannot re-grade an attempt, defend a candidate dispute, or trust a single number in your question statistics — the denominator silently changed underneath them.
2. **Never recompute a question draw after attempt start.** The served set, including option shuffle order, is materialised at start and read back verbatim. Recomputing means a candidate who refreshes gets a different test, and two candidates with the same score did not sit the same exam.
3. **Never trust a client clock.** Deadlines are computed server-side at attempt start and enforced server-side at every write. A client-supplied timestamp is advisory display data and nothing else; every assessment product that trusted one has been cheated through it.
4. **Never send hidden test-case content, reference solutions or `is_correct` flags to a candidate-scoped response.** Filter server-side in the serialisation layer, not with CSS, not with a frontend guard, and not by omitting the field from one handler. This includes error output, stack traces and diff messages. A test asserts that no candidate-facing response shape can carry these fields.
5. **Never auto-reject, auto-void or down-score on a proctoring signal.** Signals raise a flag and attach evidence to a human review queue. The system surfaces evidence; a person makes every advance/reject call. This is a product constraint and a legal exposure, not a configuration option (ADR-007).
6. **Never add a GPL, LGPL-with-static-linking, AGPL, SSPL, BSL/BUSL or Commons Clause dependency**, including transitively. Copyleft in the dependency tree of a hosted product is what those licences exist to catch, and it forecloses commercialisation. CI fails the build; do not work around the gate.
7. **Never put AI in the scoring path or the decision path.** No model ranks candidates, drafts a recommendation, grades a subjective answer into a number, or adjusts a score. AI in developer tooling is fine; AI touching a candidate's outcome is not (ADR-011).
8. **Every tenant table carries `org_id` and an RLS policy.** A new table without both is an isolation bug waiting for a reporting query to find it. `app.current_org` is set per connection; application code never filters by `org_id` as its only defence.
9. **Migrations are expand-contract only.** Add nullable, backfill, switch reads, drop old — across separate deploys. A single destructive migration breaks whatever exam window is running when it lands, and exam windows do not pause for deploys.
10. **Secrets never enter the repository.** They are injected at runtime. `.env` is ignored; `.env.example` carries obvious placeholders only.

## Keeping the docs true

This repository's documentation is load-bearing — it is the specification the code is being written against. The following eight rules are a contract, not a suggestion. Each applies **in the same change** that causes it, never as a follow-up.

1. **Structure changes update the graph.** Any change to a service boundary, a package, a queue, or an external dependency updates `code-graph.json` in the same change, and `CODE-GRAPH.md` is regenerated with `node scripts/gen-code-graph.mjs` (`make graph`). `CODE-GRAPH.md` is generated output — never hand-edit it.
2. **Completed work updates the tracker.** Any backlog item that reaches done updates its status in [`project/TRACKER.md`](project/TRACKER.md) and the summary in [`project/STATUS.md`](project/STATUS.md).
3. **Met exit criteria update the milestones.** Any milestone exit-criterion that is satisfied is marked in [`project/MILESTONES.md`](project/MILESTONES.md) with the date and the evidence that satisfied it.
4. **Expensive decisions become ADRs.** Any decision that is expensive to reverse becomes a **new** ADR appended to [`docs/04-ADRs.md`](docs/04-ADRs.md). An accepted ADR is never edited to say something different — write a new one that supersedes it and mark the old one superseded, with a link in both directions. The record of what we used to believe is the useful part.
5. **Answered questions move out of the open list.** Any question answered in [`project/OPEN-QUESTIONS.md`](project/OPEN-QUESTIONS.md) is deleted from that file and written into the document that owns the subject, and — if the answer is load-bearing — into a new ADR as well. An open-questions file that only grows is a file nobody reads.
6. **A task id is allocated in [`project/TRACKER.md`](project/TRACKER.md) and nowhere else.** Cite an id the tracker already holds, or add the row first. A document that mints its own ids collides with the backlog the moment it grows that far, and the reference then names someone else's finished task while reading exactly as it did before — which is what `docs/14-threat-model.md` did to twenty-six of its own mitigations. `scripts/check-task-ids.mjs` enforces it.
7. **Every doc you touch gets its `**Last updated:**` bumped** to the date of the change. `scripts/check-doc-freshness.mjs` enforces this in CI, and a Claude Code `PostToolUse` hook warns locally as soon as you save.
8. **A new env var lands in three places at once**: [`.env.example`](.env.example), `docker-compose.yml`, and the environment table in [`docs/13-environments-and-release.md`](docs/13-environments-and-release.md). It is also parsed and validated in `packages/config`, so a missing value fails at boot rather than at 03:00 during an exam window.

### Definition of done — copy this into your PR

```markdown
- [ ] Tests written and passing (`make test`); the new behaviour has a failing-before test
- [ ] `make lint typecheck` clean
- [ ] Contracts updated in `packages/contracts` if any request/response/error shape changed
- [ ] Migration is expand-contract; RLS policy added for any new tenant table
- [ ] No hidden test cases, reference solutions or `is_correct` flags reachable from a candidate-scoped response
- [ ] New/changed dependency passes `make licences`
- [ ] `code-graph.json` updated and `make graph` re-run if a boundary, package, queue or external dependency changed
- [ ] `project/TRACKER.md` and `project/STATUS.md` updated for any completed item
- [ ] `project/MILESTONES.md` updated if an exit criterion was met
- [ ] New ADR added for any decision expensive to reverse; no accepted ADR edited in place
- [ ] Any answered open question moved out of `project/OPEN-QUESTIONS.md` into its owning doc
- [ ] `**Last updated:**` bumped on every doc touched (`make docs-check` passes)
- [ ] New env var present in `.env.example`, `docker-compose.yml`, `packages/config` and `docs/13`
```

The full version, including what "done" means for a milestone and for a release, is in [`project/DEFINITION-OF-DONE.md`](project/DEFINITION-OF-DONE.md).

## Commands

Run `make help` for the generated list. Targets that depend on code which does not exist yet are defined and print the milestone that will implement them rather than failing obscurely.

| Command | Does | Available |
|---|---|---|
| `make help` | List every target with its description | now |
| `make up` | Start the full local stack via `docker-compose.yml` | now |
| `make down` | Stop the stack, keep volumes | now |
| `make ps` / `make logs` | Container status / follow logs (`S=api` to scope) | now |
| `make restart` | Restart one service (`S=api`) or all | now |
| `make build` | Build workspace packages and app images | M0 |
| `make migrate` | Apply Drizzle migrations to the local database | M0 |
| `make migrate-new` | Generate a new migration (`N=add_question_stats`) | M0 |
| `make seed` | Load the permission catalogue, the five system roles and the starter skill taxonomy | now |
| `make psql` | Open `psql` against the local database | now |
| `make redis-cli` | Open `valkey-cli` against the local queue backend | now |
| `make test` | Unit, integration and end-to-end suites | M0 |
| `make test-unit` / `test-integration` / `test-e2e` | One suite | M0 / M0 / M1 |
| `make lint` / `make typecheck` / `make fmt` | ESLint / `tsc --noEmit` / Prettier write | M0 |
| `make licences` | Fail on any prohibited dependency licence | now |
| `make sbom` | Produce a CycloneDX SBOM | M0 |
| `make docs-check` | Doc freshness, relative-link and task-id checks | now |
| `make graph` | Regenerate `CODE-GRAPH.md` from `code-graph.json` | now |
| `make clean` | Remove build output, caches and coverage | now |
| `make nuke` | `clean` plus remove containers, volumes and images | now |

## Conventions

**Naming.** Files and directories are `kebab-case`. TypeScript types and React components are `PascalCase`; functions, variables and object keys are `camelCase`. Database identifiers — tables, columns, indexes, enum labels — are `snake_case`, and tables are plural (`question_versions`, `attempt_questions`). Queue names are `kebab-case` and namespaced by purpose (`grading-run`, `grading-submit`, `sweep-deadline`). Environment variables are `SCREAMING_SNAKE_CASE`.

**Error codes come from `packages/contracts`.** They are stable strings, exported as a single enum, and clients branch on `code` and never on `message`. Do not invent a code at a call site, do not reuse a code with a different meaning, and do not change the meaning of a published one — add a new code and deprecate the old.

**Timestamps are `timestamptz`, stored UTC, serialised as RFC 3339.** There is no `timestamp without time zone` column in this schema, ever. A deadline that is ambiguous about its zone is a deadline that will be argued about by someone with a lawyer.

**IDs are UUIDv4**, generated by the application, never by an auto-incrementing sequence. Sequential IDs leak volume and allow enumeration across an org boundary.

**API shape.** Cursor pagination (`?limit=&cursor=` → `{data[], next_cursor}`), `PATCH` for partial updates and no `PUT`, `Idempotency-Key` honoured on mutating endpoints, explicit query parameters and never a generic query language. See [`docs/03-API-spec.md`](docs/03-API-spec.md) §2.

**Prose style.** Documentation uses British spelling — materialised, organisation, prioritised, licence as a noun. Plain declarative sentences that state the trade-off rather than just the choice. No marketing tone, no emoji, no exclamation marks. Tables where they carry weight, mermaid or ASCII diagrams where a picture helps. Every document opens with an H1 and the metadata block (`Status`, `Owner`, `Last updated`, `Companion docs`), then a `---` rule. Never leave a bare "TBD" — write "TBD — owner: `<role>`, decide by `<absolute date>`". Dates are absolute and ISO-formatted; "next week" is not a date.

## What not to do

- **No new top-level directory without updating `code-graph.json` and regenerating `CODE-GRAPH.md`.** A directory nobody documented is a directory nobody owns.
- **No secrets in the repository** — not in `.env.example`, not in a test fixture, not in a docker-compose default, not in a commented-out line. Generate local secrets with `openssl rand -hex 32`.
- **No scraping of commercial question banks.** LeetCode, HackerRank, GeeksforGeeks, InterviewBit, Codeforces and cloud-certification dumps are copyrighted works, and using them for internal hiring is still infringement. Import only from the datasets listed in [`docs/05-licensing-and-compliance.md`](docs/05-licensing-and-compliance.md) §2, with `source_license` recorded on every imported row.
- **No hand-editing generated files** — `CODE-GRAPH.md`, the generated OpenAPI document, or migration SQL that Drizzle produced.
- **No claiming code exists.** If it is not merged, it is planned, and it is written as planned.
