# Technical hiring platform — design documentation

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-15
**Companion docs:** [`../README.md`](../README.md), [`../CLAUDE.md`](../CLAUDE.md), [`../CODE-GRAPH.md`](../CODE-GRAPH.md), [`../project/STATUS.md`](../project/STATUS.md)

---

A self-hosted platform covering async assessments, live coding interviews, and proctored certification exams against one shared question bank.

This directory is the design record. It is the reason the system is shaped the way it is, and it is written to be read by someone who was not in the room. Nothing here has been built yet — the repository is documentation and scaffolding, and every statement about the system is a statement of intent. Delivery starts Monday 2026-09-21.

## Documents

| Doc | What it answers |
|---|---|
| [`01-PRD.md`](01-PRD.md) | What we're building and why, users, scope by milestone, requirements, success metrics |
| [`02-HLD.md`](02-HLD.md) | Components, flows, technology choices, scaling, security, failure modes, deployment |
| [`03-API-spec.md`](03-API-spec.md) | Endpoints, auth model, attempt state machine, webhooks, error format |
| [`04-ADRs.md`](04-ADRs.md) | The nineteen decisions that are expensive to reverse, and why they went the way they did |
| [`05-licensing-and-compliance.md`](05-licensing-and-compliance.md) | Dependency licence policy, question content licensing, employment-assessment regulation |
| [`06-testing-strategy.md`](06-testing-strategy.md) | What we test at which layer, the test data strategy, and what a milestone must prove before it closes |
| [`07-load-and-capacity-testing.md`](07-load-and-capacity-testing.md) | The k6 scenarios, the deadline-stampede case, and the pass thresholds each milestone's concurrency claim is measured against |
| [`08-i18n-and-localisation.md`](08-i18n-and-localisation.md) | Interface localisation from day one, the English-only content position, and the translation seams that make a second language a project rather than a rewrite (ADR-018) |
| [`09-ats-integration.md`](09-ats-integration.md) | The outbound event catalogue, payload and signature scheme, retry and replay semantics, and the adapter interface a direct connector would sit behind (ADR-019) |
| [`10-certification-and-credentials.md`](10-certification-and-credentials.md) | Open Badges 3.0 issuance, signing key management and rotation, revocation, and the PDF rendering of the credential (ADR-016) |
| [`11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md) | The `RETENTION_*` clocks and where each is enforced, the lawful basis for each category of data, and the data protection impact assessment |
| [`12-observability-and-runbooks.md`](12-observability-and-runbooks.md) | Logs, traces and metrics, the alerts that page someone, and the runbook for each failure mode the HLD names |
| [`13-environments-and-release.md`](13-environments-and-release.md) | Dev, staging and production, configuration and secret handling, migration and release procedure, rollback |
| [`14-threat-model.md`](14-threat-model.md) | Assets, adversaries and attack surfaces, from sandbox escape to tenant isolation to a candidate who wants the answer key, with the mitigation for each |
| [`15-accessibility-conformance.md`](15-accessibility-conformance.md) | The WCAG 2.1 AA commitment made concrete: what is tested, how, and the accommodation model the timer and proctoring must respect |
| [`16-ai-usage-policy.md`](16-ai-usage-policy.md) | The per-round AI assistance policy, the candidate-facing declaration, what is captured, and why those signals stay advisory (ADR-017) |
| [`DOC-OWNERSHIP.md`](DOC-OWNERSHIP.md) | Who owns each document, its review cadence, and what makes it stale |
| [`hiring_platform_schema.sql`](hiring_platform_schema.sql) | Full PostgreSQL schema, runnable |

Documents 06 through 16 and `DOC-OWNERSHIP.md` were written in the same documentation run as this index. Read each for its own detail rather than relying on the one-line summary above.

## Reading order

**Deciding whether to build this:** PRD §1–5, then ADR-001 and §1 of the licensing doc. If you are permanently internal-only and never distributing, ADR-001 flips and the build gets materially shorter. That question is open and tracked as OQ-008.

**Implementing:** HLD §2–4 for shape, the schema for the domain model, ADRs 003/004/006 before writing any attempt logic. Those three encode the mistakes that are painful to undo. Then ADR-012 and ADR-013 for the runtime and repository layout, [`../CODE-GRAPH.md`](../CODE-GRAPH.md) for where each module goes, and [`06-testing-strategy.md`](06-testing-strategy.md) for what your change has to prove.

**Operating it:** [`12-observability-and-runbooks.md`](12-observability-and-runbooks.md) for what to watch and what to do when it breaks, [`13-environments-and-release.md`](13-environments-and-release.md) for how a change reaches production and how it comes back out, and [`07-load-and-capacity-testing.md`](07-load-and-capacity-testing.md) before any campus drive or high-volume cohort. HLD §9 lists the failure modes; doc 12 is where each one has a procedure.

**Reviewing it for compliance:** [`05-licensing-and-compliance.md`](05-licensing-and-compliance.md) first for the three separate concerns it separates — dependency licences, question content licences, and employment-assessment regulation. Then [`11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md) for what is kept, for how long, and on what basis; [`14-threat-model.md`](14-threat-model.md) for the security position; [`15-accessibility-conformance.md`](15-accessibility-conformance.md) for the WCAG commitment, which is a discrimination exposure and not a backlog item. ADR-007 and ADR-011 are the two constraints that are not configurable and not negotiable; read them before proposing anything that touches scoring or integrity.

**Reviewing the design:** ADRs first. Each states its own reversal conditions.

## The four ideas the whole design rests on

1. **Published questions are immutable.** Editing creates a version. Attempts reference versions, not questions. Without this you cannot re-grade, defend a dispute, or trust your question statistics. (ADR-003)

2. **The served question set is materialised per attempt.** Randomised draws are resolved once, written down including shuffle order, and never recomputed. (ADR-004)

3. **Skills join roles to questions.** Never tag a question with a job role directly, or every new role means re-tagging the bank. (ADR-009)

4. **The server owns the clock, the scoring, and the question selection.** The client renders. (ADR-006)

Two constraints sit alongside them and are not design ideas but limits: proctoring produces advisory signals and never a decision (ADR-007), and no model sits anywhere in the scoring or decision path (ADR-011). ADR-017 applies the first of these to AI-use signals for the same reason. Neither is a setting, and neither should be softened under delivery pressure.

## Build sequence

| Milestone | Dates | Weeks | Delivers |
|---|---|---|---|
| M0 Question bank | 2026-09-21 → 2026-10-09 | 1–3 | Authoring, versioning, skills, roles, import/export |
| M1 Async MCQ | 2026-10-12 → 2026-10-30 | 4–6 | Assessment builder, invitations, timer, auto-grading |
| M2 Coding rounds | 2026-11-02 → 2026-11-27 | 7–10 | Monaco, Piston wiring, async grading queue |
| M3 Live interviews | 2026-11-30 → 2026-12-24 | 11–14 | Yjs collaboration, replay, scorecards |
| M4 Proctored mode | 2027-01-05 → 2027-01-30 | 15–18 | Lockdown integration, integrity review queue |

M0 through M2 is the product. M3 is a separate track that can start in parallel with a second engineer, whose availability is not yet confirmed (OQ-012); without them M3 runs serially and everything after it slips about four weeks. M4 is last deliberately — it is the least valuable per unit of effort and the most legally fraught. The gap between 2026-12-25 and 2027-01-02 is a deliberate non-working period.

Task-level breakdown, entry and exit criteria, and the parallelism assumption are in [`../project/MILESTONES.md`](../project/MILESTONES.md); current state is in [`../project/STATUS.md`](../project/STATUS.md).

## Stack

Node 22 LTS · TypeScript 5.x · Fastify 5 · PostgreSQL 16 · Valkey 8 · BullMQ · Piston · SeaweedFS · Monaco · Yjs · React 19 · TanStack Router and Query · Tailwind CSS · Drizzle ORM · Better Auth · LiveKit (M3) · Safe Exam Browser (M4).

Node and Fastify across every service resolves the runtime question the HLD left open (ADR-012). Valkey replaces Redis above 7.2 and SeaweedFS replaces MinIO, both for licence reasons rather than technical ones (ADR-015, ADR-014); the connection variable is still called `REDIS_URL` because the wire protocol is unchanged.

All MIT / Apache-2.0 / BSD-2 / BSD-3 / ISC / MPL-2.0 / PostgreSQL / Unlicense / CC0. No GPL, no AGPL, no SSPL, no BSL. CI fails the build on a prohibited licence anywhere in the tree, including transitive dependencies, and an SBOM is produced per release.

## Gaps closed

The five gaps this index listed before are now addressed. Each was tracked through [`../project/OPEN-QUESTIONS.md`](../project/OPEN-QUESTIONS.md) rather than being closed silently.

| Former gap | Closed by | Decision |
|---|---|---|
| ATS integration is webhooks only; no direct connector specified | ADR-019, [`09-ats-integration.md`](09-ats-integration.md) (OQ-002) | Webhooks are the substrate by design; a connector is a thin adapter above them, built when two customers ask for the same ATS |
| No i18n design for question content | ADR-018, [`08-i18n-and-localisation.md`](08-i18n-and-localisation.md) (OQ-003) | English-only content at v1, interface externalised from day one, translation seams designed now; a translated version is a distinct question and inherits no statistics |
| Certificate issuance format undecided (PDF vs Open Badges) | ADR-016, [`10-certification-and-credentials.md`](10-certification-and-credentials.md) (OQ-004) | Open Badges 3.0 verifiable credential is canonical; the PDF is a rendering of it |
| Retention defaults are working assumptions pending legal sign-off | [`11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md) (OQ-005) | The `RETENTION_*` defaults are codified and enforced in code with time-travel tests. Counsel sign-off is still outstanding — see below |
| Load testing plan not written | [`07-load-and-capacity-testing.md`](07-load-and-capacity-testing.md) (OQ-006) | k6 scenarios in the repository, run against staging with production-shaped volumes, thresholds stated per milestone, results committed as exit evidence |

The runtime question in HLD §5 — Node or Python — was also open by omission rather than by intent, and is closed by ADR-012 (OQ-007).

## Still open

Seven questions remain genuinely undecided. Each has a decider and an absolute decide-by date in [`../project/OPEN-QUESTIONS.md`](../project/OPEN-QUESTIONS.md); the summary here exists so nobody reads this index and concludes everything is settled.

- **Is the product permanently internal-only, or may it be distributed or hosted for third parties?** (OQ-008, by 2026-10-09.) The highest-leverage question in the project. ADR-001 rests on it and ADR-002 rests on ADR-001. Confirmed internal-only would make Judge0 and Moodle available and shorten M0 and M2 materially — and would bind the company. The permissive default holds until someone decides otherwise, which is a decision, not an assumption.
- **Does a purely deterministic scoring system fall inside the EU AI Act's definition?** (OQ-009, by 2026-12-11.) Needs a written opinion from counsel. Our scoring is a weighted sum with no model and no inference, but whether that meets the Act's definition is unsettled and determines whether conformity assessment is an obligation or good practice. Build as if in scope while the opinion is obtained.
- **Formal legal sign-off on the retention defaults.** (Within OQ-005.) The defaults are codified and enforced, which closes the engineering gap; counsel has not signed them off, which is a separate gap tracked against M4 entry. Codifying a default is not the same as validating it.
- **Who owns the skill taxonomy, and at what pruning cadence?** (OQ-010, by 2026-09-25.) ADR-009 names the taxonomy as its own risk and this must be settled before the starter taxonomy is seeded, because the seed shape encodes the ownership model.
- **Do we collect demographic data for adverse-impact monitoring, and on what lawful basis?** (OQ-011, by 2026-11-13.) It cannot be collected retroactively, so a late decision means no baseline exists when an audit needs one.
- **Is the second engineer for M3 confirmed?** (OQ-012, by 2026-10-16.) The dates above assume it.
- **Which ATS is the first direct connector built against, and do EU candidates require in-region deployment?** (OQ-013 by 2026-11-06; OQ-014 by 2026-12-04.) Both are downstream of business decisions — which ATS recruiting actually uses, and what hiring geography is in scope — and engineering should not answer either by default.

Two smaller things are decided but worth naming as things a future reader might reasonably want to reopen, both recorded with their reversal conditions in the ADRs rather than left as gaps:

- **The psychometrics job stays in TypeScript or SQL.** ADR-012 accepts the loss of the Python statistics ecosystem on the grounds that a p-value and a point-biserial correlation are elementary. If the analysis grows past those two — item response theory, differential item functioning — the answer is a separate Python job behind the existing queue boundary, not a second runtime for the API.
- **Judge0 is not revisited unless ADR-001 is.** ADR-002 is downstream of the licence policy, so the Piston decision reopens only if OQ-008 resolves to permanently internal-only, or if Judge0's licence changes. The execution adapter in `packages/exec-adapter` exists so that reversal touches one module.

## Where the rest of the repo lives

This directory holds the design record. The working surfaces are elsewhere.

| Path | What is there |
|---|---|
| [`../README.md`](../README.md) | Repository entry point — what this is, how to bring the stack up, where to start |
| [`../CLAUDE.md`](../CLAUDE.md) | The repository's working agreements: conventions, constraints and the rules any contributor, human or agent, is expected to follow |
| [`../CODE-GRAPH.md`](../CODE-GRAPH.md) | The planned module map — every app and package, what it owns, and which direction dependencies are allowed to point |
| [`../project/`](../project/) | Delivery state: [`MILESTONES.md`](../project/MILESTONES.md), [`TRACKER.md`](../project/TRACKER.md), [`RISKS.md`](../project/RISKS.md), [`OPEN-QUESTIONS.md`](../project/OPEN-QUESTIONS.md), [`STATUS.md`](../project/STATUS.md), [`DEFINITION-OF-DONE.md`](../project/DEFINITION-OF-DONE.md), [`GLOSSARY.md`](../project/GLOSSARY.md) |
| [`../infra/`](../infra/) | Container definitions, Postgres init, Piston runtime configuration, proxy, telemetry collector |
| [`../.github/`](../.github/) | CI workflows, including the licence gate that enforces ADR-001, and the review templates |

If a fact appears in two places, this directory is authoritative for design intent, `../project/` is authoritative for dates and state, and [`../CODE-GRAPH.md`](../CODE-GRAPH.md) is authoritative for module boundaries.
