# Backlog tracker

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-17
**Companion docs:** [`MILESTONES.md`](MILESTONES.md), [`DEFINITION-OF-DONE.md`](DEFINITION-OF-DONE.md), [`RISKS.md`](RISKS.md), [`GLOSSARY.md`](GLOSSARY.md), [`../docs/01-PRD.md`](../docs/01-PRD.md), [`../docs/03-API-spec.md`](../docs/03-API-spec.md), [`../docs/04-ADRs.md`](../docs/04-ADRs.md)

---

## How to use this

This is the working backlog, not a sprint board. It holds engineering units that a single person can finish and review — roughly half a day to five days each. Anything larger is a milestone scope line in [`MILESTONES.md`](MILESTONES.md) and gets broken down here before work starts.

Every task traces to something written down: a functional requirement `FR-n` from [`../docs/01-PRD.md`](../docs/01-PRD.md) §7, an architecture decision `ADR-n` from [`../docs/04-ADRs.md`](../docs/04-ADRs.md), a section of the HLD or API spec, or a milestone exit criterion. A task with no reference is either missing its reference or is not work this project agreed to do.

Read it top to bottom to understand build order; read the **Depends on** column to understand what is actually startable today.

### Id allocation rule

Ids are `H-NNN`, allocated strictly in ascending order from the highest id currently in the file, **never reused and never renumbered**. An id is permanent: it appears in branch names (`h-038-question-authoring-ui`), commit messages, PR titles and ADR cross-references, so renumbering silently breaks history. A cancelled task keeps its row with status `done` and the word "cancelled" plus a reason in the task text; deleting the row loses the record that it was considered.

**An id is allocated here and nowhere else.** A document that proposes work cites an id this file already holds, or the work is added here first. `docs/14-threat-model.md` minted forty of its own against a high-water mark of `H-109`, this file grew past it, and twenty-six of those references silently came to name other people's finished tasks — which is the failure this rule exists to prevent, arriving from the one direction the rule did not cover.

Tasks discovered mid-milestone take the next free id regardless of which milestone they belong to. The table is grouped by milestone for reading, not sorted by id.

### Status definitions

| Status | Means |
|---|---|
| `todo` | Not started. Dependencies may or may not be met — check the **Depends on** column. |
| `in-progress` | Someone named in **Owner** has a branch open. At most two per person at a time; more than that is queueing, not progress. |
| `blocked` | Cannot proceed until something outside the task is resolved. The blocker must be named in the task text — "blocked" with no named blocker is `todo` with a worse label. |
| `done` | Merged to the default branch and satisfying [`DEFINITION-OF-DONE.md`](DEFINITION-OF-DONE.md). Not "the code works on my machine". |

### The PR rule

**A pull request that closes a task flips that task's status in the same pull request.** The tracker edit is part of the diff, reviewed alongside the code. A separate "update the tracker" commit is how a tracker becomes fiction within two weeks. The same applies in reverse: a PR that starts work flips `todo` → `in-progress` in its first commit.

Reviewers should reject a PR that closes work without the tracker edit. This is cheap to enforce and the only thing that keeps the file true.

### Priority

Priority answers **"may this be cut or deferred?"**, not "is this urgent?". Urgency is the
**Depends on** column and the build order in [`ROADMAP.md`](ROADMAP.md); conflating the two produces
a backlog where everything is P0 and the label stops carrying information.

| Pri | Means | May it be deferred? |
|---|---|---|
| `P0` | On the critical path, or a non-negotiable invariant. Other work is blocked by it, or the system is unsafe without it. | No. Cutting it changes what the product is. |
| `P1` | Required for its milestone's exit criterion. | Not without moving the milestone. |
| `P2` | In scope for the milestone but not gating its exit criterion. | Yes, into the next milestone, with a recorded reason. |
| `P3` | Wanted, not committed. | Yes, indefinitely. |

Most `P0` rows are invariants rather than features — row-level security, the materialised draw, the
server clock, immutable versions, sandbox isolation, token scoping, the leak suite. That is
expected in this system: the invariants *are* the product, and each one is far cheaper to build now
than to retrofit. A `P0` that turns out to be deferrable is a mislabelled row; change it and say why.

**Priority never overrides dependency order.** A `P0` whose dependency is unmet is not startable,
and picking it up anyway is how two people end up editing the same file.

### Areas

`db` schema, migrations, RLS · `api` Fastify HTTP and SSE surface, contracts, auth · `worker` BullMQ jobs, grading, sweeps, imports · `exec` execution adapter and sandbox behaviour · `collab` y-websocket and CRDT · `web` staff console · `candidate` candidate app · `infra` docker, CI, nodes, storage, networking · `docs` written deliverables and rehearsals · `compliance` licence, retention, fairness, accessibility obligations

### Estimates

`S` up to half a day · `M` one to two days · `L` three to five days. Anything that feels bigger than `L` is two tasks.

---

## M-1 — Foundation (phase P0)

| ID | Pri | Task | Area | Milestone | Depends on | FR / ADR ref | Est | Status | Owner |
|------|---|---|---|---|---|---|---|---|
| H-001 | P0 | Repo root identity: `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `.gitignore`, `.editorconfig`, `.nvmrc` | docs | M-1 | — | — | S | done | _unassigned_ |
| H-002 | P0 | Canonical `.env.example` and `Makefile` targets, agreeing with compose and the docs | infra | M-1 | H-001 | HLD 10 | S | done | _unassigned_ |
| H-003 | P0 | Dev docker-compose stack: Postgres 16, Valkey 8, Piston, SeaweedFS, Mailpit, OTel collector, Prometheus, Grafana on the canonical ports | infra | M-1 | H-002 | HLD 10, ADR-001 | M | done | _unassigned_ |
| H-004 | P0 | Production compose plus Caddy reverse proxy and TLS termination config | infra | M-1 | H-003 | HLD 10 | M | done | _unassigned_ |
| H-005 | P0 | `CODE-GRAPH.md`, `code-graph.json` and `scripts/gen-code-graph.mjs` | docs | M-1 | H-001 | — | M | done | _unassigned_ |
| H-006 | P0 | GitHub Actions: lint, typecheck, test, build, doc-freshness and link-check workflows | infra | M-1 | H-001 | — | M | done | _unassigned_ |
| H-007 | P0 | CI licence gate script failing on GPL, LGPL-static, AGPL, SSPL, BSL/BUSL and Commons Clause | compliance | M-1 | H-006 | ADR-001 | M | done | _unassigned_ |
| H-008 | P0 | Project management layer: milestones, backlog, risks, open questions, status, definition of done, glossary | docs | M-1 | — | PRD 6 | M | done | _unassigned_ |
| H-009 | P0 | Record ADR-012..ADR-019 and rewrite the docs index | docs | M-1 | — | ADR-012 | M | done | _unassigned_ |
| H-010 | P0 | Supporting design docs 06–16: testing, load and capacity, i18n, ATS, certification, retention and DPIA, observability, environments, threat model, accessibility, AI usage policy | docs | M-1 | H-008 | PRD 11 | L | done | _unassigned_ |
| H-011 | P0 | pnpm workspace plus Turborepo pipeline, all fourteen workspaces (five apps, nine packages) present and compiling empty — _delivered as H-112_ | api | M-1 | H-001 | ADR-012 | M | done | _unassigned_ |
| H-012 | P0 | `packages/config`: env parsing and validation that fails fast at boot, driven by `.env.example` — _delivered as H-113_ | api | M-1 | H-011 | HLD 10 | S | done | _unassigned_ |
| H-013 | P0 | `packages/observability`: structured logger, OTel tracing bootstrap, Prometheus `/metrics` endpoint — _delivered as H-114_ | api | M-1 | H-011 | HLD 8 | M | done | _unassigned_ |

| H-110 | P0 | pnpm workspace, Turborepo, `tsconfig.base.json` with the strict flag set, Prettier, commit hooks | infra | M-1 | H-001 | ADR-012, ADR-013 | M | done | _unassigned_ |
| H-111 | P0 | ESLint flat config **with the layering rule enforced** (packages must not import apps; core-domain and grading import no I/O) plus a fixture test proving a violation fails | infra | M-1 | H-110 | CODE-GRAPH, docs/17 §2 | M | done | _unassigned_ |
| H-112 | P0 | All fourteen workspaces created, compiling empty, each with one passing test | infra | M-1 | H-110 | CODE-GRAPH | M | done | _unassigned_ |
| H-113 | P0 | `packages/config`: zod env schema, fail-fast at boot, secret redaction, test asserting schema and `.env.example` agree in both directions | api | M-1 | H-112 | docs/13 §4 | M | done | _unassigned_ |
| H-114 | P0 | `packages/observability`: pino logger with an enforced redaction deny-list, OTel bootstrap, prom-client registry with a label-cardinality guard that throws on id labels | api | M-1 | H-112 | docs/12 | M | done | _unassigned_ |
| H-115 | P0 | `packages/contracts`: branded ids, error envelope, closed `ERROR_CODES` union, pagination, OpenAPI 3.1 emission, and a test that an unknown error never leaks its message | api | M-1 | H-112 | docs/03 §2, docs/14 | L | done | _unassigned_ |
| H-116 | P0 | `packages/core-domain`: eight-state attempt machine with every illegal transition rejected, injected `Clock`, deterministic draw resolver returning an error on infeasibility | api | M-1 | H-115 | ADR-004, ADR-006 | L | done | _unassigned_ |
| H-117 | P0 | `packages/grading`: pure comparison per grading mode, partial credit, negative marking, table-driven tests. No model, no heuristic, no similarity scoring | api | M-1 | H-115 | ADR-008, ADR-011 | M | done | _unassigned_ |
| H-118 | P0 | `packages/db`: Drizzle schema for every table in the schema file, migration `0001_initial` including the three extensions, `migrate()` idempotent on re-run | db | M-1 | H-113 | ADR-003, HLD 3.5 | L | done | _unassigned_ |
| H-119 | P0 | Migration `0002_rls`: enable RLS and create `org_isolation` on every `org_id` table; app role and elevated background-job role | db | M-1 | H-118 | ADR-010, FR-26 | M | done | _unassigned_ |
| H-120 | P0 | **Generated** RLS negative suite over `TENANT_TABLES` for select/update/delete, so a new tenant table without a policy fails CI automatically | db | M-1 | H-119 | ADR-010, FR-26 | L | done | _unassigned_ |
| H-121 | P0 | `packages/auth`: high-entropy hashed tokens with timing-safe verification, attempt-scoped tokens, single-use 60s WS tickets, per-action permission check | api | M-1 | H-115 | FR-27, docs/14 | L | done | _unassigned_ |
| H-122 | P0 | `apps/api` skeleton: request context, `/healthz` vs `/readyz` split, `/metrics`, `/openapi.json`, global error handler returning the envelope and leaking nothing, graceful drain | api | M-1 | H-113, H-114, H-115 | docs/03, docs/12 | L | done | _unassigned_ |
| H-123 | P0 | `apps/worker` skeleton: six-queue registry with per-queue attempts and backoff, dead-letter routing with an alarm metric, idempotency helper, graceful shutdown | worker | M-1 | H-113, H-114 | ADR-008 | L | done | _unassigned_ |
| H-124 | P0 | `apps/collab` skeleton: ticket validated **before** the WebSocket upgrade, single-use enforcement, Yjs sync and awareness wiring, connection metrics | collab | M-1 | H-121 | ADR-005, docs/14 | M | done | _unassigned_ |
| H-125 | P0 | `packages/ui`: design tokens from the brand palette in light and dark, accessible Field/Alert/LiveRegion/SkipLink primitives, focus-visible, reduced-motion | web | M-1 | H-112 | docs/15 | M | done | _unassigned_ |
| H-126 | P1 | `apps/web` shell: router, typed API client branching on `code`, root error boundary, skip-link target | web | M-1 | H-125 | docs/03 §2 | M | done | _unassigned_ |
| H-127 | P0 | `apps/candidate` as a separate bundle, with an eslint override **and** a build-time bundle check proving staff-only symbols cannot reach a candidate browser | candidate | M-1 | H-125 | ADR-013 | M | done | _unassigned_ |
| H-128 | P0 | Countdown hook deriving from `server_time` and reconciling on heartbeat; test proves a manipulated local clock does not affect it | candidate | M-1 | H-127 | ADR-006 | S | done | _unassigned_ |
| H-129 | P0 | Test harness: Vitest projects, testcontainers fixtures skipping cleanly without Docker, coverage, deterministic seed, injectable time | infra | M-1 | H-112 | docs/06 | M | done | _unassigned_ |
| H-130 | P0 | Leak suite seeded as its own CI job: a candidate principal is denied every permission, and it grows an assertion whenever a candidate-facing response is added | api | M-1 | H-121, H-129 | FR-12, docs/06 | M | done | _unassigned_ |
| H-131 | P0 | MPL-2.0 header gate `scripts/check-licence-headers.mjs`, wired into `docs.yml` and the Makefile | compliance | M-1 | H-001 | ADR-020 | S | done | _unassigned_ |
| H-132 | P0 | CI switched from skip-if-no-workspace to enforcing; first `pnpm-lock.yaml`; first CycloneDX SBOM; branch protection on the ten required checks | infra | M-1 | H-112 | ADR-001 | M | done | _unassigned_ |
| H-133 | P0 | Prove the licence gate fails: plant an AGPL dependency on a scratch branch and confirm CI blocks it (a gate nobody has seen fail is a gate nobody knows works) | compliance | M-1 | H-132 | ADR-001 | S | done | _unassigned_ |
| H-134 | P1 | Measure and record RLS query-plan cost on seeded volume, so degradation is known at P0 rather than discovered at P7 | db | M-1 | H-120 | ADR-010, R-09 | M | done | _unassigned_ |
| H-135 | P1 | Clean-clone test on a second machine: stack running and CI green in under ten minutes, timed, by someone who did not build it | infra | M-1 | H-132 | ROADMAP P0 exit | S | todo | _unassigned_ |

## M0 — Question bank (phases P1–P2)

| ID | Pri | Task | Area | Milestone | Depends on | FR / ADR ref | Est | Status | Owner |
|------|---|---|---|---|---|---|---|---|
| H-014 | P0 | Drizzle schema for schema sections 1–3: organizations, users, RBAC tables, skills, job roles, job openings | db | M0 | H-011 | FR-26, FR-27 | M | done | _unassigned_ |
| H-015 | P0 | Drizzle schema for schema section 4: questions, question_versions, mcq_options, coding_specs, test_cases, short_answer_keys, question_stats, plus the two enums | db | M0 | H-014 | FR-1, ADR-003 | M | done | _unassigned_ |
| H-016 | P0 | RLS policies on every tenant table plus per-checkout `app.current_org`, and a separate elevated job role with its own audit trail | db | M0 | H-015 | FR-26, ADR-010 | M | done | _unassigned_ |
| H-017 | P0 | RLS negative test per tenant table: a session scoped to org A reads zero org B rows on select, update and delete | db | M0 | H-016 | FR-26, ADR-010 | M | done | _unassigned_ |
| H-018 | P1 | Seed script: system `user_roles`, `permissions`, `user_role_permissions`, and a two-level starter skill taxonomy | db | M0 | H-014 | ADR-009 | S | done | _unassigned_ |
| H-019 | P0 | Expand-contract migration harness plus a CI lint rejecting a destructive migration in one step | db | M0 | H-014 | HLD 10 | M | todo | _unassigned_ |
| H-020 | P0 | Indexes from schema section 11 and an `EXPLAIN` baseline captured with RLS enabled, to detect plan degradation later | db | M0 | H-017 | ADR-010 | M | done | _unassigned_ |
| H-021 | P1 | `packages/auth`: staff sessions via Better Auth plus OIDC login against `OIDC_ISSUER` | api | M0 | H-014 | FR-27 | L | done | _unassigned_ |
| H-022 | P1 | Per-action permission checks resolved from `user_role_permissions`, never from a role name, so custom roles work | api | M0 | H-021 | FR-27 | M | done | _unassigned_ |
| H-023 | P0 | `packages/contracts`: zod schemas, the stable error-code union, generated OpenAPI 3.1 | api | M0 | H-011 | API 2 | M | done | _unassigned_ |
| H-024 | P1 | Fastify app skeleton: request id, error envelope, cursor pagination, `server_time` on every response — _partial 2026-09-17: request id, error envelope and cursor pagination done; `server_time` is on the health routes only, not yet every response_ | api | M0 | H-023 | API 2, ADR-006 | M | todo | _unassigned_ |
| H-025 | P0 | `Idempotency-Key` middleware replaying the original response body and status on a repeat | api | M0 | H-024 | API 2 | M | todo | _unassigned_ |
| H-026 | P1 | Valkey-backed rate limiter implementing the five documented scopes and returning `Retry-After` — _partial 2026-09-17: Valkey-backed with `Retry-After`, 3 of 5 scopes; trial-run and submission scopes arrive with execution in P3/P4_ | api | M0 | H-024 | API 2 | M | todo | _unassigned_ |
| H-027 | P1 | Append-only `audit_log` writer plus middleware capturing every privileged action with actor, entity and reason | api | M0 | H-024 | FR-21, FR-25 | M | done | _unassigned_ |
| H-028 | P2 | Skills and job-roles CRUD including `job_role_skills` weights, and `GET /job-roles/{id}/coverage` reporting where the bank is thin | api | M0 | H-024 | FR-2, ADR-009 | M | done | _unassigned_ |
| H-029 | P1 | Question CRUD across all eight kinds with kind-specific payload validation for options, coding specs, test cases and answer keys | api | M0 | H-024 | PRD 6 M0 | L | done | _unassigned_ |
| H-030 | P0 | Version lifecycle draft → review → published → retired; `PATCH` on a published version returns 409 `version_immutable` | api | M0 | H-029 | FR-1, ADR-003 | M | done | _unassigned_ |
| H-031 | P1 | `PUT /questions/{id}/skills` with weights; no route, column or import path permits tagging a question with a job role | api | M0 | H-028 | FR-2, ADR-009 | S | done | _unassigned_ |
| H-032 | P2 | Import job adapters for HumanEval, MBPP, LBPP and Exercism, rejecting any row without `source_license`, preserving `external_ref`, emitting per-row errors instead of failing the file, and driving an attributions page in the staff console | worker | M0 | H-029 | FR-3 | L | todo | _unassigned_ |
| H-033 | P2 | QTI 2.1 import and export, round-trip without loss across all eight question kinds | worker | M0 | H-032 | M0 exit | L | done | _unassigned_ |
| H-034 | P2 | JSON bank export in an open, documented shape, with CC-BY attribution preserved in the payload | worker | M0 | H-032 | FR-29, G6 | M | done | _unassigned_ |
| H-035 | P1 | Nightly `question_stats` job computing p-value and point-biserial discrimination per question version once n ≥ 30 | worker | M0 | H-015 | FR-5 | M | done | _unassigned_ |
| H-036 | P0 | `exposure_count` increment on attempt materialisation plus a retirement flag above a configurable threshold | api | M0 | H-030 | FR-4 | S | todo | _unassigned_ |
| H-037 | P0 | Staff console shell: TanStack Router, layout, shared design tokens in `packages/ui` — _done 2026-09-20: sidebar shell with grouped navigation from the route manifest, router with focus and title management, tokens, and the list-screen primitives. **Split:** the auth guard this row also named is now `H-177`, because it was holding `H-038` behind work that has nothing to do with the shell_ | web | M0 | H-021 | — | M | done | _unassigned_ |
| H-038 | P1 | Question authoring UI: markdown prompt editor, option editor, test-case editor, explicit publish action that reads as irreversible — _partial 2026-09-20: the list screen and the authoring editor are built — prompt and explanation, kind-aware options, test cases and accepted answers, send-for-review and an irreversible publish, a published version read-only with the new-version path in its place. axe-clean in every state. The markdown **preview** is not built, and the sanitiser it needs is `H-173`_ | web | M0 | H-037 | ADR-003 | L | todo | _unassigned_ |
| H-039 | P0 | Wire the licence gate against the real `pnpm-lock.yaml`, plant an AGPL fixture to prove it fails, generate the first CycloneDX SBOM | compliance | M0 | H-007, H-011 | ADR-001 | S | done | _unassigned_ |
| H-040 | P2 | M0 exit evidence: load 200 questions tagged to at least 3 job roles and prove a lossless export/re-import round trip | docs | M0 | H-033 | M0 exit | M | todo | _unassigned_ |

## M1 — Async MCQ assessment (phase P3)

| ID | Pri | Task | Area | Milestone | Depends on | FR / ADR ref | Est | Status | Owner |
|------|---|---|---|---|---|---|---|---|
| H-041 | P0 | Drizzle schema for schema sections 5–6: assessments, assessment_sections, section_questions, section_rules, candidates, applications, invitations, attempts, attempt_questions, answers | db | M1 | H-019 | FR-6, FR-7 | M | todo | _unassigned_ |
| H-042 | P1 | Assessment and section CRUD plus assessment versioning — editing a live assessment clones a new version and in-flight attempts finish on the old one | api | M1 | H-041 | FR-10 | L | todo | _unassigned_ |
| H-043 | P1 | Implement section rule resolver with `exclude_seen_days` window, difficulty band, skill and kind filters | api | M1 | H-042 | FR-6, ADR-004 | L | todo | _unassigned_ |
| H-044 | P1 | `POST /assessments/{id}/simulate` returning feasibility, sample draw and warnings; publish is blocked until a simulate run passes | api | M1 | H-043 | ADR-004 | M | todo | _unassigned_ |
| H-045 | P1 | `POST /assessments/auto` composing a draft assessment from `job_role_skills` weights and a difficulty profile | api | M1 | H-043 | ADR-009 | M | todo | _unassigned_ |
| H-046 | P2 | Candidate and application CRUD plus bulk CSV import job with per-row error reporting | api | M1 | H-041 | PRD 6 M1 | M | todo | _unassigned_ |
| H-047 | P0 | Invitation tokens: high entropy, peppered hash at rest via `TOKEN_PEPPER`, plaintext returned exactly once, bulk issue and SMTP send through `SMTP_URL` | api | M1 | H-046 | HLD 7 | L | todo | _unassigned_ |
| H-048 | P0 | Attempt start materialises `attempt_questions` with `option_order` in one transaction, and never re-rolls on any later read | api | M1 | H-043 | FR-7, ADR-004 | L | todo | _unassigned_ |
| H-049 | P0 | Server-computed `deadline_at` from `duration_seconds` plus `accommodations.extra_time_pct`, recorded in the audit log and surfaced on the report; heartbeat returns `server_time` and `seconds_remaining` | api | M1 | H-048 | FR-8, PRD 9, ADR-006 | M | todo | _unassigned_ |
| H-050 | P1 | Autosave endpoint with ≤5s cadence, conflict-free last-write-wins per answer, and resume after disconnect with no data loss | api | M1 | H-048 | FR-9 | M | todo | _unassigned_ |
| H-051 | P0 | Attempt state machine enforcement including the transactional `finalised` guard requiring every `answers.final_score` non-null | api | M1 | H-048 | API 8 | M | todo | _unassigned_ |
| H-052 | P0 | Deadline sweep job transitions overdue attempts to `expired` and grades autosaved answers rather than discarding them | worker | M1 | H-051 | FR-8, ADR-006 | M | todo | _unassigned_ |
| H-053 | P1 | `packages/grading`: MCQ single and multi partial credit, negative marking, short-answer matchers (exact, ci, regex, numeric tolerance) — pure, no I/O | worker | M1 | H-041 | FR-20 | M | todo | _unassigned_ |
| H-054 | P2 | Per-skill sub-score roll-up derived from `question_skills` weights, exposed on the attempt report | worker | M1 | H-053 | FR-20, ADR-009 | M | todo | _unassigned_ |
| H-055 | P0 | Regrade creates a new grading run rather than mutating in place; manual score override requires a reason; both write the before and after score to the audit log | api | M1 | H-027, H-053 | FR-21, API 8 | M | todo | _unassigned_ |
| H-056 | P0 | Serialisation guard test asserting `is_correct`, `rationale_md`, `solution_code` and `expected_stdout` never appear in any candidate-facing response | api | M1 | H-048 | FR-12, HLD 7 | M | todo | _unassigned_ |
| H-057 | P0 | Candidate app shell: token redemption, no account, no install, no plugin; separate bundle from the staff console | candidate | M1 | H-047 | G2 | M | todo | _unassigned_ |
| H-058 | P2 | MCQ runner UI honouring `option_order`, section navigation and `allow_back_nav`, with the countdown derived from `server_time` and an offline autosave buffer that replays on reconnect | candidate | M1 | H-057 | FR-7, FR-8, FR-9 | L | todo | _unassigned_ |
| H-059 | P2 | Per-candidate report view plus cohort CSV export with per-skill breakdown | web | M1 | H-054 | PRD 6 M1 | M | todo | _unassigned_ |
| H-060 | P2 | Assessment analytics: per-question p-value, discrimination, mean time, and MCQ option distribution for spotting ambiguous questions | api | M1 | H-035 | PRD 9 | M | todo | _unassigned_ |
| H-061 | P1 | Webhook framework plus admin endpoints: HMAC-SHA256 signing over the raw body, at-least-once delivery, exponential backoff, 24-hour retry window, delivery log, test delivery, and secret rotation on `WEBHOOK_SIGNING_SECRET_ROTATION_DAYS` with an overlap window | worker | M1 | H-027 | API 12 | L | todo | _unassigned_ |
| H-062 | P1 | M1 exit evidence: 50 candidates complete a 30-question test concurrently, and every score reproduces exactly on re-grade | docs | M1 | H-055 | M1 exit | M | todo | _unassigned_ |

## M2 — Coding rounds (phase P4)

| ID | Pri | Task | Area | Milestone | Depends on | FR / ADR ref | Est | Status | Owner |
|------|---|---|---|---|---|---|---|---|
| H-063 | P0 | Drizzle schema for schema section 7: submissions and submission_results | db | M2 | H-041 | FR-13 | S | todo | _unassigned_ |
| H-064 | P1 | `packages/exec-adapter` implementing `execute(language, version, files, stdin, limits)` over Piston, returning the runtime identity so `language_version` and `runtime_image` are recorded on every submission | exec | M2 | H-011 | FR-13, ADR-002 | L | todo | _unassigned_ |
| H-065 | P0 | Enforce `EXEC_CPU_TIME_MS`, `EXEC_WALL_TIME_MS`, `EXEC_MEMORY_MB`, `EXEC_MAX_PROCESSES`, `EXEC_MAX_OUTPUT_BYTES` at the kernel via cgroups, and prove no network egress | exec | M2 | H-064 | FR-15, HLD 7 | M | todo | _unassigned_ |
| H-066 | P1 | Infrastructure test asserting execution nodes hold no secrets, no database credentials and no cloud IAM role, and cannot reach the API or database | infra | M2 | H-065 | HLD 7 | M | todo | _unassigned_ |
| H-067 | P1 | Piston runtime image pinning, container pre-warm pool, and a node recycle policy | infra | M2 | H-064 | HLD 6, ADR-002 | M | todo | _unassigned_ |
| H-068 | P1 | Two BullMQ queues with separate concurrency: interactive `run` (`QUEUE_RUN_CONCURRENCY`) and batch `submit` (`QUEUE_SUBMIT_CONCURRENCY`) | worker | M2 | H-063 | ADR-008 | M | todo | _unassigned_ |
| H-069 | P0 | Grading worker pipeline: load version and cases, execute per case, compare, weight, write results — idempotent by submission id, bounded by `QUEUE_MAX_ATTEMPTS`, output truncated to `EXEC_MAX_OUTPUT_BYTES` before storage | worker | M2 | H-068 | ADR-008, FR-14 | L | todo | _unassigned_ |
| H-070 | P0 | Dead-letter queue: exhausted jobs move the attempt to `under_review` and raise an alert; an infrastructure failure never scores a candidate zero | worker | M2 | H-069 | HLD 9, ADR-008 | M | todo | _unassigned_ |
| H-071 | P1 | Grading modes `test_cases`, `unit_tests` and `custom_checker` with per-case weights, in `packages/grading` with no I/O | worker | M2 | H-069 | PRD 6 M2 | M | todo | _unassigned_ |
| H-072 | P1 | Candidate-visible result filtering: sample cases full detail, hidden cases pass/fail and label only, compile errors full — enforced server-side on every response and on the SSE stream | api | M2 | H-069 | FR-12 | M | todo | _unassigned_ |
| H-073 | P1 | Run versus submit separation: a trial run touches sample cases only and consumes no submission budget; author preview reuses the identical execution path | api | M2 | H-068 | FR-11, API 4 | M | todo | _unassigned_ |
| H-074 | P2 | SSE endpoint `/attempt/submissions/{id}/stream` emitting per-case progress then the final result, with reconnect and replay from last event id | api | M2 | H-069 | ADR-008 | M | todo | _unassigned_ |
| H-075 | P0 | Per-attempt execution budget cap plus a final-minute submission rate limit, so one candidate cannot starve the pool and the deadline stampede is flattened | api | M2 | H-073 | HLD 6 | M | todo | _unassigned_ |
| H-076 | P1 | SQL question kind: provision `fixture_sql` into a disposable database per execution, torn down afterwards | exec | M2 | H-064 | schema 4 | M | todo | _unassigned_ |
| H-077 | P1 | Monaco in the candidate app with language selection, starter code, keyboard accessibility, and an SSE-driven results panel that survives reconnect | candidate | M2 | H-058 | PRD 6 M2 | L | todo | _unassigned_ |
| H-078 | P0 | SeaweedFS object storage wiring for large submission artifacts and export files, accessed only through short-TTL pre-signed URLs | infra | M2 | H-063 | HLD 3.5, ADR-001 | M | todo | _unassigned_ |
| H-079 | P0 | Queue-depth, execution-latency, sandbox-timeout and dead-letter metrics plus the alerts named in HLD 8 | infra | M2 | H-069 | HLD 8 | M | todo | _unassigned_ |
| H-080 | P0 | M2 exit evidence: 100 concurrent submissions graded with p95 result latency under 8s, dead-letter queue empty | docs | M2 | H-069 | M2 exit | M | todo | _unassigned_ |

## M3 — Live interviews (phase P5, second engineer)

| ID | Pri | Task | Area | Milestone | Depends on | FR / ADR ref | Est | Status | Owner |
|------|---|---|---|---|---|---|---|---|
| H-081 | P0 | Drizzle schema for schema sections 8–9: interview_sessions, session_participants, session_events partitioned by month, scorecard_templates, scorecard_criteria, scorecards, scorecard_ratings | db | M3 | H-063 | FR-18, FR-22 | M | todo | _unassigned_ |
| H-082 | P1 | `apps/collab` y-websocket server with Valkey pub/sub cross-instance fanout and sticky routing by room code, with a convergence test covering three clients, concurrent edits and reconnect | collab | M3 | H-081 | FR-17, ADR-005 | L | todo | _unassigned_ |
| H-083 | P1 | WS ticket issuance and validation: 60-second TTL, single use, plus room-code join with no account and no download | api | M3 | H-082 | FR-16, HLD 7 | M | todo | _unassigned_ |
| H-084 | P1 | Periodic `doc_state` snapshot to Postgres on `COLLAB_SNAPSHOT_INTERVAL_MS`, so an instance crash loses at most one interval | collab | M3 | H-082 | ADR-005 | M | todo | _unassigned_ |
| H-085 | P1 | Append every applied update to `session_events`, batched and asynchronous, as the queryable parallel stream to the opaque CRDT blob | collab | M3 | H-082 | FR-18, ADR-005 | M | todo | _unassigned_ |
| H-086 | P2 | Replay API: `GET /sessions/{id}/events` range query and a packaged replay artifact in object storage | api | M3 | H-085 | FR-18 | M | todo | _unassigned_ |
| H-087 | P2 | Replay player UI with variable speed, reconstructing to the same final text as the stored `doc_state` | web | M3 | H-086 | FR-18 | L | todo | _unassigned_ |
| H-088 | P1 | Shared editor UI with live cursors, selections and awareness presence for both participants | web | M3 | H-082 | FR-17, ADR-005 | L | todo | _unassigned_ |
| H-089 | P0 | Multi-file workspace plus in-session run routed to the interactive queue with the same limits as an attempt run | api | M3 | H-073 | PRD 6 M3 | M | todo | _unassigned_ |
| H-090 | P1 | Interviewer private notes pane, filtered server-side out of the candidate payload and out of awareness frames | api | M3 | H-082 | FR-19 | M | todo | _unassigned_ |
| H-091 | P1 | Scorecard templates and criteria carrying behavioural anchors describing what each rating level looks like | api | M3 | H-081 | FR-22 | M | todo | _unassigned_ |
| H-092 | P0 | Scorecard submit locks the record immutably, and reviewers cannot read each other's scorecards until all are submitted — enforced in the API, not the UI | api | M3 | H-091 | API 11 | M | todo | _unassigned_ |
| H-093 | P0 | Self-hosted LiveKit for live-round audio and video with short-lived token issuance | infra | M3 | H-082 | HLD 5 | M | todo | _unassigned_ |
| H-094 | P2 | M3 exit evidence: an interviewer runs a full 45-minute loop and replays it afterwards | docs | M3 | H-087 | M3 exit | M | todo | _unassigned_ |

## M4 — Proctored / certification mode (phase P6)

| ID | Pri | Task | Area | Milestone | Depends on | FR / ADR ref | Est | Status | Owner |
|------|---|---|---|---|---|---|---|---|
| H-095 | P0 | Drizzle schema for schema section 10: proctor_events partitioned by month, proctor_media with `delete_after` | db | M4 | H-081 | FR-24, FR-28 | S | todo | _unassigned_ |
| H-096 | P1 | Browser-signal collection in the candidate app: focus loss, paste, fullscreen exit, devtools — batched, fire-and-forget, with consent captured before any capture and a non-proctored alternative always offered | candidate | M4 | H-095 | PRD 6 M4, GDPR | M | todo | _unassigned_ |
| H-097 | P1 | Proctor event ingestion endpoint writing only to `proctor_events` and `attempts.integrity_flag`; signals are advisory and produce no verdict | api | M4 | H-095 | FR-23, ADR-007 | M | todo | _unassigned_ |
| H-098 | P1 | Release-blocking test asserting no code path lets a proctoring signal change a score, void an attempt, alter attempt status or reject a candidate | api | M4 | H-097 | FR-23, ADR-007 | M | todo | _unassigned_ |
| H-099 | P1 | Integrity review queue in the staff console with the specific triggering evidence attached to each flag | web | M4 | H-097 | FR-24 | L | todo | _unassigned_ |
| H-100 | P1 | Human void flow requiring a reason, reachable from any attempt state, fully audited | api | M4 | H-027 | FR-25 | S | todo | _unassigned_ |
| H-101 | P0 | Proctor media upload to object storage, readable only through short-TTL pre-signed URLs, never through a stable public path | api | M4 | H-078 | HLD 7 | M | todo | _unassigned_ |
| H-102 | P1 | Safe Exam Browser configuration generation and launch handshake for certification-mode assessments | candidate | M4 | H-096 | PRD 6 M4 | L | todo | _unassigned_ |
| H-103 | P1 | Certificate issuance with a verifiable id plus a public verification endpoint that discloses no candidate PII beyond what was consented | api | M4 | H-051 | PRD 6 M4 | L | todo | _unassigned_ |
| H-104 | P1 | GDPR erasure: `DELETE /candidates/{id}` hard-deletes PII while retaining anonymised rows so psychometric statistics survive | api | M4 | H-046 | FR-28 | M | todo | _unassigned_ |
| H-105 | P0 | Retention sweep enforcing every `RETENTION_*` variable in code — proctor media 30d, session recordings 90d, attempt data 24m, candidate PII 12m, audit log 7y — with a time-travel test per clock | worker | M4 | H-104 | FR-28 | M | todo | _unassigned_ |
| H-106 | P2 | Full organisation export: question bank, assessments and results in open formats, delivered as a pre-signed artifact | worker | M4 | H-034 | FR-29, G6 | M | todo | _unassigned_ |
| H-107 | P2 | `GET /reports/adverse-impact` with a four-fifths-rule breakdown by voluntarily collected group, plus `GET /reports/funnel` | api | M4 | H-060 | PRD 9 | M | todo | _unassigned_ |
| H-108 | P1 | Accessibility conformance pass on the candidate app: axe in CI, keyboard-only run, screen-reader script, no colour-only information, adjustable text size | candidate | M4 | H-077 | PRD 8, WCAG 2.1 AA | L | todo | _unassigned_ |
| H-109 | P2 | M4 exit evidence: a 90-minute certification exam runs end to end with a reviewable integrity report | docs | M4 | H-099 | M4 exit | M | todo | _unassigned_ |

---

---

## Security hardening — the threat model's actions

Forty actions from [`../docs/14-threat-model.md`](../docs/14-threat-model.md) §5, one or two per
threat, in threat order. They were prose until 2026-09-17: the document allocated its own ids from
`H-110` when the tracker ended at `H-109`, the tracker then grew to `H-135` on other work, and
twenty-six of the references came to name unrelated finished tasks. Renumbered here into `H-136`
onwards, which is the only place an id may be allocated.

**Milestones in this section are provisional.** They follow the milestone of the component each
threat is against, not a scheduling decision anyone has made; the security owner sets the real ones
at the next review ([`../docs/14-threat-model.md`](../docs/14-threat-model.md) §13). What is not
provisional is that each row exists, so an action cannot be closed by a document that says it is
planned.

| Id | Pri | Task | Area | M | Depends on | Ref | Est | Status | Owner |
|---|---|---|---|---|---|---|---|---|---|
| H-136 | P1 | Exec nodes run from an immutable image: read-only root, per-run tmpfs work directory, recycled after a bounded number of runs, with the interval documented | infra | M2 | — | T-001 | M | todo | _unassigned_ |
| H-137 | P0 | Infrastructure test booting the production-shaped stack and asserting from inside an exec container that no domain env var is present and that DNS/TCP to API, database, Valkey and object store all fail | infra | M2 | — | T-002, T-003 | M | todo | _unassigned_ |
| H-138 | P0 | Standing egress regression suite: one hostile submission per language attempting DNS, outbound TCP and HTTP, each asserted to fail | worker | M2 | — | T-003 | M | todo | _unassigned_ |
| H-139 | P0 | Hostile-submission suite for resource exhaustion — fork bomb, allocation bomb, CPU spin, sleep-forever, zip-bomb expansion — each killed inside the wall-time budget with the node returning to service | worker | M2 | — | T-004 | M | todo | _unassigned_ |
| H-140 | P0 | Enforce `EXEC_MAX_OUTPUT_BYTES` in `packages/exec-adapter` with truncation marked in the result, and a second hard truncation in `packages/grading` before any row is written | exec | M2 | — | T-005 | M | todo | _unassigned_ |
| H-141 | P1 | Hidden-case results expose pass/fail and label only to a candidate: no `runtime_ms`, no `memory_kb`, no exit code, no ordering beyond the declared ordinal | api | M2 | — | T-006 | S | todo | _unassigned_ |
| H-142 | P0 | Contract test: a hidden expectation planted as a distinctive UUID never appears in any candidate-visible body, frame or log | api | M2 | — | T-007 | S | todo | _unassigned_ |
| H-143 | P0 | Adapter-level test asserting the `execute()` payload carries no expected output, no question id and no organisation id | exec | M2 | — | T-008 | S | todo | _unassigned_ |
| H-144 | P0 | Author-supplied `checker_code` and `fixture_sql` execute inside the candidate sandbox, and an import never sets either from an external file — blocks `custom_checker` shipping | worker | M2 | — | T-009 | L | todo | _unassigned_ |
| H-145 | P1 | Short-lived attempt tokens with rolling renewal on heartbeat; every redemption and renewal writes a `proctor_events` row carrying IP and user-agent, visible to a reviewer and acted on by nobody | api | M1 | — | T-010 | M | todo | _unassigned_ |
| H-146 | P0 | Invitation tokens 256-bit from a CSPRNG peppered at rest; `POST /join/{room_code}` rate-limited per IP and per room, joins accepted only in a window around `scheduled_at` | api | M1 | — | T-011 | M | todo | _unassigned_ |
| H-147 | P1 | Results UI labels every non-proctored attempt with its verification level, and the async-screen-then-live-confirmation flow is stated in recruiter-facing copy | web | M1 | — | T-012 | S | todo | _unassigned_ |
| H-148 | P1 | WebSocket ticket redemption is one atomic Valkey operation; a second connection for the same participant is rejected and writes a `session_events` row | collab | M3 | — | T-013 | S | todo | _unassigned_ |
| H-149 | P0 | Staff session cookies `HttpOnly`, `Secure`, `SameSite=Lax`, host-prefixed, identifier regenerated on login, privilege change and logout, with fixation and namespace-disjointness tests | api | M0 | — | T-014 | M | todo | _unassigned_ |
| H-150 | P0 | OIDC callback validates issuer, audience, `nonce`, `exp`, `iat` skew and the PKCE verifier with `state` bound to the originating session; email claims map to an existing user, never auto-provision | auth | M0 | — | T-015 | M | todo | _unassigned_ |
| H-151 | P1 | Bulk export is asynchronous, audited, notifies org admins on completion and is rate-limited separately from the general staff budget | api | M0 | — | T-016 | M | todo | _unassigned_ |
| H-152 | P1 | Enforced MFA or IdP-only login per organisation, configurable in `/org/settings` | auth | M0 | — | T-016 | M | todo | _unassigned_ |
| H-153 | P0 | Double-submit CSRF tokens on every state-changing staff route, an `Origin`/`Sec-Fetch-Site` check, and CORS from `CORS_ALLOWED_ORIGINS` with credentials never for `*` | api | M0 | — | T-017 | M | todo | _unassigned_ |
| H-154 | P0 | Every candidate-facing route resolves its target row through the token’s attempt id in the same query, with an authorisation matrix test asserting `not_found` and never `forbidden` | api | M1 | — | T-018 | M | todo | _unassigned_ |
| H-155 | P0 | The job role is granted per-table and write-only where possible; every job touching tenant data sets `app.current_org` or is on a documented cross-tenant allow list, with a lint rule on raw job-role connections | db | M1 | — | T-019 | M | todo | _unassigned_ |
| H-156 | P0 | Extend the RLS negative-test suite to the job role: a job processing org A must read and write no org B row, asserted per job type | db | M1 | — | T-019 | M | todo | _unassigned_ |
| H-157 | P0 | Filter and sort parameters are zod enums resolving to a fixed column allow list; raw SQL only through bound `sql` templates, enforced by lint; cursors opaque and validated before decoding | contracts | M0 | — | T-020 | M | todo | _unassigned_ |
| H-158 | P1 | A user cannot grant themselves a permission they do not hold or self-assign a role they just modified; role and permission changes notify org admins. System roles immutable | api | M0 | — | T-021 | M | todo | _unassigned_ |
| H-159 | P0 | Every request schema is strict, `.passthrough()` banned by lint, and database updates built from an explicit field list rather than a parsed-body spread — _partial 2026-09-17: the question, taxonomy and bank-job schemas are `strictObject` and updates are field lists; the lint rule and a full sweep remain_ | contracts | M0 | — | T-022 | M | todo | _unassigned_ |
| H-160 | P0 | Candidate-facing responses built by explicit allow-list serialisers, with a property test walking every body and SSE frame for `is_correct`, `solution_code`, `expected_stdout`, `pattern`, `checker_code` and `fixture_sql` | contracts | M1 | — | T-023, T-024 | M | todo | _unassigned_ |
| H-161 | P1 | Hidden cases labelled generically to a candidate (`Hidden case 3`); progress frames carry `{ordinal, passed}` and nothing else | api | M2 | — | T-024 | S | todo | _unassigned_ |
| H-162 | P0 | Integration test submitting with a client clock skewed by ±6 hours asserting identical server behaviour; the candidate countdown re-syncs from `server_time` and shows reconnecting rather than freezing | candidate | M1 | — | T-025 | M | todo | _unassigned_ |
| H-163 | P0 | Autosave carries a monotonic per-answer sequence number; the server applies a write only if it exceeds the stored one and returns the applied sequence | api | M1 | — | T-026 | M | todo | _unassigned_ |
| H-164 | P0 | A transactional deadline guard on every candidate write, independent of the sweep, including accommodation extra time | api | M1 | — | T-027 | M | todo | _unassigned_ |
| H-165 | P0 | `POST /attempt/start` idempotent per attempt; redeeming an invitation whose attempt is in progress resumes it, with the redeem count checked against `max_attempts` in the same transaction | api | M1 | — | T-028 | M | todo | _unassigned_ |
| H-166 | P1 | Exposure dashboard with a per-version threshold alert, a retirement workflow requiring a replacement, and a report flagging versions whose `p_value` rises abruptly | web | M0 | — | T-029 | L | todo | _unassigned_ |
| H-167 | P1 | Candidate-facing copy stating that question content is confidential and that exposure is tracked, with exposure-driven retirement resourced as the primary control | candidate | M4 | — | T-030 | S | todo | _unassigned_ |
| H-168 | P1 | Export jobs notify org admins on completion, are rate-limited per organisation per day, and embed a per-export identifier so a leaked file traces to its job — _partial 2026-09-17: the job row, the audit rows and the seven-day expiry exist (ADR-021); notification, rate limit and watermark remain_ | worker | M0 | — | T-031 | M | todo | _unassigned_ |
| H-169 | P1 | Webhook signatures carry a signed timestamp with a documented tolerance window, and the consumer obligations are stated with a verification snippet | api | M3 | — | T-034 | S | todo | _unassigned_ |
| H-170 | P0 | Pre-signed URL TTLs of at most 300 s for media and 900 s for export artifacts, issued only against an audited authorised request, with signatures never logged | api | M4 | — | T-035 | M | todo | _unassigned_ |
| H-171 | P0 | A distinct `proctor.review` permission gating media access, an `audit_log` row per media view, and a monitored retention sweep hard-deleting object and row at `delete_after` | api | M4 | — | T-036 | M | todo | _unassigned_ |
| H-172 | P0 | CI vulnerability audit failing on high severity with a documented exception path; `--frozen-lockfile`, post-install scripts disabled except an allow list, and reviewed dependency bumps | infra | M0 | — | T-037 | M | todo | _unassigned_ |
| H-173 | P0 | Sanitising markdown pipeline with an element and attribute allow list, raw HTML disabled, `javascript:`/`data:` URLs rejected, plus a strict CSP on both apps | ui | M0 | — | T-038 | M | todo | _unassigned_ |
| H-174 | P1 | One CSV writer used by every export path, prefixing fields beginning `=`, `+`, `-`, `@`, tab or carriage return, quoting all fields and writing UTF-8 with a BOM | core-domain | M2 | — | T-039 | S | todo | _unassigned_ |
| H-175 | P0 | `audit_log` append-only at the database level, asserted by a test attempting `UPDATE` and `DELETE` as both application roles — _built 2026-09-17: migration 0002 revokes both and `packages/db/tests/rls.test.ts` asserts it; the seven-year retention half remains_ | db | M0 | — | T-040 | S | todo | _unassigned_ |
| H-176 | P0 | A failed staff login is byte-identical whether or not the address exists — one envelope, one message, and a dummy verify so the timing does not answer either; the same for password reset — _built 2026-09-20: `packages/auth/src/password.ts` and `apps/api/src/auth/routes.ts`, asserted in `staff-identity.test.ts`; the reset path arrives with it_ | auth | M0 | — | T-042 | S | todo | _unassigned_ |
| H-177 | P0 | Staff console auth guard: an unresolved principal never reaches a screen — the console redirects to login rather than rendering a shell around an empty session, and a 401 from any query returns it there | web | M0 | H-037 | docs/03 §1 | S | todo | _unassigned_ |

---

## Start here — what is actually startable

Priority says what may be cut. This says what to pick up **next**, and it is the only section that
changes weekly. Everything below has its dependencies met today.

**Rewritten 2026-09-20.** The version this replaces still listed the P0 foundation — `H-136`
workspace, `H-137` ESLint layering, `H-138` workspace stubs — as the critical path. All of it
shipped weeks earlier. A "what to do next" section that has gone stale is worse than none, because
it is the one section a new person reads first and the only one they cannot check against the code.

### The one thing that closes M0

`H-040` — 200 questions loaded, tagged to at least three job roles, exported and re-imported
without loss. Every mechanism it needs now exists: the bank, the taxonomy, the two interchange
formats, and import and export as queued jobs. What remains is the dataset work in front of it:

`H-032` dataset importers (HumanEval, MBPP, LBPP, Exercism) → `H-040` exit evidence.

`H-032` is the long pole. The formats are done and tested; what it adds is one adapter per dataset,
each rejecting a row with no `source_license` (docs/05 §2) and preserving `external_ref`.

### The console, now that it has a real screen

`H-038` question authoring — the editor, the kind-specific content, and the publish action that
makes a version immutable. It is the half of the bank that still cannot be reached from a screen.

`H-177` the auth guard, split out of `H-037` on 2026-09-20 because it was holding `H-038` behind
work unrelated to the shell.

`H-173` the sanitising markdown pipeline belongs with the authoring editor rather than after it: a
prompt is author-supplied markdown that a candidate's browser renders (T-038), and retrofitting the
sanitiser once prompts exist means auditing the ones already written.

### Independent, and each worth a day

| Task | Why now |
|---|---|
| `H-019` | The expand-contract lint. Eleven migrations exist and the rule they follow is enforced by review alone |
| `H-175` | `audit_log` append-only is already true at the database and asserted; the row remains for the seven-year retention half |
| `H-176` | Login enumeration is already uniform; the row covers extending it to password reset when that ships |
| `H-172` | The CI vulnerability audit. No dependency scanning runs today |
| `H-036` | `exposure_count`, which is what makes the bank's over-exposure visible before it matters |

### The security subset, once the console has a login

`H-149` session cookies → `H-153` CSRF → `H-150` OIDC validation → `H-177` the guard. These are one
track and they belong together: each is a claim about the same credential, and splitting them across
weeks is how three of the four end up half-done.

### The three that will be skipped under pressure, and must not be

- **`H-032`'s licence rejection.** An importer that accepts a row with no `source_license` puts
  content in the bank that nobody can prove the right to use, and it is invisible until a lawyer
  asks. The refusal is the feature.
- **`H-173` the markdown sanitiser.** It looks like polish until the first prompt containing a
  `javascript:` URL is served to a candidate.
- **`H-040` the honest round trip.** Exporting 200 questions and re-importing them into an empty
  organisation is the only check that the bank is portable. Everything else is a unit test of a
  part of it.

## Counts

| Milestone | Phase | Tasks | P0 | done | todo |
|---|---|---|---|---|---|
| M-1 | P0 | 39 | 36 | 38 | 1 |
| M0 | P1–P2 | 40 | 20 | 17 | 23 |
| M1 | P3 | 33 | 18 | 0 | 33 |
| M2 | P4 | 29 | 15 | 0 | 29 |
| M3 | P5 | 16 | 4 | 0 | 16 |
| M4 | P6 | 18 | 5 | 0 | 18 |
| **Total** | | **175** | **98** | **55** | **120** |

Reconciled against the code on 2026-09-17, not carried forward. The jump from 135 rows to 175 is the forty security actions above, which existed only as prose in the threat model until the same day. A row is `done` only where the behaviour
exists and is tested; partial work stays `todo` with an annotation saying what is done and what
remains, because `in-progress` means an owner with an open branch and every owner is unassigned.
The reconciliation was needed because P1 and the first P2 tracks were built without flipping their
rows — a breach of CLAUDE.md rule 2 that left the board describing a project that did not exist.

M-1 grew from 13 rows to 39 because the original set described the *outputs* of the foundation
phase without the engineering work that produces them — a workspace, a schema as migrations, a
tenancy harness, a test harness, a security boundary. `H-110` through `H-135` are that work, and
they are what [`P0-FOUNDATION-PLAN.md`](P0-FOUNDATION-PLAN.md) sequences step by step.

Seventy-two `P0` rows is a high proportion and is not an error. In this system the invariants are
the product: row-level security, the materialised draw, the server clock, immutable question
versions, sandbox isolation, token scoping and the leak suite are each far cheaper to build now
than to retrofit, and none of them can be cut without changing what the product is. See the
priority legend above for what `P0` does and does not mean.
