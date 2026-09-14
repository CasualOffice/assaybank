# Open questions

**Status:** draft
**Owner:** _unassigned_
**Last updated:** 2026-09-15
**Companion docs:** [`MILESTONES.md`](MILESTONES.md), [`RISKS.md`](RISKS.md), [`TRACKER.md`](TRACKER.md), [`../docs/01-PRD.md`](../docs/01-PRD.md), [`../docs/04-ADRs.md`](../docs/04-ADRs.md), [`../docs/05-licensing-and-compliance.md`](../docs/05-licensing-and-compliance.md)

---

## How this file works

Every question here blocks or shapes something. Each carries a named decider, an absolute decide-by date, and options with their trade-offs stated rather than implied. A question with no decide-by date is not open, it is abandoned.

**Status values.** `open` — no decision yet. `resolved` — decided, with a link to the document that records the decision and its reasoning. `deferred` — consciously postponed, with a new date and the reason for postponing. A decide-by date that passes silently is a process failure and is caught by the milestone-completion ritual in [`MILESTONES.md`](MILESTONES.md).

**Resolution belongs in a document, not here.** When a question resolves, the reasoning goes into a design doc or an ADR and this file points at it. This file is an index of what is undecided, not an archive of decisions.

### Source mapping

The five questions in [`../docs/01-PRD.md`](../docs/01-PRD.md) §11 and the five known gaps in [`../docs/README.md`](../docs/README.md) overlap substantially. The mapping is explicit so neither list is silently dropped.

| Source | Item | Tracked as |
|---|---|---|
| PRD §11.1 | AI assistants in coding rounds | OQ-001 |
| PRD §11.2 | ATS integration — webhooks or direct connector | OQ-002 |
| PRD §11.3 | i18n at launch | OQ-003 |
| PRD §11.4 | Certification credentials — Open Badges or PDF | OQ-004 |
| PRD §11.5 | Retention default for session recordings | OQ-005 |
| README gap 1 | ATS integration is webhooks only; no direct connector specified | OQ-002, with the concrete target system as OQ-013 |
| README gap 2 | No i18n design for question content | OQ-003 |
| README gap 3 | Certificate issuance format undecided | OQ-004 |
| README gap 4 | Retention defaults are working assumptions pending legal sign-off | OQ-005 |
| README gap 5 | Load testing plan not written | OQ-006 |

OQ-007 through OQ-014 were raised by the documentation work itself — mostly decisions the design docs assume have been made and which have not been written down anywhere.

### Status summary

| Status | Count | Ids |
|---|---|---|
| resolved | 7 | OQ-001, OQ-002, OQ-003, OQ-004, OQ-005, OQ-006, OQ-007 |
| open | 7 | OQ-008, OQ-009, OQ-010, OQ-011, OQ-012, OQ-013, OQ-014 |
| deferred | 0 | — |

---

## OQ-001 — Do we allow AI assistants in coding rounds?

**Status:** resolved — see [`../docs/16-ai-usage-policy.md`](../docs/16-ai-usage-policy.md)
**Source:** PRD §11.1
**Decider:** hiring manager, with engineering lead
**Decide by:** 2026-11-02 (M2 start) — met early

**Why it matters.** Candidates will use assistants regardless of what the policy says. If the policy is unstated, each interviewer improvises, two candidates are measured against different standards, and the hiring record stops being comparable — which defeats the product's stated purpose. It also interacts directly with R-03: against a contaminated imported bank, an assistant makes the async coding round measure nothing.

**Options considered.**

| Option | Trade-off |
|---|---|
| Block and detect | Fragile. Detection produces false accusations, which is both unfair and a legal exposure, and it pushes the product toward automated verdicts that ADR-007 forbids. |
| Allow everywhere, observe nothing | Simple and honest, but the async round's signal decays to "can this person prompt a model", measured without evidence. |
| Allow in live rounds with the prompt stream recorded; restrict in certification mode | Matches how engineering actually works now, produces observable evidence rather than a verdict, and keeps the high-stakes surface controlled. More work in the live tier. |

**Recommendation taken.** The third. ADR-011 already permits recording the candidate's own AI usage during live rounds as observable evidence, explicitly outside the scoring path. Certification mode, which runs under Safe Exam Browser, restricts by construction rather than by detection.

---

## OQ-002 — Generic webhook layer first, or a direct ATS connector?

**Status:** resolved — see [`../docs/09-ats-integration.md`](../docs/09-ats-integration.md)
**Source:** PRD §11.2, README gap 1
**Decider:** engineering lead, with recruiting
**Decide by:** 2026-10-12 (M1 start) — met early

**Why it matters.** The PRD is clear that this is not an ATS and integrates with one. If the first integration is a direct connector to one vendor, its data model leaks into ours and the second integration costs as much as the first. If it is webhooks only, every customer needs an engineer to consume them, which a recruiting team does not have.

**Options considered.**

| Option | Trade-off |
|---|---|
| Webhooks only | Cheapest, already specified in [`../docs/03-API-spec.md`](../docs/03-API-spec.md) §12, and vendor-neutral. Puts integration work on the consumer. |
| Direct connector first | Best experience for one customer. Couples our domain to theirs and sets a precedent for per-vendor code. |
| Webhooks as the substrate, connectors as thin adapters above them | More structure up front. Keeps one event model, makes the second connector cheap, and keeps vendor logic out of the core. |

**Recommendation taken.** The third. The webhook layer in `TRACKER.md` H-061 is the substrate; a named connector is a later, separable piece of work. The concrete choice of first target system remains open as OQ-013.

---

## OQ-003 — Do we need multi-language question content at launch?

**Status:** resolved — see [`../docs/08-i18n-and-localisation.md`](../docs/08-i18n-and-localisation.md)
**Source:** PRD §11.3, README gap 2
**Decider:** hiring manager, with question bank owner
**Decide by:** 2026-09-21 (M0 start) — met

**Why it matters.** This is a schema question disguised as a product question, which is why it had to be answered before M0 rather than during it. `question_versions` already carries a `locale` column with `UNIQUE (question_id, version_no, locale)`, so the data model admits translations. Whether the API, the draw rules, the psychometrics and the candidate UI treat locale as a first-class dimension is a different and much larger commitment — per-locale statistics in particular, since a translated question is psychometrically a different question.

**Options considered.**

| Option | Trade-off |
|---|---|
| English only, drop the `locale` column | Simplest. Reintroducing it later is a migration across the whole bank and all attempt history. |
| English only for v1, keep `locale` and honour it in the schema and contracts | Costs almost nothing now, preserves the option, and keeps every UI and statistics path monolingual until there is demand. |
| Full i18n at launch | Multiplies authoring cost, splits `question_stats` per locale, and delays M0 for a requirement nobody has asked for yet. |

**Recommendation taken.** The second. Keep `locale`, default `en`, treat a translation as a distinct version for statistics purposes when it eventually arrives.

---

## OQ-004 — Verifiable credentials or a PDF for certification?

**Status:** resolved — see [`../docs/10-certification-and-credentials.md`](../docs/10-certification-and-credentials.md)
**Source:** PRD §11.4, README gap 3
**Decider:** hiring manager, with legal
**Decide by:** 2026-12-11 (before M4 build starts) — met early

**Why it matters.** M4's exit path includes certificate issuance with a verifiable id. A PDF that anyone can edit is not a credential, it is a souvenir; if a third party will ever rely on it, verification has to be possible without contacting us. Conversely, adopting an open-badge stack commits us to hosting an issuer profile and a revocation mechanism indefinitely, which is an operational obligation long after the hiring cycle ends.

**Options considered.**

| Option | Trade-off |
|---|---|
| PDF only | Trivial to build. Trivial to forge. No revocation story. |
| Open Badges / verifiable credential | Interoperable and verifiable by third parties. Requires a hosted issuer profile, key management and a revocation endpoint we must keep running. |
| PDF plus a verifiable id resolved by a public endpoint | Covers the realistic use — someone checks a certificate is genuine — without committing to a credential ecosystem. Not interoperable with badge wallets. |

**Recommendation taken.** The third, with the data model kept badge-compatible so the second remains reachable without re-issuing past certificates. Task H-103 carries the verification endpoint, which must disclose no candidate PII beyond what was consented.

---

## OQ-005 — What is the retention default for session recordings?

**Status:** resolved — see [`../docs/11-data-retention-and-dpia.md`](../docs/11-data-retention-and-dpia.md)
**Source:** PRD §11.5, README gap 4
**Decider:** legal / DPO
**Decide by:** 2026-11-30 (M3 start) — met early, pending formal counsel sign-off

**Why it matters.** [`../docs/05-licensing-and-compliance.md`](../docs/05-licensing-and-compliance.md) §3 is unambiguous that retention must be *"enforced in code, not policy documents"*, and the schema already carries `candidates.erase_after` and `proctor_media.delete_after` for the purpose. A default that is only written in a policy document is a default that does not exist. Retaining recordings longer than necessary is a GDPR exposure; deleting them too early destroys the evidence that defends a disputed hiring decision, which is the whole reason the product records anything.

**Options considered.** The working assumptions from the licensing doc become the canonical `RETENTION_*` defaults: proctor media 30 days, session recordings 90 days, attempt answers and scores 24 months (aligned to the discrimination-claim limitation period), unsuccessful candidate PII 12 months, audit log 7 years, anonymised aggregates indefinite. The alternative — per-org configuration with no floor or ceiling — was rejected because it makes the compliance position unknowable across tenants.

**Recommendation taken.** Ship the defaults as environment-level constants with per-org override permitted only downward (shorter), never upward, and enforce every clock with a time-travel test (task H-105). **Formal counsel sign-off remains outstanding** and is tracked against the M4 entry dependency; the codified default does not substitute for it.

---

## OQ-006 — Where is the load testing plan?

**Status:** resolved — see [`../docs/07-load-and-capacity-testing.md`](../docs/07-load-and-capacity-testing.md)
**Source:** README gap 5
**Decider:** engineering lead
**Decide by:** 2026-10-12 (M1 start, since M1's exit criterion is a concurrency test) — met early

**Why it matters.** Three of the five milestone exit criteria are load statements — 50 concurrent candidates, 100 concurrent submissions at p95 under 8s, 500 sustained candidates in the NFR table — and none of them can be claimed without a written, repeatable scenario. The README flagged it as needed *"before the first campus drive"*; in practice it is needed before M1 closes, because otherwise the exit criterion is assessed by impression.

**Recommendation taken.** k6 scenarios checked into the repository, run against staging with production-shaped data volumes per HLD §10, with the pass thresholds stated per milestone and the results committed as exit evidence. The deadline stampede (R-01) gets its own scenario rather than being assumed away by an average-rate calculation.

---

## OQ-007 — Node or Python for the API runtime?

**Status:** resolved — see ADR-012 in [`../docs/04-ADRs.md`](../docs/04-ADRs.md)
**Source:** HLD §5, which left it as *"Team familiarity should decide this, not us"*
**Decider:** engineering lead
**Decide by:** 2026-09-18 (M-1 close) — met

**Why it matters.** Leaving a runtime undecided leaves the entire package layout, the ORM choice, the queue library and the collaboration server undecided with it. Nothing can be scaffolded.

**Options considered.**

| Option | Trade-off |
|---|---|
| Python + FastAPI + SQLAlchemy | Strong for data work and the psychometrics. Forces a second runtime anyway, because the collaboration tier has no Python equivalent. |
| Node 22 + TypeScript + Fastify | One language across API, workers, collaboration and both front ends. Shared zod contracts between server and client. Weaker numerical ecosystem for the statistics. |
| Both, split by tier | Honest about strengths, but doubles the operational surface, the CI matrix and the onboarding cost for a team this size. |

**Recommendation taken.** Node 22 LTS with TypeScript 5.x and Fastify 5. BullMQ, Yjs and `y-websocket` are Node-only, so the worker and collaboration tiers force Node regardless; running a second runtime for the API alone buys nothing. ADR-012 records the reversal condition: a Python-only team.

---

## OQ-008 — Is this system permanently internal-only, or will it be distributed or hosted for third parties?

**Status:** **open**
**Source:** [`../docs/05-licensing-and-compliance.md`](../docs/05-licensing-and-compliance.md) §1 — *"That decision should be made explicitly and written down, not assumed."*
**Decider:** _unassigned_ — executive sponsor, with legal
**Decide by:** 2026-10-09 (M0 close)

**Why it matters.** This is the single highest-leverage open question in the project, because ADR-001 rests entirely on the answer and ADR-002 rests on ADR-001. If the system is confirmed permanently internal and never distributed or hosted for another company, GPL obligations never trigger: Judge0 becomes available and is more mature than Piston, Moodle would have covered MCQ and the question bank outright, and the licensing doc's rejection table shrinks to almost nothing. The docs estimate this at weeks, plausibly months, of saved effort.

The asymmetry is what makes it urgent. Choosing permissive when internal-only turns out to be true costs us build effort. Choosing copyleft when the system is later sold, spun out or hosted for a customer costs a source-disclosure obligation or a rewrite. The second error is far worse, which is why the default holds until someone decides otherwise — but holding the expensive default by inertia rather than by decision is exactly what the licensing doc warns against.

**Options.**

| Option | Trade-off |
|---|---|
| Confirm permanently internal-only | Unlocks Judge0 and Moodle, shortens M0 and M2 materially. Binds the company: any future decision to sell or host the product triggers a rewrite. |
| Confirm the product may be distributed or hosted | Keeps ADR-001 and ADR-002 as written. More build effort, zero legal review on the critical path, unconstrained commercialisation. |
| Leave undecided | The status quo, and the worst option — we pay the permissive build cost without ever banking the commercial optionality it buys. |

**Recommendation.** Confirm the second — assume the product may be distributed — unless the sponsor is willing to record a binding internal-only constraint. The commercialisation optionality is worth more than the weeks saved, and the decision is much cheaper to make now than to unmake later. Either way it must be written down.

---

## OQ-009 — Does a purely deterministic scoring system fall inside the EU AI Act's definition?

**Status:** **open**
**Source:** [`../docs/05-licensing-and-compliance.md`](../docs/05-licensing-and-compliance.md) §3 — *"a question for counsel"*
**Decider:** _unassigned_ — legal / DPO
**Decide by:** 2026-12-11 (before M4 build starts)

**Why it matters.** Recruitment and candidate-evaluation systems are high-risk under Annex III. Our scoring is a weighted sum of test-case results and option comparisons — no model, no learning, no inference. Whether that meets the Act's definition of an AI system is genuinely unsettled, and the answer determines whether a conformity assessment, a risk-management system and formal technical documentation are obligations or good practice. See R-05.

**Options.**

| Option | Trade-off |
|---|---|
| Build as if in scope | Low marginal cost — ADR-007, ADR-011, the immutable versions and the audit log already satisfy much of the logging, traceability and human-oversight requirements. Some documentation overhead. |
| Build as if out of scope, revisit if challenged | Saves documentation effort now. The retrofit is expensive and cannot be applied retroactively to attempts already run. |
| Obtain a written opinion and build to it | Costs counsel time and calendar. Produces a defensible position rather than a guess. |

**Recommendation.** Build as if in scope while obtaining the written opinion — the licensing doc's own advice, and the two are not mutually exclusive. The opinion is needed before any EU deployment regardless.

---

## OQ-010 — Who owns the skill taxonomy, and at what cadence is it pruned?

**Status:** **open**
**Source:** ADR-009 — *"a taxonomy someone must own and prune"*
**Decider:** _unassigned_ — question bank owner, appointed by the engineering lead
**Decide by:** 2026-09-25 (first week of M0, before the starter taxonomy is seeded)

**Why it matters.** ADR-009 makes skills the join between roles and questions, and then names the taxonomy itself as the risk. Everything downstream — role coverage, random draws, per-skill sub-scores, the auto-compose endpoint — reads from it. An unowned taxonomy accumulates `python`, `python3` and `Python` within a month of the first import, and by the time anyone notices, merging is a data migration across `question_skills` and `job_role_skills` rather than a UI action. See R-07.

This must be decided before task H-018 seeds the starter taxonomy, because the seed shape encodes the ownership model: a curated two-level tree implies an owner, a flat free-text list implies nobody.

**Options.**

| Option | Trade-off |
|---|---|
| Engineering lead owns it | Available immediately, understands the data model. Not the person who knows what skills a role genuinely needs. |
| A named senior engineer as question bank owner | The right expertise. Competes with their delivery work; needs explicit time allocation or it will not happen. |
| Rotating ownership per quarter | Spreads the load. Taxonomies punish discontinuity — a rotating owner prunes conservatively and duplicates accumulate. |

**Recommendation.** A single named question bank owner with a standing quarterly prune, matching the cadence the licensing doc already assigns for the question source-licence audit so both happen in one sitting. The role should be named in [`../docs/DOC-OWNERSHIP.md`](../docs/DOC-OWNERSHIP.md), not held informally.

---

## OQ-011 — Do we collect demographic data for adverse-impact monitoring, and on what lawful basis?

**Status:** **open**
**Source:** PRD §9 — *"where that data is voluntarily collected"*; [`../docs/05-licensing-and-compliance.md`](../docs/05-licensing-and-compliance.md) §3
**Decider:** _unassigned_ — people / legal jointly
**Decide by:** 2026-11-13 (before the first cohort large enough for the four-fifths rule to mean anything)

**Why it matters.** `GET /reports/adverse-impact` and the four-fifths-rule check cannot run on data that was never collected, and demographic data cannot be collected retroactively — a candidate who completed an assessment in October cannot be asked in January. If NYC Local Law 144 or an equivalent becomes applicable (R-06), an audit requires historical selection rates by group, and their absence means the tool cannot lawfully be used in that jurisdiction. But this is sensitive data with a high bar: it must be genuinely voluntary, separable from the assessment record, and never visible to anyone making a decision about that candidate.

**Options.**

| Option | Trade-off |
|---|---|
| Do not collect | No sensitive-data exposure. No adverse-impact monitoring is possible, and PRD §9 commits to supporting it. |
| Collect voluntarily at invitation, stored separately from the assessment record | Enables the four-fifths check. Requires a lawful basis, a clear purpose statement, and hard separation so a recruiter never sees it alongside a score. |
| Collect only when a jurisdiction requires it | Minimises exposure. Produces no baseline, so the first audit has no history to audit. |

**Recommendation.** The second, with storage isolated from `candidates` and readable only by the aggregate reporting path, never by any endpoint that returns a named candidate. The lawful basis and the consent wording are legal's call, not engineering's.

---

## OQ-012 — Is the second engineer for M3 confirmed?

**Status:** **open**
**Source:** [`../docs/README.md`](../docs/README.md) — *"M3 is a separate track that can start in parallel with a second engineer"*
**Decider:** _unassigned_ — engineering lead, with whoever holds headcount
**Decide by:** 2026-10-16

**Why it matters.** The dates in [`MILESTONES.md`](MILESTONES.md) assume it. Without a second engineer M3 runs serially after M2 and the plan slips four weeks, moving M4 to 2027-02-01 → 2027-02-26. The decide-by date is set so the M2-parallel ramp-up window (2026-11-02 → 2026-11-27) is still recoverable; deciding later means the ramp-up is lost even if the answer is yes. See R-12.

**Options.**

| Option | Trade-off |
|---|---|
| Confirm a second engineer by 2026-10-16 | The plan holds. Requires headcount and two weeks of onboarding before the ramp-up window. |
| Run serial, accept a four-week slip | No headcount cost. M4 lands in late February and the whole plan must be restated in this repository rather than absorbed quietly. |
| Descope M3 to scorecards only | Live interviews continue on an existing tool; we integrate only the structured scorecard, which is the part that affects the hiring record. Loses replay and in-session execution — and replay is a genuine differentiator. |

**Recommendation.** Confirm by the date or re-plan explicitly the same week. The third option is the honest fallback if headcount is unavailable and the dates cannot move — a scorecard against an external interview still produces a comparable hiring record, which is the product's stated purpose.

---

## OQ-013 — Which ATS is the first direct connector built against?

**Status:** **open**
**Source:** PRD §11.2 — *"a direct connector to whatever we currently use"*, which no document names
**Decider:** _unassigned_ — recruiting, with engineering lead
**Decide by:** 2026-11-06

**Why it matters.** OQ-002 settled the architecture — webhooks as the substrate, connectors as thin adapters above them — but not the target. The first connector sets the shape of the adapter interface, and an interface designed against a guess fits no real system. The stage vocabulary in particular (`applications.stage` is `applied|screening|interview|offer|rejected`) has to map onto something concrete, and every ATS uses different words for the same five states.

**Options.** Cannot be enumerated until recruiting names the system in use. The decision needed is the name plus confirmation of API access and rate limits, not a build commitment.

**Recommendation.** Name the system before M2 closes so the connector can be scoped as M4-or-later work against a real API rather than a hypothetical one. Until then the webhook layer stands alone, which is a working integration, not a placeholder.

---

## OQ-014 — Do EU candidates require in-region deployment?

**Status:** **open**
**Source:** [`../docs/05-licensing-and-compliance.md`](../docs/05-licensing-and-compliance.md) §3 — *"If candidates are in the EU and your infrastructure is not, you need a transfer mechanism."*
**Decider:** _unassigned_ — legal / DPO, with engineering lead
**Decide by:** 2026-12-04 (before M4, which adds biometric data to the transfer question)

**Why it matters.** HLD §10 specifies single-region to start and does not say which region. If EU candidates are assessed on infrastructure outside the EU, a transfer mechanism is required, and the analysis gets substantially harder once proctoring adds Article 9 biometric data in M4. Self-hosting in-region is the simplest answer and the licensing doc calls it *"a genuine argument for this build"* — but a second region is not free, and every stateful component (Postgres HA, Valkey, SeaweedFS, execution nodes) multiplies.

**Options.**

| Option | Trade-off |
|---|---|
| Single region, no EU candidates | Simplest. Constrains hiring geography, which is a business decision, not a technical one. |
| Single region with a transfer mechanism | Avoids a second deployment. Requires legal work and weakens if the mechanism is challenged. |
| Per-region deployment, data never leaves | Cleanest compliance position and a genuine product argument for self-hosting. Multiplies the operational surface and the release process. |

**Recommendation.** Decide the hiring geography first — this is downstream of a business question, and engineering should not pick a region by default. If EU candidates are in scope at all, the third option is the one the architecture was designed for.
