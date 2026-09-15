# Architecture decision records

**Status:** draft
**Owner:** _unassigned_ (engineering lead)
**Last updated:** 2026-09-15
**Companion docs:** [`01-PRD.md`](01-PRD.md), [`02-HLD.md`](02-HLD.md), [`05-licensing-and-compliance.md`](05-licensing-and-compliance.md), [`../.claude/rules/invariants.md`](../.claude/rules/invariants.md)

---

Each record states the decision, why it was made, what it costs, and what would make us revisit it. Format: context → decision → consequences.

---

## ADR-001 — Permissive licenses only

**Status:** accepted

**Context.** The best-in-class open-source components in this space are split across license families. Judge0, Moodle, CoderScreen and most online judges are GPL-3 or AGPL-3. Piston, Monaco, Yjs and LiveKit are MIT or Apache-2.0. GPL obligations trigger on distribution; AGPL triggers on network use, which a candidate-facing web app plainly is. If this system is ever sold, hosted for another company, or spun out, copyleft components become a source-disclosure obligation.

**Decision.** Every dependency must be MIT, Apache-2.0, BSD-2/3, ISC, or MPL-2.0. CI fails the build on GPL, LGPL-with-static-linking, AGPL, SSPL, BSL, or any license flagged as non-permissive. An SBOM is generated per release.

**Consequences.** We give up Judge0, which is more mature than Piston, and CoderScreen, which would have been a head start. We accept more build effort in exchange for zero legal review on the critical path and unconstrained commercialisation. If the system is confirmed permanently internal-only and never distributed, this ADR is worth revisiting — GPL would then cost nothing and Judge0 would save weeks.

---

## ADR-002 — Piston over Judge0 for execution

**Status:** accepted
**Depends on:** ADR-001

**Context.** Judge0 is the most capable open-source code execution system: 90+ languages, a well-documented HTTP API, multi-file support, and years of production use in assessment products. Piston is smaller, MIT-licensed, Docker-based, and covers the languages that actually appear in technical hiring. Judge0 is GPL-3.

**Decision.** Use Piston, behind a thin internal adapter interface (`execute(language, version, files, stdin, limits) → result`).

**Consequences.** Fewer exotic languages out of the box, and we own more of the operational burden — runtime installation, container recycling, resource tuning. The adapter means the choice is reversible: swapping to Judge0 (if licensing changes), to gVisor-based isolation, or to a commercial sandbox touches one module.

Note that Piston's public API is no longer freely available, so self-hosting was required regardless. Both projects have had documented sandbox escapes; the HLD's isolation posture assumes escape rather than trusting the sandbox.

---

## ADR-003 — Published question versions are immutable

**Status:** accepted

**Context.** Question content changes: typos get fixed, test cases get added, difficulty gets recalibrated. If a question row is edited in place, then a candidate who scored 7/10 last month cannot be re-graded, an appeal cannot be investigated, and psychometric statistics mix results from materially different questions.

**Decision.** `questions` holds identity and lifecycle state. `question_versions` holds content and is append-only once `published_at` is set. Editing a published question creates a new version. Attempts reference a version, never a question.

**Consequences.** More rows and a slightly heavier authoring flow — authors must understand "publish" as a distinct, irreversible action. In exchange: reproducible grading, honest per-version statistics, and a defensible audit trail when a candidate disputes a result. The UI should make the current version feel like "the question" so the versioning is invisible during normal authoring.

---

## ADR-004 — Materialise the served question set per attempt

**Status:** accepted

**Context.** Randomised draws ("10 questions, Python, difficulty 2–3") are how you prevent question leakage across a cohort. But if selection is computed lazily or re-derived at grading time, the bank has shifted underneath you and you cannot reconstruct what the candidate actually saw — including the option shuffle order, which matters for MCQ analytics.

**Decision.** At `POST /attempt/start`, resolve every section rule once, write the full ordered set to `attempt_questions` including `option_order`, and never re-roll. All subsequent reads, grades, and reports go through that table.

**Consequences.** Slightly heavier attempt start. In exchange we get re-gradability, dispute resolution, accurate per-version exposure counting, and the ability to detect a leaked question by correlating scores against which candidates received it.

The attendant risk is rule infeasibility discovered at start time. Mitigated by `POST /assessments/{id}/simulate`, which must be called and pass before an assessment can be published.

---

## ADR-005 — Yjs CRDT for collaborative editing, not OT

**Status:** accepted

**Context.** Live interviews need two or more people editing one document with low latency and no lost keystrokes. The two approaches are operational transformation (a central server transforms and orders operations) and CRDTs (clients converge without a coordinator). OT is what Google Docs uses; it is well understood and notoriously hard to implement correctly.

**Decision.** Yjs with `y-websocket`, Redis pub/sub for cross-instance fanout, periodic state-vector snapshots to Postgres.

**Consequences.** No central lock and no server-side transformation logic, so a server restart mid-interview is survivable and offline-tolerant clients converge on reconnect. The cost is that Yjs document state is a binary blob — you cannot query it in SQL. This is why `session_events` exists as a parallel append-only stream: replay, analytics and audit read the event log, not the CRDT.

---

## ADR-006 — The server owns the clock

**Status:** accepted

**Context.** Any timer the client controls will be manipulated. System clock changes, tab suspension, and devtools all break naive client countdowns even without malice.

**Decision.** `deadline_at` is computed server-side at attempt start from `duration_seconds` plus any recorded accommodation. Every API response includes `server_time`. Submissions after `deadline_at` are rejected. A scheduled sweep transitions overdue attempts to `expired` and grades whatever was autosaved. The client countdown is display-only, reconciled on every heartbeat.

**Consequences.** Clock skew and tab suspension become non-issues. Candidates on a bad connection near the deadline may lose the last few seconds of work — mitigated by ≤5s autosave and by grading whatever is saved rather than discarding the attempt. Pause/resume, if ever needed, must be a server-side state transition, not a client timer stop.

---

## ADR-007 — Proctoring produces signals, never decisions

**Status:** accepted

**Context.** Automated proctoring systems flag candidates for looking away, having a second face in frame, or switching tabs. Published accuracy varies substantially across skin tones, ages and disabilities, and several vendors have faced legal and regulatory challenge. Employment decisions are a regulated high-risk category in multiple jurisdictions.

**Decision.** Proctoring events are advisory only. The system computes no automated integrity verdict and never rejects, voids, or down-scores an attempt on its own. Flagged attempts enter a human review queue with the specific triggering evidence attached. Webcam capture is off by default, available only in certification mode, requires recorded consent, and carries a hard retention ceiling with automatic deletion.

**Consequences.** More human review work than a fully automated system. We accept that cost. The alternative — an automated rejection pipeline built on weak signals — is both unfair and a serious legal exposure. This is a product constraint, not a configurable setting, and should not be softened under delivery pressure.

---

## ADR-008 — Asynchronous grading with a dedicated queue

**Status:** accepted

**Context.** Grading a coding submission means running N test cases, each up to the time limit. A 10-case question at 5s limits is up to 50 seconds of wall time. Doing that inside a request means the candidate's browser holds a connection for a minute and one slow submission occupies an API worker.

**Decision.** Submissions return `202` immediately with a submission ID. A Redis-backed queue feeds dedicated grading workers. Results stream to the client over SSE. Jobs are idempotent by submission ID with bounded retries and a dead-letter queue.

Two queues with separate priorities: interactive "Run" (candidate is waiting, sample cases only, low latency) and batch "Submit" (full grading, throughput over latency).

**Consequences.** More moving parts and a genuinely asynchronous client. In exchange the API stays responsive under load and execution capacity scales independently. Critically, a grading outage does not invalidate attempts — submissions queue and the attempt sits in a valid state until workers recover.

---

## ADR-009 — Skills as the join between roles and questions

**Status:** accepted

**Context.** The naive model tags each question with the job roles it suits. This breaks the first time you add a role: someone must revisit every question and decide whether "SDE-2 Backend" applies. With 500 questions and 15 roles that is unsustainable, and the tags drift out of date immediately.

**Decision.** Questions are tagged with skills. Job roles declare required skills with weights and difficulty bands. Assessment composition resolves role → skills → questions at build time.

**Consequences.** One extra layer of indirection and a taxonomy someone must own and prune. In exchange, adding a role is a five-minute configuration change, per-skill sub-scores come free, and `GET /job-roles/{id}/coverage` can tell you exactly where the bank is thin before you try to hire for something.

The taxonomy itself is the risk. Keep it shallow (two levels), make it org-editable, and merge duplicates aggressively — an unmaintained taxonomy with `python`, `python3`, and `Python` is worse than no taxonomy.

---

## ADR-010 — Row-level security for tenant isolation

**Status:** accepted

**Context.** Multi-tenant data leakage is the failure that ends products. Application-layer filtering (`WHERE org_id = ?`) works until one developer forgets one clause in one query.

**Decision.** PostgreSQL row-level security on every tenant-scoped table. The connection pool sets `app.current_org` per request from the authenticated session. Policies enforce `org_id = current_setting('app.current_org')::uuid`.

**Consequences.** A forgotten `WHERE` clause returns zero rows instead of another tenant's data. Costs: connection pooling must set the variable per checkout rather than per connection, background jobs need an explicit elevated role with its own audit trail, and some query plans degrade — measure before assuming. Worth it.

---

## ADR-011 — Defer AI features

**Status:** accepted

**Context.** Adjacent products are shipping AI question generation, AI candidate summaries, and AI-assisted scoring. Each is a plausible feature and each carries regulatory weight when applied to employment decisions.

**Decision.** No AI in the scoring or decision path for v1. Two AI features are acceptable later, both outside that path: (a) question *drafting* assistance for authors, where a human reviews and publishes; (b) recording the candidate's own AI usage during live rounds as observable evidence, since prompting is now part of real engineering work.

**Consequences.** We ship less novelty. We also avoid building an automated decision system into a high-risk regulatory category before the compliance framework is in place. Revisit once the bank is mature and the legal position on automated employment decision tools is settled in the jurisdictions we operate in.

---

## ADR-012 — Node 22 and TypeScript with Fastify for every service

**Status:** accepted
**Depends on:** ADR-005, ADR-008

**Context.** [`02-HLD.md`](02-HLD.md) §5 lists the API runtime as "Node + TypeScript (Fastify) or Python (FastAPI)" with the note that team familiarity should decide it. That is a reasonable thing for a high-level design to defer and an unreasonable thing to leave open once anything is scaffolded: the runtime determines the ORM, the queue library, the package layout, the CI matrix and the shape of the contracts package. Nothing can be built while it is open.

The choice is also less free than it looks. ADR-008 commits to BullMQ for the grading queues and ADR-005 commits to Yjs with `y-websocket` for live documents. Both are Node-only; neither has a Python equivalent with comparable maturity. Whatever the API is written in, the worker tier and the collaboration tier are Node. The real question is therefore not "Node or Python" but "one runtime or two".

**Decision.** Node 22 LTS with TypeScript 5.x across the whole repository. Fastify 5 for the HTTP API. One language for `apps/api`, `apps/worker`, `apps/collab` and both front ends, in a single pnpm workspace.

The decisive consequence of one language is `packages/contracts`: zod schemas that validate a request on the server and type the same payload in the browser, with OpenAPI 3.1 generated from them rather than maintained beside them. A Python API would mean the schema is written twice — once in Pydantic, once in TypeScript — and the two drift silently, which is precisely the class of bug the contracts package exists to prevent.

**Consequences.** We give up the Python data-science ecosystem, and the place that costs us is the nightly psychometrics job: the p-value and point-biserial correlation that PRD FR-5 requires per question version. That is a smaller loss than it sounds. Both are elementary statistics — a proportion and a correlation coefficient — computable in SQL directly over `attempt_questions`, or in TypeScript over a result set, in well under a hundred lines with no library at all. What we do not get cheaply is the next tier of analysis: item response theory, differential item functioning across demographic groups, factor analysis of the skill taxonomy. If that analysis becomes real work rather than two summary statistics, the right answer is a separate Python job behind the same queue boundary the grading workers already use — it reads Postgres, writes `question_stats`, and shares no code with the API. The queue boundary is what makes that addition cheap later, so do not let psychometrics leak into the API process in the meantime.

Second cost: one runtime means one blast radius. A Node CVE touches every tier at once, where a split stack would have contained it. The mitigation is ordinary — pinned versions, a single `.nvmrc`, Dependabot on one toolchain instead of two — and the reduced surface (one dependency tree to licence-scan under ADR-001, one SBOM, one lockfile) is worth more than the notional isolation.

Revisit if the team that actually builds this is overwhelmingly Python and would be slower in TypeScript than the second toolchain costs. Runtime choices should follow the people writing the code; this ADR is a decision about a tie, not a claim that Node is better. The worker and collaboration tiers stay Node even then, so a reversal produces a two-runtime system, not a Python one.

---

## ADR-013 — pnpm workspace monorepo with a separate candidate bundle

**Status:** accepted
**Depends on:** ADR-012

**Context.** The system has two distinct front ends: a staff console used by recruiters, interviewers and admins, and a candidate-facing runner used by people outside the organisation. The obvious build is one React application with role-based routing, which is how most products of this shape start.

That build has a specific failure mode. The staff console legitimately handles question-bank content, correct-answer keys, scoring weights, other candidates' results and integrity review evidence. If it is one bundle, all of that code — and any constant, fixture or type it drags along — ships to the candidate's browser and is readable with devtools open. Route guards do not help; they gate rendering, not the bundle. Preventing leakage then depends on every future developer correctly reasoning about tree-shaking and dynamic import boundaries, forever. One careless shared import from a "common" module is enough, and nothing in CI will notice.

**Decision.** A pnpm workspace monorepo with Turborepo for task orchestration, laid out as `apps/*` and `packages/*` per [`../CODE-GRAPH.md`](../CODE-GRAPH.md). `apps/web` (staff) and `apps/candidate` are separate applications producing separate bundles, deployed to separate origins and ports. `packages/ui` holds only presentation components and design tokens — no domain logic, no bank access, no answer keys. Anything a candidate must not see lives in a package that `apps/candidate` does not depend on, and the dependency graph is the enforcement mechanism.

**Consequences.** Some duplication: two routers, two build pipelines, two sets of application shell, two deploy targets. Shared components move to `packages/ui` and every change there must be checked against both consumers. CI runs two front-end builds instead of one.

In exchange, "can a candidate see this?" becomes a question with a mechanical answer — inspect `apps/candidate`'s dependency closure — rather than a judgement call. The rule is checkable in review and by a lint rule on disallowed imports, which route guards never are. The separation also gives the candidate app a much smaller bundle and a simpler threat model: it authenticates with short-lived attempt tokens (`packages/auth`) rather than staff sessions, so a stolen candidate token grants access to one attempt and nothing else.

The monorepo itself, as distinct from the split bundle, buys atomic changes across the contract boundary: a change to `packages/contracts` lands with the API handler and both clients in one commit, so the generated OpenAPI document and the consumers cannot be out of step at any commit on the main branch.

Revisit the monorepo if independent release cadences ever diverge enough that a single versioned tree is the obstacle rather than the help — a plausible future for `apps/collab`, which changes rarely and scales differently. Do not revisit the split bundle. Merging the two front ends to save build time would trade a mechanical guarantee for a convention, and the whole reason for this decision is that conventions fail quietly.

---

## ADR-014 — SeaweedFS, not MinIO, for object storage

**Status:** accepted
**Depends on:** ADR-001

**Context.** The system stores files that do not belong in Postgres: candidate file uploads, exported reports, question-bank import archives, session recordings from M3 and proctoring media from M4. An S3-compatible object store is the right shape, and MinIO is the default self-hosted answer — [`02-HLD.md`](02-HLD.md) §5 names it, and its §10 deployment sketch places it on the data node group.

MinIO is AGPL-3.0, and [`05-licensing-and-compliance.md`](05-licensing-and-compliance.md) §1 flags it as one of the two traps worth naming. The AGPL's network-use clause is not a distribution trigger that we might avoid by never shipping a tarball; it triggers on making the software's functionality available to users over a network, which is exactly what a candidate uploading a file to the assessment runner does. Running it inside a product that ADR-001 explicitly keeps commercialisable is the scenario the licence was written for.

**Decision.** SeaweedFS (Apache-2.0) as the self-hosted S3-compatible store, addressed through the S3 API only. Deployments that prefer a managed service may substitute any S3-compatible provider — Cloudflare R2, Backblaze B2, AWS S3 — by changing `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_FORCE_PATH_STYLE`. No application code may use a vendor-specific extension; the store is reachable only through the S3 verbs that every implementation supports.

**Consequences.** SeaweedFS is less familiar than MinIO and its documentation is thinner. Its S3 gateway covers the operations we need — put, get, delete, presigned URLs, lifecycle — but it is a gateway over a different underlying architecture, so behaviour at the edges (multipart limits, consistency after overwrite, error payload shape) must be verified against our usage rather than assumed from S3 semantics. That verification is a real task, not a formality, and belongs in the integration test suite in [`06-testing-strategy.md`](06-testing-strategy.md).

Holding the S3 API as the only interface keeps the choice cheap to reverse and makes the managed-service path a configuration change. It also means retention enforcement — the `RETENTION_PROCTOR_MEDIA_DAYS` and `RETENTION_SESSION_RECORDING_DAYS` clocks in [`11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md) — is implemented as explicit deletes issued by the worker tier against object keys we recorded, not as a bucket lifecycle rule that only some providers honour identically. Explicit deletion is slower and requires the sweep to be correct, but it is auditable and portable, and a retention promise that depends on a provider feature is a promise we cannot verify.

Revisit if ADR-001 is reversed — if the sponsor records a binding internal-only constraint (tracked as OQ-008 in [`../project/OPEN-QUESTIONS.md`](../project/OPEN-QUESTIONS.md)), MinIO's AGPL obligations never trigger and its maturity becomes available at no cost. Purchasing a MinIO commercial licence is the other exit and remains open at any time; it is a budget decision, not an architectural one.

---

## ADR-015 — Valkey, not Redis, for cache and queue

**Status:** accepted
**Depends on:** ADR-001, ADR-008

**Context.** Redis backs three things here: the BullMQ grading queues (ADR-008), the pub/sub fanout that keeps collaboration instances in sync (ADR-005), and ephemeral state — session presence, rate-limit counters, short-lived candidate session cache. [`02-HLD.md`](02-HLD.md) §4 is explicit that nothing in it is a source of truth, which is what makes this decision reversible.

Redis relicensed in 2024. Versions after 7.2 are dual RSALv2/SSPL, both of which ADR-001 prohibits and neither of which is OSI-approved. Two paths remain compliant: pin permanently to Redis 7.2, or move to Valkey, the BSD-3-Clause fork maintained under the Linux Foundation. Pinning to 7.2 is compliant on the day it is decided and degrades from there — a pinned version eventually stops receiving security fixes, and the only upgrade path from an unsupported 7.2 is a migration made under time pressure after a CVE rather than calmly now.

**Decision.** Valkey 8 everywhere — development compose, staging, production. Redis above 7.2 is prohibited by the same CI licence gate that enforces ADR-001, so it cannot be reintroduced by an unreviewed bump.

**Consequences.** Almost none, which is the point. Valkey forked from Redis 7.2 and speaks the same wire protocol; BullMQ, ioredis and every other client connect unchanged, and the operational commands, configuration file and metrics are the ones the team already knows. The migration cost is an image tag.

The connection string variable stays `REDIS_URL`. Renaming it would touch every service, every compose file, every deployment manifest and every runbook to express a licence decision that no client library can observe. The name is a protocol convention at this point, not a vendor claim. That is a deliberate inconsistency between the variable name and the software behind it, and it is documented here and in [`../.env.example`](../.env.example) so nobody has to rediscover it.

The genuine risk is divergence over time. The two projects are already adding features independently, and a Valkey-only command used casually in application code would quietly make the choice irreversible. Keep to the command surface that existed at the 7.2 fork point unless there is a specific, recorded reason not to.

Revisit if Redis returns to a permissive licence, or if the two projects diverge far enough that one has a capability the other cannot match — neither is foreseeable, and neither would be urgent.

---

## ADR-016 — Open Badges 3.0 as the certificate, PDF as a rendering of it

**Status:** accepted
**Depends on:** ADR-003, ADR-010

**Context.** PRD §11 question 4 asks whether certification mode issues verifiable credentials or whether a PDF is sufficient. The distinction matters more than it appears. A PDF is a document that asserts a result; verifying it means trusting the file, and a file is trivially edited. Certification is precisely the use case where someone outside the organisation — another employer, a client, a partner — needs to check whether a claimed credential is real, and they will be looking at whatever the candidate sends them, not at our database.

The alternative to a signed credential is a verification URL printed on the PDF, which works until the PDF is edited to point somewhere else, and which leaks a lookup endpoint that must then be rate-limited, tenant-scoped and privacy-reviewed on its own.

**Decision.** The canonical certificate is an Open Badges 3.0 verifiable credential — a W3C Verifiable Credential with the Open Badges achievement model, cryptographically signed by the issuing organisation's key. The PDF is a rendering of that credential, generated from it, carrying the credential identifier and a QR code that resolves to hosted verification. The credential is the record; the PDF is a presentation of the record and is never the thing that is verified.

The credential asserts the achievement, the issuing organisation, the issue date, any expiry, and the `question_version` set the attempt was graded against. It does not carry per-question scores or candidate PII beyond what the recipient identifier requires, because a credential is designed to be shown to third parties and everything in it is disclosed by definition.

**Consequences.** We take on key management: an issuer signing key with a defined rotation policy, a revocation mechanism for credentials issued in error, and the operational discipline that both imply. That is real work, and it is the honest cost of the decision. We also take on a standard that is maturing — Open Badges 3.0 aligns with W3C Verifiable Credentials 2.0, the ecosystem of wallets and verifiers is still thin, and some recipients will not know what to do with a credential and will only ever look at the PDF. Issuing both means neither audience is stuck.

In exchange, verification does not depend on our service being reachable, and a credential holds its meaning if the platform is decommissioned. Binding the credential to the `question_version` set makes ADR-003's immutability guarantee externally visible: a credential names exactly which published versions were assessed, so "what was this person actually tested on" is answerable years later without our database. Revocation, per ADR-010, is tenant-scoped like everything else — an organisation can revoke only its own credentials.

The full issuance flow, key rotation schedule, revocation model and PDF template are specified in [`10-certification-and-credentials.md`](10-certification-and-credentials.md).

Revisit if the ecosystem consolidates on a different credential format, or if no verifier in our market ever consumes the credential and only the PDF is used in practice — in which case the signed credential becomes an audit artefact rather than a candidate-facing feature, which is still worth keeping but not worth building a wallet integration for.

---

## ADR-017 — AI assistance policy is per round type, and its signals are advisory

**Status:** accepted
**Depends on:** ADR-007, ADR-011

**Context.** PRD §11 question 1 asks whether AI assistants are permitted in coding rounds. The three available positions are block and detect, allow and observe, or vary by round — and the first fails on its own terms. Detection of AI-assisted code is unreliable, its errors are not evenly distributed, and a candidate on a personal machine can use a second device that no browser-level control can see. A policy that depends on detection we cannot perform is a policy that produces confident false accusations.

But "always allow" is wrong too, because the three surfaces are not the same test. A live interview is a conversation where the interviewer sees how the candidate works; watching someone prompt well is signal, not noise, and it resembles the job. A certification exam attests a specific competence to third parties (ADR-016), and an attestation that the candidate could pass with unrestricted assistance attests something different from what it claims. Async screening sits between the two, and the answer there depends on what the organisation is actually screening for.

**Decision.** The policy varies by round type and is declared to the candidate in every case.

| Round type | Policy | Enforcement |
|---|---|---|
| Certification exam | AI assistance not permitted | Lockdown (Safe Exam Browser) plus proctoring signals, both advisory |
| Live interview | Permitted and observed | Prompts and responses captured into `session_events` as part of the record the interviewer already sees |
| Async screening | Configurable per assessment, default permitted | Declared in the candidate instructions; paste and focus events recorded |

The declaration is not optional. A candidate is told the policy for the round before the round starts, in the instructions and in the runner interface, because a rule the candidate was never shown cannot fairly be held against them.

**Consequences.** Three policies mean three sets of instruction copy, three candidate-facing states in the runner, and a configuration field on the assessment that recruiters must understand. It would be simpler to pick one rule for everything. It would also be wrong for at least two of the three surfaces.

The load-bearing constraint: **every AI-use signal is advisory and can never be a rejection reason on its own.** A paste event, an unusual typing cadence, a focus loss — these enter the human review queue with their specific evidence attached, exactly as every other integrity signal does under ADR-007, and the system computes no verdict from them. This is not a separate principle; it is ADR-007's logic applied to a new signal source, and it applies for the same reason. The signals are weak, their errors are not randomly distributed across candidates, and an employment decision made automatically on weak evidence is both unfair and a regulated exposure.

Observing AI use is also the one AI-adjacent capability ADR-011 explicitly permits, because it records what the candidate did rather than inferring anything about them. Nothing here puts a model in the scoring or decision path, and nothing here may be extended to do so.

The detailed policy, the candidate-facing wording, the captured event schema and the reviewer guidance are in [`16-ai-usage-policy.md`](16-ai-usage-policy.md).

Revisit when the market norm shifts — if unrestricted assistance becomes standard in certification, or if a client demands an assisted certification track, the table changes and the advisory-signals constraint does not.

---

## ADR-018 — English-only question content at v1, with the translation seams built now

**Status:** accepted
**Depends on:** ADR-003

**Context.** PRD §11 question 3 asks whether multi-language question content is needed at launch. Two distinct things get conflated under "i18n": the interface (button labels, error messages, instructions, date formats) and the question content itself (stems, options, problem statements, hints). The interface is a well-understood problem with a well-understood solution. Question content is not, because translating a question changes the question.

A translated MCQ has different reading difficulty, different distractor plausibility and different ambiguities. Its p-value and point-biserial correlation will differ from the source question's, sometimes substantially. Treating a translation as the same item and pooling their statistics produces numbers that describe no real population, and those numbers are what the bank's quality metrics in PRD §10 are built on.

**Decision.** Question content is English-only for v1. The interface is externalised from day one — no user-visible string is hardcoded in `apps/web` or `apps/candidate`, locale is resolved per user with English as the fallback, and dates, times and numbers are formatted through the locale layer rather than concatenated. The content schema carries a `locale` column on `question_versions` from the first migration, populated with `en`, so adding a language later is a data change rather than a migration against a populated production table.

When translations arrive, a translation is a row in `question_version_translations` keyed to a single `question_version_id`, carrying its own review state and freezing on publication alongside the version it translates. It is **not** a sibling `question_versions` row: `question_versions.locale` records the language a version was *authored* in and is never used to represent a translation. Each translation accumulates its own statistics from n = 0 and does not inherit the source version's p-value, discrimination or exposure count. The model, its DDL, and the four concrete failure modes of the sibling-row alternative are in [`08-i18n-and-localisation.md`](08-i18n-and-localisation.md) §3.1.

**Consequences.** Non-English-speaking candidates are out of scope at v1, which is a real limitation and should be stated to anyone evaluating the product rather than discovered during a pilot. Externalising interface strings costs a little discipline in every component and one extra review question; retrofitting it costs a sweep of every view and a long tail of missed strings, so doing it now is straightforwardly cheaper.

The psychometric consequence is the one that must not be quietly dropped later. A translated version is a different question. It cannot inherit the source's statistics, its difficulty band must be re-validated against real attempts, and a role's coverage report must count English and translated versions separately or it will overstate the bank. The cost of getting this wrong is not visible — it looks like working software producing plausible numbers — which is exactly why the constraint is recorded in an ADR rather than left to whoever implements the feature.

The seam design, the locale resolution order, the translation workflow and the fallback behaviour when a translation is missing are in [`08-i18n-and-localisation.md`](08-i18n-and-localisation.md).

Revisit when a customer or a hiring region requires it — a single campus drive in a non-English market is enough to make it urgent, and the seams exist so that the answer is a project rather than a rewrite.

---

## ADR-019 — A generic webhook layer before any direct ATS connector

**Status:** accepted
**Depends on:** ADR-010

**Context.** PRD §11 question 2 asks whether to build a generic webhook layer or a direct connector to the applicant tracking system in use. Neither the PRD nor any other document names which ATS that is, which is itself informative: we would be designing an adapter against a system nobody has specified, with no access to its API, its rate limits or its stage vocabulary.

Direct connectors are also not one piece of work. Each carries its own authentication model, its own object graph, its own pagination and rate limits, its own sandbox availability and its own breaking-change cadence. A connector built first tends to define the integration architecture by accident: whatever that one ATS needed becomes the internal shape, and the second connector fights it.

**Decision.** A generic outbound webhook layer is the integration substrate. Domain events — invitation sent, attempt started, attempt submitted, attempt graded, interview completed, credential issued — are published as signed HTTP callbacks with a stable payload schema defined in `packages/contracts`, HMAC signatures over the raw body, a documented retry schedule with exponential backoff, a replay endpoint, and a per-tenant delivery log. Signing secrets rotate on the `WEBHOOK_SIGNING_SECRET_ROTATION_DAYS` schedule with an overlap window so a rotation does not drop deliveries.

Any direct ATS connector is built later, above this layer, as a thin adapter that consumes the same events and translates them into that vendor's API. A connector is a client of the webhook contract, not a parallel path into the domain.

**Consequences.** The honest consequence: this is more work for the customer and less impressive in a demo. A webhook layer requires someone technical on the other side to receive, verify and map the events. Early customers on Greenhouse or Lever will ask for a native connector, and "we emit webhooks" will sometimes lose a deal against a competitor with a marketplace listing. That is a real cost and pretending otherwise would be dishonest.

What it buys is that every integration is possible on day one rather than only the integrations we anticipated, including the ones we would never build — an internal data warehouse, a Slack notification, a Zapier step, a customer's own middleware. It also keeps the domain model free of vendor concepts: `applications.stage` stays `applied | screening | interview | offer | rejected` and the mapping to each ATS's vocabulary lives in the adapter where it belongs. Per ADR-010, webhook endpoints, secrets and delivery logs are tenant-scoped like every other row, so one organisation's delivery failures are invisible to another.

The reversal condition is concrete and deliberately low: **two customers asking for the same ATS.** At that point the connector has a real API to be designed against, a named owner, and evidence that the work pays for itself. One request is an anecdote and produces an adapter shaped by a single installation's configuration. The target system is tracked as OQ-013 in [`../project/OPEN-QUESTIONS.md`](../project/OPEN-QUESTIONS.md), and it is unanswerable until recruiting names the system in use.

The event catalogue, payload schemas, signature scheme, retry and replay semantics, and the connector adapter interface are in [`09-ats-integration.md`](09-ats-integration.md).
