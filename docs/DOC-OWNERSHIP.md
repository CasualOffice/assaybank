# Document ownership and freshness

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-16
**Companion docs:** [`README.md`](README.md), [`../CLAUDE.md`](../CLAUDE.md), [`../CONTRIBUTING.md`](../CONTRIBUTING.md), [`../project/DEFINITION-OF-DONE.md`](../project/DEFINITION-OF-DONE.md), [`../.claude/rules/doc-maintenance.md`](../.claude/rules/doc-maintenance.md)

---

Documentation that lies is worse than no documentation. No documentation makes a reader ask someone; wrong documentation makes them confident and wrong, and they do not find out until the thing they built on it fails. This repository is documentation-first — as of 2026-09-15 the design record is the only artefact that exists — so the failure mode is not hypothetical, it is the default outcome unless something actively prevents it.

Three mechanisms prevent it, and this table is the configuration for all three.

**One owner per document.** A document owned by "the team" is owned by nobody. Every row below names exactly one role. The role is a placeholder until people are assigned; the placeholders map one-to-one onto the team handles in [`../.github/CODEOWNERS`](../.github/CODEOWNERS), so assigning a person is a single edit in two files rather than an archaeology exercise.

**One trigger set per document.** A trigger is a path pattern whose change invalidates the document. If a trigger fires in a pull request and the document is not also changed in that same pull request, the gate fails. This is the mechanism that matters: cadence catches slow rot, triggers catch the specific lie that gets written the moment a route changes and the API spec does not. Triggers are deliberately narrow — `apps/api/src/routes/**`, not `apps/api/**` — because a gate that fires on every change is a gate people learn to bypass.

**A maximum age.** Cadence is the human habit; max age in days is what CI actually enforces. A document past its max age is stale regardless of whether anything triggered it, because the absence of change in a living system is itself evidence that nobody has read the document lately.

The gate is `node scripts/check-doc-freshness.mjs`, run by [`../.github/workflows/docs.yml`](../.github/workflows/docs.yml) on every pull request. It is deliberately annoying. It fails the build for a missing date bump, which is a trivial edit, because the alternative is a reviewer deciding case by case whether this particular documentation drift matters — and reviewers, under time pressure, always decide it does not. The cost of the gate is ten seconds per pull request. The cost of not having it is a design record that six months from now nobody trusts, which means nobody reads, which means it may as well be deleted.

## How to read the table

| Column | Meaning |
|---|---|
| Path | Repository-relative path. This is the machine-readable key; the script parses the first code span in the cell. |
| Purpose | One line. If a document needs two, it is two documents. |
| Owner | The single role accountable for the document being true. Not the only person who may edit it. |
| Cadence | `on-change` — reviewed when a trigger fires, not on a calendar. `monthly` / `quarterly` / `annually` — reviewed on that calendar whether or not anything fired. |
| Max age | Days since `**Last updated:**` before CI calls the document stale. The hard threshold, independent of cadence. |
| Triggers | Path patterns (`*` within a segment, `**` across segments). A change matching any of them in a pull request requires this document to change in the same pull request. |
| Last updated | Mirrors the document's own `**Last updated:**` line. The document header is the source of truth; run `node scripts/check-doc-freshness.mjs --sync` to refresh this column. |

Non-markdown entries — currently only the schema — are registered for their trigger rules and existence check. They carry no metadata block, so no date is parsed from them and no age is computed.

## Registry

| Path | Purpose | Owner | Cadence | Max age | Triggers | Last updated |
|---|---|---|---|---|---|---|
| [`README.md`](../README.md) | Repository entry point: what this is, how to bring the stack up, where to start reading | engineering lead | on-change | 180 | `docker-compose.yml`, `Makefile`, `.env.example` | 2026-09-20 |
| [`CLAUDE.md`](../CLAUDE.md) | The operating contract every contributor, human or agent, works under | engineering lead | quarterly | 120 | `apps/*/package.json`, `packages/*/package.json` | 2026-09-20 |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | How a change is proposed, reviewed and merged | delivery lead | quarterly | 120 | `.github/workflows/**`, `Makefile` | 2026-09-18 |
| [`CODE-GRAPH.md`](../CODE-GRAPH.md) | Generated module map: every app and package, what it owns, which way dependencies point | engineering lead | on-change | 180 | `code-graph.json`, `apps/*/package.json`, `packages/*/package.json`, `pnpm-workspace.yaml`, `turbo.json` | 2026-09-15 |
| [`docs/README.md`](README.md) | Index of the design record and the reading order for each audience | engineering lead | monthly | 45 | — | 2026-09-17 |
| [`docs/01-PRD.md`](01-PRD.md) | What we are building and why: users, scope by milestone, requirements, success metrics | product lead | quarterly | 120 | — | 2026-09-14 |
| [`docs/02-HLD.md`](02-HLD.md) | Components, flows, technology choices, scaling, security, failure modes, deployment | engineering lead | on-change | 180 | `code-graph.json`, `infra/docker/**` | 2026-09-20 |
| [`docs/03-API-spec.md`](03-API-spec.md) | Endpoints, auth model, attempt state machine, webhooks, error format | backend lead | on-change | 90 | `apps/api/src/routes/**`, `packages/contracts/**` | 2026-09-17 |
| [`docs/04-ADRs.md`](04-ADRs.md) | The decisions that are expensive to reverse, each with its reversal conditions | engineering lead | annually | 400 | — | 2026-09-20 |
| [`docs/05-licensing-and-compliance.md`](05-licensing-and-compliance.md) | Dependency licence policy, question content licensing, employment-assessment regulation | legal counsel | on-change | 180 | `pnpm-lock.yaml`, `.licence-allowlist.json` | 2026-09-20 |
| [`docs/06-testing-strategy.md`](06-testing-strategy.md) | What is tested at which layer, the test data strategy, what a milestone must prove | QA lead | on-change | 180 | `.github/workflows/ci.yml`, `.github/workflows/e2e.yml`, `packages/grading/**` | 2026-09-17 |
| [`docs/07-load-and-capacity-testing.md`](07-load-and-capacity-testing.md) | k6 scenarios, the deadline stampede, and the thresholds each concurrency claim is measured against | QA lead | quarterly | 120 | `tests/load/**`, `.github/workflows/load.yml` | 2026-09-15 |
| [`docs/08-i18n-and-localisation.md`](08-i18n-and-localisation.md) | Interface localisation, the English-only content position, and the translation seams | frontend lead | on-change | 180 | `packages/ui/src/locales/**`, `apps/candidate/src/locales/**`, `apps/web/src/locales/**` | 2026-09-15 |
| [`docs/09-ats-integration.md`](09-ats-integration.md) | Outbound event catalogue, signature scheme, retry and replay, the connector adapter interface | backend lead | on-change | 180 | `apps/api/src/webhooks/**`, `packages/contracts/src/webhooks/**` | 2026-09-15 |
| [`docs/10-certification-and-credentials.md`](10-certification-and-credentials.md) | Open Badges 3.0 issuance, signing key management and rotation, revocation, PDF rendering | backend lead | on-change | 180 | `apps/api/src/credentials/**`, `packages/core-domain/src/credentials/**` | 2026-09-20 |
| [`docs/11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md) | The `RETENTION_*` clocks, where each is enforced, the lawful basis, and the DPIA | data protection officer | quarterly | 120 | `apps/worker/src/sweeps/**`, `packages/db/schema/**` | 2026-09-17 |
| [`docs/12-observability-and-runbooks.md`](12-observability-and-runbooks.md) | Logs, traces and metrics, the alerts that page someone, and the runbook for each failure mode | infrastructure lead | on-change | 180 | `packages/observability/**`, `infra/otel/**`, `infra/prometheus/**`, `infra/grafana/**` | 2026-09-17 |
| [`docs/13-environments-and-release.md`](13-environments-and-release.md) | Dev, staging and production, configuration and secrets, migration and release procedure, rollback | infrastructure lead | on-change | 180 | `.env.example`, `docker-compose.yml`, `docker-compose.prod.yml`, `infra/caddy/**`, `packages/config/**` | 2026-09-20 |
| [`docs/14-threat-model.md`](14-threat-model.md) | Assets, adversaries and attack surfaces, from sandbox escape to tenant isolation, with mitigations | security lead | quarterly | 120 | `packages/auth/**`, `packages/exec-adapter/**`, `infra/piston/**`, `infra/postgres/init/03-rls.sql` | 2026-09-20 |
| [`docs/15-accessibility-conformance.md`](15-accessibility-conformance.md) | The WCAG 2.1 AA commitment made concrete, and the accommodation model timers must respect | frontend lead | quarterly | 120 | `packages/ui/src/**` | 2026-09-20 |
| [`docs/16-ai-usage-policy.md`](16-ai-usage-policy.md) | The per-round AI assistance policy, the candidate declaration, and why the signals stay advisory | engineering lead | quarterly | 120 | `packages/grading/**`, `packages/core-domain/src/scoring/**` | 2026-09-17 |
| [`docs/17-engineering-standards.md`](17-engineering-standards.md) | The code-quality and system-design bar, and the invariants enforced in code rather than in review | engineering lead | quarterly | 120 | `packages/**`, `apps/**`, `tsconfig.base.json`, `eslint.config.js` | 2026-09-20 |
| [`docs/DOC-OWNERSHIP.md`](DOC-OWNERSHIP.md) | This registry: who owns each document, its cadence, and what makes it stale | delivery lead | monthly | 45 | — | 2026-09-16 |
| [`docs/hiring_platform_schema.sql`](hiring_platform_schema.sql) | The full PostgreSQL schema, runnable, and the canonical statement of the domain model | backend lead | on-change | 180 | `packages/db/schema/**`, `infra/postgres/init/02-schema.sql` | — |
| [`project/ROADMAP.md`](../project/ROADMAP.md) | Phase-by-phase build order, the current schedule baseline, and each phase's entry and exit gate | engineering lead | monthly | 30 | `project/MILESTONES.md` | 2026-09-17 |
| [`project/P0-FOUNDATION-PLAN.md`](../project/P0-FOUNDATION-PLAN.md) | The step-by-step build order for the foundation phase, with verification per step | engineering lead | on-change | 60 | `pnpm-workspace.yaml`, `turbo.json` | 2026-09-20 |
| [`project/P1-TENANCY-PLAN.md`](../project/P1-TENANCY-PLAN.md) | The step-by-step build order for tenancy, identity and audit, with verification per step | engineering lead | on-change | 60 | — | 2026-09-15 |
| [`packages/db/docs/rls-plan-cost.md`](../packages/db/docs/rls-plan-cost.md) | The measured `EXPLAIN` baseline for the five hottest tenant-scoped queries with row-level security on and off (R-09) | engineering lead | on-change | 180 | `packages/db/migrations/**`, `packages/db/src/schema/**` | 2026-09-20 |
| [`project/MILESTONES.md`](../project/MILESTONES.md) | M-1–M4 scope, the committed dates from the roadmap baseline, and exit criteria | delivery lead | monthly | 45 | — | 2026-09-17 |
| [`project/TRACKER.md`](../project/TRACKER.md) | The working backlog: one row per engineering unit, with status and dependencies | delivery lead | monthly | 30 | — | 2026-09-17 |
| [`project/RISKS.md`](../project/RISKS.md) | Named risks with likelihood, impact, owner, trigger and mitigation | delivery lead | monthly | 45 | — | 2026-09-15 |
| [`project/OPEN-QUESTIONS.md`](../project/OPEN-QUESTIONS.md) | Questions genuinely undecided, each with a decider and an absolute decide-by date | delivery lead | monthly | 45 | — | 2026-09-15 |
| [`project/STATUS.md`](../project/STATUS.md) | Where the project actually is this week, in one page | delivery lead | monthly | 14 | — | 2026-09-20 |
| [`project/DEFINITION-OF-DONE.md`](../project/DEFINITION-OF-DONE.md) | What "done" means for a change, a milestone and a release | engineering lead | quarterly | 120 | `.github/pull_request_template.md` | 2026-09-15 |
| [`project/GLOSSARY.md`](../project/GLOSSARY.md) | The domain vocabulary, so two people saying "attempt" mean the same thing | product lead | quarterly | 120 | — | 2026-09-15 |
| [`infra/README.md`](../infra/README.md) | What each container is, how the local stack fits together, and which port is whose | infrastructure lead | on-change | 180 | `infra/docker/**`, `infra/postgres/**`, `infra/caddy/**`, `docker-compose.yml` | 2026-09-20 |
| [`infra/piston/README.md`](../infra/piston/README.md) | Piston runtime installation, the pinned language versions, and the sandbox limits | infrastructure lead | on-change | 180 | `infra/piston/**` | 2026-09-15 |
| [`brand/README.md`](../brand/README.md) | The name, the mark, and the rules for using them | design lead | annually | 400 | `brand/*.svg` | 2026-09-16 |
| [`.claude/rules/doc-maintenance.md`](../.claude/rules/doc-maintenance.md) | The maintenance contract in full, with a compliant and a non-compliant worked example | delivery lead | quarterly | 120 | `scripts/check-doc-freshness.mjs` | 2026-09-17 |
| [`.claude/rules/invariants.md`](../.claude/rules/invariants.md) | The domain invariants, the ADR each comes from, and the test that guards it | engineering lead | quarterly | 120 | `docs/04-ADRs.md` | 2026-09-20 |
| [`.claude/rules/review-checklist.md`](../.claude/rules/review-checklist.md) | What a human reviewer checks, ordered by how expensive the mistake is | engineering lead | quarterly | 120 | `project/DEFINITION-OF-DONE.md` | 2026-09-15 |

## Owner roles and their team handles

The roles above are placeholders until people are assigned. Each maps to exactly one handle in [`../.github/CODEOWNERS`](../.github/CODEOWNERS); nothing else in the repository needs to change when a person takes a role.

| Owner role | CODEOWNERS handle | Accountable for |
|---|---|---|
| engineering lead | `@assaybank/eng-lead` | Architecture, the operating contract, the ADR record |
| backend lead | `@assaybank/backend` | API surface, schema, domain services |
| frontend lead | `@assaybank/frontend` | Staff console, candidate app, accessibility, localisation |
| infrastructure lead | `@assaybank/infra` | Containers, environments, release, observability |
| security lead | `@assaybank/security` | Threat model, sandbox, tenant isolation, secret handling |
| QA lead | `@assaybank/qa` | Test strategy, load and capacity, release evidence |
| data protection officer | `@assaybank/dpo` | Retention, DPIA, lawful basis, candidate data rights |
| legal counsel | `@assaybank/legal` | Dependency and content licensing, employment-assessment regulation |
| product lead | `@assaybank/product` | Requirements, scope, vocabulary |
| delivery lead | `@assaybank/delivery` | Milestones, backlog, risks, status, this registry |
| design lead | `@assaybank/design` | Brand, visual language |

### Trigger changes, 2026-09-17

Three patterns were narrowed because they fired on changes that could not affect the document,
and the only way to satisfy them was to bump a date on something nobody had re-read.

- `docs/05-licensing-and-compliance.md` no longer triggers on `package.json`. It exists to catch
  dependency changes, and every dependency change — root or workspace, direct or transitive —
  moves `pnpm-lock.yaml`, which it still watches. A script edit moves `package.json` and nothing
  about licensing.
- `project/P0-FOUNDATION-PLAN.md` no longer triggers on `package.json`. It still watches the
  workspace shape (`pnpm-workspace.yaml`, `turbo.json`), which is what the plan describes.
- `project/P1-TENANCY-PLAN.md` has no triggers. P1 is complete and the plan is now a record of
  how it was built. Watching `packages/db/**` meant every database change in every later phase
  demanded an edit to a finished plan.

## What the gate checks

`node scripts/check-doc-freshness.mjs` runs five checks and fails on any of them.

1. **Registration, both directions.** Every markdown file in the scanned tree appears in the registry, and every registered path exists on disk. A new document that nobody registered has no owner and no trigger set, which means it will be wrong within a month.
2. **Metadata present and parseable.** Every registered markdown file has a `**Last updated:** YYYY-MM-DD` line in its header block, and the date is real.
3. **Registry agreement.** The `Last updated` column matches the document's own header. The header wins; `--sync` rewrites the column.
4. **Age.** No document is older than its max age.
5. **Index coverage.** Every registered document under `docs/` is referenced from [`README.md`](README.md), so the index cannot silently omit a document.

In `--changed` mode, run in CI against the pull request diff, it adds the trigger check: for every registry row whose trigger patterns match a changed path, the document itself must also appear in the diff. The failure message names the document, the rule and the file that fired it.

## Escalation when a document goes stale

Staleness is a delivery problem, not a documentation problem. A document that nobody has touched past its max age usually means the system it describes has moved and nobody noticed, which is a defect waiting to be discovered by someone acting on the old text.

| When | What happens | Who |
|---|---|---|
| Day 0 past max age | The nightly `docs.yml` scheduled run fails and reports the document. No pull request is blocked by age alone — only by trigger rules — so this is a notification, not a stop. | Document owner |
| Within 5 working days | The owner either bumps `**Last updated:**` after actually re-reading the document, or opens a tracker item for the rewrite it needs. Bumping the date without reading it is the one behaviour this whole mechanism exists to prevent, and it is a review failure, not a shortcut. | Document owner |
| Within 10 working days | Unresolved staleness becomes a row in [`../project/TRACKER.md`](../project/TRACKER.md) with an owner and an estimate, and is named in [`../project/STATUS.md`](../project/STATUS.md). At this point it competes for time against feature work, which is the correct place for it to compete. | Delivery lead |
| Two consecutive cadence periods missed | The delivery lead and the document owner decide one of three things: re-own it, rewrite it, or delete it. Deleting a document that no longer describes anything real is a legitimate and under-used outcome — the registry row goes with it, and [`README.md`](README.md) loses its index line in the same change. | Delivery lead |

A document may be marked **frozen** in its own `**Status:**` line — appropriate for a superseded ADR set or a historical record — in which case it keeps its registry row for the existence check and the reviewer skips it for content. Nothing is frozen as of 2026-09-15.

## Adding a document

1. Write it with the standard header block: H1, then `**Status:**`, `**Owner:**`, `**Last updated:**`, `**Companion docs:**`, then a `---` rule.
2. Add a registry row here: path, one-line purpose, one owner role, cadence, max age, triggers.
3. Add an index line in [`README.md`](README.md) if it lives under `docs/`.
4. Run `node scripts/check-doc-freshness.mjs` and `node scripts/check-links.mjs` before opening the pull request. Both are also in `make docs-check`.

If step 2 feels like overhead for the document you are adding, that is a signal the document should be a section in an existing one.
