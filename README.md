<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/assaybank-lockup-paper.svg">
    <img src="brand/assaybank-lockup.svg" alt="Assaybank" width="300">
  </picture>
</p>

<p align="center"><em>assay</em> (v.) &mdash; to test a material in order to determine its purity and composition.</p>

# Assaybank

**Status:** in build — foundation (P0) and tenancy/identity (P1) complete; question bank (P2) in progress. CI green.
**Owner:** _unassigned_
**Last updated:** 2026-09-20
**Companion docs:** [`docs/README.md`](docs/README.md), [`CLAUDE.md`](CLAUDE.md), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CODE-GRAPH.md`](CODE-GRAPH.md), [`project/STATUS.md`](project/STATUS.md)

---

Technical hiring teams currently pick between commercial platforms priced for companies running hundreds of weekly loops — where the question bank lives in a format you cannot export cleanly and campus drives hit concurrency ceilings — and a stack of disconnected tools: a form for MCQs, a shared doc for the coding round, a screen-share for the interview, a spreadsheet for the scores. Neither produces the thing that actually matters, which is a defensible, repeatable, auditable record of why each candidate was advanced or rejected, tied to the skills the role genuinely needs. Assaybank is a self-hosted platform that covers three assessment surfaces against one shared question bank and one skill taxonomy, so a question written once is reusable everywhere, carries its own version history, and accumulates the statistics that tell you whether it discriminates between strong and weak candidates. See [`docs/01-PRD.md`](docs/01-PRD.md) §1–2 for the full argument.

## The name

An **assay** is the test an assay office runs on a metal before it strikes a hallmark — the mark
meaning *tested, and found true*. The word comes from Old French *essai*, "a trial or attempt", the
same root as *essay* and as *attempt*, which is the central table in
[`docs/hiring_platform_schema.sql`](docs/hiring_platform_schema.sql). The **bank** is the one shared
question bank all three surfaces draw from, and the asset the whole design exists to protect.

The name commits to a position the architecture already takes: this system measures, and a human
decides. Proctoring produces advisory signals and never a verdict (ADR-007), and no model sits
anywhere in the scoring path (ADR-011). See [`brand/README.md`](brand/README.md) for the mark, the
palette and the usage rules.

## The three assessment surfaces

| Surface | Analogue | Primary use | Milestone |
|---|---|---|---|
| Async assessment | HackerRank Tests | First-round screening at volume | M1 (MCQ), M2 (coding) |
| Live interview | CoderPad | Pair-programming and deep-dive rounds | M3 |
| Proctored exam | AWS certification | Certification, campus drives, high-stakes testing | M4 |

All three read from the same `question_versions` table, resolve the same section rules, and roll up to the same skill scores. The shared bank is the product; the three surfaces are presentation.

## Status

**Where it stands, 2026-09-20.** The foundation, tenancy and identity phases are built and tested, and the question bank is half built: fifteen workspaces, 2,967 passing tests, and CI green on `main` across build, security, docs and licence gates. 76 of 196 backlog tasks are done — [`project/STATUS.md`](project/STATUS.md) has the one-screen view and [`project/TRACKER.md`](project/TRACKER.md) the task-level one. No assessment can be taken yet: attempts, execution, live interviews and proctoring are phases P3 to P6, and anything in the layout below not yet built lands with the phase named against it.

Milestones follow [`docs/01-PRD.md`](docs/01-PRD.md) §6. **Dates are deliberately not repeated here** — they live in [`project/ROADMAP.md`](project/ROADMAP.md) (build order and the current baseline) and [`project/MILESTONES.md`](project/MILESTONES.md) (the commitment and its exit criteria). A calendar copied into four documents is a calendar that will disagree with itself.

| Milestone | Phase | Delivers | Exit criterion |
|---|---|---|---|
| **M-1** Foundation | P0 | Workspace, toolchain, tenancy harness, CI enforcing | A clean clone reaches a running stack and a green CI run in under 10 minutes |
| **M0** Question bank | P1–P2 | Tenancy and identity spine, authoring, immutable versioning, skills, roles, import/export | 200 questions loaded, tagged to ≥ 3 job roles, exportable and re-importable without loss |
| **M1** Async MCQ | P3 | Assessment builder, tokenised invitations, server-authoritative timer, auto-grading | 50 candidates complete a 30-question test concurrently; scores reproduce exactly on re-grade |
| **M2** Coding rounds | P4 | Monaco, Piston wiring, async grading queue with retry and dead-letter | 100 concurrent submissions graded, p95 result latency under 8 s |
| **M3** Live interviews | P5 | Yjs collaboration, session replay, structured scorecards | An interviewer runs a full 45-minute loop and replays it afterwards |
| **M4** Proctored / certification | P6 | Safe Exam Browser integration, browser-signal proctoring, integrity review queue | A 90-minute certification exam runs end to end with a reviewable integrity report |
| — | P7 | Load, disaster-recovery, security and accessibility verification before GA | Every gate in [`docs/07-load-and-capacity-testing.md`](docs/07-load-and-capacity-testing.md) green |

M0 through M2 is the product. M3 is a separate track that can start in parallel with a second engineer. M4 is last deliberately — it is the least valuable per unit of effort and the most legally fraught.

## Stack

| Concern | Choice | Licence | Why |
|---|---|---|---|
| Runtime | Node 22 LTS + TypeScript 5.x | MIT | BullMQ, Yjs and `y-websocket` are Node-only, so the collab and worker tiers force Node regardless (ADR-012) |
| HTTP API | Fastify 5 | MIT | Schema-first, fast, plugin encapsulation maps onto our module boundaries |
| Monorepo | pnpm workspaces + Turborepo | MIT | Content-hash task caching; no bespoke build orchestration |
| Database | PostgreSQL 16 | PostgreSQL | Row-level security, JSONB, partitioning, arrays |
| ORM / migrations | Drizzle ORM | Apache-2.0 | Migrations as code, SQL-shaped, no runtime magic |
| Cache / queue | Valkey 8 + BullMQ | BSD-3 / MIT | Valkey, not Redis > 7.2 — Redis relicensed to RSALv2/SSPL (see [`docs/05-licensing-and-compliance.md`](docs/05-licensing-and-compliance.md) §1) |
| Code execution | Piston, self-hosted | MIT | Judge0 is GPL-3.0 and blocks commercialisation (ADR-002) |
| Object storage | SeaweedFS (S3-compatible) | Apache-2.0 | MinIO is AGPL-3.0 and violates the licence policy |
| Editor | Monaco | MIT | Desktop-first; coding rounds are explicitly not a mobile surface |
| Collaboration | Yjs + `y-websocket` | MIT | CRDT, no central lock (ADR-005) |
| Auth | Better Auth | MIT | Session-based staff auth, no vendor dependency |
| Frontend | React 19 + TanStack Router/Query, Tailwind CSS | MIT | — |
| Mail (dev) | Mailpit | MIT | Catches outbound mail locally; never forwards |
| Video (M3) | LiveKit | Apache-2.0 | Self-hostable SFU |
| Lockdown (M4) | Safe Exam Browser | MPL-2.0 / mixed | Only serious open option |
| Observability | OpenTelemetry, Prometheus, Grafana | Apache-2.0 / AGPL-3.0 (Grafana, operational only) | Grafana is an operator-run dashboard, not a distributed dependency — see the licence note below |

## Repository layout

Directories appear as milestones land. Anything below without a "present" marker does not exist yet; the milestone column says when it is created.

```
assaybank/
├── apps/
│   ├── api/                  Fastify HTTP + SSE API. The only writer of domain tables.   M0
│   ├── worker/               BullMQ grading workers and scheduled sweeps                  M1
│   ├── collab/               y-websocket server for live interview documents              M3
│   ├── web/                  React staff console (recruiter / interviewer / admin)        M0
│   └── candidate/            React candidate app (assessment runner + interview join)     M1
├── packages/
│   ├── contracts/            zod schemas, generated OpenAPI 3.1, error codes              M0
│   ├── db/                   Drizzle schema, migrations, RLS policies, seed               M0
│   ├── core-domain/          Attempt state machine, section rules, scoring, skill roll-up M0
│   ├── exec-adapter/         Piston behind execute(language, version, files, stdin, …)    M2
│   ├── grading/              Test-case comparison and weighted scoring (pure, no I/O)     M1
│   ├── auth/                 Staff sessions/OIDC, attempt tokens, WS tickets, permissions M0
│   ├── config/               Env parsing and validation; fails fast at boot               M0
│   ├── observability/        Logger, OTel tracing, metrics                                M0
│   └── ui/                   Shared React components and design tokens                    M0
├── infra/                    Dockerfiles, Postgres init, Piston, Caddy, OTel, Prometheus  present
├── brand/                 Logo system, favicon and icon assets
├── docs/                     PRD, HLD, API spec, ADRs, and the specialist docs            present
├── project/                  Milestones, tracker, risks, open questions, status           present
├── scripts/                  Code-graph generation and the CI doc/licence gates           present
└── .github/                  Workflows, templates, CODEOWNERS                             present
```

`apps/candidate` is a separate bundle from `apps/web` on purpose: no staff-only code, no correct-answer flags and no question-bank access ever ship to a candidate browser. That is an architectural boundary, not a build-optimisation.

## Quick start

### Prerequisites

| Tool | Version | Check |
|---|---|---|
| Docker Engine + Compose v2 | 24+ / 2.20+ | `docker compose version` |
| Node | 22 LTS (see [`.nvmrc`](.nvmrc)) | `node -v` |
| pnpm | 9+ | `pnpm -v` |
| GNU Make | any | `make -v` |
| `openssl` | any | for generating local secrets |

Approximately 8 GB of RAM free for the full stack; Piston pulls language runtimes on first boot and that is the slow part.

```sh
cp .env.example .env          # then fill in the secrets it tells you to generate
make up                       # start the full local stack
make migrate                  # required: the container init creates table shapes only —
                              # the ADR-003 immutability trigger and RLS come from migrations
make seed                     # permission catalogue, system roles, starter skill taxonomy
```

`make help` lists every target. `make down` stops the stack, `make nuke` removes its volumes as well.

### Local URLs

| Service | URL | Notes |
|---|---|---|
| API | http://localhost:8080 | Fastify; `/healthz`, `/readyz`, OpenAPI at `/openapi.json` |
| Collab (WebSocket) | ws://localhost:8081 | `y-websocket`, from M3 |
| Staff console | http://localhost:5173 | Vite dev server; port 3000 in production images |
| Candidate app | http://localhost:5174 | Vite dev server; port 3001 in production images |
| PostgreSQL | postgres://localhost:5432 | `make psql` opens a shell |
| Valkey | redis://localhost:6379 | `make redis-cli` opens a shell |
| Piston | http://piston:2000 | Execution engine API. Deliberately **not** published to the host — it has no authentication and it runs untrusted code. Reach it from inside the network |
| SeaweedFS (S3) | http://localhost:8333 | S3-compatible endpoint, path-style addressing; master on 9333 |
| Mailpit | http://localhost:8025 | Web UI; SMTP on 1025. Nothing leaves the machine |
| OTel Collector | http://localhost:4317 | OTLP gRPC ingest; HTTP on 4318 |
| Prometheus | http://localhost:9090 | Scrapes API, worker and collab |
| Grafana | http://localhost:3030 | Dashboards; login from `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` in `.env` |

## Licence

MPL-2.0 — see [`LICENSE`](LICENSE) and [ADR-020](docs/04-ADRs.md). Weak copyleft at file
granularity: self-host it, modify it, sell a service built on it, combine it with proprietary code.
Modifications to MPL-covered files must be published when you distribute them; running it as a
service triggers nothing. Exhibit B is not applied, so the code stays GPL-compatible.

Every source file carries the Exhibit A notice and CI enforces it. Separately, every *dependency*
must be MIT, Apache-2.0, BSD, ISC or MPL-2.0, and the build fails on GPL, AGPL, SSPL or BSL — see
[`docs/05-licensing-and-compliance.md`](docs/05-licensing-and-compliance.md). Those are two
different rules for two different directions.

## Documentation

### Design and specification — [`docs/`](docs/README.md)

| Doc | What it answers |
|---|---|
| [`docs/README.md`](docs/README.md) | The docs index and reading order |
| [`docs/01-PRD.md`](docs/01-PRD.md) | What we are building and why, users, scope by milestone, requirements, success metrics |
| [`docs/02-HLD.md`](docs/02-HLD.md) | Components, flows, technology choices, scaling, security, failure modes, deployment |
| [`docs/03-API-spec.md`](docs/03-API-spec.md) | Endpoints, auth model, attempt state machine, webhooks, error format |
| [`docs/04-ADRs.md`](docs/04-ADRs.md) | The decisions that are expensive to reverse, and why they went the way they did |
| [`docs/05-licensing-and-compliance.md`](docs/05-licensing-and-compliance.md) | Dependency licence policy, question content licensing, employment-assessment regulation |
| [`docs/06-testing-strategy.md`](docs/06-testing-strategy.md) | Test pyramid, fixtures, the candidate-leak assertion, re-grade determinism |
| [`docs/07-load-and-capacity-testing.md`](docs/07-load-and-capacity-testing.md) | Load profiles, the deadline stampede, capacity sizing and how it is verified |
| [`docs/08-i18n-and-localisation.md`](docs/08-i18n-and-localisation.md) | Multi-language question content, UI locales, right-to-left, date and number handling |
| [`docs/09-ats-integration.md`](docs/09-ats-integration.md) | Webhook contract, signing and rotation, the connector strategy |
| [`docs/10-certification-and-credentials.md`](docs/10-certification-and-credentials.md) | Certificate issuance, verifiable IDs, Open Badges versus PDF |
| [`docs/11-data-retention-and-dpia.md`](docs/11-data-retention-and-dpia.md) | Retention clocks, erasure, data-protection impact assessment |
| [`docs/12-observability-and-runbooks.md`](docs/12-observability-and-runbooks.md) | Metrics, alerts, traces, and the on-call runbook per failure mode |
| [`docs/13-environments-and-release.md`](docs/13-environments-and-release.md) | dev/staging/production, the env-var table, blue-green and migration procedure |
| [`docs/14-threat-model.md`](docs/14-threat-model.md) | Attacker classes, trust boundaries, sandbox escape, cheating economics |
| [`docs/15-accessibility-conformance.md`](docs/15-accessibility-conformance.md) | WCAG 2.1 AA conformance plan, accommodations, assistive-technology testing |
| [`docs/16-ai-usage-policy.md`](docs/16-ai-usage-policy.md) | Where AI may and may not be used, and why the scoring path is closed to it |
| [`docs/17-engineering-standards.md`](docs/17-engineering-standards.md) | The production-grade bar: type discipline, layering, API and database rules, and what a reviewer checks first |
| [`docs/DOC-OWNERSHIP.md`](docs/DOC-OWNERSHIP.md) | Which role owns which document and how staleness is detected |
| [`docs/hiring_platform_schema.sql`](docs/hiring_platform_schema.sql) | Full PostgreSQL schema, runnable |

### Planning and execution — [`project/`](project/STATUS.md)

| Doc | What it answers |
|---|---|
| [`project/STATUS.md`](project/STATUS.md) | Where the build actually is, as of the last update |
| [`project/ROADMAP.md`](project/ROADMAP.md) | **Start here to build.** Phase-by-phase build order P0–P7, the schedule baseline, and each phase's entry and exit gate |
| [`project/P0-FOUNDATION-PLAN.md`](project/P0-FOUNDATION-PLAN.md) | The fifteen steps of the foundation phase, in order, each with its verification |
| [`project/MILESTONES.md`](project/MILESTONES.md) | M-1–M4 commitments, dates and exit criteria |
| [`project/TRACKER.md`](project/TRACKER.md) | The backlog: every work item, its milestone, owner and status |
| [`project/RISKS.md`](project/RISKS.md) | Risk register with likelihood, impact, owner and mitigation |
| [`project/OPEN-QUESTIONS.md`](project/OPEN-QUESTIONS.md) | Unanswered questions, each with an owner and a decide-by date |
| [`project/DEFINITION-OF-DONE.md`](project/DEFINITION-OF-DONE.md) | What "done" means for a backlog item, a milestone and a release |
| [`project/GLOSSARY.md`](project/GLOSSARY.md) | Domain vocabulary — attempt, draw, section rule, exposure, p-value |

### Repository operation

| Doc | What it answers |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Operating rules for any engineer or AI agent working in this repo |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Branches, commits, PR checklist, how to add an ADR or a dependency |
| [`CODE-GRAPH.md`](CODE-GRAPH.md) | Generated map of services, packages, queues and external dependencies |
| [`infra/README.md`](infra/README.md) | What each container is, how the compose files differ, how to operate them |

## How this repo stays honest

Documentation rots when it is nobody's job and nothing checks it. Four mechanisms keep this repository's description of itself true:

1. **[`project/TRACKER.md`](project/TRACKER.md) is the single backlog.** A work item that is not in the tracker is not planned; a tracker item marked done that has no merged change is a bug in the tracker. [`project/STATUS.md`](project/STATUS.md) summarises it for anyone who wants one screen instead of the whole list.
2. **[`CODE-GRAPH.md`](CODE-GRAPH.md) is generated, never hand-edited.** `code-graph.json` is the source and `node scripts/gen-code-graph.mjs` renders it. Any change to a service boundary, package, queue or external dependency updates the JSON in the same change. A hand edit to the Markdown is reverted by the next generation.
3. **[`docs/DOC-OWNERSHIP.md`](docs/DOC-OWNERSHIP.md) assigns every document a role-level owner** and a review cadence, so "who decides this" never has to be worked out from git blame.
4. **CI enforces freshness.** `scripts/check-doc-freshness.mjs` fails the build when a document changes without its `**Last updated:**` line moving, and when a document exceeds its review cadence. `scripts/check-links.mjs` fails on a broken relative link. `scripts/check-task-ids.mjs` fails when an `H-NNN` names no tracker row, which is how a document minting its own ids comes to cite someone else's finished task. `scripts/check-licences.mjs` fails on a prohibited dependency licence. `scripts/check-secrets.mjs` fails when a committed password — in a connection string or a password-named constant — could be mistaken for a real one. A Claude Code `PostToolUse` hook warns locally before you ever reach CI.

The contract those mechanisms implement is written out as numbered rules in [`CLAUDE.md`](CLAUDE.md) under "Keeping the docs true". Read it before your first change.

## Licence policy

Permitted: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, PostgreSQL License, Unlicense, CC0.

Prohibited anywhere in the dependency tree, including transitively: GPL (any version), LGPL where static linking applies, AGPL (any version), SSPL, BSL/BUSL, Commons Clause, source-available licences, and anything carrying a field-of-use restriction. CI fails the build; an SBOM is produced per release.

Two traps this repository has already routed around: **MinIO is AGPL-3.0**, so object storage is SeaweedFS; **Redis after 7.2 is RSALv2/SSPL**, so the cache and queue backend is Valkey 8. Grafana is AGPL-3.0 and is permitted only as an operator-run dashboard in `infra/` — it is never imported, linked or distributed as part of the product, and nothing in `apps/` or `packages/` may depend on it. Full policy and the content-licensing rules for questions themselves are in [`docs/05-licensing-and-compliance.md`](docs/05-licensing-and-compliance.md).

## The four ideas the whole design rests on

1. **Published questions are immutable.** Editing creates a version. Attempts reference versions, not questions. Without this you cannot re-grade, defend a dispute, or trust your question statistics. (ADR-003)
2. **The served question set is materialised per attempt.** Randomised draws are resolved once, written down including option shuffle order, and never recomputed. (ADR-004)
3. **Skills join roles to questions.** A question is never tagged with a job role directly, or every new role means re-tagging the bank. (ADR-009)
4. **The server owns the clock, the scoring and the question selection.** The client renders; it does not decide. (ADR-006)

Two constraints sit alongside them and are not configuration options: proctoring emits advisory signals only and never auto-rejects, auto-voids or down-scores an attempt (ADR-007), and no AI sits anywhere in the scoring or decision path (ADR-011).
