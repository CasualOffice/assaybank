# Backlog tracker

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-15
**Companion docs:** [`MILESTONES.md`](MILESTONES.md), [`DEFINITION-OF-DONE.md`](DEFINITION-OF-DONE.md), [`RISKS.md`](RISKS.md), [`GLOSSARY.md`](GLOSSARY.md), [`../docs/01-PRD.md`](../docs/01-PRD.md), [`../docs/03-API-spec.md`](../docs/03-API-spec.md), [`../docs/04-ADRs.md`](../docs/04-ADRs.md)

---

## How to use this

This is the working backlog, not a sprint board. It holds engineering units that a single person can finish and review — roughly half a day to five days each. Anything larger is a milestone scope line in [`MILESTONES.md`](MILESTONES.md) and gets broken down here before work starts.

Every task traces to something written down: a functional requirement `FR-n` from [`../docs/01-PRD.md`](../docs/01-PRD.md) §7, an architecture decision `ADR-n` from [`../docs/04-ADRs.md`](../docs/04-ADRs.md), a section of the HLD or API spec, or a milestone exit criterion. A task with no reference is either missing its reference or is not work this project agreed to do.

Read it top to bottom to understand build order; read the **Depends on** column to understand what is actually startable today.

### Id allocation rule

Ids are `H-NNN`, allocated strictly in ascending order from the highest id currently in the file, **never reused and never renumbered**. An id is permanent: it appears in branch names (`h-038-question-authoring-ui`), commit messages, PR titles and ADR cross-references, so renumbering silently breaks history. A cancelled task keeps its row with status `done` and the word "cancelled" plus a reason in the task text; deleting the row loses the record that it was considered.

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

### Areas

`db` schema, migrations, RLS · `api` Fastify HTTP and SSE surface, contracts, auth · `worker` BullMQ jobs, grading, sweeps, imports · `exec` execution adapter and sandbox behaviour · `collab` y-websocket and CRDT · `web` staff console · `candidate` candidate app · `infra` docker, CI, nodes, storage, networking · `docs` written deliverables and rehearsals · `compliance` licence, retention, fairness, accessibility obligations

### Estimates

`S` up to half a day · `M` one to two days · `L` three to five days. Anything that feels bigger than `L` is two tasks.

---

## M-1 — Foundation (2026-09-15 → 2026-09-18)

| ID | Task | Area | Milestone | Depends on | FR / ADR ref | Est | Status | Owner |
|---|---|---|---|---|---|---|---|---|
| H-001 | Repo root identity: `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `.gitignore`, `.editorconfig`, `.nvmrc` | docs | M-1 | — | — | S | done | _unassigned_ |
| H-002 | Canonical `.env.example` and `Makefile` targets, agreeing with compose and the docs | infra | M-1 | H-001 | HLD 10 | S | done | _unassigned_ |
| H-003 | Dev docker-compose stack: Postgres 16, Valkey 8, Piston, SeaweedFS, Mailpit, OTel collector, Prometheus, Grafana on the canonical ports | infra | M-1 | H-002 | HLD 10, ADR-001 | M | done | _unassigned_ |
| H-004 | Production compose plus Caddy reverse proxy and TLS termination config | infra | M-1 | H-003 | HLD 10 | M | done | _unassigned_ |
| H-005 | `CODE-GRAPH.md`, `code-graph.json` and `scripts/gen-code-graph.mjs` | docs | M-1 | H-001 | — | M | done | _unassigned_ |
| H-006 | GitHub Actions: lint, typecheck, test, build, doc-freshness and link-check workflows | infra | M-1 | H-001 | — | M | done | _unassigned_ |
| H-007 | CI licence gate script failing on GPL, LGPL-static, AGPL, SSPL, BSL/BUSL and Commons Clause | compliance | M-1 | H-006 | ADR-001 | M | done | _unassigned_ |
| H-008 | Project management layer: milestones, backlog, risks, open questions, status, definition of done, glossary | docs | M-1 | — | PRD 6 | M | done | _unassigned_ |
| H-009 | Record ADR-012..ADR-019 and rewrite the docs index | docs | M-1 | — | ADR-012 | M | done | _unassigned_ |
| H-010 | Supporting design docs 06–16: testing, load and capacity, i18n, ATS, certification, retention and DPIA, observability, environments, threat model, accessibility, AI usage policy | docs | M-1 | H-008 | PRD 11 | L | done | _unassigned_ |
| H-011 | pnpm workspace plus Turborepo pipeline, all thirteen packages present and compiling empty | api | M-1 | H-001 | ADR-012 | M | todo | _unassigned_ |
| H-012 | `packages/config`: env parsing and validation that fails fast at boot, driven by `.env.example` | api | M-1 | H-011 | HLD 10 | S | todo | _unassigned_ |
| H-013 | `packages/observability`: structured logger, OTel tracing bootstrap, Prometheus `/metrics` endpoint | api | M-1 | H-011 | HLD 8 | M | todo | _unassigned_ |

## M0 — Question bank (2026-09-21 → 2026-10-09)

| ID | Task | Area | Milestone | Depends on | FR / ADR ref | Est | Status | Owner |
|---|---|---|---|---|---|---|---|---|
| H-014 | Drizzle schema for schema sections 1–3: organizations, users, RBAC tables, skills, job roles, job openings | db | M0 | H-011 | FR-26, FR-27 | M | todo | _unassigned_ |
| H-015 | Drizzle schema for schema section 4: questions, question_versions, mcq_options, coding_specs, test_cases, short_answer_keys, question_stats, plus the two enums | db | M0 | H-014 | FR-1, ADR-003 | M | todo | _unassigned_ |
| H-016 | RLS policies on every tenant table plus per-checkout `app.current_org`, and a separate elevated job role with its own audit trail | db | M0 | H-015 | FR-26, ADR-010 | M | todo | _unassigned_ |
| H-017 | RLS negative test per tenant table: a session scoped to org A reads zero org B rows on select, update and delete | db | M0 | H-016 | FR-26, ADR-010 | M | todo | _unassigned_ |
| H-018 | Seed script: system `user_roles`, `permissions`, `user_role_permissions`, and a two-level starter skill taxonomy | db | M0 | H-014 | ADR-009 | S | todo | _unassigned_ |
| H-019 | Expand-contract migration harness plus a CI lint rejecting a destructive migration in one step | db | M0 | H-014 | HLD 10 | M | todo | _unassigned_ |
| H-020 | Indexes from schema section 11 and an `EXPLAIN` baseline captured with RLS enabled, to detect plan degradation later | db | M0 | H-017 | ADR-010 | M | todo | _unassigned_ |
| H-021 | `packages/auth`: staff sessions via Better Auth plus OIDC login against `OIDC_ISSUER` | api | M0 | H-014 | FR-27 | L | todo | _unassigned_ |
| H-022 | Per-action permission checks resolved from `user_role_permissions`, never from a role name, so custom roles work | api | M0 | H-021 | FR-27 | M | todo | _unassigned_ |
| H-023 | `packages/contracts`: zod schemas, the stable error-code union, generated OpenAPI 3.1 | api | M0 | H-011 | API 2 | M | todo | _unassigned_ |
| H-024 | Fastify app skeleton: request id, error envelope, cursor pagination, `server_time` on every response | api | M0 | H-023 | API 2, ADR-006 | M | todo | _unassigned_ |
| H-025 | `Idempotency-Key` middleware replaying the original response body and status on a repeat | api | M0 | H-024 | API 2 | M | todo | _unassigned_ |
| H-026 | Valkey-backed rate limiter implementing the five documented scopes and returning `Retry-After` | api | M0 | H-024 | API 2 | M | todo | _unassigned_ |
| H-027 | Append-only `audit_log` writer plus middleware capturing every privileged action with actor, entity and reason | api | M0 | H-024 | FR-21, FR-25 | M | todo | _unassigned_ |
| H-028 | Skills and job-roles CRUD including `job_role_skills` weights, and `GET /job-roles/{id}/coverage` reporting where the bank is thin | api | M0 | H-024 | FR-2, ADR-009 | M | todo | _unassigned_ |
| H-029 | Question CRUD across all eight kinds with kind-specific payload validation for options, coding specs, test cases and answer keys | api | M0 | H-024 | PRD 6 M0 | L | todo | _unassigned_ |
| H-030 | Version lifecycle draft → review → published → retired; `PATCH` on a published version returns 409 `version_immutable` | api | M0 | H-029 | FR-1, ADR-003 | M | todo | _unassigned_ |
| H-031 | `PUT /questions/{id}/skills` with weights; no route, column or import path permits tagging a question with a job role | api | M0 | H-028 | FR-2, ADR-009 | S | todo | _unassigned_ |
| H-032 | Import job adapters for HumanEval, MBPP, LBPP and Exercism, rejecting any row without `source_license`, preserving `external_ref`, emitting per-row errors instead of failing the file, and driving an attributions page in the staff console | worker | M0 | H-029 | FR-3 | L | todo | _unassigned_ |
| H-033 | QTI 2.1 import and export, round-trip without loss across all eight question kinds | worker | M0 | H-032 | M0 exit | L | todo | _unassigned_ |
| H-034 | JSON bank export in an open, documented shape, with CC-BY attribution preserved in the payload | worker | M0 | H-032 | FR-29, G6 | M | todo | _unassigned_ |
| H-035 | Nightly `question_stats` job computing p-value and point-biserial discrimination per question version once n ≥ 30 | worker | M0 | H-015 | FR-5 | M | todo | _unassigned_ |
| H-036 | `exposure_count` increment on attempt materialisation plus a retirement flag above a configurable threshold | api | M0 | H-030 | FR-4 | S | todo | _unassigned_ |
| H-037 | Staff console shell: TanStack Router, auth guard, layout, shared design tokens in `packages/ui` | web | M0 | H-021 | — | M | todo | _unassigned_ |
| H-038 | Question authoring UI: markdown prompt editor, option editor, test-case editor, explicit publish action that reads as irreversible | web | M0 | H-037 | ADR-003 | L | todo | _unassigned_ |
| H-039 | Wire the licence gate against the real `pnpm-lock.yaml`, plant an AGPL fixture to prove it fails, generate the first CycloneDX SBOM | compliance | M0 | H-007, H-011 | ADR-001 | S | todo | _unassigned_ |
| H-040 | M0 exit evidence: load 200 questions tagged to at least 3 job roles and prove a lossless export/re-import round trip | docs | M0 | H-033 | M0 exit | M | todo | _unassigned_ |

## M1 — Async MCQ assessment (2026-10-12 → 2026-10-30)

| ID | Task | Area | Milestone | Depends on | FR / ADR ref | Est | Status | Owner |
|---|---|---|---|---|---|---|---|---|
| H-041 | Drizzle schema for schema sections 5–6: assessments, assessment_sections, section_questions, section_rules, candidates, applications, invitations, attempts, attempt_questions, answers | db | M1 | H-019 | FR-6, FR-7 | M | todo | _unassigned_ |
| H-042 | Assessment and section CRUD plus assessment versioning — editing a live assessment clones a new version and in-flight attempts finish on the old one | api | M1 | H-041 | FR-10 | L | todo | _unassigned_ |
| H-043 | Implement section rule resolver with `exclude_seen_days` window, difficulty band, skill and kind filters | api | M1 | H-042 | FR-6, ADR-004 | L | todo | _unassigned_ |
| H-044 | `POST /assessments/{id}/simulate` returning feasibility, sample draw and warnings; publish is blocked until a simulate run passes | api | M1 | H-043 | ADR-004 | M | todo | _unassigned_ |
| H-045 | `POST /assessments/auto` composing a draft assessment from `job_role_skills` weights and a difficulty profile | api | M1 | H-043 | ADR-009 | M | todo | _unassigned_ |
| H-046 | Candidate and application CRUD plus bulk CSV import job with per-row error reporting | api | M1 | H-041 | PRD 6 M1 | M | todo | _unassigned_ |
| H-047 | Invitation tokens: high entropy, peppered hash at rest via `TOKEN_PEPPER`, plaintext returned exactly once, bulk issue and SMTP send through `SMTP_URL` | api | M1 | H-046 | HLD 7 | L | todo | _unassigned_ |
| H-048 | Attempt start materialises `attempt_questions` with `option_order` in one transaction, and never re-rolls on any later read | api | M1 | H-043 | FR-7, ADR-004 | L | todo | _unassigned_ |
| H-049 | Server-computed `deadline_at` from `duration_seconds` plus `accommodations.extra_time_pct`, recorded in the audit log and surfaced on the report; heartbeat returns `server_time` and `seconds_remaining` | api | M1 | H-048 | FR-8, PRD 9, ADR-006 | M | todo | _unassigned_ |
| H-050 | Autosave endpoint with ≤5s cadence, conflict-free last-write-wins per answer, and resume after disconnect with no data loss | api | M1 | H-048 | FR-9 | M | todo | _unassigned_ |
| H-051 | Attempt state machine enforcement including the transactional `finalised` guard requiring every `answers.final_score` non-null | api | M1 | H-048 | API 8 | M | todo | _unassigned_ |
| H-052 | Deadline sweep job transitions overdue attempts to `expired` and grades autosaved answers rather than discarding them | worker | M1 | H-051 | FR-8, ADR-006 | M | todo | _unassigned_ |
| H-053 | `packages/grading`: MCQ single and multi partial credit, negative marking, short-answer matchers (exact, ci, regex, numeric tolerance) — pure, no I/O | worker | M1 | H-041 | FR-20 | M | todo | _unassigned_ |
| H-054 | Per-skill sub-score roll-up derived from `question_skills` weights, exposed on the attempt report | worker | M1 | H-053 | FR-20, ADR-009 | M | todo | _unassigned_ |
| H-055 | Regrade creates a new grading run rather than mutating in place; manual score override requires a reason; both write the before and after score to the audit log | api | M1 | H-027, H-053 | FR-21, API 8 | M | todo | _unassigned_ |
| H-056 | Serialisation guard test asserting `is_correct`, `rationale_md`, `solution_code` and `expected_stdout` never appear in any candidate-facing response | api | M1 | H-048 | FR-12, HLD 7 | M | todo | _unassigned_ |
| H-057 | Candidate app shell: token redemption, no account, no install, no plugin; separate bundle from the staff console | candidate | M1 | H-047 | G2 | M | todo | _unassigned_ |
| H-058 | MCQ runner UI honouring `option_order`, section navigation and `allow_back_nav`, with the countdown derived from `server_time` and an offline autosave buffer that replays on reconnect | candidate | M1 | H-057 | FR-7, FR-8, FR-9 | L | todo | _unassigned_ |
| H-059 | Per-candidate report view plus cohort CSV export with per-skill breakdown | web | M1 | H-054 | PRD 6 M1 | M | todo | _unassigned_ |
| H-060 | Assessment analytics: per-question p-value, discrimination, mean time, and MCQ option distribution for spotting ambiguous questions | api | M1 | H-035 | PRD 9 | M | todo | _unassigned_ |
| H-061 | Webhook framework plus admin endpoints: HMAC-SHA256 signing over the raw body, at-least-once delivery, exponential backoff, 24-hour retry window, delivery log, test delivery, and secret rotation on `WEBHOOK_SIGNING_SECRET_ROTATION_DAYS` with an overlap window | worker | M1 | H-027 | API 12 | L | todo | _unassigned_ |
| H-062 | M1 exit evidence: 50 candidates complete a 30-question test concurrently, and every score reproduces exactly on re-grade | docs | M1 | H-055 | M1 exit | M | todo | _unassigned_ |

## M2 — Coding rounds (2026-11-02 → 2026-11-27)

| ID | Task | Area | Milestone | Depends on | FR / ADR ref | Est | Status | Owner |
|---|---|---|---|---|---|---|---|---|
| H-063 | Drizzle schema for schema section 7: submissions and submission_results | db | M2 | H-041 | FR-13 | S | todo | _unassigned_ |
| H-064 | `packages/exec-adapter` implementing `execute(language, version, files, stdin, limits)` over Piston, returning the runtime identity so `language_version` and `runtime_image` are recorded on every submission | exec | M2 | H-011 | FR-13, ADR-002 | L | todo | _unassigned_ |
| H-065 | Enforce `EXEC_CPU_TIME_MS`, `EXEC_WALL_TIME_MS`, `EXEC_MEMORY_MB`, `EXEC_MAX_PROCESSES`, `EXEC_MAX_OUTPUT_BYTES` at the kernel via cgroups, and prove no network egress | exec | M2 | H-064 | FR-15, HLD 7 | M | todo | _unassigned_ |
| H-066 | Infrastructure test asserting execution nodes hold no secrets, no database credentials and no cloud IAM role, and cannot reach the API or database | infra | M2 | H-065 | HLD 7 | M | todo | _unassigned_ |
| H-067 | Piston runtime image pinning, container pre-warm pool, and a node recycle policy | infra | M2 | H-064 | HLD 6, ADR-002 | M | todo | _unassigned_ |
| H-068 | Two BullMQ queues with separate concurrency: interactive `run` (`QUEUE_RUN_CONCURRENCY`) and batch `submit` (`QUEUE_SUBMIT_CONCURRENCY`) | worker | M2 | H-063 | ADR-008 | M | todo | _unassigned_ |
| H-069 | Grading worker pipeline: load version and cases, execute per case, compare, weight, write results — idempotent by submission id, bounded by `QUEUE_MAX_ATTEMPTS`, output truncated to `EXEC_MAX_OUTPUT_BYTES` before storage | worker | M2 | H-068 | ADR-008, FR-14 | L | todo | _unassigned_ |
| H-070 | Dead-letter queue: exhausted jobs move the attempt to `under_review` and raise an alert; an infrastructure failure never scores a candidate zero | worker | M2 | H-069 | HLD 9, ADR-008 | M | todo | _unassigned_ |
| H-071 | Grading modes `test_cases`, `unit_tests` and `custom_checker` with per-case weights, in `packages/grading` with no I/O | worker | M2 | H-069 | PRD 6 M2 | M | todo | _unassigned_ |
| H-072 | Candidate-visible result filtering: sample cases full detail, hidden cases pass/fail and label only, compile errors full — enforced server-side on every response and on the SSE stream | api | M2 | H-069 | FR-12 | M | todo | _unassigned_ |
| H-073 | Run versus submit separation: a trial run touches sample cases only and consumes no submission budget; author preview reuses the identical execution path | api | M2 | H-068 | FR-11, API 4 | M | todo | _unassigned_ |
| H-074 | SSE endpoint `/attempt/submissions/{id}/stream` emitting per-case progress then the final result, with reconnect and replay from last event id | api | M2 | H-069 | ADR-008 | M | todo | _unassigned_ |
| H-075 | Per-attempt execution budget cap plus a final-minute submission rate limit, so one candidate cannot starve the pool and the deadline stampede is flattened | api | M2 | H-073 | HLD 6 | M | todo | _unassigned_ |
| H-076 | SQL question kind: provision `fixture_sql` into a disposable database per execution, torn down afterwards | exec | M2 | H-064 | schema 4 | M | todo | _unassigned_ |
| H-077 | Monaco in the candidate app with language selection, starter code, keyboard accessibility, and an SSE-driven results panel that survives reconnect | candidate | M2 | H-058 | PRD 6 M2 | L | todo | _unassigned_ |
| H-078 | SeaweedFS object storage wiring for large submission artifacts and export files, accessed only through short-TTL pre-signed URLs | infra | M2 | H-063 | HLD 3.5, ADR-001 | M | todo | _unassigned_ |
| H-079 | Queue-depth, execution-latency, sandbox-timeout and dead-letter metrics plus the alerts named in HLD 8 | infra | M2 | H-069 | HLD 8 | M | todo | _unassigned_ |
| H-080 | M2 exit evidence: 100 concurrent submissions graded with p95 result latency under 8s, dead-letter queue empty | docs | M2 | H-069 | M2 exit | M | todo | _unassigned_ |

## M3 — Live interviews (2026-11-30 → 2026-12-24, second engineer)

| ID | Task | Area | Milestone | Depends on | FR / ADR ref | Est | Status | Owner |
|---|---|---|---|---|---|---|---|---|
| H-081 | Drizzle schema for schema sections 8–9: interview_sessions, session_participants, session_events partitioned by month, scorecard_templates, scorecard_criteria, scorecards, scorecard_ratings | db | M3 | H-063 | FR-18, FR-22 | M | todo | _unassigned_ |
| H-082 | `apps/collab` y-websocket server with Valkey pub/sub cross-instance fanout and sticky routing by room code, with a convergence test covering three clients, concurrent edits and reconnect | collab | M3 | H-081 | FR-17, ADR-005 | L | todo | _unassigned_ |
| H-083 | WS ticket issuance and validation: 60-second TTL, single use, plus room-code join with no account and no download | api | M3 | H-082 | FR-16, HLD 7 | M | todo | _unassigned_ |
| H-084 | Periodic `doc_state` snapshot to Postgres on `COLLAB_SNAPSHOT_INTERVAL_MS`, so an instance crash loses at most one interval | collab | M3 | H-082 | ADR-005 | M | todo | _unassigned_ |
| H-085 | Append every applied update to `session_events`, batched and asynchronous, as the queryable parallel stream to the opaque CRDT blob | collab | M3 | H-082 | FR-18, ADR-005 | M | todo | _unassigned_ |
| H-086 | Replay API: `GET /sessions/{id}/events` range query and a packaged replay artifact in object storage | api | M3 | H-085 | FR-18 | M | todo | _unassigned_ |
| H-087 | Replay player UI with variable speed, reconstructing to the same final text as the stored `doc_state` | web | M3 | H-086 | FR-18 | L | todo | _unassigned_ |
| H-088 | Shared editor UI with live cursors, selections and awareness presence for both participants | web | M3 | H-082 | FR-17, ADR-005 | L | todo | _unassigned_ |
| H-089 | Multi-file workspace plus in-session run routed to the interactive queue with the same limits as an attempt run | api | M3 | H-073 | PRD 6 M3 | M | todo | _unassigned_ |
| H-090 | Interviewer private notes pane, filtered server-side out of the candidate payload and out of awareness frames | api | M3 | H-082 | FR-19 | M | todo | _unassigned_ |
| H-091 | Scorecard templates and criteria carrying behavioural anchors describing what each rating level looks like | api | M3 | H-081 | FR-22 | M | todo | _unassigned_ |
| H-092 | Scorecard submit locks the record immutably, and reviewers cannot read each other's scorecards until all are submitted — enforced in the API, not the UI | api | M3 | H-091 | API 11 | M | todo | _unassigned_ |
| H-093 | Self-hosted LiveKit for live-round audio and video with short-lived token issuance | infra | M3 | H-082 | HLD 5 | M | todo | _unassigned_ |
| H-094 | M3 exit evidence: an interviewer runs a full 45-minute loop and replays it afterwards | docs | M3 | H-087 | M3 exit | M | todo | _unassigned_ |

## M4 — Proctored / certification mode (2027-01-05 → 2027-01-30)

| ID | Task | Area | Milestone | Depends on | FR / ADR ref | Est | Status | Owner |
|---|---|---|---|---|---|---|---|---|
| H-095 | Drizzle schema for schema section 10: proctor_events partitioned by month, proctor_media with `delete_after` | db | M4 | H-081 | FR-24, FR-28 | S | todo | _unassigned_ |
| H-096 | Browser-signal collection in the candidate app: focus loss, paste, fullscreen exit, devtools — batched, fire-and-forget, with consent captured before any capture and a non-proctored alternative always offered | candidate | M4 | H-095 | PRD 6 M4, GDPR | M | todo | _unassigned_ |
| H-097 | Proctor event ingestion endpoint writing only to `proctor_events` and `attempts.integrity_flag`; signals are advisory and produce no verdict | api | M4 | H-095 | FR-23, ADR-007 | M | todo | _unassigned_ |
| H-098 | Release-blocking test asserting no code path lets a proctoring signal change a score, void an attempt, alter attempt status or reject a candidate | api | M4 | H-097 | FR-23, ADR-007 | M | todo | _unassigned_ |
| H-099 | Integrity review queue in the staff console with the specific triggering evidence attached to each flag | web | M4 | H-097 | FR-24 | L | todo | _unassigned_ |
| H-100 | Human void flow requiring a reason, reachable from any attempt state, fully audited | api | M4 | H-027 | FR-25 | S | todo | _unassigned_ |
| H-101 | Proctor media upload to object storage, readable only through short-TTL pre-signed URLs, never through a stable public path | api | M4 | H-078 | HLD 7 | M | todo | _unassigned_ |
| H-102 | Safe Exam Browser configuration generation and launch handshake for certification-mode assessments | candidate | M4 | H-096 | PRD 6 M4 | L | todo | _unassigned_ |
| H-103 | Certificate issuance with a verifiable id plus a public verification endpoint that discloses no candidate PII beyond what was consented | api | M4 | H-051 | PRD 6 M4 | L | todo | _unassigned_ |
| H-104 | GDPR erasure: `DELETE /candidates/{id}` hard-deletes PII while retaining anonymised rows so psychometric statistics survive | api | M4 | H-046 | FR-28 | M | todo | _unassigned_ |
| H-105 | Retention sweep enforcing every `RETENTION_*` variable in code — proctor media 30d, session recordings 90d, attempt data 24m, candidate PII 12m, audit log 7y — with a time-travel test per clock | worker | M4 | H-104 | FR-28 | M | todo | _unassigned_ |
| H-106 | Full organisation export: question bank, assessments and results in open formats, delivered as a pre-signed artifact | worker | M4 | H-034 | FR-29, G6 | M | todo | _unassigned_ |
| H-107 | `GET /reports/adverse-impact` with a four-fifths-rule breakdown by voluntarily collected group, plus `GET /reports/funnel` | api | M4 | H-060 | PRD 9 | M | todo | _unassigned_ |
| H-108 | Accessibility conformance pass on the candidate app: axe in CI, keyboard-only run, screen-reader script, no colour-only information, adjustable text size | candidate | M4 | H-077 | PRD 8, WCAG 2.1 AA | L | todo | _unassigned_ |
| H-109 | M4 exit evidence: a 90-minute certification exam runs end to end with a reviewable integrity report | docs | M4 | H-099 | M4 exit | M | todo | _unassigned_ |

---

## Counts

| Milestone | Tasks | done | todo |
|---|---|---|---|
| M-1 | 13 | 10 | 3 |
| M0 | 27 | 0 | 27 |
| M1 | 22 | 0 | 22 |
| M2 | 18 | 0 | 18 |
| M3 | 14 | 0 | 14 |
| M4 | 15 | 0 | 15 |
| **Total** | **109** | **10** | **99** |

The ten `done` rows are the documentation, infrastructure configuration and process artifacts produced in the 2026-09-15 foundation run. **No application code exists in this repository.** Every row describing runtime behaviour is `todo`, including the three M-1 rows that need a compiling workspace.
